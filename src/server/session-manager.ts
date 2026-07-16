import { randomBytes, randomUUID } from "node:crypto";
import { spawn as spawnPty } from "node-pty";
import type { AuditEvent, AuditFields, AuditLogger } from "./audit-log.js";
import { noopAuditLogger } from "./audit-log.js";
import type { RuntimeConfig } from "./config.js";
import type { DeviceMetadataConfig } from "./device-metadata.js";
import { sanitizeSuggestedCommand, validateDevice } from "./device.js";
import type { QuickShellOutputChunk, QuickShellPoll, QuickShellPublicSession, SessionId } from "../shared/protocol.js";
import { BoundedTextBuffer } from "../shared/bounded-text-buffer.js";
import { utf8ByteLength } from "../shared/utf8.js";

export interface Disposable {
  dispose(): void;
}

export interface PtyProcess {
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number | null }) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type PtyFactory = (
  file: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd?: string;
    env: Record<string, string>;
  },
) => PtyProcess;

export interface QuickShellSessionInput {
  device: string;
  reason?: string;
  suggested?: string;
}

export interface QuickShellSession {
  id: SessionId;
  appToken: string;
  wsToken: string;
  pty?: PtyProcess;
  publicSummary: QuickShellPublicSession;
  createdAt: number;
  lastActivityAt: number;
  exited: boolean;
  exitCode: number | null;
  scrollback: BoundedTextBuffer;
  outputChunks: QuickShellOutputChunk[];
  outputChunkBytes: number;
  nextOutputSeq: number;
  disposables: Disposable[];
}

export interface StartedQuickShellSession extends QuickShellSession {
  pty: PtyProcess;
}

export interface QuickShellSessionManagerOptions {
  config: RuntimeConfig;
  allowedHosts: ReadonlySet<string>;
  deviceMetadata?: DeviceMetadataConfig;
  audit?: AuditLogger;
  ptyFactory?: PtyFactory;
}

const ENV_ALLOWLIST = ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "SSH_AUTH_SOCK", "TERM"];

function defaultPtyFactory(): PtyFactory {
  return (file, args, options) => spawnPty(file, args, options);
}

function token(): string {
  return randomBytes(24).toString("base64url");
}

function buildPtyEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.TERM = env.TERM || "xterm-256color";
  return env;
}

export class QuickShellSessionManager {
  private readonly config: RuntimeConfig;
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly deviceMetadata: DeviceMetadataConfig;
  private readonly audit: AuditLogger;
  private readonly ptyFactory: PtyFactory;
  private readonly sessions = new Map<SessionId, QuickShellSession>();
  private readonly closedListeners = new Set<(sessionId: SessionId) => void>();

  constructor(options: QuickShellSessionManagerOptions) {
    this.config = options.config;
    this.allowedHosts = options.allowedHosts;
    this.deviceMetadata = options.deviceMetadata ?? { devices: new Map() };
    this.audit = options.audit ?? noopAuditLogger;
    this.ptyFactory = options.ptyFactory ?? defaultPtyFactory();
  }

  async createSession(input: QuickShellSessionInput): Promise<QuickShellSession> {
    if (this.sessions.size >= this.config.maxSessions) {
      throw new Error("maximum quick-shell sessions reached");
    }

    const device = validateDevice(input.device, this.allowedHosts, this.config.maxDeviceLength);
    const suggested = sanitizeSuggestedCommand(input.suggested, this.config.maxSuggestedCommandLength);
    const reason = input.reason?.slice(0, this.config.maxReasonLength).trim() || undefined;
    const now = Date.now();
    const id = randomUUID();
    const publicSummary: QuickShellPublicSession = { sessionId: id, device };
    const metadata = this.deviceMetadata.devices.get(device);
    if (reason) publicSummary.reason = reason;
    if (suggested) publicSummary.suggestedCommand = suggested;
    if (metadata?.label) publicSummary.deviceLabel = metadata.label;
    if (metadata?.group) publicSummary.deviceGroup = metadata.group;
    if (metadata?.danger) publicSummary.deviceDanger = metadata.danger;
    if (metadata?.defaultShell) publicSummary.deviceDefaultShell = metadata.defaultShell;

    const session: QuickShellSession = {
      id,
      appToken: token(),
      wsToken: token(),
      publicSummary,
      createdAt: now,
      lastActivityAt: now,
      exited: false,
      exitCode: null,
      scrollback: new BoundedTextBuffer(this.config.maxScrollbackBytes),
      outputChunks: [],
      outputChunkBytes: 0,
      nextOutputSeq: 1,
      disposables: [],
    };

    this.sessions.set(id, session);
    this.audit.record("session_opened", {
      sessionId: id,
      device,
      reason: reason ? "present" : undefined,
      suggestedCommand: suggested,
    });
    return session;
  }

  startSession(sessionId: SessionId): StartedQuickShellSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (session.pty) return session as StartedQuickShellSession;

    const cwd = process.env.HOME;
    let pty: PtyProcess;
    try {
      pty = this.ptyFactory("ssh", [session.publicSummary.device], {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd,
        env: buildPtyEnv(),
      });
    } catch (error) {
      this.audit.record("ssh_start_failed", {
        sessionId: session.id,
        device: session.publicSummary.device,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    session.pty = pty;
    this.audit.record("session_started", { sessionId: session.id, device: session.publicSummary.device });
    session.disposables.push(
      pty.onData((data) => {
        session.scrollback.append(data);
        this.appendOutputChunk(session, data);
      }),
      pty.onExit((event) => {
        session.exited = true;
        session.exitCode = event.exitCode;
        session.lastActivityAt = Date.now();
        this.audit.record("session_exited", {
          sessionId: session.id,
          device: session.publicSummary.device,
          exitCode: event.exitCode,
        });
      }),
    );

    this.recordActivity(session.id);
    return session as StartedQuickShellSession;
  }

  getSession(sessionId: SessionId): QuickShellSession | undefined {
    return this.sessions.get(sessionId);
  }

  onSessionClosed(listener: (sessionId: SessionId) => void): Disposable {
    this.closedListeners.add(listener);
    return { dispose: () => this.closedListeners.delete(listener) };
  }

  authenticateApp(sessionId: SessionId, appToken: string): QuickShellSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.appToken !== appToken) return undefined;
    this.recordActivity(sessionId);
    return session;
  }

  authenticateWsCapability(sessionId: SessionId, wsToken: string): QuickShellSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.wsToken !== wsToken) return undefined;
    this.recordActivity(sessionId);
    return session;
  }

  authenticateWs(sessionId: SessionId, wsToken: string): StartedQuickShellSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || !session.pty || session.wsToken !== wsToken) return undefined;
    this.recordActivity(sessionId);
    return session as StartedQuickShellSession;
  }

  recordActivity(sessionId: SessionId): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.lastActivityAt = Date.now();
    return true;
  }

  writeInput(sessionId: SessionId, data: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.pty || session.exited) return false;
    session.pty.write(data);
    this.recordActivity(sessionId);
    return true;
  }

  resizeSession(sessionId: SessionId, cols: number, rows: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.pty || session.exited) return false;
    session.pty.resize(cols, rows);
    this.recordActivity(sessionId);
    return true;
  }

  pollSession(sessionId: SessionId, afterSeq: number): QuickShellPoll | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    this.recordActivity(sessionId);
    const firstSeq = session.outputChunks[0]?.seq;
    const reset = firstSeq !== undefined && afterSeq > 0 && afterSeq < firstSeq - 1;
    const chunks = session.outputChunks.filter((chunk) => chunk.seq > afterSeq);
    return {
      sessionId,
      chunks,
      nextSeq: session.nextOutputSeq - 1,
      reset,
      exited: session.exited,
      exitCode: session.exitCode,
    };
  }

  closeSession(sessionId: SessionId): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    for (const disposable of session.disposables.splice(0)) {
      disposable.dispose();
    }
    session.pty?.kill();
    this.sessions.delete(sessionId);
    this.audit.record("session_closed", { sessionId: session.id, device: session.publicSummary.device });
    for (const listener of this.closedListeners) listener(sessionId);
    return true;
  }

  cleanupExpiredSessions(now = Date.now()): number {
    let closed = 0;
    for (const session of [...this.sessions.values()]) {
      const expiredByAge = now - session.createdAt >= this.config.maxSessionAgeMs;
      const expiredByIdle = now - session.lastActivityAt >= this.config.idleGraceMs;
      if (expiredByAge || expiredByIdle) {
        this.audit.record("session_expired", {
          sessionId: session.id,
          device: session.publicSummary.device,
          reason: expiredByAge ? "age" : "idle",
        });
        if (this.closeSession(session.id)) closed += 1;
      }
    }
    return closed;
  }

  closeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.closeSession(sessionId);
    }
  }

  listSessions(): QuickShellSession[] {
    return [...this.sessions.values()];
  }

  recordOutputConfirmed(sessionId: SessionId, byteCount: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.audit.record("output_confirmed", {
      sessionId,
      device: session.publicSummary.device,
      byteCount,
    });
    this.recordActivity(sessionId);
    return true;
  }

  recordAuditEvent(event: AuditEvent, fields?: AuditFields): void {
    this.audit.record(event, fields);
  }

  private appendOutputChunk(session: QuickShellSession, data: string): void {
    const byteLength = utf8ByteLength(data);
    session.outputChunks.push({ seq: session.nextOutputSeq, data });
    session.nextOutputSeq += 1;
    session.outputChunkBytes += byteLength;
    while (session.outputChunkBytes > this.config.maxScrollbackBytes && session.outputChunks.length > 0) {
      const removed = session.outputChunks.shift();
      if (!removed) break;
      session.outputChunkBytes -= utf8ByteLength(removed.data);
    }
  }
}

import { randomBytes, randomUUID } from "node:crypto";
import { spawn as spawnPty } from "node-pty";
import type { AuditEvent, AuditFields, AuditLogger } from "./audit-log.js";
import { noopAuditLogger } from "./audit-log.js";
import type { RuntimeConfig } from "./config.js";
import type { DeviceMetadataConfig } from "./device-metadata.js";
import { sanitizeSuggestedCommand, validateDevice } from "./device.js";
import { buildSshCommandArgs } from "./ssh-config.js";
import type {
  QuickShellOutputChunk,
  QuickShellPoll,
  QuickShellPollResetReason,
  QuickShellPublicSession,
  SessionId,
} from "../shared/protocol.js";
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_NAME,
  DEFAULT_TERMINAL_ROWS,
} from "../shared/terminal-defaults.js";
import { BoundedTextBuffer } from "../shared/bounded-text-buffer.js";
import { takeLastUtf8Bytes, utf8ByteLength } from "../shared/utf8.js";

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
  closing: boolean;
}

/** Why a PTY write or resize could not be delivered. */
export type SessionDropReason = "missing" | "exited" | "closing";

export type SessionWriteResult =
  { written: true } | { written: false; reason: SessionDropReason };

export type SessionResizeResult =
  { resized: true } | { resized: false; reason: SessionDropReason };

export interface QuickShellDeviceSummary {
  alias: string;
  label?: string;
  group?: string;
  danger?: "normal" | "caution" | "danger";
  defaultShell?: string;
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

const ENV_ALLOWLIST = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "SSH_AUTH_SOCK",
  "TERM",
];
const MAX_OUTPUT_CHUNKS = 256;

interface LifecycleFailure {
  sessionId?: SessionId;
  step: string;
  error: unknown;
}

function defaultPtyFactory(): PtyFactory {
  return (file, args, options) => spawnPty(file, args, options);
}

function token(): string {
  return randomBytes(24).toString("base64url");
}

function buildPtyEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.TERM = env.TERM || DEFAULT_TERMINAL_NAME;
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
  private droppedAuditRecords = 0;
  private lastAuditError: unknown;

  constructor(options: QuickShellSessionManagerOptions) {
    this.config = options.config;
    this.allowedHosts = options.allowedHosts;
    this.deviceMetadata = options.deviceMetadata ?? { devices: new Map() };
    this.audit = options.audit ?? noopAuditLogger;
    this.ptyFactory = options.ptyFactory ?? defaultPtyFactory();
  }

  async createSession(
    input: QuickShellSessionInput,
  ): Promise<QuickShellSession> {
    if (this.sessions.size >= this.config.maxSessions) {
      throw new Error("maximum quick-shell sessions reached");
    }

    const device = validateDevice(
      input.device,
      this.allowedHosts,
      this.config.maxDeviceLength,
    );
    const suggested = sanitizeSuggestedCommand(
      input.suggested,
      this.config.maxSuggestedCommandLength,
    );
    const reason =
      input.reason?.slice(0, this.config.maxReasonLength).trim() || undefined;
    const now = Date.now();
    const id = randomUUID();
    const publicSummary: QuickShellPublicSession = { sessionId: id, device };
    const metadata = this.deviceMetadata.devices.get(device);
    if (reason) publicSummary.reason = reason;
    if (suggested) publicSummary.suggestedCommand = suggested;
    if (metadata?.label) publicSummary.deviceLabel = metadata.label;
    if (metadata?.group) publicSummary.deviceGroup = metadata.group;
    if (metadata?.danger) publicSummary.deviceDanger = metadata.danger;
    if (metadata?.defaultShell)
      publicSummary.deviceDefaultShell = metadata.defaultShell;

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
      closing: false,
    };

    this.sessions.set(id, session);
    this.recordAuditEventSafe("session_opened", {
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
    if (session.closing) return undefined;
    if (session.pty) return session as StartedQuickShellSession;

    const cwd = process.env.HOME;
    let pty: PtyProcess;
    try {
      pty = this.ptyFactory(
        "ssh",
        buildSshCommandArgs(
          this.config.sshConfigPath,
          session.publicSummary.device,
        ),
        {
          name: DEFAULT_TERMINAL_NAME,
          cols: DEFAULT_TERMINAL_COLS,
          rows: DEFAULT_TERMINAL_ROWS,
          cwd,
          env: buildPtyEnv(),
        },
      );
    } catch (error) {
      this.recordAuditEventSafe("ssh_start_failed", {
        sessionId: session.id,
        device: session.publicSummary.device,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    session.pty = pty;
    try {
      session.disposables.push(
        pty.onData((data) => {
          this.recordActivity(session.id);
          session.scrollback.append(data);
          this.appendOutputChunk(session, data);
        }),
      );
      session.disposables.push(
        pty.onExit((event) => {
          session.exited = true;
          session.exitCode = event.exitCode;
          session.lastActivityAt = Date.now();
          this.recordAuditEventSafe("session_exited", {
            sessionId: session.id,
            device: session.publicSummary.device,
            exitCode: event.exitCode,
          });
        }),
      );
    } catch (error) {
      const failures: LifecycleFailure[] = [];
      this.disposeRegisteredListeners(
        session.id,
        session.disposables.splice(0),
        failures,
      );
      const terminated = this.killPty(session, failures);
      session.closing = !terminated;
      if (terminated) session.pty = undefined;
      this.logLifecycleFailures(
        "quick-shell session start cleanup failed",
        failures,
      );
      this.recordAuditEventSafe("ssh_start_failed", {
        sessionId: session.id,
        device: session.publicSummary.device,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    this.recordAuditEventSafe("session_started", {
      sessionId: session.id,
      device: session.publicSummary.device,
    });

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

  authenticateApp(
    sessionId: SessionId,
    appToken: string,
  ): QuickShellSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.appToken !== appToken) return undefined;
    this.recordActivity(sessionId);
    return session;
  }

  authenticateWsCapability(
    sessionId: SessionId,
    wsToken: string,
  ): QuickShellSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.wsToken !== wsToken) return undefined;
    this.recordActivity(sessionId);
    return session;
  }

  recordActivity(sessionId: SessionId): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.lastActivityAt = Date.now();
    return true;
  }

  /**
   * Reports *why* a write was dropped rather than collapsing three distinct
   * states into `false`: the caller surfaces this to the model, which would
   * otherwise treat a write against a dead PTY as delivered.
   */
  private deliverableSession(
    sessionId: SessionId,
  ): { session: QuickShellSession } | { reason: SessionDropReason } {
    const session = this.sessions.get(sessionId);
    if (!session?.pty) return { reason: "missing" };
    if (session.exited) return { reason: "exited" };
    if (session.closing) return { reason: "closing" };
    return { session };
  }

  writeInput(sessionId: SessionId, data: string): SessionWriteResult {
    const target = this.deliverableSession(sessionId);
    if ("reason" in target) return { written: false, reason: target.reason };
    target.session.pty?.write(data);
    this.recordActivity(sessionId);
    return { written: true };
  }

  resizeSession(
    sessionId: SessionId,
    cols: number,
    rows: number,
  ): SessionResizeResult {
    const target = this.deliverableSession(sessionId);
    if ("reason" in target) return { resized: false, reason: target.reason };
    target.session.pty?.resize(cols, rows);
    this.recordActivity(sessionId);
    return { resized: true };
  }

  pollSession(
    sessionId: SessionId,
    afterSeq: number,
  ): QuickShellPoll | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    this.recordActivity(sessionId);
    const firstSeq = session.outputChunks[0]?.seq;
    const lastSeq = session.nextOutputSeq - 1;
    const staleCursor = firstSeq !== undefined && afterSeq < firstSeq - 1;
    const cursorAhead = afterSeq > lastSeq;
    if (staleCursor || cursorAhead) {
      const resetReason: QuickShellPollResetReason = staleCursor
        ? "stale_cursor"
        : "cursor_ahead";
      return this.snapshotPoll(session, sessionId, resetReason, firstSeq);
    }

    const chunks = session.outputChunks.filter((chunk) => chunk.seq > afterSeq);
    const truncatedBytes = chunks.reduce(
      (total, chunk) => total + this.chunkTruncatedBytes(chunk),
      0,
    );
    const reset = truncatedBytes > 0;
    return {
      sessionId,
      chunks,
      nextSeq: lastSeq,
      reset,
      resetReason: reset ? "truncated_output" : undefined,
      droppedBeforeSeq:
        firstSeq === undefined ? undefined : Math.max(0, firstSeq - 1),
      truncatedBytes: reset ? truncatedBytes : undefined,
      exited: session.exited,
      exitCode: session.exitCode,
    };
  }

  closeSession(sessionId: SessionId): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const result = this.closeSessionWithDiagnostics(session);
    this.logLifecycleFailures(
      "quick-shell session cleanup failed",
      result.failures,
    );
    return result.closed;
  }

  cleanupExpiredSessions(now = Date.now()): number {
    let closed = 0;
    const failures: LifecycleFailure[] = [];
    for (const session of [...this.sessions.values()]) {
      const expiredByAge =
        now - session.createdAt >= this.config.maxSessionAgeMs;
      const expiredByIdle =
        now - session.lastActivityAt >= this.config.idleGraceMs;
      if (expiredByAge || expiredByIdle) {
        this.recordAuditEventSafe(
          "session_expired",
          {
            sessionId: session.id,
            device: session.publicSummary.device,
            reason: expiredByAge ? "age" : "idle",
          },
          failures,
        );
        const result = this.closeSessionWithDiagnostics(session);
        failures.push(...result.failures);
        if (result.closed) closed += 1;
      }
    }
    this.logLifecycleFailures(
      "quick-shell expired session cleanup failed",
      failures,
    );
    return closed;
  }

  closeAll(): void {
    const failures: LifecycleFailure[] = [];
    for (const sessionId of [...this.sessions.keys()]) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      failures.push(...this.closeSessionWithDiagnostics(session).failures);
    }
    this.logLifecycleFailures("quick-shell closeAll cleanup failed", failures);
  }

  listSessions(): QuickShellSession[] {
    return [...this.sessions.values()];
  }

  listDevices(): QuickShellDeviceSummary[] {
    return [...this.allowedHosts].sort().map((alias) => {
      const metadata = this.deviceMetadata.devices.get(alias);
      const device: QuickShellDeviceSummary = { alias };
      if (metadata?.label) device.label = metadata.label;
      if (metadata?.group) device.group = metadata.group;
      if (metadata?.danger) device.danger = metadata.danger;
      if (metadata?.defaultShell) device.defaultShell = metadata.defaultShell;
      return device;
    });
  }

  recordOutputConfirmed(sessionId: SessionId, byteCount: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.recordAuditEventSafe("output_confirmed", {
      sessionId,
      device: session.publicSummary.device,
      byteCount,
    });
    this.recordActivity(sessionId);
    return true;
  }

  recordAuditEvent(event: AuditEvent, fields?: AuditFields): void {
    this.recordAuditEventSafe(event, fields);
  }

  private appendOutputChunk(session: QuickShellSession, data: string): void {
    if (data.length === 0) return;

    const originalBytes = utf8ByteLength(data);
    const retained = takeLastUtf8Bytes(data, this.config.maxScrollbackBytes);
    const wasTruncated = retained.bytes < originalBytes;
    const chunk: QuickShellOutputChunk = {
      seq: session.nextOutputSeq,
      data: retained.text,
      truncated: wasTruncated ? true : undefined,
      originalBytes: wasTruncated ? originalBytes : undefined,
      retainedBytes: wasTruncated ? retained.bytes : undefined,
    };

    session.outputChunks.push(chunk);
    session.nextOutputSeq += 1;
    session.outputChunkBytes += retained.bytes;
    while (
      (session.outputChunkBytes > this.config.maxScrollbackBytes ||
        session.outputChunks.length > MAX_OUTPUT_CHUNKS) &&
      session.outputChunks.length > 0
    ) {
      const removed = session.outputChunks.shift();
      if (!removed) break;
      session.outputChunkBytes -= utf8ByteLength(removed.data);
    }
  }

  private snapshotPoll(
    session: QuickShellSession,
    sessionId: SessionId,
    resetReason: QuickShellPollResetReason,
    firstSeq: number | undefined,
  ): QuickShellPoll {
    const snapshot = session.scrollback.toString();
    const snapshotSeq = session.nextOutputSeq - 1;
    return {
      sessionId,
      chunks: [],
      nextSeq: snapshotSeq,
      reset: true,
      resetReason,
      snapshot,
      snapshotBytes: session.scrollback.byteLength,
      snapshotSeq,
      droppedBeforeSeq:
        firstSeq === undefined ? undefined : Math.max(0, firstSeq - 1),
      exited: session.exited,
      exitCode: session.exitCode,
    };
  }

  private closeSessionWithDiagnostics(session: QuickShellSession): {
    closed: boolean;
    failures: LifecycleFailure[];
  } {
    const failures: LifecycleFailure[] = [];
    session.closing = true;
    this.disposeRegisteredListeners(
      session.id,
      session.disposables.splice(0),
      failures,
    );
    if (!this.killPty(session, failures)) {
      return { closed: false, failures };
    }

    this.sessions.delete(session.id);
    this.recordAuditEventSafe(
      "session_closed",
      { sessionId: session.id, device: session.publicSummary.device },
      failures,
    );
    for (const listener of this.closedListeners) {
      try {
        listener(session.id);
      } catch (error) {
        failures.push({ sessionId: session.id, step: "close_listener", error });
      }
    }
    session.pty = undefined;
    return { closed: true, failures };
  }

  private disposeRegisteredListeners(
    sessionId: SessionId,
    disposables: Disposable[],
    failures: LifecycleFailure[],
  ): void {
    for (const disposable of disposables) {
      try {
        disposable.dispose();
      } catch (error) {
        failures.push({ sessionId, step: "dispose_listener", error });
      }
    }
  }

  private killPty(
    session: QuickShellSession,
    failures: LifecycleFailure[],
  ): boolean {
    try {
      session.pty?.kill();
      return true;
    } catch (error) {
      failures.push({ sessionId: session.id, step: "pty_kill", error });
      return false;
    }
  }

  private recordAuditEventSafe(
    event: AuditEvent,
    fields?: AuditFields,
    failures?: LifecycleFailure[],
  ): void {
    try {
      this.audit.record(event, fields);
      this.noteAuditWriteSucceeded();
    } catch (error) {
      this.droppedAuditRecords += 1;
      this.lastAuditError = error;
      const failure = {
        sessionId:
          typeof fields?.sessionId === "string" ? fields.sessionId : undefined,
        step: `audit:${event}`,
        error,
      };
      if (failures) {
        failures.push(failure);
      } else {
        this.logLifecycleFailures("quick-shell audit record failed", [failure]);
      }
    }
  }

  /**
   * A recovered sink still has a gap in it, so the count of records lost while
   * it was down is written into the log itself rather than reset silently.
   */
  private noteAuditWriteSucceeded(): void {
    if (this.droppedAuditRecords === 0) return;
    const droppedRecords = this.droppedAuditRecords;
    this.droppedAuditRecords = 0;
    this.lastAuditError = undefined;
    try {
      this.audit.record("audit_sink_recovered", { droppedRecords });
    } catch (error) {
      this.droppedAuditRecords = droppedRecords;
      this.lastAuditError = error;
    }
  }

  /**
   * Health of the audit sink itself. Sessions keep running when auditing fails,
   * so this is the only signal that the log has gaps.
   */
  auditHealth(): { healthy: boolean; droppedRecords: number; error?: string } {
    return {
      healthy: this.droppedAuditRecords === 0,
      droppedRecords: this.droppedAuditRecords,
      error:
        this.lastAuditError === undefined
          ? undefined
          : this.lastAuditError instanceof Error
            ? this.lastAuditError.message
            : String(this.lastAuditError),
    };
  }

  private logLifecycleFailures(
    message: string,
    failures: LifecycleFailure[],
  ): void {
    if (failures.length === 0) return;
    console.error(
      message,
      new AggregateError(
        failures.map((failure) => failure.error),
        message,
      ),
      failures.map(({ sessionId, step }) => ({ sessionId, step })),
    );
  }

  private chunkTruncatedBytes(chunk: QuickShellOutputChunk): number {
    if (!chunk.truncated) return 0;
    return Math.max(
      0,
      (chunk.originalBytes ?? 0) -
        (chunk.retainedBytes ?? utf8ByteLength(chunk.data)),
    );
  }
}

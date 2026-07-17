import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export type SftpAction =
  | "hello"
  | "root"
  | "list"
  | "lstat"
  | "realpath"
  | "mkdir"
  | "rename"
  | "remove"
  | "upload"
  | "download"
  | "close";

export interface SftpCloseReason {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface TransferResult {
  bytes: number;
}

export interface SftpHelper {
  readonly closed: Promise<SftpCloseReason>;
  request<T>(
    action: SftpAction,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<T>;
  upload(
    source: Readable,
    request: { path: string; bytes: number },
    signal: AbortSignal,
  ): Promise<TransferResult>;
  download(
    target: Writable,
    request: { path: string; maxBytes: number },
    signal: AbortSignal,
  ): Promise<TransferResult>;
  dispose(): void;
  drain(timeoutMs: number): Promise<void>;
}

interface Pending {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  cleanup(): void;
}

export interface SpawnSftpHelperOptions {
  helperPath: string;
  sshConfigPath: string;
  device: string;
  cwd?: string;
  env: Record<string, string>;
  maxPending?: number;
  spawnProcess?: typeof spawn;
}

function protocolError(code: string): Error {
  const error = new Error(code);
  error.name = "SftpProtocolError";
  return error;
}

export function spawnSftpHelper(options: SpawnSftpHelperOptions): SftpHelper {
  const child = (options.spawnProcess ?? spawn)(
    options.helperPath,
    [options.sshConfigPath, options.device],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    },
  );
  return new ChildSftpHelper(child, options.maxPending ?? 8);
}

export class ChildSftpHelper implements SftpHelper {
  private nextId = 1;
  private disposed = false;
  private readonly pending = new Map<number, Pending>();
  readonly closed: Promise<SftpCloseReason>;

  constructor(
    private readonly child: ChildProcess,
    private readonly maxPending = 8,
  ) {
    if (!child.stdin || !child.stdout)
      throw new Error("SFTP helper requires piped control streams");
    this.closed = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        this.disposed = true;
        this.rejectPending(protocolError("helper_closed"));
        resolve({ code, signal });
      });
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.once("error", () =>
      this.rejectPending(protocolError("helper_unavailable")),
    );
  }

  request<T>(
    action: SftpAction,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.disposed || !this.child.stdin?.writable)
      return Promise.reject(protocolError("helper_closed"));
    if (this.pending.size >= this.maxPending)
      return Promise.reject(protocolError("queue_full"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        reject(protocolError("aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      this.child.stdin!.write(
        `${JSON.stringify({ version: 1, id, action, params })}\n`,
        (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          pending.cleanup();
          pending.reject(protocolError("helper_unavailable"));
        },
      );
    });
  }

  async upload(
    source: Readable,
    request: { path: string; bytes: number },
    signal: AbortSignal,
  ): Promise<TransferResult> {
    const stream = this.child.stdio[3];
    if (!stream || !("write" in stream))
      throw protocolError("transfer_unavailable");
    const result = this.request<TransferResult>("upload", request, signal);
    source.pipe(stream as Writable, { end: false });
    const abort = () => source.unpipe(stream as Writable);
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await result;
    } finally {
      signal.removeEventListener("abort", abort);
      source.unpipe(stream as Writable);
    }
  }

  async download(
    target: Writable,
    request: { path: string; maxBytes: number },
    signal: AbortSignal,
  ): Promise<TransferResult> {
    const stream = this.child.stdio[4];
    if (!stream || !("pipe" in stream))
      throw protocolError("transfer_unavailable");
    (stream as Readable).pipe(target, { end: false });
    const abort = () => (stream as Readable).unpipe(target);
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await this.request<TransferResult>("download", request, signal);
    } finally {
      signal.removeEventListener("abort", abort);
      (stream as Readable).unpipe(target);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectPending(protocolError("helper_closed"));
    this.child.kill("SIGTERM");
  }

  async drain(timeoutMs: number): Promise<void> {
    await Promise.race([
      this.closed.then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    if (this.child.exitCode === null && this.child.signalCode === null)
      this.child.kill("SIGKILL");
  }

  private handleLine(line: string): void {
    let value: { version?: number; id?: number; data?: unknown; code?: string };
    try {
      value = JSON.parse(line) as typeof value;
    } catch {
      this.dispose();
      return;
    }
    if (value.version !== 1 || !Number.isSafeInteger(value.id)) {
      this.dispose();
      return;
    }
    const pending = this.pending.get(value.id!);
    if (!pending) return;
    this.pending.delete(value.id!);
    pending.cleanup();
    if (value.code) pending.reject(protocolError(value.code));
    else pending.resolve(value.data);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
}

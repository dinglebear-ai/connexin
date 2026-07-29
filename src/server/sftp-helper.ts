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
  | "download";

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
    request: { path: string; bytes: number; overwrite: boolean },
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
  connectTimeoutSeconds?: number;
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
      env: {
        ...options.env,
        CONNEXIN_SFTP_CONNECT_TIMEOUT_SECONDS: String(
          options.connectTimeoutSeconds ?? 15,
        ),
      },
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    },
  );
  return new ChildSftpHelper(child, options.maxPending ?? 8);
}

export class ChildSftpHelper implements SftpHelper {
  private nextId = 1;
  private disposed = false;
  private transferTail: Promise<void> = Promise.resolve();
  private stderrBytes = 0;
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
    for (const stream of child.stdio) {
      stream?.on?.("error", () => {
        if (!this.disposed)
          this.rejectPending(protocolError("helper_unavailable"));
      });
    }
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.stderrBytes = Math.min(
        64 * 1024,
        this.stderrBytes + Buffer.byteLength(chunk),
      );
    });
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
    request: { path: string; bytes: number; overwrite: boolean },
    signal: AbortSignal,
  ): Promise<TransferResult> {
    return this.exclusiveTransfer(signal, async () => {
      const stream = this.child.stdio[3];
      if (!stream || !("write" in stream))
        throw protocolError("transfer_unavailable");
      const result = this.request<TransferResult>("upload", request, signal);
      source.pipe(stream as Writable, { end: false });
      try {
        return await result;
      } finally {
        source.unpipe(stream as Writable);
      }
    });
  }

  async download(
    target: Writable,
    request: { path: string; maxBytes: number },
    signal: AbortSignal,
  ): Promise<TransferResult> {
    return this.exclusiveTransfer(signal, async () => {
      const stream = this.child.stdio[4];
      if (!stream || !("pipe" in stream))
        throw protocolError("transfer_unavailable");
      const source = stream as Readable;
      // The control-stream result (byte count) and the file bytes on fd 4 travel
      // over separate pipes with no ordering guarantee, so the result can resolve
      // before the tail of the payload has finished flowing into `target`.
      // Unpiping at that point drops the final chunk(s) and the caller sees a
      // short/mismatched download. Count delivered bytes and, once the helper
      // tells us how many to expect, wait for them all before unpiping.
      let received = 0;
      let expected = Number.POSITIVE_INFINITY;
      let settle: ((error?: Error) => void) | undefined;
      const countChunk = (chunk: Buffer) => {
        received += chunk.length;
        if (received >= expected) settle?.();
      };
      // The tail may never arrive: the helper can die, the SSH link can drop,
      // or the caller can abort after the control response has landed. Any of
      // those must reject the download. Waiting only on `data` wedged the
      // session's whole transfer lane forever, because the release in
      // exclusiveTransfer's finally never ran.
      const failTail = (error: Error) => () => settle?.(error);
      const onSourceEnd = failTail(protocolError("transfer_truncated"));
      const onSourceError = failTail(protocolError("transfer_failed"));
      const onAbort = failTail(protocolError("transfer_aborted"));

      source.on("data", countChunk);
      source.pipe(target, { end: false });
      try {
        const result = await this.request<TransferResult>(
          "download",
          request,
          signal,
        );
        expected = result.bytes;
        if (received < expected) {
          await new Promise<void>((resolve, reject) => {
            settle = (error) => {
              settle = undefined;
              if (error) reject(error);
              else resolve();
            };
            source.once("end", onSourceEnd);
            source.once("close", onSourceEnd);
            source.once("error", onSourceError);
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          });
        }
        return result;
      } finally {
        settle = undefined;
        source.off("data", countChunk);
        source.off("end", onSourceEnd);
        source.off("close", onSourceEnd);
        source.off("error", onSourceError);
        signal.removeEventListener("abort", onAbort);
        source.unpipe(target);
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectPending(protocolError("helper_closed"));
    this.kill("SIGTERM");
  }

  async drain(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.closed.then(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (this.child.exitCode === null && this.child.signalCode === null)
      this.kill("SIGKILL");
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

  private async exclusiveTransfer<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.transferTail;
    let release!: () => void;
    this.transferTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      let abortDuringWait: (() => void) | undefined;
      try {
        await Promise.race([
          previous,
          new Promise<never>((_, reject) => {
            abortDuringWait = () => reject(protocolError("aborted"));
            signal.addEventListener("abort", abortDuringWait, { once: true });
          }),
        ]);
      } finally {
        if (abortDuringWait)
          signal.removeEventListener("abort", abortDuringWait);
      }
      if (signal.aborted) {
        this.dispose();
        throw protocolError("aborted");
      }
      const abort = () => this.dispose();
      signal.addEventListener("abort", abort, { once: true });
      try {
        return await operation();
      } finally {
        signal.removeEventListener("abort", abort);
      }
    } finally {
      release();
    }
  }

  private kill(signal: NodeJS.Signals): void {
    try {
      if (this.child.pid) process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch {
      this.child.kill(signal);
    }
  }
}

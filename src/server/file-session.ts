import { createHash, randomBytes } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import { posix } from "node:path";
import type { RuntimeConfig } from "./config.js";
import {
  assertCanonicalWithin,
  confinedRemotePath,
  normalizeRelativePath,
} from "./file-policy.js";
import type { SftpHelper } from "./sftp-helper.js";

export interface RemoteFileEntry {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
  size: number;
  modified: number;
  mode: number;
}
export interface PublicFileEntry extends RemoteFileEntry {
  path: string;
  fingerprint: string;
}
export type FileHelperFactory = () => SftpHelper;

export type PrepareFileOperation =
  | { operation: "mkdir"; path: string }
  | {
      operation: "rename";
      from: string;
      to: string;
      expectedFingerprint: string;
      overwrite: boolean;
      targetFingerprint?: string;
    }
  | {
      operation: "delete";
      path: string;
      expectedFingerprint: string;
      kind: "file" | "directory" | "symlink";
    }
  | {
      operation: "upload";
      path: string;
      bytes: number;
      overwrite: boolean;
      expectedFingerprint?: string;
    }
  | {
      operation: "download";
      path: string;
      expectedFingerprint: string;
      bytes: number;
    };

type Lease =
  | { operation: "mkdir"; path: string; expiresAt: number }
  | {
      operation: "rename";
      from: string;
      to: string;
      sourceFingerprint: string;
      overwrite: boolean;
      targetFingerprint?: string;
      expiresAt: number;
    }
  | {
      operation: "delete";
      path: string;
      fingerprint: string;
      kind: "file" | "directory" | "symlink";
      expiresAt: number;
    }
  | {
      operation: "upload";
      path: string;
      bytes: number;
      overwrite: boolean;
      targetFingerprint?: string;
      expiresAt: number;
    }
  | {
      operation: "download";
      path: string;
      fingerprint: string;
      bytes: number;
      expiresAt: number;
    };

export class FileSession {
  private helper?: SftpHelper;
  private connecting?: Promise<SftpHelper>;
  private root?: string;
  private disposed = false;
  private readonly leases = new Map<string, Lease>();
  private transferTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: RuntimeConfig,
    private readonly factory: FileHelperFactory,
  ) {}

  async list(relativePath: string): Promise<PublicFileEntry[]> {
    return this.readOnly(async (helper) => {
      const { canonical } = await this.resolveContent(helper, relativePath);
      const result = await this.timed(
        helper,
        helper.request<{ entries: RemoteFileEntry[] }>("list", {
          path: canonical,
          limit: this.config.maxFileEntries + 1,
        }),
      );
      if (result.entries.length > this.config.maxFileEntries)
        throw new Error("directory_too_large");
      let metadataBytes = 0;
      const entries = result.entries.map((entry) => {
        assertSafeEntry(entry);
        metadataBytes += Buffer.byteLength(JSON.stringify(entry));
        if (metadataBytes > this.config.maxFileMetadataBytes)
          throw new Error("metadata_too_large");
        return {
          ...entry,
          path:
            relativePath === "." ? entry.name : `${relativePath}/${entry.name}`,
          fingerprint: fingerprint(entry),
        };
      });
      return entries.sort((a, b) =>
        a.kind === b.kind
          ? a.name.localeCompare(b.name)
          : a.kind === "directory"
            ? -1
            : 1,
      );
    });
  }

  async prepare(input: PrepareFileOperation): Promise<string> {
    if (this.leases.size >= this.config.maxFileOperationLeases)
      throw new Error("lease_limit");
    const helper = await this.getHelper();
    let lease: Lease;
    if (input.operation === "mkdir") {
      const target = await this.resolveEntry(helper, input.path, true);
      if (target.entry) throw new Error("already_exists");
      lease = {
        operation: "mkdir",
        path: target.path,
        expiresAt: this.expiry(),
      };
    } else if (input.operation === "rename") {
      const source = await this.resolveEntry(helper, input.from, false);
      requireFingerprint(source.entry!, input.expectedFingerprint);
      const target = await this.resolveEntry(helper, input.to, true);
      if (target.entry?.kind === "symlink")
        throw new Error("symlink_overwrite_denied");
      if (target.entry && !input.overwrite) throw new Error("already_exists");
      if (target.entry && input.targetFingerprint !== fingerprint(target.entry))
        throw new Error("file_changed");
      lease = {
        operation: "rename",
        from: source.path,
        to: target.path,
        sourceFingerprint: input.expectedFingerprint,
        overwrite: input.overwrite,
        targetFingerprint: target.entry ? fingerprint(target.entry) : undefined,
        expiresAt: this.expiry(),
      };
    } else if (input.operation === "delete") {
      const target = await this.resolveEntry(helper, input.path, false);
      requireFingerprint(target.entry!, input.expectedFingerprint);
      if (target.entry!.kind !== input.kind) throw new Error("file_changed");
      lease = {
        operation: "delete",
        path: target.path,
        fingerprint: input.expectedFingerprint,
        kind: input.kind,
        expiresAt: this.expiry(),
      };
    } else if (input.operation === "upload") {
      if (
        !Number.isSafeInteger(input.bytes) ||
        input.bytes < 0 ||
        input.bytes > this.config.maxTransferBytes
      )
        throw new Error("too_large");
      const target = await this.resolveEntry(helper, input.path, true);
      if (
        target.entry?.kind === "symlink" ||
        target.entry?.kind === "directory"
      )
        throw new Error("unsafe_target");
      if (target.entry && !input.overwrite) throw new Error("already_exists");
      if (
        target.entry &&
        input.expectedFingerprint !== fingerprint(target.entry)
      )
        throw new Error("file_changed");
      lease = {
        operation: "upload",
        path: target.path,
        bytes: input.bytes,
        overwrite: input.overwrite,
        targetFingerprint: target.entry ? fingerprint(target.entry) : undefined,
        expiresAt: this.expiry(),
      };
    } else {
      const target = await this.resolveContent(helper, input.path);
      if (target.entry.kind !== "file") throw new Error("not_regular_file");
      requireFingerprint(target.entry, input.expectedFingerprint);
      if (
        target.entry.size !== input.bytes ||
        input.bytes > this.config.maxEmbeddedDownloadBytes
      )
        throw new Error("too_large");
      lease = {
        operation: "download",
        path: target.canonical,
        fingerprint: input.expectedFingerprint,
        bytes: input.bytes,
        expiresAt: this.expiry(),
      };
    }
    const token = randomBytes(24).toString("base64url");
    this.leases.set(token, lease);
    return token;
  }

  async mutate(
    leaseToken: string,
    expected: "mkdir" | "rename" | "delete",
  ): Promise<void> {
    const lease = this.consumeLease(leaseToken, expected);
    const helper = await this.getHelper();
    try {
      if (lease.operation === "mkdir") {
        const current = await this.resolveEntryByCanonical(
          helper,
          lease.path,
          true,
        );
        if (current) throw new Error("file_changed");
        await this.timed(
          helper,
          helper.request("mkdir", { path: lease.path }),
          true,
        );
      } else if (lease.operation === "rename") {
        const source = await this.lstat(helper, lease.from);
        requireFingerprint(source, lease.sourceFingerprint);
        const target = await this.optionalLstat(helper, lease.to);
        if (
          target?.kind === "symlink" ||
          (target && fingerprint(target) !== lease.targetFingerprint)
        )
          throw new Error("file_changed");
        await this.timed(
          helper,
          helper.request("rename", {
            from: lease.from,
            to: lease.to,
            overwrite: lease.overwrite,
          }),
          true,
        );
      } else {
        const current = await this.lstat(helper, lease.path);
        requireFingerprint(current, lease.fingerprint);
        if (current.kind !== lease.kind) throw new Error("file_changed");
        await this.timed(
          helper,
          helper.request("remove", {
            path: lease.path,
            directory: lease.kind === "directory",
          }),
          true,
        );
      }
    } catch (error) {
      if (isHelperLoss(error)) throw new Error("outcome_unknown");
      throw error;
    }
  }

  async upload(
    leaseToken: string,
    source: Readable,
    bytes: number,
    signal: AbortSignal,
  ): Promise<number> {
    const lease = this.consumeLease(leaseToken, "upload");
    if (lease.operation !== "upload" || bytes !== lease.bytes)
      throw new Error("invalid_lease");
    return this.withTransfer(signal, async (helper, combined) => {
      const current = await this.optionalLstat(helper, lease.path);
      if (
        current?.kind === "symlink" ||
        (current ? fingerprint(current) : undefined) !== lease.targetFingerprint
      )
        throw new Error("file_changed");
      try {
        const result = await helper.upload(
          source,
          { path: lease.path, bytes, overwrite: lease.overwrite },
          combined,
        );
        if (result.bytes !== bytes) throw new Error("transfer_size_mismatch");
        return result.bytes;
      } catch (error) {
        if (combined.aborted || isHelperLoss(error))
          throw new Error("outcome_unknown");
        throw error;
      }
    });
  }

  async downloadBuffer(
    leaseToken: string,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const lease = this.consumeLease(leaseToken, "download");
    if (lease.operation !== "download") throw new Error("invalid_lease");
    return this.withTransfer(signal, async (helper, combined) => {
      const current = await this.lstat(helper, lease.path);
      requireFingerprint(current, lease.fingerprint);
      if (
        current.kind !== "file" ||
        current.size !== lease.bytes ||
        current.size > this.config.maxEmbeddedDownloadBytes
      )
        throw new Error("file_changed");
      const sink = new PassThrough();
      const chunks: Buffer[] = [];
      let actual = 0;
      sink.on("data", (chunk: Buffer) => {
        actual += chunk.length;
        if (actual > lease.bytes) combined.throwIfAborted();
        chunks.push(Buffer.from(chunk));
      });
      const result = await helper.download(
        sink,
        { path: lease.path, maxBytes: lease.bytes },
        combined,
      );
      if (result.bytes !== lease.bytes || actual !== lease.bytes)
        throw new Error("transfer_size_mismatch");
      return Buffer.concat(chunks, actual);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.leases.clear();
    this.helper?.dispose();
    void this.connecting?.then(
      (helper) => helper.dispose(),
      () => undefined,
    );
  }

  async drain(timeoutMs: number): Promise<void> {
    const helpers = [
      this.helper,
      await this.connecting?.catch(() => undefined),
    ].filter((value): value is SftpHelper => Boolean(value));
    await Promise.all(
      [...new Set(helpers)].map((helper) => helper.drain(timeoutMs)),
    );
  }

  private async readOnly<T>(
    operation: (helper: SftpHelper) => Promise<T>,
  ): Promise<T> {
    let helper = await this.getHelper();
    try {
      return await operation(helper);
    } catch (error) {
      if (!isHelperLoss(error) || this.disposed) throw error;
      this.poison(helper);
      helper = await this.getHelper();
      return operation(helper);
    }
  }

  private async getHelper(): Promise<SftpHelper> {
    if (this.disposed) throw new Error("session_closed");
    if (this.helper) return this.helper;
    if (this.connecting) return this.connecting;
    let connecting!: Promise<SftpHelper>;
    connecting = (async () => {
      const helper = this.factory();
      try {
        await this.timed(helper, helper.request("hello", {}));
        const root = await this.timed(
          helper,
          helper.request<{ path: string }>("root", {}),
        );
        if (this.disposed) {
          helper.dispose();
          throw new Error("session_closed");
        }
        this.root = root.path;
        this.helper = helper;
        void helper.closed.then(() => {
          if (this.helper === helper) this.helper = undefined;
        });
        return helper;
      } catch (error) {
        helper.dispose();
        throw error;
      } finally {
        if (this.connecting === connecting) this.connecting = undefined;
      }
    })();
    this.connecting = connecting;
    return connecting;
  }

  private async resolveContent(
    helper: SftpHelper,
    relative: string,
  ): Promise<{ canonical: string; entry: RemoteFileEntry }> {
    const candidate = confinedRemotePath(this.root!, relative, this.config);
    const canonical = await this.timed(
      helper,
      helper.request<{ path: string }>("realpath", { path: candidate }),
    );
    assertCanonicalWithin(this.root!, canonical.path);
    return {
      canonical: canonical.path,
      entry: await this.lstat(helper, canonical.path),
    };
  }

  private async resolveEntry(
    helper: SftpHelper,
    relative: string,
    allowMissing: boolean,
  ): Promise<{ path: string; entry?: RemoteFileEntry }> {
    const normalized = normalizeRelativePath(relative, this.config);
    if (normalized === ".") throw new Error("root_mutation_denied");
    const base = posix.basename(normalized);
    const parentRelative = posix.dirname(normalized);
    const candidateParent = confinedRemotePath(
      this.root!,
      parentRelative,
      this.config,
    );
    const parent = await this.timed(
      helper,
      helper.request<{ path: string }>("realpath", { path: candidateParent }),
    );
    assertCanonicalWithin(this.root!, parent.path);
    const target = posix.join(parent.path, base);
    const entry = await this.optionalLstat(helper, target);
    if (!entry && !allowMissing) throw new Error("not_found");
    return { path: target, entry };
  }

  private async resolveEntryByCanonical(
    helper: SftpHelper,
    path: string,
    allowMissing: boolean,
  ): Promise<RemoteFileEntry | undefined> {
    assertCanonicalWithin(this.root!, posix.dirname(path));
    const entry = await this.optionalLstat(helper, path);
    if (!entry && !allowMissing) throw new Error("not_found");
    return entry;
  }

  private async lstat(
    helper: SftpHelper,
    path: string,
  ): Promise<RemoteFileEntry> {
    const entry = await this.timed(
      helper,
      helper.request<RemoteFileEntry>("lstat", { path }),
    );
    assertSafeEntry(entry);
    return entry;
  }
  private async optionalLstat(
    helper: SftpHelper,
    path: string,
  ): Promise<RemoteFileEntry | undefined> {
    try {
      return await this.lstat(helper, path);
    } catch (error) {
      if (error instanceof Error && error.message === "not_found")
        return undefined;
      throw error;
    }
  }

  private consumeLease<T extends Lease["operation"]>(
    token: string,
    operation: T,
  ): Extract<Lease, { operation: T }> {
    const lease = this.leases.get(token);
    this.leases.delete(token);
    if (!lease || lease.operation !== operation || lease.expiresAt < Date.now())
      throw new Error("invalid_lease");
    return lease as Extract<Lease, { operation: T }>;
  }

  private async withTransfer<T>(
    signal: AbortSignal,
    operation: (helper: SftpHelper, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const previous = this.transferTail;
    let release!: () => void;
    this.transferTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    let abortDuringWait: (() => void) | undefined;
    try {
      await Promise.race([
        previous,
        new Promise<never>((_, reject) => {
          abortDuringWait = () => reject(new Error("aborted"));
          signal.addEventListener("abort", abortDuringWait, { once: true });
        }),
      ]);
    } finally {
      if (abortDuringWait) signal.removeEventListener("abort", abortDuringWait);
    }
    if (signal.aborted) {
      release();
      throw new Error("aborted");
    }
    let helper: SftpHelper | undefined;
    let combined: AbortSignal | undefined;
    try {
      helper = await this.getHelper();
      const timeout = AbortSignal.timeout(
        this.config.fileTransferMaxDurationMs,
      );
      combined = AbortSignal.any([signal, timeout]);
      return await operation(helper, combined);
    } finally {
      release();
      if (helper && combined?.aborted) {
        this.poison(helper);
        await helper.drain(this.config.fileShutdownTimeoutMs);
      }
    }
  }

  private async timed<T>(
    helper: SftpHelper,
    promise: Promise<T>,
    mutation = false,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(mutation ? "outcome_unknown" : "timeout")),
            this.config.fileMetadataTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "timeout" || error.message === "outcome_unknown")
      )
        this.poison(helper);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private poison(helper: SftpHelper): void {
    if (this.helper === helper) this.helper = undefined;
    helper.dispose();
  }
  private expiry(): number {
    return Date.now() + this.config.fileOperationLeaseTtlMs;
  }
}

function assertSafeEntry(entry: RemoteFileEntry): void {
  if (
    !entry ||
    !["file", "directory", "symlink", "other"].includes(entry.kind) ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    !Number.isSafeInteger(entry.modified) ||
    !Number.isSafeInteger(entry.mode)
  )
    throw new Error("invalid_metadata");
}
function fingerprint(entry: RemoteFileEntry): string {
  assertSafeEntry(entry);
  return createHash("sha256")
    .update(`${entry.kind}\0${entry.size}\0${entry.modified}\0${entry.mode}`)
    .digest("base64url");
}
function requireFingerprint(entry: RemoteFileEntry, expected: string): void {
  if (fingerprint(entry) !== expected) throw new Error("file_changed");
}
function isHelperLoss(error: unknown): boolean {
  return (
    error instanceof Error &&
    ["helper_closed", "helper_unavailable", "aborted", "timeout"].includes(
      error.message,
    )
  );
}

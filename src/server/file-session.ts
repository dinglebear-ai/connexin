import { createHash, randomBytes } from "node:crypto";
import type { RuntimeConfig } from "./config.js";
import { assertCanonicalWithin, confinedRemotePath } from "./file-policy.js";
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
interface Lease {
  operation: string;
  paths: string[];
  expiresAt: number;
  overwrite: boolean;
}

export class FileSession {
  private helper?: SftpHelper;
  private connecting?: Promise<SftpHelper>;
  private root?: string;
  private disposed = false;
  private readonly leases = new Map<string, Lease>();

  constructor(
    private readonly config: RuntimeConfig,
    private readonly factory: FileHelperFactory,
  ) {}

  async list(relativePath: string): Promise<PublicFileEntry[]> {
    const helper = await this.getHelper();
    const root = this.root!;
    const remote = confinedRemotePath(root, relativePath, this.config);
    const canonical = await helper.request<{ path: string }>("realpath", {
      path: remote,
    });
    assertCanonicalWithin(root, canonical.path);
    const result = await helper.request<{ entries: RemoteFileEntry[] }>(
      "list",
      { path: canonical.path, limit: this.config.maxFileEntries + 1 },
    );
    if (result.entries.length > this.config.maxFileEntries)
      throw new Error("directory_too_large");
    return result.entries
      .map((entry) => ({
        ...entry,
        path:
          relativePath === "." ? entry.name : `${relativePath}/${entry.name}`,
        fingerprint: fingerprint(entry),
      }))
      .sort((a, b) =>
        a.kind === b.kind
          ? a.name.localeCompare(b.name)
          : a.kind === "directory"
            ? -1
            : 1,
      );
  }

  prepare(operation: string, paths: string[], overwrite = false): string {
    if (this.disposed) throw new Error("session_closed");
    if (this.leases.size >= 16) throw new Error("lease_limit");
    const normalized = paths.map((path) =>
      confinedRemotePath(this.root ?? ".", path, this.config),
    );
    const token = randomBytes(24).toString("base64url");
    this.leases.set(token, {
      operation,
      paths: normalized,
      overwrite,
      expiresAt: Date.now() + this.config.fileOperationLeaseTtlMs,
    });
    return token;
  }

  async mutate(leaseToken: string): Promise<void> {
    const lease = this.leases.get(leaseToken);
    this.leases.delete(leaseToken);
    if (!lease || lease.expiresAt < Date.now())
      throw new Error("invalid_lease");
    const helper = await this.getHelper();
    if (lease.operation === "mkdir")
      await helper.request("mkdir", { path: lease.paths[0] });
    else if (lease.operation === "rename")
      await helper.request("rename", {
        from: lease.paths[0],
        to: lease.paths[1],
        overwrite: lease.overwrite,
      });
    else if (lease.operation === "delete")
      await helper.request("remove", {
        path: lease.paths[0],
        directory: false,
      });
    else throw new Error("invalid_lease");
  }

  dispose(): void {
    this.disposed = true;
    this.leases.clear();
    this.helper?.dispose();
    this.helper = undefined;
  }
  async drain(timeoutMs: number): Promise<void> {
    await this.helper?.drain(timeoutMs);
  }

  private async getHelper(): Promise<SftpHelper> {
    if (this.disposed) throw new Error("session_closed");
    if (this.helper) return this.helper;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const helper = this.factory();
      try {
        await helper.request("hello", {});
        const root = await helper.request<{ path: string }>("root", {});
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
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }
}

function fingerprint(entry: RemoteFileEntry): string {
  return createHash("sha256")
    .update(`${entry.kind}\0${entry.size}\0${entry.modified}\0${entry.mode}`)
    .digest("base64url");
}

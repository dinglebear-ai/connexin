import type { ConnexinHiddenMeta } from "../shared/protocol.js";

export interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  size: number;
  modified: number;
  mode: number;
  fingerprint: string;
}
interface ToolClient {
  callServerTool(call: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    _meta?: Record<string, unknown>;
  }>;
}

export class FileApi {
  constructor(
    private readonly client: ToolClient,
    private readonly capability: ConnexinHiddenMeta["connexin"],
    private readonly fileBaseUrl: string,
    private readonly fileToken: string,
  ) {}

  async list(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ entries: FileEntry[]; maxEmbeddedDownloadBytes: number }> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const result = await this.client.callServerTool({
      name: "list_connexin_files",
      arguments: { ...this.capability, path },
    });
    if (result.isError)
      throw new Error(result.content?.[0]?.text ?? "Unable to list files");
    const meta = result._meta?.connexinFiles as
      { entries?: FileEntry[]; maxEmbeddedDownloadBytes?: number } | undefined;
    if (!meta || !Array.isArray(meta.entries))
      throw new Error("Invalid file listing");
    return {
      entries: meta.entries,
      maxEmbeddedDownloadBytes: meta.maxEmbeddedDownloadBytes ?? 0,
    };
  }

  async mutate(
    operation: "mkdir" | "rename" | "delete",
    request: Record<string, unknown>,
  ): Promise<void> {
    const prepared = await this.client.callServerTool({
      name: "prepare_connexin_file_operation",
      arguments: { ...this.capability, operation, ...request },
    });
    const lease = (
      prepared._meta?.connexinFiles as { lease?: string } | undefined
    )?.lease;
    if (prepared.isError || !lease)
      throw new Error("Unable to prepare file operation");
    const names = {
      mkdir: "mkdir_connexin_path",
      rename: "rename_connexin_path",
      delete: "delete_connexin_path",
    } as const;
    const result = await this.client.callServerTool({
      name: names[operation],
      arguments: { ...this.capability, lease },
    });
    if (result.isError)
      throw new Error(result.content?.[0]?.text ?? "File operation failed");
  }

  async upload(
    path: string,
    file: File,
    signal: AbortSignal,
    target?: FileEntry,
  ): Promise<void> {
    const lease = await this.prepare({
      operation: "upload",
      path,
      bytes: file.size,
      overwrite: Boolean(target),
      expectedFingerprint: target?.fingerprint,
    });
    const response = await fetch(new URL("/files/upload", this.fileBaseUrl), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.fileToken}`,
        "X-Connexin-File-Lease": lease,
        "Content-Type": file.type || "application/octet-stream",
      },
      body: file,
      signal,
    });
    if (!response.ok) throw new Error("Upload failed");
  }

  async download(entry: FileEntry, signal: AbortSignal): Promise<ArrayBuffer> {
    const lease = await this.prepare({
      operation: "download",
      path: entry.path,
      expectedFingerprint: entry.fingerprint,
      bytes: entry.size,
    });
    const response = await fetch(new URL("/files/download", this.fileBaseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.fileToken}`,
        "X-Connexin-File-Lease": lease,
      },
      signal,
    });
    if (!response.ok) throw new Error("Download failed");
    const declared = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(declared) || declared !== entry.size)
      throw new Error("Download size changed");
    const body = await response.arrayBuffer();
    if (body.byteLength !== entry.size) throw new Error("Download truncated");
    return body;
  }

  private async prepare(request: Record<string, unknown>): Promise<string> {
    const result = await this.client.callServerTool({
      name: "prepare_connexin_file_operation",
      arguments: { ...this.capability, ...request },
    });
    const lease = (
      result._meta?.connexinFiles as { lease?: string } | undefined
    )?.lease;
    if (result.isError || !lease) throw new Error("Unable to prepare transfer");
    return lease;
  }
}

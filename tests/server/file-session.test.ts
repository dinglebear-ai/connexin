import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  FileSession,
  type RemoteFileEntry,
} from "../../src/server/file-session.js";
import { testRuntimeConfig } from "./helpers/runtime-config.js";

const file = (name: string, size = 1): RemoteFileEntry => ({
  name,
  kind: "file",
  size,
  modified: 1,
  mode: 0o644,
});
const directory = (name: string): RemoteFileEntry => ({
  name,
  kind: "directory",
  size: 0,
  modified: 1,
  mode: 0o755,
});
const symlink = (name: string): RemoteFileEntry => ({
  name,
  kind: "symlink",
  size: 7,
  modified: 1,
  mode: 0o120777,
});

function helper(
  options: {
    realpaths?: Record<string, string>;
    entries?: Record<string, RemoteFileEntry>;
    listing?: RemoteFileEntry[];
  } = {},
) {
  const entries = new Map(
    Object.entries({
      "/home/me": directory("me"),
      ...(options.entries ?? { "/home/me/a.txt": file("a.txt") }),
    }),
  );
  const request = vi.fn(async (action: string, params: any) => {
    if (action === "hello") return { protocol: 1 };
    if (action === "root") return { path: "/home/me" };
    if (action === "realpath")
      return { path: options.realpaths?.[params.path] ?? params.path };
    if (action === "list")
      return { entries: options.listing ?? [...entries.values()] };
    if (action === "lstat") {
      const value = entries.get(params.path);
      if (!value) throw new Error("not_found");
      return value;
    }
    if (action === "mkdir") {
      entries.set(params.path, directory(params.path.split("/").at(-1)!));
      return { ok: true };
    }
    if (action === "remove") {
      entries.delete(params.path);
      return { ok: true };
    }
    if (action === "rename") {
      const value = entries.get(params.from)!;
      entries.delete(params.from);
      entries.set(params.to, { ...value, name: params.to.split("/").at(-1)! });
      return { ok: true };
    }
    throw new Error("unsupported_action");
  });
  return {
    closed: new Promise(() => {}),
    request,
    upload: vi.fn(async (_source, req) => ({ bytes: req.bytes })),
    download: vi.fn(async (target, req) => {
      target.write(Buffer.alloc(req.maxBytes, 1));
      return { bytes: req.maxBytes };
    }),
    dispose: vi.fn(),
    drain: vi.fn(),
    entries,
  } as any;
}

async function listed(session: FileSession, name: string) {
  return (await session.list(".")).find((entry) => entry.name === name)!;
}

describe("FileSession", () => {
  it("starts one helper lazily", async () => {
    const value = helper();
    const factory = vi.fn(() => value);
    const session = new FileSession(testRuntimeConfig(), factory);
    expect(factory).not.toHaveBeenCalled();
    await session.list(".");
    expect(factory).toHaveBeenCalledOnce();
  });

  it.each(["mkdir", "rename", "delete", "upload", "download"] as const)(
    "rejects %s through a symlink ancestor escaping home",
    async (operation) => {
      const value = helper({
        realpaths: {
          "/home/me/link": "/outside",
          "/home/me/link/file": "/outside/file",
        },
        entries: { "/outside/file": file("file") },
      });
      const session = new FileSession(testRuntimeConfig(), () => value);
      const fp =
        (await session.list(".").catch(() => []))[0]?.fingerprint ??
        "x".repeat(43);
      const request =
        operation === "mkdir"
          ? { operation, path: "link/new" }
          : operation === "rename"
            ? {
                operation,
                from: "link/file",
                to: "safe",
                expectedFingerprint: fp,
                overwrite: false,
              }
            : operation === "delete"
              ? {
                  operation,
                  path: "link/file",
                  expectedFingerprint: fp,
                  kind: "file" as const,
                }
              : operation === "upload"
                ? { operation, path: "link/file", bytes: 1, overwrite: false }
                : {
                    operation,
                    path: "link/file",
                    bytes: 1,
                    expectedFingerprint: fp,
                  };
      await expect(session.prepare(request as any)).rejects.toThrow(
        "path_outside_root",
      );
    },
  );

  it("renames and deletes an in-root symlink object without following its leaf", async () => {
    const value = helper({
      entries: { "/home/me/link": symlink("link") },
    });
    const session = new FileSession(testRuntimeConfig(), () => value);
    const entry = await listed(session, "link");
    const rename = await session.prepare({
      operation: "rename",
      from: "link",
      to: "renamed",
      expectedFingerprint: entry.fingerprint,
      overwrite: false,
    });
    await session.mutate(rename, "rename");
    const renamed = await listed(session, "renamed");
    const remove = await session.prepare({
      operation: "delete",
      path: "renamed",
      expectedFingerprint: renamed.fingerprint,
      kind: "symlink",
    });
    await session.mutate(remove, "delete");
    expect(value.request).toHaveBeenCalledWith("remove", {
      path: "/home/me/renamed",
      directory: false,
    });
  });

  it("binds leases to tool, fingerprint, kind, size, expiry, and one use", async () => {
    const value = helper();
    const session = new FileSession(
      testRuntimeConfig({ fileOperationLeaseTtlMs: 5 }),
      () => value,
    );
    const entry = await listed(session, "a.txt");
    const lease = await session.prepare({
      operation: "delete",
      path: entry.path,
      expectedFingerprint: entry.fingerprint,
      kind: "file",
    });
    await expect(session.mutate(lease, "rename")).rejects.toThrow(
      "invalid_lease",
    );
    await expect(session.mutate(lease, "delete")).rejects.toThrow(
      "invalid_lease",
    );
    const upload = await session.prepare({
      operation: "upload",
      path: "new",
      bytes: 2,
      overwrite: false,
    });
    await expect(
      session.upload(
        upload,
        Readable.from("x"),
        1,
        new AbortController().signal,
      ),
    ).rejects.toThrow("invalid_lease");
    const expired = await session.prepare({
      operation: "mkdir",
      path: "later",
    });
    await new Promise((r) => setTimeout(r, 10));
    await expect(session.mutate(expired, "mkdir")).rejects.toThrow(
      "invalid_lease",
    );
  });

  it("revalidates fingerprints immediately before mutation", async () => {
    const value = helper();
    const session = new FileSession(testRuntimeConfig(), () => value);
    const entry = await listed(session, "a.txt");
    const lease = await session.prepare({
      operation: "delete",
      path: entry.path,
      expectedFingerprint: entry.fingerprint,
      kind: "file",
    });
    value.entries.set("/home/me/a.txt", file("a.txt", 2));
    await expect(session.mutate(lease, "delete")).rejects.toThrow(
      "file_changed",
    );
  });

  it("deletes empty directories with RemoveDirectory semantics", async () => {
    const value = helper({
      entries: { "/home/me/empty": directory("empty") },
      listing: [directory("empty")],
    });
    const session = new FileSession(testRuntimeConfig(), () => value);
    const entry = await listed(session, "empty");
    const lease = await session.prepare({
      operation: "delete",
      path: "empty",
      expectedFingerprint: entry.fingerprint,
      kind: "directory",
    });
    await session.mutate(lease, "delete");
    expect(value.request).toHaveBeenCalledWith("remove", {
      path: "/home/me/empty",
      directory: true,
    });
  });

  it("validates a bounded download fully before returning bytes", async () => {
    const value = helper();
    const session = new FileSession(testRuntimeConfig(), () => value);
    const entry = await listed(session, "a.txt");
    const lease = await session.prepare({
      operation: "download",
      path: entry.path,
      expectedFingerprint: entry.fingerprint,
      bytes: entry.size,
    });
    await expect(
      session.downloadBuffer(lease, new AbortController().signal),
    ).resolves.toEqual(Buffer.from([1]));
  });

  it("releases the transfer queue when helper startup fails", async () => {
    let closeInitial!: () => void;
    const initial = helper({
      entries: { "/home/me/one": file("one"), "/home/me/two": file("two") },
    });
    initial.closed = new Promise<void>((resolve) => {
      closeInitial = resolve;
    });
    const failing = {
      ...helper(),
      request: vi.fn(async () => {
        throw new Error("helper_unavailable");
      }),
    };
    const replacement = helper({
      entries: { "/home/me/one": file("one"), "/home/me/two": file("two") },
    });
    const factory = vi
      .fn()
      .mockReturnValueOnce(initial)
      .mockReturnValueOnce(failing)
      .mockReturnValueOnce(replacement);
    const session = new FileSession(testRuntimeConfig(), factory);
    const first = await session.prepare({
      operation: "upload",
      path: "one",
      bytes: 1,
      overwrite: true,
      expectedFingerprint: (await listed(session, "one")).fingerprint,
    });
    const second = await session.prepare({
      operation: "upload",
      path: "two",
      bytes: 1,
      overwrite: true,
      expectedFingerprint: (await listed(session, "two")).fingerprint,
    });
    closeInitial();
    await Promise.resolve();

    await expect(
      session.upload(
        first,
        Readable.from("x"),
        1,
        new AbortController().signal,
      ),
    ).rejects.toThrow("helper_unavailable");
    await expect(
      Promise.race([
        session.upload(
          second,
          Readable.from("y"),
          1,
          new AbortController().signal,
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("transfer_queue_stuck")), 100),
        ),
      ]),
    ).resolves.toBe(1);
  });
  it("recycles the helper after a failed transfer so stale pipe bytes cannot leak", async () => {
    // Bulk payloads ride dedicated fds that are never resynchronized. A
    // rejected upload leaves its bytes queued; if the same helper is reused,
    // the next upload reads them as its own head and every length check still
    // passes, so the wrong content is written and audited as success.
    const rejecting = {
      ...helper(),
      upload: vi.fn(async () => {
        throw new Error("already_exists");
      }),
    };
    const replacement = helper();
    const factory = vi
      .fn()
      .mockReturnValueOnce(rejecting)
      .mockReturnValueOnce(replacement);
    const session = new FileSession(testRuntimeConfig(), factory);

    const lease = await session.prepare({
      operation: "upload",
      path: "b.txt",
      bytes: 4,
      overwrite: false,
    });
    await expect(
      session.upload(
        lease,
        Readable.from(Buffer.from("data")),
        4,
        new AbortController().signal,
      ),
    ).rejects.toThrow();

    // The poisoned helper must be disposed, not handed to the next transfer.
    expect(rejecting.dispose).toHaveBeenCalled();

    const nextLease = await session.prepare({
      operation: "upload",
      path: "c.txt",
      bytes: 4,
      overwrite: false,
    });
    await session.upload(
      nextLease,
      Readable.from(Buffer.from("safe")),
      4,
      new AbortController().signal,
    );
    expect(factory).toHaveBeenCalledTimes(2);
    expect(replacement.upload).toHaveBeenCalled();
  });

  it("keeps the helper when a transfer succeeds", async () => {
    const value = helper();
    const factory = vi.fn().mockReturnValue(value);
    const session = new FileSession(testRuntimeConfig(), factory);
    const entry = await listed(session, "a.txt");
    const lease = await session.prepare({
      operation: "download",
      path: entry.path,
      expectedFingerprint: entry.fingerprint,
      bytes: entry.size,
    });
    await session.downloadBuffer(lease, new AbortController().signal);

    expect(value.dispose).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("rejects an over-delivering download instead of buffering past the lease", async () => {
    // The old guard called combined.throwIfAborted(), which only throws when
    // the signal is ALREADY aborted -- so it never capped anything.
    const value = {
      ...helper(),
      download: vi.fn(async (target: any, req: any) => {
        target.write(Buffer.alloc(req.maxBytes + 64, 1));
        return { bytes: req.maxBytes };
      }),
    };
    const session = new FileSession(testRuntimeConfig(), () => value);
    const entry = await listed(session, "a.txt");
    const lease = await session.prepare({
      operation: "download",
      path: entry.path,
      expectedFingerprint: entry.fingerprint,
      bytes: entry.size,
    });

    await expect(
      session.downloadBuffer(lease, new AbortController().signal),
    ).rejects.toThrow();
  });
});

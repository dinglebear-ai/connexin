import { describe, expect, it, vi } from "vitest";
import { FileSession } from "../../src/server/file-session.js";
import { testRuntimeConfig } from "./helpers/runtime-config.js";
function helper() {
  return {
    closed: new Promise(() => {}),
    request: vi.fn(async (action: string) =>
      action === "root" || action === "realpath"
        ? { path: "/home/me" }
        : action === "list"
          ? {
              entries: [
                {
                  name: "a.txt",
                  kind: "file",
                  size: 1,
                  modified: 1,
                  mode: 0o644,
                },
              ],
            }
          : { protocol: 1 },
    ),
    upload: vi.fn(),
    download: vi.fn(),
    dispose: vi.fn(),
    drain: vi.fn(),
  } as any;
}
describe("FileSession", () => {
  it("starts one helper lazily and sorts a listing", async () => {
    const value = helper();
    const factory = vi.fn(() => value);
    const session = new FileSession(testRuntimeConfig(), factory);
    expect(factory).not.toHaveBeenCalled();
    await expect(session.list(".")).resolves.toMatchObject([
      { name: "a.txt", path: "a.txt" },
    ]);
    expect(factory).toHaveBeenCalledOnce();
  });
  it("consumes operation leases", async () => {
    const value = helper();
    const session = new FileSession(testRuntimeConfig(), () => value);
    await session.list(".");
    const lease = session.prepare("mkdir", ["new"]);
    await session.mutate(lease);
    await expect(session.mutate(lease)).rejects.toThrow("invalid_lease");
  });
});

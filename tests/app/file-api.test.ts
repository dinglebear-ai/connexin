// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileApi, type FileEntry } from "../../src/app/file-api.js";

const entry: FileEntry = {
  name: "a.bin",
  path: "a.bin",
  kind: "file",
  size: 4,
  modified: 1,
  mode: 0o600,
  fingerprint: "f".repeat(43),
};
function client() {
  return {
    callServerTool: vi.fn(async () => ({
      _meta: { quickShellFiles: { lease: "l".repeat(24) } },
    })),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("FileApi transfers", () => {
  it("binds download preparation to fingerprint and size", async () => {
    const tools = client();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array(4), {
            status: 200,
            headers: { "content-length": "4" },
          }),
      ),
    );
    const api = new FileApi(
      tools,
      { sessionId: "s", appToken: "a" },
      "http://127.0.0.1",
      "token",
    );
    expect(
      (await api.download(entry, new AbortController().signal)).byteLength,
    ).toBe(4);
    expect(tools.callServerTool).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: expect.objectContaining({
          operation: "download",
          path: "a.bin",
          expectedFingerprint: entry.fingerprint,
          bytes: 4,
        }),
      }),
    );
  });

  it.each([
    ["3", 4],
    ["4", 3],
  ] as const)(
    "rejects declared or actual truncation before returning to host",
    async (contentLength, actual) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(new Uint8Array(actual), {
              status: 200,
              headers: { "content-length": contentLength },
            }),
        ),
      );
      const api = new FileApi(
        client(),
        { sessionId: "s", appToken: "a" },
        "http://127.0.0.1",
        "token",
      );
      await expect(
        api.download(entry, new AbortController().signal),
      ).rejects.toThrow(/size changed|truncated/);
    },
  );
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeInlineWasmDataUrl, responseForInlineWasmDataUrl, withInlineWasmFetchShim } from "../../src/app/ghostty-loader.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ghostty-loader", () => {
  it("decodes inline WASM data URLs without fetching a sidecar asset", () => {
    const bytes = decodeInlineWasmDataUrl("data:application/wasm;base64,AAECA/8=");

    expect([...bytes]).toEqual([0, 1, 2, 3, 255]);
  });

  it("rejects non-inline WASM URLs", () => {
    expect(() => decodeInlineWasmDataUrl("./ghostty-vt.wasm")).toThrow("Ghostty WASM was not loaded");
  });

  it("returns an application/wasm response for inline Ghostty data URLs", async () => {
    const response = responseForInlineWasmDataUrl("data:application/wasm;base64,AAECA/8=");

    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toBe("application/wasm");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 1, 2, 3, 255]);
  });

  it("intercepts native data WASM fetches only while Ghostty initializes", async () => {
    const nativeFetch = vi.fn(async () => {
      throw new TypeError("native fetch blocked data URL");
    });
    globalThis.fetch = nativeFetch as unknown as typeof fetch;

    const result = await withInlineWasmFetchShim(async () => {
      const response = await fetch("data:application/wasm;base64,AAECA/8=");
      return [...new Uint8Array(await response.arrayBuffer())];
    });

    expect(result).toEqual([0, 1, 2, 3, 255]);
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(nativeFetch);
  });
});

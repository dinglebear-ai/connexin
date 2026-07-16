import { init } from "ghostty-web";

let initPromise: Promise<void> | undefined;

export function decodeInlineWasmDataUrl(url: string): Uint8Array {
  const match = /^data:application\/wasm(?:;[^,]*)?;base64,(.+)$/s.exec(url);
  if (!match) throw new Error("Ghostty WASM was not loaded from an inline data URL");

  const binary = atob(match[1]!);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function responseForInlineWasmDataUrl(url: string): Response {
  const bytes = decodeInlineWasmDataUrl(url);
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return new Response(body.buffer, {
    status: 200,
    headers: { "content-type": "application/wasm" },
  });
}

export function loadGhosttyRuntime(): Promise<void> {
  initPromise ??= withInlineWasmFetchShim(init);
  return initPromise;
}

export async function withInlineWasmFetchShim<T>(load: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  const shim: typeof fetch = (input, initOptions) => {
    const url = readFetchUrl(input);
    if (url?.startsWith("data:application/wasm")) {
      return Promise.resolve(responseForInlineWasmDataUrl(url));
    }
    return originalFetch.call(globalThis, input, initOptions);
  };

  globalThis.fetch = shim;
  try {
    return await load();
  } finally {
    if (globalThis.fetch === shim) globalThis.fetch = originalFetch;
  }
}

function readFetchUrl(input: RequestInfo | URL): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return undefined;
}

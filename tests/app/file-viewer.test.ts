// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VIEWABLE_BYTES,
  closeFileViewer,
  decodeTextFile,
  isProbablyBinary,
  openFileViewer,
} from "../../src/app/file-viewer.js";

const encode = (text: string) => new TextEncoder().encode(text);
const buffer = (text: string) => encode(text).buffer as ArrayBuffer;

function viewer(): HTMLDialogElement {
  const dialog = document.querySelector<HTMLDialogElement>(".file-viewer");
  if (!dialog) throw new Error("no viewer mounted");
  return dialog;
}

const body = () => viewer().querySelector(".file-viewer__body")!;
const meta = () => viewer().querySelector(".send-dialog__meta")!;

/** Let the load promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("decodeTextFile", () => {
  it("decodes valid UTF-8 including multi-byte characters", () => {
    const result = decodeTextFile(buffer("# Title\n\nnaïve — 日本語\n"));
    expect(result).toEqual({
      kind: "text",
      text: "# Title\n\nnaïve — 日本語\n",
      truncatedLines: false,
    });
  });

  it("treats embedded NUL bytes as binary", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]);
    expect(isProbablyBinary(bytes)).toBe(true);
    expect(decodeTextFile(bytes.buffer as ArrayBuffer)).toEqual({
      kind: "binary",
    });
  });

  it("treats invalid UTF-8 as binary rather than showing replacement chars", () => {
    // 0xff is never valid in UTF-8, and there is no NUL to catch it first.
    const bytes = new Uint8Array([0x68, 0x69, 0xff, 0xfe]);
    expect(isProbablyBinary(bytes)).toBe(false);
    expect(decodeTextFile(bytes.buffer as ArrayBuffer)).toEqual({
      kind: "binary",
    });
  });

  it("caps very long files and flags the truncation", () => {
    const result = decodeTextFile(buffer("line\n".repeat(6000)));
    if (result.kind !== "text") throw new Error("expected text");
    expect(result.truncatedLines).toBe(true);
    expect(result.text.split("\n")).toHaveLength(5000);
  });

  it("handles an empty file", () => {
    expect(decodeTextFile(buffer(""))).toEqual({
      kind: "text",
      text: "",
      truncatedLines: false,
    });
  });
});

describe("openFileViewer", () => {
  beforeEach(() => document.body.replaceChildren());

  it("renders file contents as text", async () => {
    const markdown = "# Notes\n\n- one\n- two\n";
    void openFileViewer({ name: "notes.md", size: markdown.length }, async () =>
      buffer(markdown),
    );
    await settle();

    expect(viewer().querySelector("h2")!.textContent).toBe("notes.md");
    expect(body().textContent).toBe(markdown);
    expect(viewer().dataset.state).toBe("ready");
    expect(meta().textContent).toContain("5 lines");
  });

  it("never interprets file contents as markup", async () => {
    const hostile = "<img src=x onerror=alert(1)>\n<script>bad()</script>";
    void openFileViewer({ name: "evil.md", size: hostile.length }, async () =>
      buffer(hostile),
    );
    await settle();

    expect(body().querySelector("img")).toBeNull();
    expect(body().querySelector("script")).toBeNull();
    expect(body().textContent).toBe(hostile);
  });

  it("refuses oversized files without fetching them", async () => {
    const load = vi.fn();
    void openFileViewer(
      { name: "huge.log", size: MAX_VIEWABLE_BYTES + 1 },
      load,
    );
    await settle();

    expect(load).not.toHaveBeenCalled();
    expect(viewer().dataset.state).toBe("notice");
    expect(body().textContent).toContain("Download");
  });

  it("reports binary files instead of dumping bytes", async () => {
    void openFileViewer(
      { name: "logo.png", size: 4 },
      async () =>
        new Uint8Array([0x89, 0x50, 0x00, 0x47]).buffer as ArrayBuffer,
    );
    await settle();

    expect(viewer().dataset.state).toBe("notice");
    expect(body().textContent).toContain("binary");
  });

  it("surfaces load failures in the viewer", async () => {
    void openFileViewer({ name: "gone.txt", size: 10 }, async () => {
      throw new Error("Download size changed");
    });
    await settle();

    expect(viewer().dataset.state).toBe("notice");
    expect(body().textContent).toBe("Download size changed");
  });

  it("calls out an empty file rather than showing a blank pane", async () => {
    void openFileViewer({ name: "empty.txt", size: 0 }, async () => buffer(""));
    await settle();

    expect(body().textContent).toBe("This file is empty");
    expect(meta().textContent).toContain("empty file");
  });

  it("aborts the in-flight read when dismissed", async () => {
    let observed: AbortSignal | undefined;
    const pending = openFileViewer(
      { name: "slow.txt", size: 10 },
      (signal) =>
        new Promise<ArrayBuffer>(() => {
          observed = signal;
        }),
    );

    expect(observed?.aborted).toBe(false);
    viewer().close();
    await pending;

    expect(observed?.aborted).toBe(true);
    expect(document.querySelector(".file-viewer")).toBeNull();
  });

  it("closes on teardown so a modal cannot outlive its panel", async () => {
    const pending = openFileViewer(
      { name: "slow.txt", size: 10 },
      () => new Promise<ArrayBuffer>(() => {}),
    );

    closeFileViewer();
    await pending;
    expect(document.querySelector(".file-viewer")).toBeNull();
  });

  it("supersedes an open viewer rather than stacking modals", async () => {
    const first = openFileViewer({ name: "a.txt", size: 1 }, async () =>
      buffer("a"),
    );
    void openFileViewer({ name: "b.txt", size: 1 }, async () => buffer("b"));

    await first;
    expect(document.querySelectorAll(".file-viewer")).toHaveLength(1);
    expect(viewer().querySelector("h2")!.textContent).toBe("b.txt");
  });
});

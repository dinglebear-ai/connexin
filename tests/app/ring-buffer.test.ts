import { describe, expect, it } from "vitest";
import { BoundedTextBuffer } from "../../src/shared/bounded-text-buffer.js";
import { takeFirstUtf8Bytes } from "../../src/shared/utf8.js";

describe("takeFirstUtf8Bytes", () => {
  it("truncates by UTF-8 bytes without splitting a code point", () => {
    expect(takeFirstUtf8Bytes("a🙂b", 5)).toEqual({ text: "a🙂", bytes: 5 });
    expect(takeFirstUtf8Bytes("🙂a", 3)).toEqual({ text: "", bytes: 0 });
  });
});

describe("BoundedTextBuffer", () => {
  it("caps retained text and keeps recent chunks", () => {
    const buffer = new BoundedTextBuffer(5);
    buffer.append("hello");
    buffer.append(" world");

    expect(buffer.byteLength).toBeLessThanOrEqual(5);
    expect(buffer.toString()).toBe("world");
  });

  it("retains text across multiple chunks", () => {
    const buffer = new BoundedTextBuffer(100);
    buffer.append("one");
    buffer.append("two");

    expect(buffer.toString()).toBe("onetwo");
  });

  it("trims multibyte text on byte boundaries", () => {
    const buffer = new BoundedTextBuffer(5);
    buffer.append("a🙂b");

    expect(buffer.byteLength).toBe(5);
    expect(buffer.toString()).toBe("🙂b");
  });

  it("handles many tiny chunks without losing the retained suffix", () => {
    const buffer = new BoundedTextBuffer(10);

    for (let index = 0; index < 500; index += 1) {
      buffer.append(String(index % 10));
    }

    expect(buffer.byteLength).toBeLessThanOrEqual(10);
    expect(buffer.toString()).toBe("0123456789");
  });

  it("handles many tiny multibyte chunks on byte boundaries", () => {
    const buffer = new BoundedTextBuffer(8);

    for (let index = 0; index < 100; index += 1) {
      buffer.append("🙂");
    }

    expect(buffer.byteLength).toBe(8);
    expect(buffer.toString()).toBe("🙂🙂");
  });
});

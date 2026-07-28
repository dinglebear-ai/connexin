import { describe, expect, it } from "vitest";
import { BoundedTextBuffer } from "../../src/shared/bounded-text-buffer.js";
import {
  dropFirstUtf8Bytes,
  takeFirstUtf8Bytes,
  takeLastUtf8Bytes,
  utf8ByteLength,
} from "../../src/shared/utf8.js";

describe("takeFirstUtf8Bytes", () => {
  it("truncates by UTF-8 bytes without splitting a code point", () => {
    expect(takeFirstUtf8Bytes("a🙂b", 5)).toEqual({ text: "a🙂", bytes: 5 });
    expect(takeFirstUtf8Bytes("🙂a", 3)).toEqual({ text: "", bytes: 0 });
  });
});

describe("utf8ByteLength", () => {
  // These are computed arithmetically rather than via TextEncoder, so the
  // agreement has to be asserted rather than assumed.
  const encoder = new TextEncoder();
  const samples = [
    "",
    "ascii",
    "é",
    "€",
    "🙂",
    "日本語",
    "\u{10FFFF}",
    "a🙂b\né",
    "\ud800", // lone high surrogate
    "\udc00", // lone low surrogate
    "\ud800a", // high surrogate not followed by a low one
    "a\ud83d", // trailing high surrogate
  ];

  it.each(samples)("matches TextEncoder for %j", (sample) => {
    expect(utf8ByteLength(sample)).toBe(encoder.encode(sample).byteLength);
  });
});

describe("dropFirstUtf8Bytes", () => {
  it("drops the shortest code-point-aligned prefix worth at least n bytes", () => {
    expect(dropFirstUtf8Bytes("a🙂b", 1)).toEqual({ text: "🙂b", bytes: 1 });
    // Cannot split the emoji, so dropping 1 byte of it drops all 4.
    expect(dropFirstUtf8Bytes("🙂ab", 1)).toEqual({ text: "ab", bytes: 4 });
    expect(dropFirstUtf8Bytes("abc", 0)).toEqual({ text: "abc", bytes: 0 });
  });

  it("is the inverse of takeLastUtf8Bytes, which is what the buffer relies on", () => {
    for (const sample of ["a🙂b", "🙂🙂🙂", "日本語abc", "é€🙂"]) {
      const total = utf8ByteLength(sample);
      for (let keep = 1; keep < total; keep += 1) {
        expect(dropFirstUtf8Bytes(sample, total - keep).text).toBe(
          takeLastUtf8Bytes(sample, keep).text,
        );
      }
    }
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

  it("trims correctly when a large head chunk is eaten one byte at a time", () => {
    // The partial-trim path: a head chunk far larger than each append. The
    // earlier implementation retained the whole remainder code point by code
    // point on every append, which was both quadratic and easy to get wrong.
    const buffer = new BoundedTextBuffer(16);
    buffer.append("0123456789abcdef");
    for (const character of "GHIJ") buffer.append(character);

    expect(buffer.byteLength).toBe(16);
    expect(buffer.toString()).toBe("456789abcdefGHIJ");
  });

  describe("append cost", () => {
    /** Median wall-clock ms for one append against a head chunk of `headBytes`. */
    function medianAppendMs(headBytes: number, appends = 200): number {
      const buffer = new BoundedTextBuffer(headBytes);
      buffer.append("x".repeat(headBytes));
      const samples: number[] = [];
      for (let index = 0; index < appends; index += 1) {
        const start = performance.now();
        buffer.append("y");
        samples.push(performance.now() - start);
      }
      return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
    }

    it("stays flat as the head chunk grows", () => {
      // Quadratic trimming showed up here as a ~16x jump between these two
      // sizes (measured 15.9ms vs 53.7ms per append). Linear trimming keeps
      // both immeasurably small. The threshold is loose on purpose: this is
      // guarding an algorithmic class, not a wall-clock budget on CI hardware.
      const small = medianAppendMs(16 * 1024);
      const large = medianAppendMs(256 * 1024);

      expect(small).toBeLessThan(1);
      expect(large).toBeLessThan(1);
    });

    it("absorbs a large flood in bounded time", () => {
      const buffer = new BoundedTextBuffer(128 * 1024);
      buffer.append("x".repeat(128 * 1024));
      const chunk = "y".repeat(1024);

      const start = performance.now();
      for (let sent = 0; sent < 4 * 1024 * 1024; sent += 1024)
        buffer.append(chunk);
      const elapsed = performance.now() - start;

      // Took ~8.5s before the fix; runs in ~10ms after.
      expect(elapsed).toBeLessThan(1000);
      expect(buffer.byteLength).toBe(128 * 1024);
    });
  });
});

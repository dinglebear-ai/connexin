/**
 * UTF-8 byte accounting for JS strings.
 *
 * These run on every byte of terminal output in both the server and the browser
 * bundle, so they are written to allocate nothing. An earlier version measured
 * byte lengths with `TextEncoder.encode().byteLength`, which allocates a whole
 * Uint8Array just to read a number; called once per code point it made
 * scrollback trimming quadratic (a 200-keystroke echo against a 64 KB head
 * chunk took 13 s). Everything below is arithmetic over UTF-16 code units.
 *
 * Semantics match TextEncoder exactly, including unpaired surrogates, which
 * encode as U+FFFD and therefore count as 3 bytes.
 */

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

function isHighSurrogate(unit: number): boolean {
  return unit >= HIGH_SURROGATE_START && unit <= HIGH_SURROGATE_END;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= LOW_SURROGATE_START && unit <= LOW_SURROGATE_END;
}

function previousCodePointStart(text: string, end: number): number {
  const start = end - 1;
  const codeUnit = text.charCodeAt(start);
  if (isLowSurrogate(codeUnit) && start > 0) {
    const previous = text.charCodeAt(start - 1);
    if (isHighSurrogate(previous)) return start - 1;
  }
  return start;
}

/** UTF-8 byte length of `text[start..end)`. Allocates nothing. */
function byteLengthOfRange(text: string, start: number, end: number): number {
  let bytes = 0;
  for (let index = start; index < end; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (isHighSurrogate(unit) && index + 1 < end) {
      if (isLowSurrogate(text.charCodeAt(index + 1))) {
        // A well-formed pair is one code point above the BMP: 4 bytes.
        bytes += 4;
        index += 1;
      } else {
        // Unpaired: TextEncoder substitutes U+FFFD.
        bytes += 3;
      }
    } else {
      // BMP (and unpaired surrogates, which become U+FFFD) are 3 bytes.
      bytes += 3;
    }
  }
  return bytes;
}

export function utf8ByteLength(text: string): number {
  return byteLengthOfRange(text, 0, text.length);
}

export function takeFirstUtf8Bytes(
  text: string,
  maxBytes: number,
): { text: string; bytes: number } {
  if (maxBytes <= 0) return { text: "", bytes: 0 };

  let bytes = 0;
  let end = 0;
  while (end < text.length) {
    const next = nextCodePointEnd(text, end);
    const codePointBytes = byteLengthOfRange(text, end, next);
    if (bytes + codePointBytes > maxBytes) break;
    bytes += codePointBytes;
    end = next;
  }
  return { text: text.slice(0, end), bytes };
}

export function takeLastUtf8Bytes(
  text: string,
  maxBytes: number,
): { text: string; bytes: number } {
  if (maxBytes <= 0) return { text: "", bytes: 0 };

  const totalBytes = utf8ByteLength(text);
  if (totalBytes <= maxBytes) return { text, bytes: totalBytes };

  let bytes = 0;
  let start = text.length;
  while (start > 0) {
    const previous = previousCodePointStart(text, start);
    const candidateBytes = byteLengthOfRange(text, previous, start);
    if (bytes + candidateBytes > maxBytes) break;
    bytes += candidateBytes;
    start = previous;
  }

  return { text: text.slice(start), bytes };
}

function nextCodePointEnd(text: string, start: number): number {
  const unit = text.charCodeAt(start);
  if (
    isHighSurrogate(unit) &&
    start + 1 < text.length &&
    isLowSurrogate(text.charCodeAt(start + 1))
  )
    return start + 2;
  return start + 1;
}

/**
 * Drop the shortest code-point-aligned prefix worth at least `minBytes`.
 *
 * This is the inverse of `takeLastUtf8Bytes` and returns the same string for
 * `minBytes === utf8ByteLength(text) - maxBytes`, but costs O(dropped) instead
 * of O(retained). Trimming a ring buffer discards a little and keeps a lot, so
 * scanning the discarded side is what keeps appends flat.
 */
export function dropFirstUtf8Bytes(
  text: string,
  minBytes: number,
): { text: string; bytes: number } {
  if (minBytes <= 0) return { text, bytes: 0 };

  let dropped = 0;
  let start = 0;
  while (start < text.length && dropped < minBytes) {
    const next = nextCodePointEnd(text, start);
    dropped += byteLengthOfRange(text, start, next);
    start = next;
  }
  return { text: text.slice(start), bytes: dropped };
}

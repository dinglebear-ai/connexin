import { dropFirstUtf8Bytes, utf8ByteLength } from "./utf8.js";

/**
 * Byte-bounded ring of text chunks, used for terminal scrollback on both the
 * server and the client.
 *
 * Per-chunk byte lengths are cached alongside the chunks. Recomputing the head
 * chunk's length on every append (and retaining it code point by code point)
 * made trimming quadratic in the head chunk size, which stalled the Node event
 * loop for seconds on ordinary output floods.
 */
export class BoundedTextBuffer {
  private chunks: string[] = [];
  private chunkBytes: number[] = [];
  private firstChunk = 0;
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  get byteLength(): number {
    return this.totalBytes;
  }

  append(chunk: string): void {
    if (chunk.length === 0) return;
    const bytes = utf8ByteLength(chunk);
    this.chunks.push(chunk);
    this.chunkBytes.push(bytes);
    this.totalBytes += bytes;
    this.trim();
  }

  toString(): string {
    return this.chunks.slice(this.firstChunk).join("");
  }

  clear(): void {
    this.chunks = [];
    this.chunkBytes = [];
    this.firstChunk = 0;
    this.totalBytes = 0;
  }

  private trim(): void {
    while (
      this.totalBytes > this.maxBytes &&
      this.firstChunk < this.chunks.length
    ) {
      const firstBytes = this.chunkBytes[this.firstChunk]!;
      const overflow = this.totalBytes - this.maxBytes;

      if (firstBytes <= overflow) {
        this.firstChunk += 1;
        this.totalBytes -= firstBytes;
        this.compactIfNeeded();
        continue;
      }

      // Partial trim: drop just the overflow off the front. Scanning the
      // dropped prefix is O(overflow); retaining from the back would be
      // O(chunk size) and is what made this quadratic.
      const first = this.chunks[this.firstChunk]!;
      const dropped = dropFirstUtf8Bytes(first, overflow);
      this.chunks[this.firstChunk] = dropped.text;
      this.chunkBytes[this.firstChunk] = firstBytes - dropped.bytes;
      this.totalBytes -= dropped.bytes;
      break;
    }
  }

  private compactIfNeeded(): void {
    if (this.firstChunk < 64 || this.firstChunk * 2 < this.chunks.length)
      return;
    this.chunks = this.chunks.slice(this.firstChunk);
    this.chunkBytes = this.chunkBytes.slice(this.firstChunk);
    this.firstChunk = 0;
  }
}

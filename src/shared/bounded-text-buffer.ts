import { takeLastUtf8Bytes, utf8ByteLength } from "./utf8.js";

export class BoundedTextBuffer {
  private chunks: string[] = [];
  private firstChunk = 0;
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  get byteLength(): number {
    return this.totalBytes;
  }

  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.totalBytes += utf8ByteLength(chunk);
    this.trim();
  }

  toString(): string {
    return this.chunks.slice(this.firstChunk).join("");
  }

  clear(): void {
    this.chunks = [];
    this.firstChunk = 0;
    this.totalBytes = 0;
  }

  private trim(): void {
    while (this.totalBytes > this.maxBytes && this.firstChunk < this.chunks.length) {
      const first = this.chunks[this.firstChunk]!;
      const firstBytes = utf8ByteLength(first);
      const overflow = this.totalBytes - this.maxBytes;

      if (firstBytes <= overflow) {
        this.firstChunk += 1;
        this.totalBytes -= firstBytes;
        this.compactIfNeeded();
        continue;
      }

      const retained = takeLastUtf8Bytes(first, firstBytes - overflow);
      this.totalBytes -= firstBytes - retained.bytes;
      this.chunks[this.firstChunk] = retained.text;
      break;
    }
  }

  private compactIfNeeded(): void {
    if (this.firstChunk < 64 || this.firstChunk * 2 < this.chunks.length) return;
    this.chunks = this.chunks.slice(this.firstChunk);
    this.firstChunk = 0;
  }
}

const encoder = new TextEncoder();

function previousCodePointStart(text: string, end: number): number {
  const start = end - 1;
  const codeUnit = text.charCodeAt(start);
  if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff && start > 0) {
    const previous = text.charCodeAt(start - 1);
    if (previous >= 0xd800 && previous <= 0xdbff) return start - 1;
  }
  return start;
}

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
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
    const candidate = text.slice(previous, start);
    const candidateBytes = utf8ByteLength(candidate);
    if (bytes + candidateBytes > maxBytes) break;
    bytes += candidateBytes;
    start = previous;
  }

  return { text: text.slice(start), bytes };
}

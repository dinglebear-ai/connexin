import { posix } from "node:path";
import { utf8ByteLength } from "../shared/utf8.js";

export interface FilePathLimits {
  maxFilePathBytes: number;
  maxFileComponentBytes: number;
  maxFilePathDepth: number;
}

export function normalizeRelativePath(
  value: string,
  limits: FilePathLimits,
): string {
  if (value.includes("\0") || /[\u0000-\u001f\u007f]/u.test(value))
    throw new Error("invalid_path");
  const raw = value.replaceAll("\\", "/");
  if (raw.startsWith("/")) throw new Error("invalid_path");
  const parts = raw.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) throw new Error("path_outside_root");
  if (parts.length > limits.maxFilePathDepth) throw new Error("path_too_deep");
  for (const part of parts)
    if (utf8ByteLength(part) > limits.maxFileComponentBytes)
      throw new Error("component_too_long");
  const normalized = parts.join("/");
  if (utf8ByteLength(normalized) > limits.maxFilePathBytes)
    throw new Error("path_too_long");
  return normalized || ".";
}

export function confinedRemotePath(
  root: string,
  relative: string,
  limits: FilePathLimits,
): string {
  const normalized = normalizeRelativePath(relative, limits);
  return normalized === "." ? root : posix.join(root, normalized);
}

export function assertCanonicalWithin(root: string, target: string): void {
  if (target !== root && !target.startsWith(`${root}/`))
    throw new Error("path_outside_root");
}

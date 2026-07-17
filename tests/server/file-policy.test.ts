import { describe, expect, it } from "vitest";
import {
  confinedRemotePath,
  normalizeRelativePath,
} from "../../src/server/file-policy.js";
const limits = {
  maxFilePathBytes: 64,
  maxFileComponentBytes: 16,
  maxFilePathDepth: 4,
};
describe("file path policy", () => {
  it("normalizes confined relative paths", () =>
    expect(confinedRemotePath("/home/me", "docs/./a", limits)).toBe(
      "/home/me/docs/a",
    ));
  it.each(["/etc", "../etc", "a/../../b", "bad\0name"])(
    "rejects unsafe path %s",
    (path) => expect(() => normalizeRelativePath(path, limits)).toThrow(),
  );
});

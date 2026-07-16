import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function runNode(args: string[], cwd: string): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  return new Promise((resolveResult) => {
    execFile(process.execPath, args, { cwd }, (error, stdout, stderr) => {
      resolveResult({
        exitCode: error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1,
        stderr: String(stderr),
        stdout: String(stdout),
      });
    });
  });
}

describe("write-build-manifest", () => {
  it("fails when git metadata cannot be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quick-shell-manifest-"));

    const result = await runNode([resolve("scripts/write-build-manifest.mjs")], dir);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unable to read git metadata (rev-parse HEAD)");
  });
});

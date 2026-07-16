import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  return new Promise((resolveResult) => {
    execFile(command, args, { cwd }, (error, stdout, stderr) => {
      resolveResult({
        exitCode:
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : 1,
        stderr: String(stderr),
        stdout: String(stdout),
      });
    });
  });
}

function runNode(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  return runCommand(process.execPath, args, cwd);
}

function runGit(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  return runCommand("git", args, cwd);
}

async function runGitOk(args: string[], cwd: string): Promise<void> {
  const result = await runGit(args, cwd);
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
}

async function writeFixtureFile(
  root: string,
  path: string,
  contents: string,
): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(join(fullPath, ".."), { recursive: true });
  await writeFile(fullPath, contents);
}

async function writeManifestFixture(root: string): Promise<void> {
  const files: Record<string, string> = {
    "package.json": "{}\n",
    "package-lock.json": "{}\n",
    "mcp-app.html": "<html></html>\n",
    "src/server/main.ts": "export const server = 1;\n",
    "src/shared/protocol.ts": "export const protocol = 1;\n",
    "src/cli/main.ts": "export const cli = 1;\n",
    "dist/app/mcp-app.html": "<html>built</html>\n",
    "dist/server/server/main.js": "export const server = 1;\n",
    "dist/server/server/main.d.ts": "export declare const server = 1;\n",
    "dist/server/shared/protocol.js": "export const protocol = 1;\n",
    "dist/server/shared/protocol.d.ts": "export declare const protocol = 1;\n",
    "dist/server/cli/main.js": "export const cli = 1;\n",
    "dist/server/cli/main.d.ts": "export declare const cli = 1;\n",
  };
  await Promise.all(
    Object.entries(files).map(([path, contents]) =>
      writeFixtureFile(root, path, contents),
    ),
  );
  await runGitOk(["init"], root);
  await runGitOk(["add", "."], root);
  await runGitOk(
    [
      "-c",
      "user.name=Quick Shell",
      "-c",
      "user.email=quick-shell@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    root,
  );
}

describe("write-build-manifest", () => {
  it("fails when git metadata cannot be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quick-shell-manifest-"));

    const result = await runNode(
      [resolve("scripts/write-build-manifest.mjs")],
      dir,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "Unable to read git metadata (rev-parse HEAD)",
    );
  });

  it("rejects unexpected stale artifacts instead of adding them to the manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quick-shell-manifest-"));
    await writeManifestFixture(dir);
    await writeFixtureFile(
      dir,
      "dist/server/server/stale.js",
      "export const stale = true;\n",
    );

    const result = await runNode(
      [resolve("scripts/write-build-manifest.mjs")],
      dir,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unexpected build artifact");
    expect(result.stderr).toContain("dist/server/server/stale.js");
  });
});

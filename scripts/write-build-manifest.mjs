#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const manifestPath = "dist/quick-shell-build-manifest.json";
const files = [
  "package.json",
  "package-lock.json",
  "mcp-app.html",
  "dist/app/mcp-app.html",
  "dist/server/server/main.js",
  "dist/server/cli/main.js",
];

function git(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read git metadata (${args.join(" ")}): ${detail}`);
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const manifest = {
  version: 1,
  packageName: "quick-shell",
  gitSha: git(["rev-parse", "HEAD"]),
  gitDirty: git(["status", "--porcelain"]).length > 0,
  builtAt: new Date().toISOString(),
  files: {},
};

for (const file of files) {
  manifest.files[file] = await sha256(file);
}

await mkdir(dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

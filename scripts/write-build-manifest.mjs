#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";

const manifestPath = "dist/quick-shell-build-manifest.json";
const rootFiles = ["package.json", "package-lock.json", "mcp-app.html"];
const appFiles = ["dist/app/mcp-app.html"];
const helperFiles = ["dist/bin/quick-shell-sftp"];
const serverSourceRoots = ["src/server", "src/shared", "src/cli"];
const buildRoots = ["dist/app", "dist/server", "dist/bin"];

async function collectFiles(root) {
  const files = [];

  async function walk(path) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  }

  await walk(root);
  return files.sort();
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function collectExpectedServerFiles() {
  const files = [];
  for (const root of serverSourceRoots) {
    for (const sourceFile of await collectFiles(root)) {
      if (!sourceFile.endsWith(".ts")) continue;
      const outputBase = `dist/server/${relative("src", sourceFile).replace(/\.ts$/, "")}`;
      files.push(`${outputBase}.js`, `${outputBase}.d.ts`);
    }
  }
  return files.sort();
}

function git(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to read git metadata (${args.join(" ")}): ${detail}`,
    );
  }
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function formatList(paths) {
  return paths.map((path) => `  - ${path}`).join("\n");
}

const gitSha = git(["rev-parse", "HEAD"]);
const gitDirty = git(["status", "--porcelain"]).length > 0;
const expectedFiles = new Set([
  ...rootFiles,
  ...appFiles,
  ...helperFiles,
  ...(await collectExpectedServerFiles()),
]);
const actualBuildFiles = (
  await Promise.all(
    buildRoots.map(async (root) =>
      (await exists(root)) ? collectFiles(root) : [],
    ),
  )
)
  .flat()
  .sort();
const unexpectedFiles = actualBuildFiles.filter(
  (file) => !expectedFiles.has(file),
);
if (unexpectedFiles.length > 0) {
  throw new Error(
    [
      "Unexpected build artifact(s) found in dist; refusing to write a manifest that would bless stale output.",
      formatList(unexpectedFiles),
      "Run npm run clean and rebuild.",
    ].join("\n"),
  );
}

const files = [...expectedFiles].sort();
const missingFiles = [];
for (const file of files) {
  if (!(await exists(file))) missingFiles.push(file);
}
if (missingFiles.length > 0) {
  throw new Error(
    [
      "Expected build artifact(s) are missing:",
      formatList(missingFiles),
      "Run npm run build.",
    ].join("\n"),
  );
}

const manifest = {
  version: 1,
  packageName: "quick-shell",
  gitSha,
  gitDirty,
  builtAt: new Date().toISOString(),
  files: {},
};

for (const file of files) {
  manifest.files[file] = await sha256(file);
}

await mkdir(dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

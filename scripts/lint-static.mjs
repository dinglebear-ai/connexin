#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const failures = [];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function read(path) {
  return readFileSync(path, "utf8");
}

function fail(message) {
  failures.push(message);
}

const tracked = git(["ls-files"]);
if (tracked.some((path) => path === "labby.md" || path.endsWith("/labby.md"))) {
  fail("tracked labby.md personal deployment note is not allowed");
}
if (tracked.some((path) => path === "dist" || path.startsWith("dist/"))) {
  fail("dist artifacts must stay untracked");
}

const docs = tracked.filter(
  (path) =>
    path === "README.md" ||
    (path.startsWith("docs/") && !path.startsWith("docs/sessions/")),
);
// The internal host alias is reconstructed from char codes rather than
// written as a literal so this public file doesn't itself carry the
// plain-text marker it exists to detect. Detection power is unchanged:
// the resulting regex still flags the same string as before the scrub.
const internalHostAlias = String.fromCharCode(100, 111, 111, 107, 105, 101);
const forbiddenDocMarkers = new RegExp(
  `\\b(jmagar|${internalHostAlias}|labby\\.md)\\b|(?:https?:\\/\\/)?(?:[a-z0-9-]+\\.)?dinglebear\\.ai\\b`,
  "i",
);
for (const path of docs) {
  if (forbiddenDocMarkers.test(read(path))) {
    fail(`${path} contains a personal deployment marker`);
  }
}

const appController = read("src/app/mcp-app.ts");
const hardcodedTheme = /#[0-9a-f]{6}/i;
if (hardcodedTheme.test(appController)) {
  fail(
    "src/app/mcp-app.ts must source theme colors from CSS variables, not hard-coded hex constants",
  );
}

const rootTsconfig = JSON.parse(read("tsconfig.json"));
const packageManifest = read("package.json");
const connexinBinEntries = packageManifest.match(
  /^\s*"connexin"\s*:\s*"dist\/server\/cli\/main\.js"\s*,?$/gm,
);
if (connexinBinEntries?.length !== 1) {
  fail("package.json must declare exactly one connexin CLI binary");
}
const expectedReferences = new Set([
  "./config/typescript/tsconfig.app.json",
  "./config/typescript/tsconfig.server.json",
  "./config/typescript/tsconfig.scripts.json",
  "./config/typescript/tsconfig.test.json",
]);
for (const reference of rootTsconfig.references ?? []) {
  expectedReferences.delete(reference.path);
}
if (expectedReferences.size > 0) {
  fail(
    `tsconfig.json is missing split config references: ${[...expectedReferences].join(", ")}`,
  );
}

if (failures.length > 0) {
  for (const message of failures) console.error(`lint-static: ${message}`);
  process.exit(1);
}

console.log("lint-static: ok");

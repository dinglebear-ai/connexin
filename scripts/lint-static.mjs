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
  (path) => path === "README.md" || path.startsWith("docs/"),
);
const forbiddenDocMarkers = /\b(jmagar|dinglebear|dookie|labby\.md)\b/i;
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
const expectedReferences = new Set([
  "./tsconfig.app.json",
  "./tsconfig.server.json",
  "./tsconfig.scripts.json",
  "./tsconfig.test.json",
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

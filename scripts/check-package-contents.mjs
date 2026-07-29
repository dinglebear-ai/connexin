#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
});
const [pack] = JSON.parse(output);
const packaged = new Set(pack.files.map((file) => file.path));
const required = [
  "config/connexin.env.example",
  "config/connexin.toml.example",
  "dist/app/src/app/mcp-app.html",
  "dist/server/cli/main.js",
];
const missing = required.filter((path) => !packaged.has(path));
if (missing.length > 0) {
  throw new Error(
    `npm package is missing required files: ${missing.join(", ")}`,
  );
}

console.log("package contents: ok");

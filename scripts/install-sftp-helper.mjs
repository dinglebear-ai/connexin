#!/usr/bin/env node
// Downloads the prebuilt Go SFTP helper from GitHub Releases.
//
// Runs two ways:
//   - as npm's `postinstall` hook (best effort; never fails the install)
//   - with --required, as the runtime self-heal when the binary is missing
//     because postinstall was skipped (pnpm/yarn defaults, `npm ci
//     --ignore-scripts`, npm's newer install-script gating)
//
// The binary is executed with the user's SSH credentials, so the download is
// verified against the release SHA256SUMS before it is written into place.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  downloadUrl,
  helperDestination,
  isSourceCheckout,
  releaseVersion,
  shouldSkipDownload,
  targetFor,
} from "./sftp-helper-target.mjs";

const MAX_REDIRECTS = 5;

function fetchBuffer(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    get(
      url,
      { headers: { "user-agent": "connexin-installer" } },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;

        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirectsLeft === 0) {
            reject(new Error(`Too many redirects fetching ${url}`));
            return;
          }
          resolve(
            fetchBuffer(new URL(location, url).toString(), redirectsLeft - 1),
          );
          return;
        }

        if (status !== 200) {
          response.resume();
          reject(new Error(`HTTP ${status} fetching ${url}`));
          return;
        }

        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
      },
    ).on("error", reject);
  });
}

/** Pull the expected digest for `asset` out of the release SHA256SUMS file. */
async function expectedDigest(asset, env) {
  const sumsUrl = downloadUrl({ asset: "SHA256SUMS" }, env);
  const text = (await fetchBuffer(sumsUrl)).toString("utf8");
  for (const line of text.split("\n")) {
    const [digest, name] = line.trim().split(/\s+/);
    if (name?.replace(/^\*/, "") === asset) return digest;
  }
  throw new Error(`${asset} is not listed in ${sumsUrl}`);
}

export async function installSftpHelper(env = process.env) {
  const target = targetFor();
  const destination = helperDestination(target);

  if (existsSync(destination))
    return { destination, skipped: "already-present" };
  if (shouldSkipDownload(env)) return { destination, skipped: "skip-flag" };
  if (isSourceCheckout()) return { destination, skipped: "source-checkout" };

  const url = downloadUrl(target, env);
  const expected = await expectedDigest(target.asset, env);
  const archive = await fetchBuffer(url);

  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${target.asset}\n  expected ${expected}\n  actual   ${actual}`,
    );
  }

  const scratch = mkdtempSync(join(tmpdir(), "connexin-helper-"));
  try {
    const archivePath = join(scratch, target.asset);
    writeFileSync(archivePath, archive);
    execFileSync("tar", ["-xzf", archivePath, "-C", scratch], {
      stdio: "inherit",
    });

    const extracted = join(scratch, target.binary);
    if (!existsSync(extracted)) {
      throw new Error(`${target.asset} did not contain ${target.binary}`);
    }

    mkdirSync(dirname(destination), { recursive: true });
    // Copy rather than rename: scratch is often on a different filesystem.
    copyFileSync(extracted, destination);
    chmodSync(destination, 0o755);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  return { destination, version: releaseVersion(env) };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const required = process.argv.includes("--required");
  try {
    const result = await installSftpHelper();
    if (result.skipped === "skip-flag") {
      console.log(
        "connexin: skipping SFTP helper download (CONNEXIN_SKIP_HELPER_DOWNLOAD)",
      );
    } else if (result.skipped === "source-checkout") {
      console.log(
        "connexin: source checkout detected; run `npm run build` to build the SFTP helper",
      );
    } else if (result.skipped === "already-present") {
      console.log(
        `connexin: SFTP helper already present at ${result.destination}`,
      );
    } else {
      console.log(
        `connexin: installed SFTP helper ${result.version} -> ${result.destination}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (required) {
      console.error(
        `connexin: could not install the SFTP helper.\n  ${message}`,
      );
      process.exit(1);
    }
    // Best effort during postinstall: a failure here must not break `npm
    // install`, because the runtime self-heal will retry. Say so loudly rather
    // than letting the file silently not exist.
    console.warn(
      `connexin: SFTP helper download failed; file transfer will be unavailable until it succeeds.\n` +
        `  ${message}\n` +
        `  Retry with: node scripts/install-sftp-helper.mjs --required\n` +
        `  Or point CONNEXIN_SFTP_HELPER at a binary you built yourself.`,
    );
  }
}

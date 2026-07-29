// Platform/arch resolution for the Go SFTP helper binary.
//
// Kept free of I/O so it can be unit-tested directly. The release workflow's
// build matrix and this table must stay in lockstep: if CI stops producing an
// asset, drop it here too rather than advertising a target we cannot ship.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO = "dinglebear-ai/connexin";

/** platform/arch -> release asset name and extracted binary name. */
const TARGETS = new Map([
  [
    "linux/x64",
    {
      asset: "connexin-sftp-linux-x86_64.tar.gz",
      binary: "connexin-sftp",
    },
  ],
  [
    "linux/arm64",
    {
      asset: "connexin-sftp-linux-arm64.tar.gz",
      binary: "connexin-sftp",
    },
  ],
  [
    "darwin/x64",
    {
      asset: "connexin-sftp-darwin-x86_64.tar.gz",
      binary: "connexin-sftp",
    },
  ],
  [
    "darwin/arm64",
    {
      asset: "connexin-sftp-darwin-arm64.tar.gz",
      binary: "connexin-sftp",
    },
  ],
  [
    "win32/x64",
    {
      asset: "connexin-sftp-windows-x86_64.tar.gz",
      binary: "connexin-sftp.exe",
    },
  ],
  [
    "win32/arm64",
    {
      asset: "connexin-sftp-windows-arm64.tar.gz",
      binary: "connexin-sftp.exe",
    },
  ],
]);

export function supportedTargets() {
  return [...TARGETS.keys()];
}

export function targetFor(platform = process.platform, arch = process.arch) {
  const target = TARGETS.get(`${platform}/${arch}`);
  if (!target) {
    throw new Error(
      `Unsupported platform ${platform}/${arch}. Supported targets: ${supportedTargets().join(", ")}.`,
    );
  }
  return target;
}

export function packageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function packageVersion() {
  const require = createRequire(import.meta.url);
  return require("../package.json").version;
}

/**
 * Release tag to pull from. Defaults to the package version, which is why CI
 * must assert that the npm version and the git tag match exactly.
 */
export function releaseVersion(env = process.env) {
  const raw = env.CONNEXIN_HELPER_VERSION?.trim() || packageVersion();
  return raw.startsWith("v") ? raw : `v${raw}`;
}

export function releaseBaseUrl(env = process.env) {
  const base = env.CONNEXIN_RELEASE_BASE_URL?.trim();
  if (base) return base.replace(/\/+$/, "");
  // Canonical repo, not a rename redirect — fresh installs must not depend on
  // GitHub forwarding an old owner/name.
  return `https://github.com/${DEFAULT_REPO}/releases/download`;
}

export function downloadUrl(target, env = process.env) {
  return `${releaseBaseUrl(env)}/${releaseVersion(env)}/${target.asset}`;
}

/** Where the binary lands. Matches defaultSftpHelperPath() in src/server/config.ts. */
export function helperDestination(target, root = packageRoot()) {
  return resolve(root, "dist", "bin", target.binary);
}

export function shouldSkipDownload(env = process.env) {
  const flag = env.CONNEXIN_SKIP_HELPER_DOWNLOAD?.trim();
  return flag === "1" || flag === "true";
}

/**
 * True when running inside the git checkout rather than an installed package.
 * The published tarball ships neither cmd/ nor go.mod, so their presence means
 * the helper is expected to come from `npm run build`, not a release download —
 * which also keeps `npm install` quiet on a fresh clone of an unreleased
 * version.
 */
export function isSourceCheckout(root = packageRoot(), exists = existsSync) {
  return (
    exists(resolve(root, "go.mod")) &&
    exists(resolve(root, "cmd", "connexin-sftp"))
  );
}

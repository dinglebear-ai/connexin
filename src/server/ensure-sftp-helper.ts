import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type EnsureSftpHelperResult =
  | { status: "present" }
  | { status: "installed" }
  | { status: "user-managed"; reason: string }
  | { status: "unavailable"; reason: string };

export interface EnsureSftpHelperOptions {
  helperPath: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  runInstaller?: (scriptPath: string) => void;
}

/**
 * The helper is normally fetched by the `postinstall` hook, but package
 * managers skip install scripts routinely (pnpm/yarn defaults, `npm ci
 * --ignore-scripts`, npm's newer install-script gating). Re-run the downloader
 * once at startup so a skipped postinstall degrades into a slow first boot
 * rather than a broken file-transfer feature.
 *
 * A download failure is reported, not thrown: shell sessions do not need the
 * helper, so taking the whole server down would be a worse outcome than losing
 * SFTP.
 */
export function ensureSftpHelper(
  options: EnsureSftpHelperOptions,
): EnsureSftpHelperResult {
  const {
    helperPath,
    env = process.env,
    exists = existsSync,
    runInstaller = defaultRunInstaller,
  } = options;

  if (exists(helperPath)) return { status: "present" };

  // An explicit override means the operator manages this binary themselves;
  // downloading over their chosen path would be presumptuous.
  if (env.QUICK_SHELL_SFTP_HELPER?.trim()) {
    return {
      status: "user-managed",
      reason: `QUICK_SHELL_SFTP_HELPER points at ${helperPath}, which does not exist`,
    };
  }

  // helperPath is always <packageRoot>/dist/bin/<binary>.
  const scriptPath = resolve(
    helperPath,
    "..",
    "..",
    "..",
    "scripts",
    "install-sftp-helper.mjs",
  );
  if (!exists(scriptPath)) {
    return {
      status: "unavailable",
      reason: `installer not found at ${scriptPath}`,
    };
  }

  try {
    runInstaller(scriptPath);
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  return exists(helperPath)
    ? { status: "installed" }
    : {
        status: "unavailable",
        reason: "installer finished but the binary is still missing",
      };
}

function defaultRunInstaller(scriptPath: string): void {
  execFileSync(process.execPath, [scriptPath, "--required"], {
    stdio: "inherit",
  });
}

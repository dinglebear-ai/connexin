import { describe, expect, it, vi } from "vitest";
import { ensureSftpHelper } from "../../src/server/ensure-sftp-helper.js";

const HELPER = "/pkg/dist/bin/quick-shell-sftp";
const INSTALLER = "/pkg/scripts/install-sftp-helper.mjs";

describe("ensureSftpHelper", () => {
  it("does nothing when the helper is already there", () => {
    const runInstaller = vi.fn();
    expect(
      ensureSftpHelper({
        helperPath: HELPER,
        env: {},
        exists: () => true,
        runInstaller,
      }),
    ).toEqual({ status: "present" });
    expect(runInstaller).not.toHaveBeenCalled();
  });

  it("re-runs the downloader when postinstall was skipped", () => {
    const present = new Set([INSTALLER]);
    const runInstaller = vi.fn(() => {
      present.add(HELPER);
    });

    const result = ensureSftpHelper({
      helperPath: HELPER,
      env: {},
      exists: (path) => present.has(path),
      runInstaller,
    });

    expect(runInstaller).toHaveBeenCalledWith(INSTALLER);
    expect(result).toEqual({ status: "installed" });
  });

  it("never downloads over an operator-supplied path", () => {
    const runInstaller = vi.fn();
    const result = ensureSftpHelper({
      helperPath: "/custom/sftp",
      env: { QUICK_SHELL_SFTP_HELPER: "/custom/sftp" },
      exists: () => false,
      runInstaller,
    });

    expect(runInstaller).not.toHaveBeenCalled();
    expect(result.status).toBe("user-managed");
  });

  it("reports rather than throws when the download fails", () => {
    const result = ensureSftpHelper({
      helperPath: HELPER,
      env: {},
      exists: (path) => path === INSTALLER,
      runInstaller: () => {
        throw new Error("HTTP 404 fetching release asset");
      },
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "HTTP 404 fetching release asset",
    });
  });

  it("reports when the installer runs but produces nothing", () => {
    const result = ensureSftpHelper({
      helperPath: HELPER,
      env: {},
      exists: (path) => path === INSTALLER,
      runInstaller: () => {},
    });

    expect(result.status).toBe("unavailable");
    expect(result).toHaveProperty(
      "reason",
      expect.stringContaining("still missing"),
    );
  });

  it("reports a missing installer instead of crashing", () => {
    const result = ensureSftpHelper({
      helperPath: HELPER,
      env: {},
      exists: () => false,
      runInstaller: () => {},
    });

    expect(result.status).toBe("unavailable");
  });
});

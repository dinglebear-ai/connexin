import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSftpHelperPath } from "../../src/server/config.js";
import {
  helperDestination,
  targetFor,
} from "../../scripts/sftp-helper-target.mjs";

// The installer and the server resolve the helper independently. If they ever
// disagree on the filename, the download "succeeds" and the server still
// reports the binary as missing, so pin them together.
describe("helper path agreement between installer and server", () => {
  it("uses the extensionless name off Windows", () => {
    expect(basename(defaultSftpHelperPath({}, "linux"))).toBe("connexin-sftp");
    expect(basename(defaultSftpHelperPath({}, "darwin"))).toBe("connexin-sftp");
  });

  it("uses the .exe name on Windows, matching what the installer writes", () => {
    expect(basename(defaultSftpHelperPath({}, "win32"))).toBe(
      "connexin-sftp.exe",
    );
  });

  it.each([
    ["linux", "x64"],
    ["linux", "arm64"],
    ["darwin", "arm64"],
    ["win32", "x64"],
  ])("agrees with helperDestination() on %s/%s", (platform, arch) => {
    const installerName = basename(
      helperDestination(targetFor(platform, arch), "/pkg"),
    );
    const serverName = basename(
      defaultSftpHelperPath({}, platform as NodeJS.Platform),
    );
    expect(serverName).toBe(installerName);
  });

  it("still honours an explicit override verbatim", () => {
    expect(
      defaultSftpHelperPath({ CONNEXIN_SFTP_HELPER: "/custom/sftp" }, "win32"),
    ).toBe("/custom/sftp");
  });
});

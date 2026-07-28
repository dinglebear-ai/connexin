import { describe, expect, it } from "vitest";
import {
  downloadUrl,
  helperDestination,
  isSourceCheckout,
  releaseBaseUrl,
  releaseVersion,
  shouldSkipDownload,
  supportedTargets,
  targetFor,
} from "../../scripts/sftp-helper-target.mjs";

describe("targetFor", () => {
  it("maps every supported platform/arch to an asset and binary name", () => {
    expect(targetFor("linux", "x64")).toEqual({
      asset: "quick-shell-sftp-linux-x86_64.tar.gz",
      binary: "quick-shell-sftp",
    });
    expect(targetFor("darwin", "arm64").asset).toBe(
      "quick-shell-sftp-darwin-arm64.tar.gz",
    );
  });

  it("uses the .exe binary name on Windows", () => {
    expect(targetFor("win32", "x64").binary).toBe("quick-shell-sftp.exe");
    expect(targetFor("win32", "arm64").binary).toBe("quick-shell-sftp.exe");
  });

  it("rejects unsupported combinations and names what is supported", () => {
    expect(() => targetFor("sunos", "sparc")).toThrow(
      /Unsupported platform sunos\/sparc/,
    );
    expect(() => targetFor("linux", "ia32")).toThrow(/linux\/x64/);
  });

  it("advertises exactly the six targets the release matrix builds", () => {
    expect(supportedTargets().sort()).toEqual(
      [
        "darwin/arm64",
        "darwin/x64",
        "linux/arm64",
        "linux/x64",
        "win32/arm64",
        "win32/x64",
      ].sort(),
    );
  });
});

describe("release coordinates", () => {
  it("prefixes a bare version with v", () => {
    expect(releaseVersion({ QUICK_SHELL_HELPER_VERSION: "1.2.3" })).toBe(
      "v1.2.3",
    );
    expect(releaseVersion({ QUICK_SHELL_HELPER_VERSION: "v1.2.3" })).toBe(
      "v1.2.3",
    );
  });

  it("falls back to the package version so tag and package stay coupled", () => {
    expect(releaseVersion({})).toMatch(/^v\d+\.\d+\.\d+/);
  });

  it("points at the canonical repo rather than a rename redirect", () => {
    expect(releaseBaseUrl({})).toBe(
      "https://github.com/dinglebear-ai/quick-shell/releases/download",
    );
  });

  it("honours a base URL override and trims trailing slashes", () => {
    expect(
      releaseBaseUrl({
        QUICK_SHELL_RELEASE_BASE_URL: "https://mirror.test/dl//",
      }),
    ).toBe("https://mirror.test/dl");
  });

  it("builds a full asset URL", () => {
    const env = {
      QUICK_SHELL_RELEASE_BASE_URL: "https://mirror.test/dl",
      QUICK_SHELL_HELPER_VERSION: "9.9.9",
    };
    expect(downloadUrl(targetFor("linux", "x64"), env)).toBe(
      "https://mirror.test/dl/v9.9.9/quick-shell-sftp-linux-x86_64.tar.gz",
    );
  });
});

describe("install guards", () => {
  it("honours the skip flag", () => {
    expect(shouldSkipDownload({ QUICK_SHELL_SKIP_HELPER_DOWNLOAD: "1" })).toBe(
      true,
    );
    expect(
      shouldSkipDownload({ QUICK_SHELL_SKIP_HELPER_DOWNLOAD: "true" }),
    ).toBe(true);
    expect(shouldSkipDownload({})).toBe(false);
    expect(shouldSkipDownload({ QUICK_SHELL_SKIP_HELPER_DOWNLOAD: "0" })).toBe(
      false,
    );
  });

  it("detects a source checkout by its Go sources", () => {
    const exists = (path: string) =>
      path.endsWith("go.mod") || path.endsWith("quick-shell-sftp");
    expect(isSourceCheckout("/repo", exists)).toBe(true);
    expect(isSourceCheckout("/repo", () => false)).toBe(false);
  });
});

describe("helperDestination", () => {
  it("matches the layout defaultSftpHelperPath() expects", () => {
    expect(helperDestination(targetFor("linux", "x64"), "/pkg")).toBe(
      "/pkg/dist/bin/quick-shell-sftp",
    );
  });
});

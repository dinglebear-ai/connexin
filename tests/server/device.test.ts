import { describe, expect, it } from "vitest";
import { sanitizeSuggestedCommand, validateDevice } from "../../src/server/device.js";

describe("validateDevice", () => {
  const allowed = new Set(["fileserver", "admin-box"]);

  it("accepts allowlisted aliases", () => {
    expect(validateDevice("fileserver", allowed)).toBe("fileserver");
  });

  it("rejects unknown aliases", () => {
    expect(() => validateDevice("unknown", allowed)).toThrow("not listed in SSH config");
  });

  it("rejects unsupported target characters", () => {
    expect(() => validateDevice("bad host", allowed)).toThrow("unsupported characters");
  });

  it("rejects leading dash targets", () => {
    expect(() => validateDevice("-oProxyCommand=sh", allowed)).toThrow("must not start with '-'");
  });

  it("uses the configured device length limit without reloading environment config", () => {
    expect(() => validateDevice("fileserver", allowed, 3)).toThrow("device is too long");
  });
});

describe("sanitizeSuggestedCommand", () => {
  it("removes line breaks without appending enter", () => {
    expect(sanitizeSuggestedCommand("echo ok\nrm -rf /")).toBe("echo ok rm -rf /");
  });

  it("uses the configured suggested command length limit", () => {
    expect(sanitizeSuggestedCommand("abcdef", 3)).toBe("abc");
  });
});

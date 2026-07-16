import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadDeviceMetadata,
  parseQuickShellToml,
  type DeviceMetadataConfig,
} from "../../src/server/device-metadata.js";
import { QuickShellSessionManager } from "../../src/server/session-manager.js";
import { testRuntimeConfig } from "./helpers/runtime-config.js";

describe("parseQuickShellToml", () => {
  it("parses string metadata from device tables", () => {
    const config = parseQuickShellToml(`
      [devices.devbox]
      label = "Dev Box"
      group = "dev"
      danger = "normal"
      default_shell = "zsh"

      [devices."admin-box"]
      label = "Agent OS"
      danger = "caution"
    `);

    expect(config.devices.get("devbox")).toEqual({
      label: "Dev Box",
      group: "dev",
      danger: "normal",
      defaultShell: "zsh",
    });
    expect(config.devices.get("admin-box")).toEqual({
      label: "Agent OS",
      danger: "caution",
    });
  });

  it("rejects invalid danger values", () => {
    expect(() =>
      parseQuickShellToml(`
        [devices.fileserver]
        danger = "spicy"
      `),
    ).toThrow("danger must be normal, caution, or danger");
  });

  it("loads an empty config when the file is absent", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "quick-shell-metadata-"));
    try {
      const config = await loadDeviceMetadata(join(tempDir, "missing.toml"));
      expect(config.devices.size).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns a fresh empty config when the file is absent", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "quick-shell-metadata-"));
    try {
      const missingPath = join(tempDir, "missing.toml");
      const first = await loadDeviceMetadata(missingPath);
      first.devices.set("mutated", { label: "Mutated" });

      const second = await loadDeviceMetadata(missingPath);

      expect(second.devices.has("mutated")).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports invalid quoted device table names with line context", () => {
    expect(() =>
      parseQuickShellToml('[devices."unterminated]\nlabel = "bad"\n'),
    ).toThrow("quick-shell.toml line 1: invalid device table name");
  });

  it("loads metadata from disk", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "quick-shell-metadata-"));
    try {
      const configPath = join(tempDir, "quick-shell.toml");
      await writeFile(
        configPath,
        '[devices.fileserver]\nlabel = "File Server"\n',
      );

      const config = await loadDeviceMetadata(configPath);

      expect(config.devices.get("fileserver")?.label).toBe("File Server");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("device metadata integration", () => {
  const metadata: DeviceMetadataConfig = {
    devices: new Map([
      [
        "fileserver",
        {
          label: "File Server",
          group: "storage",
          danger: "danger",
          defaultShell: "bash",
        },
      ],
      ["unknown", { label: "Unknown Box" }],
    ]),
  };

  it("decorates allowed SSH aliases", async () => {
    const manager = new QuickShellSessionManager({
      config: testRuntimeConfig(),
      allowedHosts: new Set(["fileserver"]),
      deviceMetadata: metadata,
      ptyFactory: () => {
        throw new Error("should not spawn");
      },
    });

    const session = await manager.createSession({ device: "fileserver" });

    expect(session.publicSummary).toMatchObject({
      device: "fileserver",
      deviceLabel: "File Server",
      deviceGroup: "storage",
      deviceDanger: "danger",
      deviceDefaultShell: "bash",
    });
  });

  it("does not allow aliases just because they exist in quick-shell.toml", async () => {
    const manager = new QuickShellSessionManager({
      config: testRuntimeConfig(),
      allowedHosts: new Set(["fileserver"]),
      deviceMetadata: metadata,
      ptyFactory: () => {
        throw new Error("should not spawn");
      },
    });

    await expect(manager.createSession({ device: "unknown" })).rejects.toThrow(
      "not listed in SSH config",
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  defaultRunner,
  runVerifyDeployment,
  type BuildManifest,
  type CommandRunner,
} from "../../scripts/verify-deployment.js";

function json(value: unknown): string {
  return JSON.stringify(value);
}

describe("runVerifyDeployment", () => {
  const runtimeToolNames = [
    "check_connexin",
    "list_connexin_devices",
    "open_connexin",
    "get_connexin_session",
    "poll_connexin_session",
    "write_connexin_input",
    "resize_connexin_session",
    "close_connexin_session",
    "record_connexin_output_confirmed",
    "list_connexin_files",
    "prepare_connexin_file_operation",
    "mkdir_connexin_path",
    "rename_connexin_path",
    "delete_connexin_path",
  ];
  const appOnlyMetadata = runtimeToolNames.slice(3).map((name) => ({
    name,
    visibility: ["app"],
    hasUiResource: false,
    hasOutputTemplate: false,
    openaiVisibility: "private",
  }));
  const manifest: BuildManifest = {
    version: 1,
    packageName: "@dinglebear/connexin",
    gitSha: "abc123",
    gitDirty: false,
    builtAt: "2026-07-14T00:00:00.000Z",
    files: {
      "package.json": "a".repeat(64),
      "package-lock.json": "b".repeat(64),
      "src/app/mcp-app.html": "c".repeat(64),
      "dist/app/src/app/mcp-app.html": "d".repeat(64),
      "dist/server/server/main.js": "e".repeat(64),
      "dist/server/cli/main.js": "f".repeat(64),
      "dist/bin/connexin-sftp": "0".repeat(64),
    },
  };

  function shaLines(buildManifest = manifest): string {
    return Object.entries(buildManifest.files)
      .map(([path, hash]) => `${hash}  ${path}`)
      .join("\n");
  }

  function passingRunner(buildManifest = manifest): {
    calls: string[];
    run: CommandRunner;
  } {
    const calls: string[] = [];
    return {
      calls,
      run: async (command, args) => {
        const call = [command, ...args].join(" ");
        const normalizedCall = call.replaceAll("'", "");
        calls.push(call);
        if (
          (command === "incus" || command === "bash") &&
          call.includes("test -d")
        ) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (
          (command === "incus" || command === "bash") &&
          call.includes("cat dist/connexin-build-manifest.json")
        ) {
          return { stdout: json(buildManifest), stderr: "", exitCode: 0 };
        }
        if (
          (command === "incus" || command === "bash") &&
          call.includes("sha256sum")
        ) {
          return { stdout: shaLines(buildManifest), stderr: "", exitCode: 0 };
        }
        if (
          (command === "incus" || command === "bash") &&
          call.includes("resource_smoke")
        ) {
          return {
            stdout: json({
              toolNames: runtimeToolNames,
              appOnlyMetadata,
              resourceCount: 1,
              mimeType: "text/html;profile=mcp-app",
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (
          command === "gatewayctl" &&
          normalizedCall.includes("gateway get")
        ) {
          return {
            stdout: json({
              config: {
                enabled: true,
                command: "node",
                args: ["/opt/connexin/dist/server/server/main.js", "--stdio"],
              },
              runtime: {
                exposed_tool_count: runtimeToolNames.length,
                last_error: null,
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (
          command === "gatewayctl" &&
          normalizedCall.includes("gateway mcp list")
        ) {
          return {
            stdout: json([
              {
                name: "connexin",
                enabled: true,
                connected: true,
                exposed_tool_count: runtimeToolNames.length,
                likely_stale_count: 0,
              },
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        if (
          command === "gatewayctl" &&
          normalizedCall.includes("gateway code exec")
        ) {
          const code = normalizedCall;
          if (code.includes("codemode.search")) {
            return {
              stdout: json({
                result: [
                  { id: "connexin::check_connexin" },
                  { id: "connexin::list_connexin_devices" },
                  { id: "connexin::open_connexin" },
                ],
              }),
              stderr: "",
              exitCode: 0,
            };
          }
          return {
            stdout: json({ result: { ok: true, result: { ok: true } } }),
            stderr: "",
            exitCode: 0,
          };
        }
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      },
    };
  }

  it("passes when source, gateway, runtime, code mode, and resource checks pass", async () => {
    const { calls, run } = passingRunner();

    const result = await runVerifyDeployment({
      run,
      expectedManifest: manifest,
    });

    expect(result.ok).toBe(true);
    expect(
      calls.some((call) =>
        call.includes("cat dist/connexin-build-manifest.json"),
      ),
    ).toBe(true);
    expect(calls.some((call) => call.includes("sha256sum"))).toBe(true);
    expect(
      calls.some((call) => call.replaceAll("'", "").includes("gateway get")),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.replaceAll("'", "").includes("gateway code exec"),
      ),
    ).toBe(true);
    expect(calls.some((call) => call.includes("callTool"))).toBe(true);
    expect(
      calls.some(
        (call) => call.includes("mktemp") && call.includes("resource_smoke"),
      ),
    ).toBe(true);
    expect(
      calls.some((call) => call.includes(".connexin-resource-smoke")),
    ).toBe(true);
  });

  it("fails with a recovery hint when deployment reports stale stdio state", async () => {
    const run: CommandRunner = async (command, args) => {
      const call = [command, ...args].join(" ");
      const normalizedCall = call.replaceAll("'", "");
      if (
        command === "bash" &&
        normalizedCall.includes("cat dist/connexin-build-manifest.json")
      ) {
        return { stdout: json(manifest), stderr: "", exitCode: 0 };
      }
      if (command === "bash" && normalizedCall.includes("sha256sum"))
        return { stdout: shaLines(), stderr: "", exitCode: 0 };
      if (command === "bash") return { stdout: "", stderr: "", exitCode: 0 };
      if (command === "gatewayctl" && normalizedCall.includes("gateway get")) {
        return {
          stdout: json({
            config: {
              enabled: true,
              command: "node",
              args: ["/opt/connexin/dist/server/server/main.js", "--stdio"],
            },
            runtime: {
              exposed_tool_count: runtimeToolNames.length,
              last_error: "upstream call failed: Transport closed",
            },
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (
        command === "gatewayctl" &&
        normalizedCall.includes("gateway mcp list")
      ) {
        return {
          stdout: json([
            {
              name: "connexin",
              enabled: true,
              connected: false,
              exposed_tool_count: runtimeToolNames.length,
            },
          ]),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: json({ result: [] }), stderr: "", exitCode: 0 };
    };

    const result = await runVerifyDeployment({
      run,
      expectedManifest: manifest,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("Transport closed");
    expect(result.recoveryHint).toContain("Restart or recycle");
  });

  it("does not treat command spawn failures as success", async () => {
    const result = await defaultRunner("__connexin_missing_command__", []);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("__connexin_missing_command__");
  });

  it("fails when the deployed build manifest is not the local build", async () => {
    const deployed = { ...manifest, gitSha: "old" };
    const { calls, run } = passingRunner(deployed);

    const result = await runVerifyDeployment({
      run,
      expectedManifest: manifest,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain(
      "deployed gitSha old does not match local abc123",
    );
    expect(
      calls.some((call) => call.replaceAll("'", "").includes("gateway get")),
    ).toBe(false);
    expect(calls.some((call) => call.includes("resource_smoke"))).toBe(false);
  });

  it("fails clearly when the deployed build manifest JSON shape is invalid", async () => {
    const invalidManifest = {
      ...manifest,
      files: {
        "package.json": "not-a-sha",
      },
    };
    const { run } = passingRunner(invalidManifest as BuildManifest);

    const result = await runVerifyDeployment({
      run,
      expectedManifest: manifest,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain(
      "container build manifest: invalid JSON shape",
    );
    expect(result.failures.join("\n")).toContain("files.package.json");
  });

  it("fails when deployment is pointed at a different server command", async () => {
    const { run } = passingRunner();
    const wrappedRun: CommandRunner = async (command, args) => {
      const result = await run(command, args);
      const normalizedCall = [command, ...args].join(" ").replaceAll("'", "");
      if (command === "gatewayctl" && normalizedCall.includes("gateway get")) {
        const parsed = JSON.parse(result.stdout) as {
          config: { command: string; args: string[] };
        };
        parsed.config.command = "/usr/bin/node";
        parsed.config.args = [
          "/tmp/connexin/dist/server/server/main.js",
          "--stdio",
        ];
        return { ...result, stdout: json(parsed) };
      }
      return result;
    };

    const result = await runVerifyDeployment({
      run: wrappedRun,
      expectedManifest: manifest,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain(
      "command /usr/bin/node does not match node",
    );
    expect(result.failures.join("\n")).toContain(
      "/tmp/connexin/dist/server/server/main.js",
    );
  });

  it("allows gateway search to index token-gated app-only helpers", async () => {
    const { run } = passingRunner();
    const wrappedRun: CommandRunner = async (command, args) => {
      const normalizedCall = [command, ...args].join(" ").replaceAll("'", "");
      if (
        command === "gatewayctl" &&
        normalizedCall.includes("gateway code exec") &&
        normalizedCall.includes("codemode.search")
      ) {
        return {
          stdout: json({
            result: [
              { id: "connexin::check_connexin" },
              { id: "connexin::list_connexin_devices" },
              { id: "connexin::open_connexin" },
              { id: "connexin::write_connexin_input" },
            ],
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      return run(command, args);
    };

    const result = await runVerifyDeployment({
      run: wrappedRun,
      expectedManifest: manifest,
    });

    expect(result.ok).toBe(true);
  });

  it("fails when app-only helpers bind their own app resource", async () => {
    const { run } = passingRunner();
    const wrappedRun: CommandRunner = async (command, args) => {
      const normalizedCall = [command, ...args].join(" ").replaceAll("'", "");
      if (
        (command === "incus" || command === "bash") &&
        normalizedCall.includes("resource_smoke")
      ) {
        return {
          stdout: json({
            toolNames: runtimeToolNames,
            appOnlyMetadata: appOnlyMetadata.map((tool) =>
              tool.name === "write_connexin_input"
                ? {
                    ...tool,
                    hasUiResource: true,
                    hasOutputTemplate: true,
                    openaiVisibility: "public",
                  }
                : tool,
            ),
            resourceCount: 1,
            mimeType: "text/html;profile=mcp-app",
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      return run(command, args);
    };

    const result = await runVerifyDeployment({
      run: wrappedRun,
      expectedManifest: manifest,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain(
      "resource smoke: write_connexin_input binds a UI resource",
    );
    expect(result.failures.join("\n")).toContain(
      "resource smoke: write_connexin_input binds an OpenAI output template",
    );
  });

  it("fails clearly when gateway JSON shape is invalid", async () => {
    const { run } = passingRunner();
    const wrappedRun: CommandRunner = async (command, args) => {
      const normalizedCall = [command, ...args].join(" ").replaceAll("'", "");
      if (command === "gatewayctl" && normalizedCall.includes("gateway get")) {
        return {
          stdout: json({
            config: {
              enabled: true,
              command: "node",
              args: "/opt/connexin/dist/server/server/main.js --stdio",
            },
            runtime: {
              exposed_tool_count: runtimeToolNames.length,
              last_error: null,
            },
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      return run(command, args);
    };

    const result = await runVerifyDeployment({
      run: wrappedRun,
      expectedManifest: manifest,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain(
      "gateway get: invalid JSON shape",
    );
    expect(result.failures.join("\n")).toContain("config.args");
  });

  it("fails clearly when resource smoke JSON shape is invalid", async () => {
    const { run } = passingRunner();
    const wrappedRun: CommandRunner = async (command, args) => {
      const normalizedCall = [command, ...args].join(" ");
      if (
        (command === "incus" || command === "bash") &&
        normalizedCall.includes("resource_smoke")
      ) {
        return {
          stdout: json({
            toolNames: "open_connexin",
            resourceCount: "one",
            mimeType: "text/html;profile=mcp-app",
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      return run(command, args);
    };

    const result = await runVerifyDeployment({
      run: wrappedRun,
      expectedManifest: manifest,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain(
      "resource smoke: invalid JSON shape",
    );
    expect(result.failures.join("\n")).toContain("toolNames");
  });

  it("fails when the local build manifest was created from a dirty worktree", async () => {
    const dirtyManifest = { ...manifest, gitDirty: true };
    const { run } = passingRunner(dirtyManifest);

    const result = await runVerifyDeployment({
      run,
      expectedManifest: dirtyManifest,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain(
      "build was created from a dirty working tree",
    );
  });
});

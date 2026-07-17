import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../../src/server/config.js";
import {
  createServer,
  resetAppHtmlCacheForTests,
} from "../../src/server/create-server.js";
import {
  publicStructuredContent,
  quickShellPublicOutputSchema,
} from "../../src/server/mcp-tooling.js";
import { QuickShellSessionManager } from "../../src/server/session-manager.js";
import { QuickShellPublicSessionSchema } from "../../src/shared/protocol.js";
import { FakePty } from "./helpers/fake-pty.js";
import { testRuntimeConfig } from "./helpers/runtime-config.js";

const APP_RESOURCE_URI = "ui://quick-shell/mcp-app.v2.html";
const LEGACY_APP_RESOURCE_URI = "ui://quick-shell/mcp-app.html";
const APP_HTML_PATH = resolve("dist/app/mcp-app.html");

async function withBuiltAppHtml<T>(
  html: string,
  run: () => Promise<T>,
): Promise<T> {
  let originalHtml: string | undefined;
  try {
    originalHtml = await readFile(APP_HTML_PATH, "utf8");
  } catch {
    originalHtml = undefined;
  }

  await mkdir(resolve("dist/app"), { recursive: true });
  await writeFile(APP_HTML_PATH, html);
  resetAppHtmlCacheForTests();
  try {
    return await run();
  } finally {
    resetAppHtmlCacheForTests();
    if (originalHtml === undefined) {
      await rm(APP_HTML_PATH, { force: true });
    } else {
      await writeFile(APP_HTML_PATH, originalHtml);
    }
  }
}

async function connectClient(server = createTestServer().server) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

function createTestServer(
  bridgeBaseUrl = "http://127.0.0.1:34567",
  overrides: Partial<RuntimeConfig> = {},
) {
  const ptys: FakePty[] = [];
  const runtimeConfig = testRuntimeConfig(overrides);
  const manager = new QuickShellSessionManager({
    config: runtimeConfig,
    allowedHosts: new Set(["test-device"]),
    deviceMetadata: {
      devices: new Map([
        [
          "test-device",
          {
            label: "Test Device",
            group: "lab",
            danger: "caution",
            defaultShell: "zsh",
          },
        ],
      ]),
    },
    ptyFactory: () => {
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    },
  });
  return {
    server: createServer({ bridgeBaseUrl, config: runtimeConfig, manager }),
    manager,
    ptys,
  };
}

async function connectTestClient(fixture = createTestServer()) {
  return {
    ...(await connectClient(fixture.server)),
    manager: fixture.manager,
    ptys: fixture.ptys,
  };
}

describe("createServer", () => {
  it("derives and validates the public MCP session projection from one schema", () => {
    expect(Object.keys(quickShellPublicOutputSchema)).toEqual(
      Object.keys(QuickShellPublicSessionSchema.shape),
    );
    expect(
      publicStructuredContent({
        sessionId: "session-1",
        device: "test-device",
        reason: "debug",
        leaked: "not public",
      } as never),
    ).toEqual({
      sessionId: "session-1",
      device: "test-device",
      reason: "debug",
    });
    expect(() =>
      publicStructuredContent({ sessionId: "session-1", device: "" }),
    ).toThrow();
  });

  it("returns hidden app metadata without exposing tokens in model-visible fields", async () => {
    const { client, server, manager, ptys } = await connectTestClient();
    try {
      const result = await client.callTool({
        name: "open_quick_shell",
        arguments: {
          device: "test-device",
          reason: "debug",
          suggested_command: "uptime",
        },
      });

      expect(JSON.stringify(result.content)).not.toMatch(/appToken|wsToken/);
      expect(JSON.stringify(result.structuredContent)).not.toMatch(
        /appToken|wsToken/,
      );
      expect(result.structuredContent).toMatchObject({
        device: "test-device",
        suggestedCommand: "uptime",
      });
      const quickShell = result._meta?.quickShell as {
        sessionId: string;
        appToken: string;
      };
      expect(quickShell).toMatchObject({
        sessionId: expect.any(String),
        appToken: expect.any(String),
      });
      const appSession = result._meta?.quickShellSession as {
        sessionId: string;
        wsUrl: string;
        wsToken: string;
        maxInputBytes: number;
        maxWsPayloadBytes: number;
      };
      expect(appSession).toMatchObject({
        sessionId: quickShell.sessionId,
        wsUrl: expect.stringContaining("/terminal?session="),
        wsToken: expect.any(String),
        maxInputBytes: 16_384,
        maxWsPayloadBytes: 16_384,
      });
      expect(appSession.wsUrl).not.toContain("token=");

      expect(JSON.stringify(result.content)).not.toContain(quickShell.appToken);
      expect(JSON.stringify(result.structuredContent)).not.toContain(
        quickShell.appToken,
      );
      expect(JSON.stringify(result.content)).not.toContain(appSession.wsToken);
      expect(JSON.stringify(result.structuredContent)).not.toContain(
        appSession.wsToken,
      );
      expect(manager.getSession(quickShell.sessionId)?.pty).toBeUndefined();
      expect(ptys).toEqual([]);
    } finally {
      await server.close();
      await client.close();
    }
  });

  it("uses wss URLs and CSP domains for an https public bridge", async () => {
    await withBuiltAppHtml("<html>fixture</html>", async () => {
      const { client, server } = await connectTestClient(
        createTestServer("https://quick-shell.example"),
      );
      try {
        const result = await client.callTool({
          name: "open_quick_shell",
          arguments: { device: "test-device" },
        });
        const appSession = result._meta?.quickShellSession as { wsUrl: string };
        expect(appSession.wsUrl).toMatch(
          /^wss:\/\/quick-shell\.example\/terminal\?/,
        );

        const resource = await client.readResource({ uri: APP_RESOURCE_URI });
        expect(resource.contents[0]?._meta).toMatchObject({
          ui: {
            csp: {
              connectDomains: [
                "https://quick-shell.example",
                "wss://quick-shell.example",
              ],
            },
          },
        });
      } finally {
        await server.close();
        await client.close();
      }
    });
  });

  it("reports unhealthy once the audit sink starts failing", async () => {
    const runtimeConfig = testRuntimeConfig();
    let failWrites = false;
    const manager = new QuickShellSessionManager({
      config: runtimeConfig,
      allowedHosts: new Set(["test-device"]),
      audit: {
        record: () => {
          if (failWrites) throw new Error("ENOSPC: no space left on device");
        },
      },
      ptyFactory: () => new FakePty(),
    });
    const { client } = await connectClient(
      createServer({
        bridgeBaseUrl: "http://127.0.0.1:34567",
        config: runtimeConfig,
        manager,
      }),
    );

    const healthy = await client.callTool({
      name: "check_quick_shell",
      arguments: {},
    });
    expect(healthy.structuredContent).toMatchObject({
      ok: true,
      auditHealthy: true,
      droppedAuditRecords: 0,
    });

    // Sessions keep serving shells when auditing breaks, so the health check is
    // the only thing that can tell an operator the log now has gaps.
    failWrites = true;
    await manager.createSession({ device: "test-device" });

    const degraded = await client.callTool({
      name: "check_quick_shell",
      arguments: {},
    });
    expect(degraded.structuredContent).toMatchObject({
      ok: false,
      auditHealthy: false,
    });
    expect(
      (degraded.structuredContent as { droppedAuditRecords: number })
        .droppedAuditRecords,
    ).toBeGreaterThan(0);
    expect(JSON.stringify(degraded.content)).toContain("degraded");

    failWrites = false;
    manager.recordAuditEvent("session_closed", { sessionId: "s1" });
    const recovered = await client.callTool({
      name: "check_quick_shell",
      arguments: {},
    });
    expect(recovered.structuredContent).toMatchObject({
      ok: true,
      auditHealthy: true,
      droppedAuditRecords: 0,
    });
  });

  it("serves a side-effect-free health check and tool errors for invalid opens", async () => {
    const { client, server } = await connectTestClient();
    try {
      const health = await client.callTool({
        name: "check_quick_shell",
        arguments: {},
      });
      expect(health.structuredContent).toMatchObject({ ok: true });

      const devices = await client.callTool({
        name: "list_quick_shell_devices",
        arguments: {},
      });
      expect(devices.structuredContent).toMatchObject({
        devices: [
          {
            alias: "test-device",
            label: "Test Device",
            group: "lab",
            danger: "caution",
            defaultShell: "zsh",
          },
        ],
      });

      const invalid = await client.callTool({
        name: "open_quick_shell",
        arguments: { device: "unknown" },
      });
      expect(invalid.isError).toBe(true);
      expect(JSON.stringify(invalid.content)).toContain(
        "not listed in SSH config",
      );

      const listed = await client.listTools();
      const healthTool = listed.tools.find(
        (tool) => tool.name === "check_quick_shell",
      );
      expect(healthTool?._meta?.ui).toBeUndefined();
      expect(healthTool?.outputSchema).toMatchObject({
        properties: { ok: { type: "boolean" } },
      });
      expect(healthTool?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      });
    } finally {
      await server.close();
      await client.close();
    }
  });

  it("exposes server instructions and portable MCP App tool metadata", async () => {
    const { client, server } = await connectTestClient();
    try {
      expect(client.getInstructions()).toContain(
        "human-controlled SSH terminal",
      );

      const listed = await client.listTools();
      const openTool = listed.tools.find(
        (tool) => tool.name === "open_quick_shell",
      );
      const listTool = listed.tools.find(
        (tool) => tool.name === "list_quick_shell_devices",
      );
      const appOnly = listed.tools.find(
        (tool) => tool.name === "get_quick_shell_session",
      );

      expect(openTool?.outputSchema).toMatchObject({
        properties: {
          sessionId: { type: "string" },
          device: { type: "string" },
          suggestedCommand: { type: "string" },
        },
      });
      expect(openTool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      });
      expect(openTool?._meta).toMatchObject({
        ui: {
          resourceUri: APP_RESOURCE_URI,
          visibility: ["model"],
        },
        "openai/outputTemplate": APP_RESOURCE_URI,
        "openai/widgetAccessible": false,
        "openai/visibility": "public",
      });

      expect(listTool?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      });
      expect(listTool?._meta).toMatchObject({
        "openai/visibility": "public",
      });
      expect(listTool?._meta?.ui).toBeUndefined();
      expect(listTool?._meta?.["openai/outputTemplate"]).toBeUndefined();

      expect(appOnly?._meta).toMatchObject({
        ui: {
          resourceUri: APP_RESOURCE_URI,
          visibility: ["app"],
        },
        "openai/outputTemplate": APP_RESOURCE_URI,
        "openai/widgetAccessible": true,
        "openai/visibility": "private",
      });
    } finally {
      await server.close();
      await client.close();
    }
  });

  it("requires app token for the app-only session details tool", async () => {
    const { client, server, manager, ptys } = await connectTestClient();
    try {
      const opened = await client.callTool({
        name: "open_quick_shell",
        arguments: { device: "test-device" },
      });
      const quickShell = opened._meta?.quickShell as {
        sessionId: string;
        appToken: string;
      };

      const denied = await client.callTool({
        name: "get_quick_shell_session",
        arguments: { sessionId: quickShell.sessionId, appToken: "bad" },
      });
      expect(denied.isError).toBe(true);

      const details = await client.callTool({
        name: "get_quick_shell_session",
        arguments: quickShell,
      });
      expect(JSON.stringify(details.structuredContent)).not.toMatch(
        /wsUrl|wsToken|token=/,
      );
      const appSession = (details._meta?.quickShellSession ?? {}) as {
        wsUrl: string;
        wsToken: string;
      };
      expect(appSession.wsUrl).toContain(
        `/terminal?session=${quickShell.sessionId}`,
      );
      expect(appSession.wsUrl).not.toContain("token=");
      expect(JSON.stringify(details.structuredContent)).not.toMatch(
        quickShell.appToken,
      );
      expect(appSession.wsToken).toEqual(expect.any(String));
      expect(JSON.stringify(details.content)).not.toContain(appSession.wsToken);
      expect(manager.getSession(quickShell.sessionId)?.pty).toBeDefined();
      expect(ptys).toHaveLength(1);
    } finally {
      await server.close();
      await client.close();
    }
  });

  it("supports an app-only terminal transport without exposing terminal output in visible fields", async () => {
    const { client, server, manager, ptys } = await connectTestClient();
    try {
      const opened = await client.callTool({
        name: "open_quick_shell",
        arguments: { device: "test-device" },
      });
      const quickShell = opened._meta?.quickShell as {
        sessionId: string;
        appToken: string;
      };

      const details = await client.callTool({
        name: "get_quick_shell_session",
        arguments: quickShell,
      });
      expect(details.isError).not.toBe(true);
      expect(manager.getSession(quickShell.sessionId)?.pty).toBeDefined();
      expect(ptys).toHaveLength(1);

      const write = await client.callTool({
        name: "write_quick_shell_input",
        arguments: { ...quickShell, data: "whoami" },
      });
      expect(write.structuredContent).toMatchObject({ written: true });
      expect(ptys[0]?.writes).toEqual(["whoami"]);

      const resize = await client.callTool({
        name: "resize_quick_shell_session",
        arguments: { ...quickShell, cols: 88, rows: 33 },
      });
      expect(resize.structuredContent).toMatchObject({ resized: true });
      expect(ptys[0]?.resizes).toEqual([{ cols: 88, rows: 33 }]);

      ptys[0]?.emitData("secret terminal output");
      const poll = await client.callTool({
        name: "poll_quick_shell_session",
        arguments: { ...quickShell, afterSeq: 0 },
      });

      expect(JSON.stringify(poll.content)).not.toContain(
        "secret terminal output",
      );
      expect(JSON.stringify(poll.structuredContent)).not.toContain(
        "secret terminal output",
      );
      expect(poll.structuredContent).toMatchObject({
        sessionId: quickShell.sessionId,
        device: "test-device",
      });
      expect(poll._meta?.quickShellPoll).toMatchObject({
        sessionId: quickShell.sessionId,
        chunks: [{ seq: 1, data: "secret terminal output" }],
        nextSeq: 1,
      });
    } finally {
      await server.close();
      await client.close();
    }
  });

  it("rejects app-only terminal input above the configured UTF-8 byte limit", async () => {
    const { client, server, ptys } = await connectTestClient(
      createTestServer("http://127.0.0.1:34567", { maxInputBytes: 4 }),
    );
    try {
      const opened = await client.callTool({
        name: "open_quick_shell",
        arguments: { device: "test-device" },
      });
      const quickShell = opened._meta?.quickShell as {
        sessionId: string;
        appToken: string;
      };

      const write = await client.callTool({
        name: "write_quick_shell_input",
        arguments: { ...quickShell, data: "🙂x" },
      });

      expect(write.isError).toBe(true);
      expect(JSON.stringify(write.content)).toContain("Input validation error");
      expect(ptys[0]?.writes ?? []).toEqual([]);
    } finally {
      await server.close();
      await client.close();
    }
  });

  it("marks get_quick_shell_session app-only in tools/list", async () => {
    const { client, server } = await connectTestClient();
    try {
      const listed = await client.listTools();
      const appOnly = listed.tools.find(
        (tool) => tool.name === "get_quick_shell_session",
      );
      const closeOnly = listed.tools.find(
        (tool) => tool.name === "close_quick_shell_session",
      );
      expect(appOnly?._meta?.ui).toMatchObject({ visibility: ["app"] });
      expect(closeOnly?._meta?.ui).toMatchObject({ visibility: ["app"] });
    } finally {
      await server.close();
      await client.close();
    }
  });

  it("closes sessions through an app-only capability", async () => {
    const { client, server } = await connectTestClient();
    try {
      const opened = await client.callTool({
        name: "open_quick_shell",
        arguments: { device: "test-device" },
      });
      const quickShell = opened._meta?.quickShell as {
        sessionId: string;
        appToken: string;
      };

      const denied = await client.callTool({
        name: "close_quick_shell_session",
        arguments: { sessionId: quickShell.sessionId, appToken: "bad" },
      });
      expect(denied.isError).toBe(true);

      const closed = await client.callTool({
        name: "close_quick_shell_session",
        arguments: quickShell,
      });
      expect(closed.structuredContent).toMatchObject({ closed: true });

      const details = await client.callTool({
        name: "get_quick_shell_session",
        arguments: quickShell,
      });
      expect(details.isError).toBe(true);
    } finally {
      await server.close();
      await client.close();
    }
  });

  it("reports retained PTY termination failures as not closed and retries", async () => {
    const { client, server, manager, ptys } = await connectTestClient();
    try {
      const opened = await client.callTool({
        name: "open_quick_shell",
        arguments: { device: "test-device" },
      });
      const quickShell = opened._meta?.quickShell as {
        sessionId: string;
        appToken: string;
      };
      await client.callTool({
        name: "get_quick_shell_session",
        arguments: quickShell,
      });
      const pty = ptys[0]!;
      let attempts = 0;
      pty.kill = () => {
        attempts += 1;
        if (attempts === 1) throw new Error("kill failed");
        pty.killed = true;
      };
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const failed = await client.callTool({
        name: "close_quick_shell_session",
        arguments: quickShell,
      });
      expect(failed.isError).not.toBe(true);
      expect(failed.structuredContent).toEqual({ closed: false });
      expect(failed.structuredContent).not.toHaveProperty("alreadyClosed");
      expect(manager.getSession(quickShell.sessionId)?.pty).toBe(pty);

      const retried = await client.callTool({
        name: "close_quick_shell_session",
        arguments: quickShell,
      });
      expect(retried.structuredContent).toEqual({ closed: true });
      expect(attempts).toBe(2);
      expect(manager.getSession(quickShell.sessionId)).toBeUndefined();
      consoleError.mockRestore();
    } finally {
      vi.restoreAllMocks();
      await server.close();
      await client.close();
    }
  });

  it("audits invalid write and resize capabilities consistently", async () => {
    const fixture = createTestServer();
    const audit = vi.spyOn(fixture.manager, "recordAuditEvent");
    const { client, server } = await connectTestClient(fixture);
    try {
      const opened = await client.callTool({
        name: "open_quick_shell",
        arguments: { device: "test-device" },
      });
      const quickShell = opened._meta?.quickShell as { sessionId: string };

      const write = await client.callTool({
        name: "write_quick_shell_input",
        arguments: { ...quickShell, appToken: "bad", data: "x" },
      });
      const resize = await client.callTool({
        name: "resize_quick_shell_session",
        arguments: { ...quickShell, appToken: "bad", cols: 80, rows: 24 },
      });

      expect(write.isError).toBe(true);
      expect(resize.isError).toBe(true);
      expect(audit).toHaveBeenCalledWith(
        "app_session_rejected",
        expect.objectContaining({ reason: "invalid_write_capability" }),
      );
      expect(audit).toHaveBeenCalledWith(
        "app_session_rejected",
        expect.objectContaining({ reason: "invalid_resize_capability" }),
      );
    } finally {
      await server.close();
      await client.close();
    }
  });

  it("treats a missing app-owned session as already closed", async () => {
    const { client, server, manager } = await connectTestClient();
    try {
      const opened = await client.callTool({
        name: "open_quick_shell",
        arguments: { device: "test-device" },
      });
      const quickShell = opened._meta?.quickShell as {
        sessionId: string;
        appToken: string;
      };
      manager.closeSession(quickShell.sessionId);

      const closed = await client.callTool({
        name: "close_quick_shell_session",
        arguments: quickShell,
      });

      expect(closed.isError).not.toBe(true);
      expect(closed.structuredContent).toMatchObject({
        closed: true,
        alreadyClosed: true,
      });
    } finally {
      await server.close();
      await client.close();
    }
  });

  it("returns a safe startup failure message to the app", async () => {
    const runtimeConfig = testRuntimeConfig();
    const manager = new QuickShellSessionManager({
      config: runtimeConfig,
      allowedHosts: new Set(["test-device"]),
      ptyFactory: () => {
        throw new Error("ssh binary missing");
      },
    });
    const { client, server } = await connectClient(
      createServer({
        bridgeBaseUrl: "http://127.0.0.1:34567",
        config: runtimeConfig,
        manager,
      }),
    );
    try {
      const opened = await client.callTool({
        name: "open_quick_shell",
        arguments: { device: "test-device" },
      });
      const quickShell = opened._meta?.quickShell as {
        sessionId: string;
        appToken: string;
      };

      const details = await client.callTool({
        name: "get_quick_shell_session",
        arguments: quickShell,
      });

      expect(details.isError).toBe(true);
      expect(JSON.stringify(details.content)).toContain(
        "Unable to start quick-shell SSH session for test-device: ssh binary missing",
      );
      expect(manager.getSession(quickShell.sessionId)).toBeUndefined();
    } finally {
      await server.close();
      await client.close();
    }
  });

  it("rejects tool arguments above configured limits", async () => {
    const { client, server } = await connectClient(
      createTestServer("http://127.0.0.1:34567", { maxDeviceLength: 4 }).server,
    );
    try {
      const result = await client.callTool({
        name: "open_quick_shell",
        arguments: { device: "test-device" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(
        "Input validation error",
      );
    } finally {
      await server.close();
      await client.close();
    }
  });

  it("returns app resource CSP with bridge origins and reloads built HTML", async () => {
    let originalHtml: string | undefined;
    let client: Client | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      try {
        originalHtml = await readFile(APP_HTML_PATH, "utf8");
      } catch {
        originalHtml = undefined;
      }

      await mkdir(resolve("dist/app"), { recursive: true });
      await writeFile(APP_HTML_PATH, "<html>first</html>");
      resetAppHtmlCacheForTests();

      ({ client, server } = await connectClient(
        createTestServer("http://127.0.0.1:45678").server,
      ));
      const first = await client.readResource({ uri: APP_RESOURCE_URI });
      const legacy = await client.readResource({
        uri: LEGACY_APP_RESOURCE_URI,
      });
      await writeFile(APP_HTML_PATH, "<html>second</html>");
      resetAppHtmlCacheForTests();
      const second = await client.readResource({ uri: APP_RESOURCE_URI });

      expect(first.contents[0]).toMatchObject({
        mimeType: "text/html;profile=mcp-app",
        text: "<html>first</html>",
        _meta: {
          ui: {
            csp: {
              connectDomains: [
                "http://127.0.0.1:45678",
                "ws://127.0.0.1:45678",
              ],
              resourceDomains: [],
              frameDomains: [],
              baseUriDomains: [],
            },
            prefersBorder: false,
          },
        },
      });
      expect(legacy.contents[0]).toMatchObject({
        uri: LEGACY_APP_RESOURCE_URI,
        mimeType: "text/html;profile=mcp-app",
        text: "<html>first</html>",
      });
      expect(second.contents[0]).toMatchObject({ text: "<html>second</html>" });
    } finally {
      resetAppHtmlCacheForTests();
      await server?.close();
      await client?.close();
      if (originalHtml === undefined) {
        await rm(APP_HTML_PATH, { force: true });
      } else {
        await writeFile(APP_HTML_PATH, originalHtml);
      }
    }
  });
});

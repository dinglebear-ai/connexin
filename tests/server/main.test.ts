import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";
import {
  prepareRuntime,
  runHttp,
  startHttpMcpServer,
} from "../../src/server/main.js";
import { FakePty } from "./helpers/fake-pty.js";

async function sshConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "connexin-"));
  const path = join(dir, "config");
  await writeFile(path, "Host test-device\n  HostName 127.0.0.1\n");
  return path;
}

describe("main transports", () => {
  it("prepares stdio mode with a localhost bridge sidecar and real bridge base URL", async () => {
    const runtime = await prepareRuntime({
      env: { CONNEXIN_SSH_CONFIG: await sshConfigPath() },
      ptyFactory: () => new FakePty(),
    });
    try {
      expect(runtime.bridge.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(runtime.bridge.listenUrl).toBe(runtime.bridge.baseUrl);
    } finally {
      await runtime.close();
    }
  });

  it("prepares stdio mode with a configured public bridge URL", async () => {
    const runtime = await prepareRuntime({
      env: {
        CONNEXIN_SSH_CONFIG: await sshConfigPath(),
        CONNEXIN_BRIDGE_PUBLIC_URL: "https://connexin.example",
        CONNEXIN_ALLOWED_ORIGINS: "https://chatgpt.com",
      },
      ptyFactory: () => new FakePty(),
    });
    try {
      expect(runtime.bridge.listenUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(runtime.bridge.baseUrl).toBe("https://connexin.example");
    } finally {
      await runtime.close();
    }
  });

  it("rejects HTTP MCP requests without bearer authorization", async () => {
    const runtime = await prepareRuntime({
      env: {
        CONNEXIN_SSH_CONFIG: await sshConfigPath(),
        CONNEXIN_HTTP_TOKEN: "secret",
      },
      ptyFactory: () => new FakePty(),
    });
    const http = await startHttpMcpServer({ runtime, port: 0 });
    try {
      const response = await fetch(`${http.baseUrl}/mcp`, {
        method: "POST",
        body: "{}",
      });
      expect(response.status).toBe(401);
    } finally {
      await http.close();
      await runtime.close();
    }
  });

  it("authenticates HTTP MCP requests before parsing malformed or oversized JSON", async () => {
    const runtime = await prepareRuntime({
      env: {
        CONNEXIN_SSH_CONFIG: await sshConfigPath(),
        CONNEXIN_HTTP_TOKEN: "secret",
      },
      ptyFactory: () => new FakePty(),
    });
    const http = await startHttpMcpServer({ runtime, port: 0 });
    try {
      const malformed = await fetch(`${http.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      const oversized = await fetch(`${http.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "x".repeat(1024 * 1024) }),
      });

      expect(malformed.status).toBe(401);
      expect(oversized.status).toBe(401);
    } finally {
      await http.close();
      await runtime.close();
    }
  });

  it("rejects startup when the HTTP MCP port is already in use", async () => {
    const occupied = http.createServer();
    await new Promise<void>((resolve) =>
      occupied.listen(0, "127.0.0.1", resolve),
    );
    const address = occupied.address();
    if (address === null || typeof address === "string")
      throw new Error("test server did not bind");
    const runtime = await prepareRuntime({
      env: {
        CONNEXIN_SSH_CONFIG: await sshConfigPath(),
        CONNEXIN_HTTP_TOKEN: "secret",
      },
      ptyFactory: () => new FakePty(),
    });

    try {
      await expect(
        startHttpMcpServer({ runtime, port: address.port }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await runtime.close();
      await new Promise<void>((resolveClose, rejectClose) => {
        occupied.close((error) =>
          error ? rejectClose(error) : resolveClose(),
        );
      });
    }
  });

  it("rolls back the prepared runtime when HTTP startup fails", async () => {
    const occupied = http.createServer();
    await new Promise<void>((resolve) =>
      occupied.listen(0, "127.0.0.1", resolve),
    );
    const address = occupied.address();
    if (address === null || typeof address === "string")
      throw new Error("test server did not bind");

    try {
      await expect(
        runHttp({
          env: {
            CONNEXIN_SSH_CONFIG: await sshConfigPath(),
            CONNEXIN_HTTP_TOKEN: "secret",
            CONNEXIN_HTTP_PORT: String(address.port),
          },
          ptyFactory: () => new FakePty(),
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        occupied.close((error) =>
          error ? rejectClose(error) : resolveClose(),
        );
      });
    }
  });

  it("handles multiple authorized stateless HTTP MCP requests", async () => {
    const runtime = await prepareRuntime({
      env: {
        CONNEXIN_SSH_CONFIG: await sshConfigPath(),
        CONNEXIN_HTTP_TOKEN: "secret",
        // Stateless HTTP cannot retain MCP Apps capabilities between requests.
        // This is an explicit trusted-host escape hatch.
        CONNEXIN_REQUIRE_APP_HOST: "0",
      },
      ptyFactory: () => new FakePty(),
    });
    const http = await startHttpMcpServer({ runtime, port: 0 });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${http.baseUrl}/mcp`),
      {
        requestInit: { headers: { authorization: "Bearer secret" } },
      },
    );
    const client = new Client(
      { name: "http-test-client", version: "0.1.0" },
      {
        capabilities: {
          // open_connexin refuses hosts that do not advertise MCP Apps.
          extensions: {
            "io.modelcontextprotocol/ui": {
              mimeTypes: ["text/html;profile=mcp-app"],
            },
          },
        } as never,
      },
    );
    try {
      await client.connect(transport);

      const listed = await client.listTools();
      const opened = await client.callTool({
        name: "open_connexin",
        arguments: { device: "test-device" },
      });

      expect(listed.tools.some((tool) => tool.name === "open_connexin")).toBe(
        true,
      );
      expect(opened.structuredContent).toMatchObject({ device: "test-device" });
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      await http.close();
      await runtime.close();
    }
  });

  it("can close runtime more than once", async () => {
    const runtime = await prepareRuntime({
      env: { CONNEXIN_SSH_CONFIG: await sshConfigPath() },
      ptyFactory: () => new FakePty(),
    });

    await expect(runtime.close()).resolves.toBeUndefined();
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it("closes the stdio runtime when stdin ends", async () => {
    const child = spawn(
      process.execPath,
      [
        resolve("node_modules/.bin/tsx"),
        resolve("src/server/main.ts"),
        "--stdio",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CONNEXIN_SSH_CONFIG: await sshConfigPath(),
          CONNEXIN_CLEANUP_INTERVAL_MS: "1000",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderrText = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });

    try {
      await Promise.race([
        new Promise<void>((resolveReady) => {
          child.stderr.on("data", () => {
            if (stderrText.includes("bridge_listening")) resolveReady();
          });
        }),
        new Promise<"timeout">((resolveTimeout) =>
          setTimeout(() => resolveTimeout("timeout"), 10_000),
        ),
      ]).then((ready) => {
        if (ready === "timeout")
          throw new Error(`stdio child did not start: ${stderrText}`);
      });
      child.stdin.end();
      const exit = await Promise.race([
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolveExit) => {
            child.once("exit", (code, signal) => resolveExit({ code, signal }));
          },
        ),
        new Promise<"timeout">((resolveTimeout) =>
          setTimeout(() => resolveTimeout("timeout"), 5_000),
        ),
      ]);

      if (exit === "timeout") {
        child.kill("SIGTERM");
        throw new Error(
          `stdio child did not exit after stdin closed: ${stderrText}`,
        );
      }
      expect(exit).toMatchObject({ code: 0, signal: null });
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
  }, 20_000);

  it("schedules cleanup for sessions past max age", async () => {
    vi.useFakeTimers();
    const ptys: FakePty[] = [];
    const runtime = await prepareRuntime({
      env: {
        CONNEXIN_SSH_CONFIG: await sshConfigPath(),
        CONNEXIN_MAX_SESSION_AGE_MS: "1",
        CONNEXIN_IDLE_GRACE_MS: "60000",
        CONNEXIN_CLEANUP_INTERVAL_MS: "5",
      },
      ptyFactory: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    });
    try {
      const session = await runtime.manager.createSession({
        device: "test-device",
      });
      runtime.manager.startSession(session.id);

      await vi.advanceTimersByTimeAsync(10);

      expect(runtime.manager.getSession(session.id)).toBeUndefined();
      expect(ptys[0]?.killed).toBe(true);
    } finally {
      await runtime.close();
      vi.useRealTimers();
    }
  });
});

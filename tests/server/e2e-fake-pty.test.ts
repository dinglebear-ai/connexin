import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { prepareRuntime } from "../../src/server/main.js";
import type { ServerTerminalMessage } from "../../src/shared/protocol.js";
import { FakePty } from "./helpers/fake-pty.js";
import WebSocket from "ws";

async function sshConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "quick-shell-e2e-"));
  const path = join(dir, "config");
  await writeFile(path, "Host test-device\n  HostName 127.0.0.1\n");
  return path;
}

function nextMessage(ws: WebSocket): Promise<ServerTerminalMessage> {
  return new Promise((resolve) => {
    ws.once("message", (data) =>
      resolve(JSON.parse(data.toString()) as ServerTerminalMessage),
    );
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("quick-shell fake PTY E2E", () => {
  it("opens a session, authenticates app lookup, bridges terminal IO, and closes", async () => {
    const ptys: FakePty[] = [];
    const runtime = await prepareRuntime({
      env: { QUICK_SHELL_SSH_CONFIG: await sshConfigPath() },
      ptyFactory: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "e2e-client", version: "0.1.0" });

    try {
      await Promise.all([
        runtime.server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const opened = await client.callTool({
        name: "open_quick_shell",
        arguments: { device: "test-device", suggested_command: "uptime" },
      });

      expect(JSON.stringify(opened.content)).not.toMatch(/appToken|wsToken/);
      expect(JSON.stringify(opened.structuredContent)).not.toMatch(
        /appToken|wsToken/,
      );

      const quickShell = opened._meta?.quickShell as {
        sessionId: string;
        appToken: string;
      };
      expect(ptys).toHaveLength(0);
      const details = await client.callTool({
        name: "get_quick_shell_session",
        arguments: quickShell,
      });
      expect(ptys).toHaveLength(1);
      expect(JSON.stringify(details.structuredContent)).not.toMatch(
        /wsUrl|wsToken|token=/,
      );
      const { wsToken, wsUrl } = details._meta?.quickShellSession as {
        wsToken: string;
        wsUrl: string;
      };
      expect(wsUrl).not.toContain("token=");
      const ws = new WebSocket(wsUrl);
      const ready = nextMessage(ws);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: "authenticate", token: wsToken }));
      await expect(ready).resolves.toMatchObject({ type: "ready" });

      ws.send(JSON.stringify({ type: "input", data: "whoami" }));
      await waitForCondition(() => ptys[0]?.writes.length === 1);
      expect(ptys[0]?.writes).toEqual(["whoami"]);

      ptys[0]?.emitData("agent\n");
      await expect(nextMessage(ws)).resolves.toEqual({
        type: "output",
        data: "agent\n",
      });

      ws.send(JSON.stringify({ type: "close" }));
      await new Promise((resolve) => ws.once("close", resolve));
      expect(ptys[0]?.killed).toBe(true);
    } finally {
      await client.close();
      await runtime.close();
    }
  });
});

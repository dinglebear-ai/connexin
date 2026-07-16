import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAuditLogger, createMemoryAuditSink } from "../../src/server/audit-log.js";
import { createServer } from "../../src/server/create-server.js";
import { QuickShellSessionManager } from "../../src/server/session-manager.js";
import { testRuntimeConfig } from "./helpers/runtime-config.js";
import { FakePty } from "./helpers/fake-pty.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

describe("audit logging", () => {
  it("redacts token-shaped and output-shaped fields", () => {
    const sink = createMemoryAuditSink();
    const audit = createAuditLogger({ sink });

    audit.record("session_opened", {
      sessionId: "s1",
      device: "fileserver",
      appToken: "secret-app",
      wsToken: "secret-ws",
      output: "terminal output",
      suggestedCommand: "hostname",
    });

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({ event: "session_opened", sessionId: "s1", device: "fileserver" });
    expect(JSON.stringify(sink.records[0])).not.toMatch(/secret|terminal output|hostname|appToken|wsToken|output|suggestedCommand/);
  });

  it("redacts nested token-shaped and output-shaped fields", () => {
    const sink = createMemoryAuditSink();
    const audit = createAuditLogger({ sink });

    audit.record("session_closed", {
      sessionId: "s1",
      nested: {
        appToken: "secret-app",
        items: [{ output: "terminal output", safe: "kept" }],
      },
    });

    expect(sink.records[0]).toMatchObject({ nested: { items: [{ safe: "kept" }] } });
    expect(JSON.stringify(sink.records[0])).not.toMatch(/secret-app|terminal output|appToken|output/);
  });

  it("writes JSON lines to a configured file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "quick-shell-audit-"));
    try {
      const path = join(tempDir, "audit.jsonl");
      const audit = createAuditLogger({ path });

      audit.record("session_closed", { sessionId: "s1", device: "fileserver" });
      await audit.flush?.();

      const lines = (await readFile(path, "utf8")).trim().split("\n");
      expect(JSON.parse(lines[0]!)).toMatchObject({ event: "session_closed", sessionId: "s1", device: "fileserver" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records open, start, close, and expiration events", async () => {
    const sink = createMemoryAuditSink();
    const ptys: FakePty[] = [];
    const manager = new QuickShellSessionManager({
      config: testRuntimeConfig({ maxSessionAgeMs: 100, idleGraceMs: 100 }),
      allowedHosts: new Set(["fileserver", "admin-box"]),
      audit: createAuditLogger({ sink }),
      ptyFactory: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    });

    const started = await manager.createSession({ device: "fileserver", suggested: "hostname" });
    manager.startSession(started.id);
    manager.closeSession(started.id);
    const expired = await manager.createSession({ device: "admin-box" });
    expired.createdAt = 0;
    expired.lastActivityAt = 0;
    manager.cleanupExpiredSessions(1_000);

    expect(sink.records.map((record) => record.event)).toEqual([
      "session_opened",
      "session_started",
      "session_closed",
      "session_opened",
      "session_expired",
      "session_closed",
    ]);
    expect(JSON.stringify(sink.records)).not.toContain("hostname");
  });

  it("records output-confirm breadcrumbs through an app-only capability", async () => {
    const sink = createMemoryAuditSink();
    const manager = new QuickShellSessionManager({
      config: testRuntimeConfig(),
      allowedHosts: new Set(["test-device"]),
      audit: createAuditLogger({ sink }),
      ptyFactory: () => new FakePty(),
    });
    const server = createServer({
      bridgeBaseUrl: "http://127.0.0.1:34567",
      config: testRuntimeConfig(),
      manager,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "audit-test", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const opened = await client.callTool({ name: "open_quick_shell", arguments: { device: "test-device" } });
      const quickShell = opened._meta?.quickShell as { sessionId: string; appToken: string };

      const result = await client.callTool({
        name: "record_quick_shell_output_confirmed",
        arguments: { ...quickShell, byteCount: 42 },
      });

      expect(result.structuredContent).toMatchObject({ recorded: true });
      expect(sink.records.at(-1)).toMatchObject({
        event: "output_confirmed",
        sessionId: quickShell.sessionId,
        device: "test-device",
        byteCount: 42,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

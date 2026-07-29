import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAuditRateLimiter,
  createAuditLogger,
  createMemoryAuditSink,
} from "../../src/server/audit-log.js";
import { createServer } from "../../src/server/create-server.js";
import { ConnexinSessionManager } from "../../src/server/session-manager.js";
import { testRuntimeConfig } from "./helpers/runtime-config.js";
import { FakePty } from "./helpers/fake-pty.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

describe("audit logging", () => {
  it("bounds detailed audit records and reports how many were suppressed", () => {
    let now = 1_000;
    const details: number[] = [];
    const started: number[] = [];
    const summaries: { at: number; suppressedCount: number }[] = [];
    const limiter = createAuditRateLimiter({
      maxEvents: 3,
      windowMs: 60_000,
      now: () => now,
      onSuppressionStarted: () => started.push(now),
      onSuppressionSummary: (suppressedCount) =>
        summaries.push({ at: now, suppressedCount }),
    });

    for (let index = 0; index < 100; index += 1) {
      limiter.record(() => details.push(index));
    }

    expect(details).toEqual([0, 1, 2]);
    // An in-progress flood is visible immediately, exactly once per window.
    expect(started).toEqual([1_000]);
    // The total is only knowable at window close, so it is not reported yet.
    expect(summaries).toEqual([]);

    now += 60_000;
    limiter.record(() => details.push(100));
    expect(details).toEqual([0, 1, 2, 100]);
    // 100 attempts, 3 recorded in detail, so 97 were suppressed.
    expect(summaries).toEqual([{ at: 61_000, suppressedCount: 97 }]);
    expect(started).toEqual([1_000]);
  });

  it("does not report suppression for a window that dropped nothing", () => {
    let now = 1_000;
    const started: number[] = [];
    const summaries: number[] = [];
    const limiter = createAuditRateLimiter({
      maxEvents: 3,
      windowMs: 60_000,
      now: () => now,
      onSuppressionStarted: () => started.push(now),
      onSuppressionSummary: (suppressedCount) =>
        summaries.push(suppressedCount),
    });

    limiter.record(() => {});
    now += 60_000;
    limiter.record(() => {});

    expect(started).toEqual([]);
    expect(summaries).toEqual([]);
  });

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
    expect(sink.records[0]).toMatchObject({
      event: "session_opened",
      sessionId: "s1",
      device: "fileserver",
    });
    expect(JSON.stringify(sink.records[0])).not.toMatch(
      /secret|terminal output|hostname|appToken|wsToken|output|suggestedCommand/,
    );
  });

  it("keeps startup deployment fields that the verifier greps for", () => {
    const sink = createMemoryAuditSink();
    const audit = createAuditLogger({ sink });

    audit.record("runtime_started", {
      mode: "stdio",
      sshConfigPath: "/home/op/.ssh/config",
      connexinConfigPath: "/home/op/.config/connexin.json",
    });
    audit.record("bridge_listening", {
      baseUrl: "http://127.0.0.1:8765",
      listenUrl: "http://127.0.0.1:8765",
    });

    expect(sink.records[0]).toMatchObject({
      event: "runtime_started",
      sshConfigPath: "/home/op/.ssh/config",
      connexinConfigPath: "/home/op/.config/connexin.json",
    });
    // scripts/verify-deployment.ts greps the log for exactly this shape.
    expect(JSON.stringify(sink.records[1])).toContain(
      '"baseUrl":"http://127.0.0.1:8765"',
    );
    expect(sink.records[1]).toMatchObject({
      listenUrl: "http://127.0.0.1:8765",
    });
  });

  it("still redacts secret-bearing path and url fields", () => {
    const sink = createMemoryAuditSink();
    const audit = createAuditLogger({ sink });

    // The allowlist is exact-key, so nothing else matching path/url leaks.
    audit.record("file_operation_completed", {
      path: "/srv/secrets/key.pem",
      filename: "key.pem",
      downloadUrl: "https://example.test/?token=abc",
      lease: "lease-token",
    });

    expect(JSON.stringify(sink.records[0])).not.toMatch(
      /key\.pem|secrets|token=abc|lease-token/,
    );
  });

  it("keeps the hasAppToken diagnostic, which carries no secret", () => {
    const sink = createMemoryAuditSink();
    const audit = createAuditLogger({ sink });

    audit.record("app_session_requested", {
      sessionId: "s1",
      hasSessionId: true,
      hasAppToken: false,
    });

    // Distinguishing "no token supplied" from "wrong token supplied" is the
    // whole point of this field during incident review.
    expect(sink.records[0]).toMatchObject({
      sessionId: "s1",
      hasSessionId: true,
      hasAppToken: false,
    });
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

    expect(sink.records[0]).toMatchObject({
      nested: { items: [{ safe: "kept" }] },
    });
    expect(JSON.stringify(sink.records[0])).not.toMatch(
      /secret-app|terminal output|appToken|output/,
    );
  });

  it("writes JSON lines to a configured file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "connexin-audit-"));
    try {
      const path = join(tempDir, "audit.jsonl");
      const audit = createAuditLogger({ path });

      audit.record("session_closed", { sessionId: "s1", device: "fileserver" });
      await audit.flush?.();

      const lines = (await readFile(path, "utf8")).trim().split("\n");
      expect(JSON.parse(lines[0]!)).toMatchObject({
        event: "session_closed",
        sessionId: "s1",
        device: "fileserver",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records open, start, close, and expiration events", async () => {
    const sink = createMemoryAuditSink();
    const ptys: FakePty[] = [];
    const manager = new ConnexinSessionManager({
      config: testRuntimeConfig({ maxSessionAgeMs: 100, idleGraceMs: 100 }),
      allowedHosts: new Set(["fileserver", "admin-box"]),
      audit: createAuditLogger({ sink }),
      ptyFactory: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    });

    const started = await manager.createSession({
      device: "fileserver",
      suggested: "hostname",
    });
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
    const manager = new ConnexinSessionManager({
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
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "audit-test", version: "0.1.0" },
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
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const opened = await client.callTool({
        name: "open_connexin",
        arguments: { device: "test-device" },
      });
      const connexin = opened._meta?.connexin as {
        sessionId: string;
        appToken: string;
      };

      const result = await client.callTool({
        name: "record_connexin_output_confirmed",
        arguments: { ...connexin, byteCount: 42 },
      });

      expect(result.structuredContent).toMatchObject({ recorded: true });
      expect(sink.records.at(-1)).toMatchObject({
        event: "output_confirmed",
        sessionId: connexin.sessionId,
        device: "test-device",
        byteCount: 42,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

import http from "node:http";
import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  createAuditLogger,
  createMemoryAuditSink,
} from "../../src/server/audit-log.js";
import type { RuntimeConfig } from "../../src/server/config.js";
import { startBridgeServer } from "../../src/server/bridge-server.js";
import { QuickShellSessionManager } from "../../src/server/session-manager.js";
import { FakePty } from "./helpers/fake-pty.js";
import { testRuntimeConfig } from "./helpers/runtime-config.js";

async function fixture(overrides: Partial<RuntimeConfig> = {}) {
  const ptys: FakePty[] = [];
  const runtimeConfig = testRuntimeConfig({
    maxWsPayloadBytes: 256,
    ...overrides,
  });
  const manager = new QuickShellSessionManager({
    config: runtimeConfig,
    allowedHosts: new Set(["test-device"]),
    ptyFactory: () => {
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    },
  });
  const session = await manager.createSession({ device: "test-device" });
  manager.startSession(session.id);
  const bridge = await startBridgeServer({ config: runtimeConfig, manager });
  return { bridge, manager, ptys, session };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitForClose(
  ws: WebSocket,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    );
  });
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

function nextMessages(ws: WebSocket, count: number): Promise<unknown[]> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];
    const listener = (data: WebSocket.RawData) => {
      messages.push(JSON.parse(data.toString()));
      if (messages.length === count) {
        ws.off("message", listener);
        resolve(messages);
      }
    };
    ws.on("message", listener);
  });
}

function noMessage(ws: WebSocket): Promise<boolean> {
  return Promise.race([
    nextMessage(ws).then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 30)),
  ]);
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function wsUrl(baseUrl: string, sessionId: string): string {
  return `${baseUrl.replace("http:", "ws:")}/terminal?session=${sessionId}`;
}

async function sendMalformedUpgrade(
  baseUrl: string,
  sessionId: string,
): Promise<void> {
  const parsed = new URL(baseUrl);
  const socket = net.connect(Number(parsed.port), parsed.hostname);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  socket.end(
    [
      `GET /terminal?session=${sessionId} HTTP/1.1`,
      `Host: ${parsed.host}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "",
      "",
    ].join("\r\n"),
  );
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve();
    }, 25);
    timer.unref?.();
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function connectAndReadReady(
  url: string,
  token: string,
): Promise<WebSocket> {
  const ws = new WebSocket(url);
  const ready = nextMessage(ws);
  await waitForOpen(ws);
  ws.send(JSON.stringify({ type: "authenticate", token }));
  await expect(ready).resolves.toMatchObject({ type: "ready" });
  return ws;
}

describe("startBridgeServer", () => {
  it("starts on localhost port 0 and returns the actual base URL", async () => {
    const { bridge, manager } = await fixture();
    try {
      expect(bridge.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      manager.closeAll();
      await bridge.close();
    }
  });

  it("rejects startup when the bridge port is already in use", async () => {
    const occupied = http.createServer();
    await new Promise<void>((resolve) =>
      occupied.listen(0, "127.0.0.1", resolve),
    );
    const address = occupied.address();
    if (address === null || typeof address === "string")
      throw new Error("test server did not bind");
    const occupiedPort = address.port;
    const runtimeConfig = testRuntimeConfig({ bridgePort: occupiedPort });
    const manager = new QuickShellSessionManager({
      config: runtimeConfig,
      allowedHosts: new Set(["test-device"]),
      ptyFactory: () => new FakePty(),
    });

    try {
      await expect(
        startBridgeServer({ config: runtimeConfig, manager }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      manager.closeAll();
      await new Promise<void>((resolve, reject) => {
        occupied.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("can advertise a public bridge URL while listening locally", async () => {
    const { bridge, manager } = await fixture({
      bridgePublicUrl: "https://quick-shell.example",
    });
    try {
      expect(bridge.listenUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(bridge.baseUrl).toBe("https://quick-shell.example");
    } finally {
      manager.closeAll();
      await bridge.close();
    }
  });

  it("rejects bad session tokens with policy violation", async () => {
    const { bridge, manager, session } = await fixture();
    const ws = new WebSocket(wsUrl(bridge.baseUrl, session.id));
    const closed = waitForClose(ws);
    await waitForOpen(ws);
    ws.send(JSON.stringify({ type: "authenticate", token: "bad" }));

    await expect(closed).resolves.toMatchObject({ code: 1008 });
    manager.closeAll();
    await bridge.close();
  });

  it("does not let malformed upgrades exhaust pending authentication slots", async () => {
    const { bridge, manager, session } = await fixture();
    const url = wsUrl(bridge.baseUrl, session.id);
    try {
      for (let index = 0; index < 40; index += 1) {
        await sendMalformedUpgrade(bridge.baseUrl, session.id);
      }

      const ws = await connectAndReadReady(url, session.wsToken);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    } finally {
      manager.closeAll();
      await bridge.close();
    }
  });

  it("rejects missing session ids before WebSocket upgrade", async () => {
    const { bridge, manager } = await fixture();
    const ws = new WebSocket(
      `${bridge.baseUrl.replace("http:", "ws:")}/terminal`,
    );
    ws.once("error", () => {});
    const closed = waitForClose(ws);

    await expect(closed).resolves.toMatchObject({ code: 1006 });
    manager.closeAll();
    await bridge.close();
  });

  it("rejects configured disallowed origins", async () => {
    const { bridge, manager, session } = await fixture({
      allowedOrigins: ["https://allowed.example"],
    });
    const ws = new WebSocket(wsUrl(bridge.baseUrl, session.id), {
      headers: { Origin: "https://blocked.example" },
    });
    ws.once("error", () => {});
    const closed = waitForClose(ws);

    await expect(closed).resolves.toMatchObject({ code: 1006 });
    manager.closeAll();
    await bridge.close();
  });

  it("rejects missing origins when an origin allowlist is configured", async () => {
    const { bridge, manager, session } = await fixture({
      allowedOrigins: ["https://allowed.example"],
    });
    const ws = new WebSocket(wsUrl(bridge.baseUrl, session.id));
    ws.once("error", () => {});
    const closed = waitForClose(ws);

    await expect(closed).resolves.toMatchObject({ code: 1006 });
    manager.closeAll();
    await bridge.close();
  });

  it("bounds audit writes for a burst of unauthenticated rejections", async () => {
    const sink = createMemoryAuditSink();
    const runtimeConfig = testRuntimeConfig({
      allowedOrigins: ["https://allowed.example"],
    });
    const manager = new QuickShellSessionManager({
      config: runtimeConfig,
      allowedHosts: new Set(["test-device"]),
      audit: createAuditLogger({ sink }),
      ptyFactory: () => new FakePty(),
    });
    const session = await manager.createSession({ device: "test-device" });
    const bridge = await startBridgeServer({ config: runtimeConfig, manager });

    try {
      for (let index = 0; index < 50; index += 1) {
        const ws = new WebSocket(wsUrl(bridge.baseUrl, session.id), {
          headers: { Origin: `https://blocked-${index}.example` },
        });
        ws.once("error", () => {});
        await waitForClose(ws);
      }

      const rejections = sink.records.filter(
        (record) => record.event === "bridge_connection_rejected",
      );
      expect(rejections.length).toBeLessThan(50);
      expect(rejections).toContainEqual(
        expect.objectContaining({
          event: "bridge_connection_rejected",
          reason: "audit_rate_limited",
          suppressedEvent: "unauthenticated_bridge_rejection",
          detailLimit: 10,
          windowMs: 60_000,
        }),
      );
      const summary = rejections.find(
        (record) => record.reason === "audit_rate_limited",
      );
      expect(summary).not.toHaveProperty("origin");
      expect(summary).not.toHaveProperty("sessionId");
    } finally {
      manager.closeAll();
      await bridge.close();
    }
  });

  it("bounds audit writes for malformed pre-authentication messages", async () => {
    const sink = createMemoryAuditSink();
    const runtimeConfig = testRuntimeConfig();
    const manager = new QuickShellSessionManager({
      config: runtimeConfig,
      allowedHosts: new Set(["test-device"]),
      audit: createAuditLogger({ sink }),
      ptyFactory: () => new FakePty(),
    });
    const session = await manager.createSession({ device: "test-device" });
    const bridge = await startBridgeServer({ config: runtimeConfig, manager });
    const messages = [
      "not json",
      JSON.stringify({ type: "resize", cols: 0, rows: 0 }),
      JSON.stringify({ type: "input", data: "whoami" }),
    ];

    try {
      for (let index = 0; index < 45; index += 1) {
        const ws = new WebSocket(wsUrl(bridge.baseUrl, session.id));
        await waitForOpen(ws);
        const closed = waitForClose(ws);
        ws.send(messages[index % messages.length]);
        await closed;
      }

      const messageRejections = sink.records.filter(
        (record) => record.event === "bridge_message_rejected",
      );
      const detailed = messageRejections.filter(
        (record) => record.reason !== "audit_rate_limited",
      );
      expect(detailed).toHaveLength(10);
      // Message rejections carry their own budget, so a flood of them is
      // reported under their own event rather than spending the connection
      // rejection quota.
      expect(sink.records).toContainEqual(
        expect.objectContaining({
          event: "bridge_message_rejected",
          reason: "audit_rate_limited",
          suppressedEvent: "unauthenticated_bridge_message_rejection",
          detailLimit: 10,
          windowMs: 60_000,
        }),
      );
      expect(
        sink.records.filter(
          (record) => record.event === "bridge_connection_rejected",
        ),
      ).toEqual([]);
    } finally {
      manager.closeAll();
      await bridge.close();
    }
  });

  it("uses maxPayload", async () => {
    const { bridge, manager } = await fixture({ maxWsPayloadBytes: 1234 });
    try {
      expect(bridge.maxPayloadBytes).toBe(1234);
    } finally {
      manager.closeAll();
      await bridge.close();
    }
  });

  it("starts the SSH PTY lazily when the bridge socket connects", async () => {
    const ptys: FakePty[] = [];
    const runtimeConfig = testRuntimeConfig();
    const manager = new QuickShellSessionManager({
      config: runtimeConfig,
      allowedHosts: new Set(["test-device"]),
      ptyFactory: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    });
    const session = await manager.createSession({ device: "test-device" });
    const bridge = await startBridgeServer({ config: runtimeConfig, manager });

    expect(session.pty).toBeUndefined();
    const ws = await connectAndReadReady(
      wsUrl(bridge.baseUrl, session.id),
      session.wsToken,
    );

    expect(manager.getSession(session.id)?.pty).toBeDefined();
    expect(ptys).toHaveLength(1);
    ws.close();
    manager.closeAll();
    await bridge.close();
  });

  it("sends an error before policy-closing invalid JSON messages", async () => {
    const { bridge, manager, session } = await fixture();
    const ws = await connectAndReadReady(
      wsUrl(bridge.baseUrl, session.id),
      session.wsToken,
    );

    const message = nextMessage(ws);
    const closed = waitForClose(ws);
    ws.send("{");

    await expect(message).resolves.toEqual({
      type: "error",
      message: "invalid terminal message",
    });
    await expect(closed).resolves.toMatchObject({ code: 1008 });
    manager.closeAll();
    await bridge.close();
  });

  it("sends an error before policy-closing schema-invalid messages", async () => {
    const { bridge, manager, session } = await fixture();
    const ws = await connectAndReadReady(
      wsUrl(bridge.baseUrl, session.id),
      session.wsToken,
    );

    const message = nextMessage(ws);
    const closed = waitForClose(ws);
    ws.send(JSON.stringify({ type: "resize", cols: 1, rows: 1 }));

    await expect(message).resolves.toEqual({
      type: "error",
      message: "invalid terminal message",
    });
    await expect(closed).resolves.toMatchObject({ code: 1008 });
    manager.closeAll();
    await bridge.close();
  });

  it("enforces input length and resize bounds", async () => {
    const { bridge, manager, session } = await fixture({
      maxWsPayloadBytes: 100,
    });
    const ws = await connectAndReadReady(
      wsUrl(bridge.baseUrl, session.id),
      session.wsToken,
    );

    const oversizeClosed = waitForClose(ws);
    ws.send(JSON.stringify({ type: "input", data: "x".repeat(101) }));
    await expect(oversizeClosed).resolves.toMatchObject({ code: 1009 });

    manager.closeAll();
    await bridge.close();
  });

  it("enforces terminal input by UTF-8 bytes", async () => {
    const { bridge, manager, ptys, session } = await fixture({
      maxInputBytes: 4,
      maxWsPayloadBytes: 100,
    });
    const ws = await connectAndReadReady(
      wsUrl(bridge.baseUrl, session.id),
      session.wsToken,
    );

    ws.send(JSON.stringify({ type: "input", data: "🙂x" }));

    await expect(nextMessage(ws)).resolves.toEqual({
      type: "error",
      message: "invalid terminal message",
    });
    expect(ptys[0]?.writes).toEqual([]);
    ws.close();
    manager.closeAll();
    await bridge.close();
  });

  it("allows output confirmations up to the submit byte limit", async () => {
    const { bridge, manager, session } = await fixture({
      maxInputBytes: 8,
      maxSubmitBytes: 512,
      maxWsPayloadBytes: 128,
    });
    const ws = await connectAndReadReady(
      wsUrl(bridge.baseUrl, session.id),
      session.wsToken,
    );

    ws.send(JSON.stringify({ type: "output_confirmed", byteCount: 512 }));

    await expect(noMessage(ws)).resolves.toBe(true);
    ws.close();
    manager.closeAll();
    await bridge.close();
  });

  it("allows only one active socket per session by closing the old socket", async () => {
    const { bridge, manager, session } = await fixture();
    const url = wsUrl(bridge.baseUrl, session.id);
    const first = await connectAndReadReady(url, session.wsToken);

    const firstClosed = waitForClose(first);
    const second = await connectAndReadReady(url, session.wsToken);

    await expect(firstClosed).resolves.toMatchObject({ code: 1000 });
    second.close();
    manager.closeAll();
    await bridge.close();
  });

  it("ignores replaced socket input and disposes its PTY forwarding immediately", async () => {
    const { bridge, manager, ptys, session } = await fixture();
    const url = wsUrl(bridge.baseUrl, session.id);
    const first = await connectAndReadReady(url, session.wsToken);
    const firstClosed = waitForClose(first);
    const second = await connectAndReadReady(url, session.wsToken);
    await expect(firstClosed).resolves.toMatchObject({ code: 1000 });

    first.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "input", data: "stale" })),
    );
    expect(ptys[0]?.writes).toEqual([]);

    ptys[0]?.emitData("fresh");
    await expect(nextMessage(second)).resolves.toEqual({
      type: "output",
      data: "fresh",
    });
    await expect(noMessage(first)).resolves.toBe(true);

    second.close();
    manager.closeAll();
    await bridge.close();
  });

  it("forwards PTY output to the socket", async () => {
    const { bridge, manager, ptys, session } = await fixture();
    const ws = await connectAndReadReady(
      wsUrl(bridge.baseUrl, session.id),
      session.wsToken,
    );

    ptys[0]?.emitData("hello");

    await expect(nextMessage(ws)).resolves.toEqual({
      type: "output",
      data: "hello",
    });
    ws.close();
    manager.closeAll();
    await bridge.close();
  });

  it("replays exit status when the PTY already exited before the socket connects", async () => {
    const { bridge, manager, ptys, session } = await fixture();
    ptys[0]?.emitExit(7);
    const ws = new WebSocket(wsUrl(bridge.baseUrl, session.id));
    const messages = nextMessages(ws, 2);
    await waitForOpen(ws);
    ws.send(JSON.stringify({ type: "authenticate", token: session.wsToken }));

    await expect(messages).resolves.toEqual([
      { type: "ready", sessionId: session.id, scrollback: "" },
      { type: "exit", exitCode: 7 },
    ]);
    ws.close();
    manager.closeAll();
    await bridge.close();
  });

  it("closes slow sockets without killing the session before a single output payload exceeds the limit", async () => {
    const { bridge, manager, ptys, session } = await fixture({
      wsBufferedAmountLimitBytes: 32,
    });
    const url = wsUrl(bridge.baseUrl, session.id);
    const ws = await connectAndReadReady(url, session.wsToken);
    const closed = waitForClose(ws);

    ptys[0]?.emitData("x".repeat(128));

    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(ptys[0]?.killed).toBe(false);
    expect(manager.getSession(session.id)).toBeDefined();

    const reconnected = await connectAndReadReady(url, session.wsToken);
    ptys[0]?.emitData("fresh");
    await expect(nextMessage(reconnected)).resolves.toEqual({
      type: "output",
      data: "fresh",
    });
    reconnected.close();
    manager.closeAll();
    await bridge.close();
  });

  it("closes slow sockets without killing the session when queued output plus a new chunk exceeds the limit", async () => {
    const { bridge, manager, ptys, session } = await fixture({
      wsBufferedAmountLimitBytes: 64,
    });
    const url = wsUrl(bridge.baseUrl, session.id);
    const ws = await connectAndReadReady(url, session.wsToken);
    const originalBufferedAmount = Object.getOwnPropertyDescriptor(
      WebSocket.prototype,
      "bufferedAmount",
    );
    Object.defineProperty(WebSocket.prototype, "bufferedAmount", {
      configurable: true,
      get: () => 50,
    });
    const closed = waitForClose(ws);

    try {
      ptys[0]?.emitData("ok");

      await expect(closed).resolves.toMatchObject({ code: 1011 });
      expect(ptys[0]?.killed).toBe(false);
      expect(manager.getSession(session.id)).toBeDefined();
    } finally {
      if (originalBufferedAmount) {
        Object.defineProperty(
          WebSocket.prototype,
          "bufferedAmount",
          originalBufferedAmount,
        );
      }
      const reconnected = await connectAndReadReady(url, session.wsToken);
      ptys[0]?.emitData("fresh");
      await expect(nextMessage(reconnected)).resolves.toEqual({
        type: "output",
        data: "fresh",
      });
      reconnected.close();
      manager.closeAll();
      await bridge.close();
    }
  });

  it("closes active sockets when session cleanup closes the session", async () => {
    const { bridge, manager, ptys, session } = await fixture({
      maxSessionAgeMs: 1,
    });
    const ws = await connectAndReadReady(
      wsUrl(bridge.baseUrl, session.id),
      session.wsToken,
    );
    const closed = waitForClose(ws);
    session.createdAt = 0;
    session.lastActivityAt = 0;

    expect(manager.cleanupExpiredSessions(10)).toBe(1);

    await expect(closed).resolves.toMatchObject({ code: 1000 });
    expect(ptys[0]?.killed).toBe(true);
    await bridge.close();
  });

  it("closes the session when the client sends close", async () => {
    const { bridge, manager, ptys, session } = await fixture();
    const ws = await connectAndReadReady(
      wsUrl(bridge.baseUrl, session.id),
      session.wsToken,
    );

    ws.send(JSON.stringify({ type: "close" }));

    await waitForClose(ws);
    expect(ptys[0]?.killed).toBe(true);
    expect(manager.getSession(session.id)).toBeUndefined();
    await bridge.close();
  });

  it("rejects upgrades once too many connections sit unauthenticated", async () => {
    const sink = createMemoryAuditSink();
    const runtimeConfig = testRuntimeConfig();
    const manager = new QuickShellSessionManager({
      config: runtimeConfig,
      allowedHosts: new Set(["test-device"]),
      audit: createAuditLogger({ sink }),
      ptyFactory: () => new FakePty(),
    });
    const session = await manager.createSession({ device: "test-device" });
    const bridge = await startBridgeServer({ config: runtimeConfig, manager });
    const sockets: WebSocket[] = [];

    try {
      // Open the cap's worth of sockets and never authenticate them, so every
      // pending-auth slot stays occupied.
      for (let index = 0; index < 32; index += 1) {
        const ws = new WebSocket(wsUrl(bridge.baseUrl, session.id));
        ws.once("error", () => {});
        sockets.push(ws);
        await waitForOpen(ws);
      }

      const rejected = new WebSocket(wsUrl(bridge.baseUrl, session.id));
      const failure = new Promise<Error>((resolve) => {
        rejected.once("error", resolve);
      });
      expect((await failure).message).toContain("503");
      expect(sink.records).toContainEqual(
        expect.objectContaining({
          event: "bridge_connection_rejected",
          reason: "too_many_pending_auth_connections",
        }),
      );
    } finally {
      for (const ws of sockets) ws.close();
      manager.closeAll();
      await bridge.close();
    }
  });

  it("tears down the session when a PTY write fails", async () => {
    const sink = createMemoryAuditSink();
    const ptys: FakePty[] = [];
    const runtimeConfig = testRuntimeConfig({ maxWsPayloadBytes: 256 });
    const manager = new QuickShellSessionManager({
      config: runtimeConfig,
      allowedHosts: new Set(["test-device"]),
      audit: createAuditLogger({ sink }),
      ptyFactory: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    });
    const session = await manager.createSession({ device: "test-device" });
    manager.startSession(session.id);
    const bridge = await startBridgeServer({ config: runtimeConfig, manager });

    try {
      const ws = await connectAndReadReady(
        wsUrl(bridge.baseUrl, session.id),
        session.wsToken,
      );
      // EPIPE against an ssh process that already died is routine, not exotic.
      ptys[0]!.write = () => {
        throw new Error("EPIPE: broken pipe");
      };
      const closed = waitForClose(ws);
      ws.send(JSON.stringify({ type: "input", data: "whoami\n" }));
      await closed;

      expect(manager.getSession(session.id)).toBeUndefined();
      expect(sink.records).toContainEqual(
        expect.objectContaining({
          event: "bridge_io_failed",
          sessionId: session.id,
        }),
      );
    } finally {
      manager.closeAll();
      await bridge.close();
    }
  });

  it("ignores input and resize after PTY exit", async () => {
    const { bridge, manager, ptys, session } = await fixture();
    const ws = await connectAndReadReady(
      wsUrl(bridge.baseUrl, session.id),
      session.wsToken,
    );
    ptys[0]?.emitExit(0);
    await expect(nextMessage(ws)).resolves.toEqual({
      type: "exit",
      exitCode: 0,
    });

    ws.send(JSON.stringify({ type: "input", data: "after-exit" }));
    ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    await expect(noMessage(ws)).resolves.toBe(true);

    expect(ptys[0]?.writes).toEqual([]);
    expect(ptys[0]?.resizes).toEqual([]);
    ws.close();
    manager.closeAll();
    await bridge.close();
  });

  it("keeps connected idle sessions alive with ping activity", async () => {
    const { bridge, manager, session } = await fixture({ idleGraceMs: 50 });
    const ws = await connectAndReadReady(
      wsUrl(bridge.baseUrl, session.id),
      session.wsToken,
    );
    session.lastActivityAt = 0;

    ws.send(JSON.stringify({ type: "ping" }));
    await waitForCondition(() => session.lastActivityAt > 0);

    expect(manager.cleanupExpiredSessions(100)).toBe(0);
    expect(manager.getSession(session.id)).toBeDefined();
    ws.close();
    manager.closeAll();
    await bridge.close();
  });

  it("can close the bridge more than once", async () => {
    const { bridge, manager } = await fixture();
    manager.closeAll();

    await expect(bridge.close()).resolves.toBeUndefined();
    await expect(bridge.close()).resolves.toBeUndefined();
  });

  it("closes cleanly with a code-point-safe reason after a multibyte startup error", async () => {
    const runtimeConfig = testRuntimeConfig();
    const startupError = `failed ${"🙂".repeat(100)}`;
    const manager = new QuickShellSessionManager({
      config: runtimeConfig,
      allowedHosts: new Set(["test-device"]),
      ptyFactory: () => {
        throw new Error(startupError);
      },
    });
    const session = await manager.createSession({ device: "test-device" });
    const bridge = await startBridgeServer({ config: runtimeConfig, manager });
    const ws = new WebSocket(wsUrl(bridge.baseUrl, session.id));
    const message = nextMessage(ws);
    const closed = waitForClose(ws);

    try {
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: "authenticate", token: session.wsToken }));

      await expect(message).resolves.toMatchObject({
        type: "error",
        message: expect.stringContaining(startupError),
      });
      const result = await closed;
      expect(result.code).toBe(1011);
      expect(Buffer.byteLength(result.reason, "utf8")).toBeLessThanOrEqual(123);
      expect(result.reason).not.toContain("�");
    } finally {
      manager.closeAll();
      await bridge.close();
    }
  });

  it("continues connection and bridge cleanup when a disposable throws", async () => {
    const { bridge, manager, ptys, session } = await fixture();
    const pty = ptys[0]!;
    let secondDisposed = false;
    pty.onData = (listener) => {
      pty.data.on("data", listener);
      return {
        dispose: () => {
          pty.data.off("data", listener);
          throw new Error("data cleanup failed");
        },
      };
    };
    pty.onExit = (listener) => {
      pty.exit.on("exit", listener);
      return {
        dispose: () => {
          secondDisposed = true;
          pty.exit.off("exit", listener);
        },
      };
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ws = await connectAndReadReady(
      wsUrl(bridge.baseUrl, session.id),
      session.wsToken,
    );
    const closed = waitForClose(ws);

    try {
      await expect(bridge.close()).resolves.toBeUndefined();
      await expect(closed).resolves.toMatchObject({ code: 1001 });
      expect(secondDisposed).toBe(true);
      expect(bridge.httpServer.listening).toBe(false);
      expect(error).toHaveBeenCalledWith(
        "quick-shell bridge disposable cleanup failed",
        expect.any(Error),
      );
    } finally {
      error.mockRestore();
      manager.closeAll();
      await bridge.close().catch(() => undefined);
    }
  });
});

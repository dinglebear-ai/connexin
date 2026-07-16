import http from "node:http";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
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

  it("rejects invalid JSON messages with an error response", async () => {
    const { bridge, manager, session } = await fixture();
    const ws = await connectAndReadReady(
      wsUrl(bridge.baseUrl, session.id),
      session.wsToken,
    );

    ws.send("{");

    await expect(nextMessage(ws)).resolves.toEqual({
      type: "error",
      message: "invalid terminal message",
    });
    ws.close();
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

    const ws2 = await connectAndReadReady(
      wsUrl(bridge.baseUrl, session.id),
      session.wsToken,
    );
    ws2.send(JSON.stringify({ type: "resize", cols: 1, rows: 1 }));
    await expect(nextMessage(ws2)).resolves.toEqual({
      type: "error",
      message: "invalid terminal message",
    });
    ws2.close();
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
});

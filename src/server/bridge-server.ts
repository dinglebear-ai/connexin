import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { RuntimeConfig } from "./config.js";
import type { Disposable, QuickShellSessionManager, StartedQuickShellSession } from "./session-manager.js";
import { clientTerminalMessageSchema } from "../shared/protocol.js";
import type { ServerTerminalMessage, SessionId } from "../shared/protocol.js";

export interface BridgeServer {
  baseUrl: string;
  listenUrl: string;
  close(): Promise<void>;
  httpServer: http.Server;
  maxPayloadBytes: number;
}

export interface StartBridgeServerOptions {
  config: RuntimeConfig;
  manager: QuickShellSessionManager;
}

interface ActiveConnection {
  socket: WebSocket;
  disposables: Disposable[];
}

function sendJson(ws: WebSocket, message: ServerTerminalMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendOutputWithBackpressure(
  ws: WebSocket,
  data: string,
  bufferedAmountLimitBytes: number,
): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  const payload = JSON.stringify({ type: "output", data } satisfies ServerTerminalMessage);
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  if (ws.bufferedAmount + payloadBytes > bufferedAmountLimitBytes) {
    sendJson(ws, { type: "error", message: "terminal client is too slow" });
    ws.close(1011, "terminal client is too slow");
    return false;
  }
  ws.send(payload);
  return true;
}

function closeWithPolicy(ws: WebSocket, reason: string): void {
  ws.close(1008, reason);
}

function wsOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}

function parseRequest(url: string | undefined): { sessionId: SessionId; token: string } | undefined {
  if (!url) return undefined;
  const parsed = new URL(url, "http://127.0.0.1");
  if (parsed.pathname !== "/terminal") return undefined;

  const sessionId = parsed.searchParams.get("session");
  const token = parsed.searchParams.get("token");
  if (!sessionId || !token) return undefined;
  return { sessionId, token };
}

export async function startBridgeServer(options: StartBridgeServerOptions): Promise<BridgeServer> {
  const { config, manager } = options;
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end("not found");
  });
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/terminal",
    maxPayload: config.maxWsPayloadBytes,
  });
  const activeConnections = new Map<SessionId, ActiveConnection>();
  let closePromise: Promise<void> | undefined;
  const schema = clientTerminalMessageSchema(config.maxWsPayloadBytes);
  const sessionClosedSubscription = manager.onSessionClosed((sessionId) => {
    const connection = activeConnections.get(sessionId);
    if (connection) {
      for (const disposable of connection.disposables) disposable.dispose();
      connection.socket.close(1000, "session closed");
    }
    activeConnections.delete(sessionId);
  });

  wss.on("connection", (ws, request) => {
    let activeSessionId: SessionId | undefined;
    const isCurrent = () => activeSessionId !== undefined && activeConnections.get(activeSessionId)?.socket === ws;
    ws.on("error", (error) => {
      console.error("quick-shell bridge websocket error", {
        sessionId: activeSessionId,
        message: error instanceof Error ? error.message : String(error),
      });
    });

    const requestOrigin = request.headers.origin;
    if (config.allowedOrigins.length > 0 && (!requestOrigin || !config.allowedOrigins.includes(requestOrigin))) {
      manager.recordAuditEvent("bridge_connection_rejected", {
        reason: "origin_not_allowed",
        origin: requestOrigin,
      });
      closeWithPolicy(ws, "origin not allowed");
      return;
    }

    const parsed = parseRequest(request.url);
    if (!parsed) {
      manager.recordAuditEvent("bridge_connection_rejected", { reason: "missing_session_or_token" });
      closeWithPolicy(ws, "missing session or token");
      return;
    }

    const pendingSession = manager.authenticateWsCapability(parsed.sessionId, parsed.token);
    if (!pendingSession) {
      manager.recordAuditEvent("bridge_connection_rejected", {
        sessionId: parsed.sessionId,
        reason: "invalid_session_or_token",
      });
      closeWithPolicy(ws, "invalid session or token");
      return;
    }

    let session: StartedQuickShellSession | undefined;
    try {
      session = manager.startSession(pendingSession.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      manager.recordAuditEvent("bridge_connection_rejected", {
        sessionId: pendingSession.id,
        device: pendingSession.publicSummary.device,
        reason: "ssh_start_failed",
        error: message,
      });
      ws.close(1011, "terminal process unavailable");
      return;
    }
    if (!session) {
      manager.recordAuditEvent("bridge_connection_rejected", {
        sessionId: pendingSession.id,
        device: pendingSession.publicSummary.device,
        reason: "missing_session",
      });
      closeWithPolicy(ws, "invalid session or token");
      return;
    }
    activeSessionId = session.id;

    const prior = activeConnections.get(session.id);
    if (prior) {
      for (const disposable of prior.disposables) disposable.dispose();
      if (prior.socket.readyState === WebSocket.OPEN) {
        prior.socket.close(1000, "replaced by another quick-shell view");
      }
    }

    const disposables = attachSessionForwarding(ws, session, config, manager, isCurrent);
    activeConnections.set(session.id, { socket: ws, disposables });
    manager.recordAuditEvent("bridge_connected", { sessionId: session.id, device: session.publicSummary.device });
    sendJson(ws, { type: "ready", sessionId: session.id, scrollback: session.scrollback.toString() });
    if (session.exited) {
      sendJson(ws, { type: "exit", exitCode: session.exitCode });
    }

    ws.on("message", (data) => {
      if (!isCurrent()) return;
      manager.recordActivity(session.id);
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        manager.recordAuditEvent("bridge_message_rejected", {
          sessionId: session.id,
          device: session.publicSummary.device,
          reason: "invalid_json",
        });
        sendJson(ws, { type: "error", message: "invalid terminal message" });
        return;
      }

      const message = schema.safeParse(raw);
      if (!message.success) {
        manager.recordAuditEvent("bridge_message_rejected", {
          sessionId: session.id,
          device: session.publicSummary.device,
          reason: "invalid_schema",
        });
        sendJson(ws, { type: "error", message: "invalid terminal message" });
        return;
      }

      switch (message.data.type) {
        case "input": {
          const input = message.data.data;
          writeToPty(ws, manager, session, () => session.pty.write(input));
          break;
        }
        case "resize": {
          const { cols, rows } = message.data;
          writeToPty(ws, manager, session, () => session.pty.resize(cols, rows));
          break;
        }
        case "close":
          try {
            manager.closeSession(session.id);
          } finally {
            ws.close(1000, "session closed");
          }
          break;
        case "output_confirmed":
          manager.recordOutputConfirmed(session.id, message.data.byteCount);
          break;
        case "ping":
          break;
      }
    });

    ws.once("close", (code, reason) => {
      for (const disposable of disposables) disposable.dispose();
      if (activeConnections.get(session.id)?.socket === ws) {
        activeConnections.delete(session.id);
      }
      manager.recordAuditEvent("bridge_disconnected", {
        sessionId: session.id,
        device: session.publicSummary.device,
        code,
        reason: reason.toString(),
      });
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(config.bridgePort, config.bridgeHost, resolve));
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("bridge server did not bind to a TCP port");
  }
  const host = config.bridgeHost === "0.0.0.0" || config.bridgeHost === "::" ? "127.0.0.1" : config.bridgeHost;
  const listenUrl = `http://${host}:${address.port}`;
  const baseUrl = config.bridgePublicUrl ?? listenUrl;

  return {
    baseUrl,
    listenUrl,
    httpServer,
    maxPayloadBytes: config.maxWsPayloadBytes,
    close: () => {
      closePromise ??= new Promise<void>((resolve, reject) => {
        sessionClosedSubscription.dispose();
        for (const connection of activeConnections.values()) {
          for (const disposable of connection.disposables) disposable.dispose();
          connection.socket.close(1001, "bridge closing");
        }
        const terminateTimer = setTimeout(() => {
          for (const connection of activeConnections.values()) connection.socket.terminate();
          for (const client of wss.clients) client.terminate();
          activeConnections.clear();
        }, 250);
        terminateTimer.unref();
        wss.close((wsError) => {
          clearTimeout(terminateTimer);
          activeConnections.clear();
          if (wsError) {
            reject(wsError);
            return;
          }
          httpServer.close((httpError) => {
            if (httpError && (httpError as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(httpError);
            else resolve();
          });
        });
      });
      return closePromise;
    },
  };
}

function attachSessionForwarding(
  ws: WebSocket,
  session: StartedQuickShellSession,
  config: RuntimeConfig,
  manager: QuickShellSessionManager,
  isCurrent: () => boolean,
): Disposable[] {
  return [
    session.pty.onData((data) => {
      if (!isCurrent()) return;
      if (sendOutputWithBackpressure(ws, data, config.wsBufferedAmountLimitBytes)) {
        manager.recordActivity(session.id);
      } else {
        manager.recordAuditEvent("bridge_backpressure_closed", {
          sessionId: session.id,
          device: session.publicSummary.device,
        });
        manager.closeSession(session.id);
      }
    }),
    session.pty.onExit((event) => {
      if (!isCurrent()) return;
      sendJson(ws, { type: "exit", exitCode: event.exitCode });
    }),
  ];
}

function writeToPty(
  ws: WebSocket,
  manager: QuickShellSessionManager,
  session: StartedQuickShellSession,
  action: () => void,
): void {
  if (session.exited) return;
  try {
    action();
  } catch (error) {
    sendJson(ws, { type: "error", message: "terminal process is no longer available" });
    console.error("quick-shell bridge PTY I/O failed", {
      sessionId: session.id,
      message: error instanceof Error ? error.message : String(error),
    });
    manager.recordAuditEvent("bridge_io_failed", {
      sessionId: session.id,
      device: session.publicSummary.device,
      error: error instanceof Error ? error.message : String(error),
    });
    manager.closeSession(session.id);
    ws.close(1011, "terminal process unavailable");
  }
}

export function bridgeConnectDomains(baseUrl: string): string[] {
  return [baseUrl, wsOrigin(baseUrl)];
}

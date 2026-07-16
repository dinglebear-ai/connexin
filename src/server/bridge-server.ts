import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { RuntimeConfig } from "./config.js";
import type {
  Disposable,
  QuickShellSessionManager,
  StartedQuickShellSession,
} from "./session-manager.js";
import {
  SessionIdSchema,
  clientTerminalMessageSchema,
} from "../shared/protocol.js";
import type { ServerTerminalMessage, SessionId } from "../shared/protocol.js";

const AUTH_TIMEOUT_MS = 5_000;
const MAX_PENDING_AUTH_CONNECTIONS = 32;

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

function disposeConnection(connection: ActiveConnection): void {
  for (const disposable of connection.disposables.splice(0))
    disposable.dispose();
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
  const payload = JSON.stringify({
    type: "output",
    data,
  } satisfies ServerTerminalMessage);
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

function parseRequest(
  url: string | undefined,
): { sessionId: SessionId } | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url, "http://127.0.0.1");
  } catch {
    return undefined;
  }
  if (parsed.pathname !== "/terminal") return undefined;

  const sessionId = parsed.searchParams.get("session");
  const validatedSessionId = SessionIdSchema.safeParse(sessionId);
  if (!validatedSessionId.success) return undefined;
  return { sessionId: validatedSessionId.data };
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

interface ErrorEmitter {
  once(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

function listenHttpServer(
  httpServer: http.Server,
  port: number,
  host: string,
  extraErrorEmitter?: ErrorEmitter,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleError = (error: Error) => {
      httpServer.off("listening", handleListening);
      httpServer.off("error", handleError);
      extraErrorEmitter?.off("error", handleError);
      reject(error);
    };
    const handleListening = () => {
      httpServer.off("error", handleError);
      extraErrorEmitter?.off("error", handleError);
      resolve();
    };

    httpServer.once("error", handleError);
    extraErrorEmitter?.once("error", handleError);
    httpServer.once("listening", handleListening);
    httpServer.listen(port, host);
  });
}

export async function startBridgeServer(
  options: StartBridgeServerOptions,
): Promise<BridgeServer> {
  const { config, manager } = options;
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end("not found");
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxWsPayloadBytes,
  });
  const activeConnections = new Map<SessionId, ActiveConnection>();
  let closePromise: Promise<void> | undefined;
  let pendingAuthConnections = 0;
  const schema = clientTerminalMessageSchema({
    maxInputBytes: config.maxInputBytes,
    maxSubmitBytes: config.maxSubmitBytes,
  });
  const sessionClosedSubscription = manager.onSessionClosed((sessionId) => {
    const connection = activeConnections.get(sessionId);
    if (connection) {
      disposeConnection(connection);
      connection.socket.close(1000, "session closed");
    }
    activeConnections.delete(sessionId);
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const requestOrigin = request.headers.origin;
    if (
      config.allowedOrigins.length > 0 &&
      (!requestOrigin || !config.allowedOrigins.includes(requestOrigin))
    ) {
      manager.recordAuditEvent("bridge_connection_rejected", {
        reason: "origin_not_allowed",
        origin: requestOrigin,
      });
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    const parsed = parseRequest(request.url);
    if (!parsed) {
      manager.recordAuditEvent("bridge_connection_rejected", {
        reason: "missing_session",
      });
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }

    if (!manager.getSession(parsed.sessionId)) {
      manager.recordAuditEvent("bridge_connection_rejected", {
        sessionId: parsed.sessionId,
        reason: "invalid_session",
      });
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    if (pendingAuthConnections >= MAX_PENDING_AUTH_CONNECTIONS) {
      manager.recordAuditEvent("bridge_connection_rejected", {
        sessionId: parsed.sessionId,
        reason: "too_many_pending_auth_connections",
      });
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }

    pendingAuthConnections += 1;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, parsed.sessionId);
    });
  });

  wss.on(
    "connection",
    (
      ws: WebSocket,
      _request: http.IncomingMessage,
      pendingSessionId: SessionId,
    ) => {
      let activeSessionId: SessionId | undefined;
      let session: StartedQuickShellSession | undefined;
      let connectionDisposables: Disposable[] = [];
      let authPending = true;
      const isCurrent = () =>
        activeSessionId !== undefined &&
        activeConnections.get(activeSessionId)?.socket === ws;
      const disposeThisConnection = () => {
        for (const disposable of connectionDisposables.splice(0))
          disposable.dispose();
      };
      const settleAuth = () => {
        if (!authPending) return;
        authPending = false;
        pendingAuthConnections = Math.max(0, pendingAuthConnections - 1);
        clearTimeout(authTimer);
      };
      const authTimer = setTimeout(() => {
        manager.recordAuditEvent("bridge_connection_rejected", {
          sessionId: pendingSessionId,
          reason: "auth_timeout",
        });
        settleAuth();
        closeWithPolicy(ws, "authentication timeout");
      }, AUTH_TIMEOUT_MS);
      authTimer.unref();

      ws.on("error", (error: Error) => {
        console.error("quick-shell bridge websocket error", {
          sessionId: activeSessionId,
          message: error instanceof Error ? error.message : String(error),
        });
      });

      ws.on("message", (data: WebSocket.RawData) => {
        let raw: unknown;
        try {
          raw = JSON.parse(data.toString());
        } catch {
          manager.recordAuditEvent("bridge_message_rejected", {
            sessionId: activeSessionId ?? pendingSessionId,
            device: session?.publicSummary.device,
            reason: "invalid_json",
          });
          sendJson(ws, { type: "error", message: "invalid terminal message" });
          return;
        }

        const message = schema.safeParse(raw);
        if (!message.success) {
          manager.recordAuditEvent("bridge_message_rejected", {
            sessionId: activeSessionId ?? pendingSessionId,
            device: session?.publicSummary.device,
            reason: "invalid_schema",
          });
          sendJson(ws, { type: "error", message: "invalid terminal message" });
          return;
        }

        if (message.data.type === "authenticate") {
          if (!authPending || session) {
            manager.recordAuditEvent("bridge_message_rejected", {
              sessionId: activeSessionId ?? pendingSessionId,
              device: session?.publicSummary.device,
              reason: "duplicate_authentication",
            });
            sendJson(ws, {
              type: "error",
              message: "invalid terminal message",
            });
            return;
          }

          const pendingSession = manager.authenticateWsCapability(
            pendingSessionId,
            message.data.token,
          );
          if (!pendingSession) {
            manager.recordAuditEvent("bridge_connection_rejected", {
              sessionId: pendingSessionId,
              reason: "invalid_session_or_token",
            });
            settleAuth();
            closeWithPolicy(ws, "invalid session or token");
            return;
          }

          try {
            session = manager.startSession(pendingSession.id);
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            manager.recordAuditEvent("bridge_connection_rejected", {
              sessionId: pendingSession.id,
              device: pendingSession.publicSummary.device,
              reason: "ssh_start_failed",
              error: errorMessage,
            });
            settleAuth();
            ws.close(1011, "terminal process unavailable");
            return;
          }
          if (!session) {
            manager.recordAuditEvent("bridge_connection_rejected", {
              sessionId: pendingSession.id,
              device: pendingSession.publicSummary.device,
              reason: "missing_session",
            });
            settleAuth();
            closeWithPolicy(ws, "invalid session or token");
            return;
          }
          activeSessionId = session.id;
          settleAuth();

          const prior = activeConnections.get(session.id);
          if (prior) {
            disposeConnection(prior);
            if (prior.socket.readyState === WebSocket.OPEN) {
              prior.socket.close(1000, "replaced by another quick-shell view");
            }
          }

          connectionDisposables = attachSessionForwarding(
            ws,
            session,
            config,
            manager,
            isCurrent,
          );
          activeConnections.set(session.id, {
            socket: ws,
            disposables: connectionDisposables,
          });
          manager.recordAuditEvent("bridge_connected", {
            sessionId: session.id,
            device: session.publicSummary.device,
          });
          sendJson(ws, {
            type: "ready",
            sessionId: session.id,
            scrollback: session.scrollback.toString(),
          });
          if (session.exited) {
            sendJson(ws, { type: "exit", exitCode: session.exitCode });
          }
          return;
        }

        if (!session || !isCurrent()) {
          manager.recordAuditEvent("bridge_message_rejected", {
            sessionId: pendingSessionId,
            reason: "unauthenticated_message",
          });
          closeWithPolicy(ws, "authentication required");
          return;
        }

        const activeSession = session;
        manager.recordActivity(activeSession.id);
        switch (message.data.type) {
          case "input": {
            const input = message.data.data;
            writeToPty(ws, manager, activeSession, () =>
              activeSession.pty.write(input),
            );
            break;
          }
          case "resize": {
            const { cols, rows } = message.data;
            writeToPty(ws, manager, activeSession, () =>
              activeSession.pty.resize(cols, rows),
            );
            break;
          }
          case "close":
            try {
              manager.closeSession(activeSession.id);
            } finally {
              ws.close(1000, "session closed");
            }
            break;
          case "output_confirmed":
            manager.recordOutputConfirmed(
              activeSession.id,
              message.data.byteCount,
            );
            break;
          case "ping":
            break;
        }
      });

      ws.once("close", (code: number, reason: Buffer) => {
        settleAuth();
        disposeThisConnection();
        if (session) {
          const connection = activeConnections.get(session.id);
          if (connection?.socket === ws) {
            activeConnections.delete(session.id);
          }
        }
        manager.recordAuditEvent("bridge_disconnected", {
          sessionId: session?.id ?? pendingSessionId,
          device: session?.publicSummary.device,
          code,
          reason: reason.toString(),
        });
      });
    },
  );

  try {
    await listenHttpServer(
      httpServer,
      config.bridgePort,
      config.bridgeHost,
      wss,
    );
  } catch (error) {
    sessionClosedSubscription.dispose();
    wss.close();
    throw error;
  }
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("bridge server did not bind to a TCP port");
  }
  const host =
    config.bridgeHost === "0.0.0.0" || config.bridgeHost === "::"
      ? "127.0.0.1"
      : config.bridgeHost;
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
          disposeConnection(connection);
          connection.socket.close(1001, "bridge closing");
        }
        const terminateTimer = setTimeout(() => {
          for (const connection of activeConnections.values())
            connection.socket.terminate();
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
            if (
              httpError &&
              (httpError as NodeJS.ErrnoException).code !==
                "ERR_SERVER_NOT_RUNNING"
            )
              reject(httpError);
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
      if (
        sendOutputWithBackpressure(ws, data, config.wsBufferedAmountLimitBytes)
      ) {
        manager.recordActivity(session.id);
      } else {
        manager.recordAuditEvent("bridge_backpressure_closed", {
          sessionId: session.id,
          device: session.publicSummary.device,
        });
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
    sendJson(ws, {
      type: "error",
      message: "terminal process is no longer available",
    });
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

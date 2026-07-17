import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { createAuditRateLimiter } from "./audit-log.js";
import { isOriginAllowed } from "./config.js";
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
import { takeFirstUtf8Bytes } from "../shared/utf8.js";

const AUTH_TIMEOUT_MS = 5_000;
const MAX_PENDING_AUTH_CONNECTIONS = 32;
const MAX_WS_CLOSE_REASON_BYTES = 123;
const REJECTION_AUDIT_LIMIT = 10;
const REJECTION_AUDIT_WINDOW_MS = 60_000;

async function handleFileRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: RuntimeConfig,
  manager: QuickShellSessionManager,
): Promise<void> {
  const origin = req.headers.origin;
  if (!origin || !isOriginAllowed(config.allowedOrigins, origin)) {
    res.writeHead(403, { "Content-Type": "application/problem+json" });
    res.end('{"code":"origin_not_allowed"}');
    return;
  }
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const methodAllowed =
    (pathname === "/files/upload" && req.method === "PUT") ||
    (pathname === "/files/download" && req.method === "POST");
  if (req.method === "OPTIONS") {
    const requestedMethod = req.headers["access-control-request-method"];
    if (
      (pathname !== "/files/upload" && pathname !== "/files/download") ||
      !["PUT", "POST"].includes(String(requestedMethod))
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": String(requestedMethod),
      "Access-Control-Allow-Headers":
        "Authorization, X-Quick-Shell-File-Lease, Content-Type",
      "Access-Control-Max-Age": "300",
      Vary: "Origin",
    });
    res.end();
    return;
  }
  if (!methodAllowed) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const auth = req.headers.authorization;
  const session = auth?.startsWith("Bearer ")
    ? manager.authenticateFileCapability(auth.slice(7))
    : undefined;
  const lease = req.headers["x-quick-shell-file-lease"];
  if (!session || typeof lease !== "string") {
    res.writeHead(401, { "Content-Type": "application/problem+json" });
    res.end('{"code":"unauthorized"}');
    return;
  }
  const fileSession = manager.getFileSession(session.id);
  if (!fileSession) {
    res.writeHead(410);
    res.end();
    return;
  }
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  try {
    if (pathname === "/files/upload") {
      const length = Number(req.headers["content-length"]);
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > config.maxTransferBytes
      )
        throw new Error("too_large");
      const bytes = await fileSession.upload(
        lease,
        req,
        length,
        controller.signal,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ bytes }));
    } else {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="quick-shell-download"',
      });
      await fileSession.download(lease, res, controller.signal);
      res.end();
    }
  } catch (error) {
    if (!res.headersSent)
      res.writeHead(
        error instanceof Error && error.message === "too_large" ? 413 : 409,
        { "Content-Type": "application/problem+json" },
      );
    if (!res.writableEnded)
      res.end(
        JSON.stringify({
          code:
            error instanceof Error && /^[a-z_]+$/.test(error.message)
              ? error.message
              : "operation_failed",
        }),
      );
  }
}

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
  disposeAll(connection.disposables);
}

function disposeAll(disposables: Disposable[]): void {
  for (const disposable of disposables.splice(0)) {
    try {
      disposable.dispose();
    } catch (error) {
      console.error("quick-shell bridge disposable cleanup failed", error);
    }
  }
}

function sendJson(ws: WebSocket, message: ServerTerminalMessage): boolean {
  if (ws.readyState !== WebSocket.OPEN) {
    // The client never receives this; without a log the reason is lost entirely.
    console.error("quick-shell bridge dropped message on non-open socket", {
      type: message.type,
      readyState: ws.readyState,
    });
    return false;
  }
  return sendRaw(ws, JSON.stringify(message));
}

/**
 * `ws.send` throws on a socket that closed after the readyState check, so every
 * send is guarded: an unguarded throw inside a PTY data listener would escape
 * into node-pty's emitter and take down every other session with it.
 */
function sendRaw(ws: WebSocket, payload: string): boolean {
  try {
    ws.send(payload);
    return true;
  } catch (error) {
    console.error("quick-shell bridge websocket send failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
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
    closeSocket(ws, 1011, "terminal client is too slow");
    return false;
  }
  return sendRaw(ws, payload);
}

function closeWithPolicy(ws: WebSocket, reason: string): void {
  closeSocket(ws, 1008, reason);
}

function closeReason(reason: string): string {
  return takeFirstUtf8Bytes(reason, MAX_WS_CLOSE_REASON_BYTES).text;
}

function closeSocket(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, closeReason(reason));
  } catch (error) {
    console.error("quick-shell bridge websocket close failed", error);
    try {
      ws.terminate();
    } catch (terminateError) {
      console.error(
        "quick-shell bridge websocket terminate failed",
        terminateError,
      );
    }
  }
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
  const httpServer = http.createServer((req, res) => {
    void handleFileRequest(req, res, config, manager);
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxWsPayloadBytes,
  });
  const activeConnections = new Map<SessionId, ActiveConnection>();
  let closePromise: Promise<void> | undefined;
  let pendingAuthConnections = 0;
  // Connection and message rejections get separate budgets: a flood of bad
  // upgrades must not silently suppress unrelated message rejections.
  const connectionRejectionAuditLimiter = createAuditRateLimiter({
    maxEvents: REJECTION_AUDIT_LIMIT,
    windowMs: REJECTION_AUDIT_WINDOW_MS,
    onSuppressionStarted: () =>
      manager.recordAuditEvent("bridge_connection_rejected", {
        reason: "audit_rate_limited",
        suppressedEvent: "unauthenticated_bridge_rejection",
        detailLimit: REJECTION_AUDIT_LIMIT,
        windowMs: REJECTION_AUDIT_WINDOW_MS,
      }),
    onSuppressionSummary: (suppressedCount) =>
      manager.recordAuditEvent("bridge_connection_rejected", {
        reason: "audit_rate_limit_summary",
        suppressedEvent: "unauthenticated_bridge_rejection",
        suppressedCount,
        windowMs: REJECTION_AUDIT_WINDOW_MS,
      }),
  });
  const recordUnauthenticatedRejection = (fields: Record<string, unknown>) => {
    connectionRejectionAuditLimiter.record(() =>
      manager.recordAuditEvent("bridge_connection_rejected", fields),
    );
  };
  // Server-scoped rather than per-connection: a per-connection budget would let
  // N sockets each emit a full quota, defeating the flood protection.
  const messageRejectionAuditLimiter = createAuditRateLimiter({
    maxEvents: REJECTION_AUDIT_LIMIT,
    windowMs: REJECTION_AUDIT_WINDOW_MS,
    onSuppressionStarted: () =>
      manager.recordAuditEvent("bridge_message_rejected", {
        reason: "audit_rate_limited",
        suppressedEvent: "unauthenticated_bridge_message_rejection",
        detailLimit: REJECTION_AUDIT_LIMIT,
        windowMs: REJECTION_AUDIT_WINDOW_MS,
      }),
    onSuppressionSummary: (suppressedCount) =>
      manager.recordAuditEvent("bridge_message_rejected", {
        reason: "audit_rate_limit_summary",
        suppressedEvent: "unauthenticated_bridge_message_rejection",
        suppressedCount,
        windowMs: REJECTION_AUDIT_WINDOW_MS,
      }),
  });
  const schema = clientTerminalMessageSchema({
    maxInputBytes: config.maxInputBytes,
    maxSubmitBytes: config.maxSubmitBytes,
  });
  const sessionClosedSubscription = manager.onSessionClosed((sessionId) => {
    const connection = activeConnections.get(sessionId);
    if (connection) {
      disposeConnection(connection);
      closeSocket(connection.socket, 1000, "session closed");
    }
    activeConnections.delete(sessionId);
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const requestOrigin = request.headers.origin;
    if (
      config.allowedOrigins.length > 0 &&
      (!requestOrigin || !isOriginAllowed(config.allowedOrigins, requestOrigin))
    ) {
      recordUnauthenticatedRejection({
        reason: "origin_not_allowed",
        origin: requestOrigin,
      });
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    const parsed = parseRequest(request.url);
    if (!parsed) {
      recordUnauthenticatedRejection({
        reason: "missing_session",
      });
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }

    if (!manager.getSession(parsed.sessionId)) {
      recordUnauthenticatedRejection({
        sessionId: parsed.sessionId,
        reason: "invalid_session",
      });
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    if (pendingAuthConnections >= MAX_PENDING_AUTH_CONNECTIONS) {
      recordUnauthenticatedRejection({
        sessionId: parsed.sessionId,
        reason: "too_many_pending_auth_connections",
      });
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }

    try {
      wss.handleUpgrade(request, socket, head, (ws) => {
        pendingAuthConnections += 1;
        wss.emit("connection", ws, request, parsed.sessionId);
      });
    } catch (error) {
      recordUnauthenticatedRejection({
        sessionId: parsed.sessionId,
        reason: "upgrade_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      socket.destroy();
    }
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
        disposeAll(connectionDisposables);
      };
      const settleAuth = () => {
        if (!authPending) return;
        authPending = false;
        pendingAuthConnections = Math.max(0, pendingAuthConnections - 1);
        clearTimeout(authTimer);
      };
      const recordMessageRejection = (fields: Record<string, unknown>) => {
        const write = () =>
          manager.recordAuditEvent("bridge_message_rejected", fields);
        if (authPending) {
          messageRejectionAuditLimiter.record(write);
          return;
        }
        write();
      };
      const authTimer = setTimeout(() => {
        recordUnauthenticatedRejection({
          sessionId: pendingSessionId,
          reason: "auth_timeout",
        });
        settleAuth();
        closeWithPolicy(ws, "authentication timeout");
      }, AUTH_TIMEOUT_MS);
      authTimer.unref();

      ws.on("error", (error: Error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("quick-shell bridge websocket error", {
          sessionId: activeSessionId,
          message,
        });
        manager.recordAuditEvent("bridge_io_failed", {
          sessionId: activeSessionId,
          step: "ws_error",
          error: message,
        });
      });

      ws.on("message", (data: WebSocket.RawData) => {
        let raw: unknown;
        try {
          raw = JSON.parse(data.toString());
        } catch {
          recordMessageRejection({
            sessionId: activeSessionId ?? pendingSessionId,
            device: session?.publicSummary.device,
            reason: "invalid_json",
          });
          sendJson(ws, { type: "error", message: "invalid terminal message" });
          closeWithPolicy(ws, "invalid terminal message");
          return;
        }

        const message = schema.safeParse(raw);
        if (!message.success) {
          recordMessageRejection({
            sessionId: activeSessionId ?? pendingSessionId,
            device: session?.publicSummary.device,
            reason: "invalid_schema",
          });
          sendJson(ws, { type: "error", message: "invalid terminal message" });
          closeWithPolicy(ws, "invalid terminal message");
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
            recordUnauthenticatedRejection({
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
            const message = `Unable to start quick-shell SSH session for ${pendingSession.publicSummary.device}${errorMessage ? `: ${errorMessage}` : "."}`;
            manager.recordAuditEvent("bridge_connection_rejected", {
              sessionId: pendingSession.id,
              device: pendingSession.publicSummary.device,
              reason: "ssh_start_failed",
              error: errorMessage,
            });
            settleAuth();
            sendJson(ws, { type: "error", message });
            closeSocket(ws, 1011, message);
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
              closeSocket(
                prior.socket,
                1000,
                "replaced by another quick-shell view",
              );
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
          recordMessageRejection({
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
              closeSocket(ws, 1000, "session closed");
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
          closeSocket(connection.socket, 1001, "bridge closing");
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
  let backpressureClosed = false;
  let dataDisposable: Disposable;
  dataDisposable = session.pty.onData((data) => {
    if (!isCurrent()) return;
    if (backpressureClosed) return;
    if (
      sendOutputWithBackpressure(ws, data, config.wsBufferedAmountLimitBytes)
    ) {
      manager.recordActivity(session.id);
    } else {
      backpressureClosed = true;
      dataDisposable.dispose();
      manager.recordAuditEvent("bridge_backpressure_closed", {
        sessionId: session.id,
        device: session.publicSummary.device,
      });
    }
  });
  return [
    dataDisposable,
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
    closeSocket(ws, 1011, "terminal process unavailable");
  }
}

export function bridgeConnectDomains(baseUrl: string): string[] {
  return [baseUrl, wsOrigin(baseUrl)];
}

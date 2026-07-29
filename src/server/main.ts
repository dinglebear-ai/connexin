import http from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAuditLogger } from "./audit-log.js";
import {
  httpPortFromEnv,
  loadRuntimeConfig,
  type RuntimeConfig,
} from "./config.js";
import { loadDeviceMetadata } from "./device-metadata.js";
import { ensureSftpHelper } from "./ensure-sftp-helper.js";
import { loadAllowedSshHosts } from "./ssh-config.js";
import { createServer } from "./create-server.js";
import { startBridgeServer, type BridgeServer } from "./bridge-server.js";
import { ConnexinSessionManager, type PtyFactory } from "./session-manager.js";

export interface PreparedRuntime {
  config: RuntimeConfig;
  manager: ConnexinSessionManager;
  bridge: BridgeServer;
  server: ReturnType<typeof createServer>;
  cleanupTimer: NodeJS.Timeout;
  close(): Promise<void>;
}

export interface PrepareRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  ptyFactory?: PtyFactory;
  mode?: "stdio" | "http" | "test";
}

export interface HttpMcpServer {
  baseUrl: string;
  close(): Promise<void>;
}

interface CloseableService {
  close(): Promise<void>;
}

function listenHttpServer(
  httpServer: http.Server,
  port: number,
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleError = (error: Error) => {
      httpServer.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      httpServer.off("error", handleError);
      resolve();
    };

    httpServer.once("error", handleError);
    httpServer.once("listening", handleListening);
    httpServer.listen(port, host);
  });
}

function closeHttpServer(httpServer: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    httpServer.close((error) => {
      if (
        error &&
        (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
      )
        reject(error);
      else resolve();
    });
  });
}

export async function prepareRuntime(
  options: PrepareRuntimeOptions = {},
): Promise<PreparedRuntime> {
  const config = loadRuntimeConfig(options.env ?? process.env);
  const sftpHelper = ensureSftpHelper({
    helperPath: config.sftpHelperPath,
    env: options.env ?? process.env,
  });
  const [allowedHosts, deviceMetadata] = await Promise.all([
    loadAllowedSshHosts(config.sshConfigPath),
    loadDeviceMetadata(config.connexinConfigPath),
  ]);
  const audit = createAuditLogger(
    config.auditLogPath ? { path: config.auditLogPath } : {},
  );
  const manager = new ConnexinSessionManager({
    config,
    allowedHosts,
    deviceMetadata,
    audit,
    ptyFactory: options.ptyFactory,
  });
  const bridge = await startBridgeServer({ config, manager });
  // Failing loudly on an unwritable audit sink is intended, but the bridge is
  // already listening by this point and would otherwise keep its port bound for
  // the life of the process.
  try {
    audit.record("runtime_started", {
      mode: options.mode ?? "stdio",
      pid: process.pid,
      auditLog: config.auditLogPath ? "file" : "stderr",
      sshConfigPath: config.sshConfigPath,
      connexinConfigPath: config.connexinConfigPath,
      allowedHostCount: allowedHosts.size,
      metadataDeviceCount: deviceMetadata.devices.size,
      maxSessions: config.maxSessions,
      sftpHelper: sftpHelper.status,
      ...("reason" in sftpHelper
        ? { sftpHelperReason: sftpHelper.reason }
        : {}),
    });
    audit.record("bridge_listening", {
      baseUrl: bridge.baseUrl,
      listenUrl: bridge.listenUrl,
      maxPayloadBytes: config.maxWsPayloadBytes,
      allowedOriginCount: config.allowedOrigins.length,
    });
  } catch (error) {
    await bridge.close().catch((closeError: unknown) => {
      console.error("connexin bridge close failed", closeError);
    });
    throw error;
  }
  const server = createServer({
    bridgeBaseUrl: bridge.baseUrl,
    config,
    manager,
  });
  let closePromise: Promise<void> | undefined;
  const cleanupTimer = setInterval(() => {
    try {
      manager.cleanupExpiredSessions();
    } catch (error) {
      console.error(error);
    }
  }, config.cleanupIntervalMs);
  cleanupTimer.unref();

  return {
    config,
    manager,
    bridge,
    server,
    cleanupTimer,
    close: () => {
      closePromise ??= Promise.resolve().then(async () => {
        const errors: unknown[] = [];
        clearInterval(cleanupTimer);
        try {
          await server.close();
        } catch (error) {
          errors.push(error);
          console.error("connexin MCP server close failed", error);
        }
        try {
          await manager.closeAllAndDrain();
        } catch (error) {
          errors.push(error);
          console.error("connexin PTY cleanup failed", error);
        }
        try {
          await bridge.close();
        } catch (error) {
          errors.push(error);
          console.error("connexin bridge close failed", error);
        }
        manager.recordAuditEvent("runtime_closed", {
          mode: options.mode ?? "stdio",
          errorCount: errors.length,
        });
        // Callers exit the process as soon as this resolves, and in stdio mode
        // the audit sink writes to a pipe, so the closing records are only
        // durable once the sink has drained.
        try {
          await audit.flush?.();
        } catch (error) {
          errors.push(error);
          console.error("connexin audit flush failed", error);
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "connexin runtime cleanup failed");
        }
      });
      return closePromise;
    },
  };
}

function bearerIsValid(header: string | undefined, expected: string): boolean {
  return header === `Bearer ${expected}`;
}

export async function startHttpMcpServer(options: {
  runtime: PreparedRuntime;
  port?: number;
}): Promise<HttpMcpServer> {
  const { runtime } = options;
  if (!runtime.config.httpToken) {
    throw new Error("CONNEXIN_HTTP_TOKEN is required in --http mode");
  }

  const app = express();
  const requestClosers = new Set<() => Promise<void>>();
  app.all("/mcp", (req, res, next) => {
    if (
      !bearerIsValid(req.header("authorization"), runtime.config.httpToken!)
    ) {
      res.status(401).json({ error: "missing or invalid bearer token" });
      return;
    }
    next();
  });
  app.use("/mcp", express.json({ limit: "1mb" }));
  app.all("/mcp", async (req, res) => {
    const requestServer = createServer({
      bridgeBaseUrl: runtime.bridge.baseUrl,
      config: runtime.config,
      manager: runtime.manager,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    let closed = false;
    const closeRequest = async () => {
      if (closed) return;
      closed = true;
      requestClosers.delete(closeRequest);
      await transport
        .close()
        .catch((error) =>
          console.error("connexin HTTP transport close failed", error),
        );
      await requestServer
        .close()
        .catch((error) =>
          console.error("connexin HTTP request server close failed", error),
        );
    };
    requestClosers.add(closeRequest);
    res.on("close", () => {
      void closeRequest();
    });

    try {
      await requestServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      await closeRequest();
      console.error("connexin HTTP MCP request failed", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "internal MCP server error" });
      }
    }
  });

  const httpServer = http.createServer(app);
  try {
    await listenHttpServer(httpServer, options.port ?? 0, "127.0.0.1");
  } catch (error) {
    await Promise.all(
      [...requestClosers].map((closeRequest) => closeRequest()),
    );
    await closeHttpServer(httpServer).catch(() => undefined);
    throw error;
  }
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("HTTP MCP server did not bind to a TCP port");
  }

  let closePromise: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => {
      closePromise ??= (async () => {
        await Promise.all(
          [...requestClosers].map((closeRequest) => closeRequest()),
        );
        await closeHttpServer(httpServer);
      })();
      return closePromise;
    },
  };
}

function registerSignalCleanup(service: CloseableService): void {
  let closing = false;
  const cleanup = () => {
    if (closing) return;
    closing = true;
    service
      .close()
      .catch((error) => console.error(error))
      .finally(() => process.exit(0));
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}

export async function runStdio(): Promise<void> {
  const runtime = await prepareRuntime({ mode: "stdio" });
  registerSignalCleanup(runtime);
  const transport = new StdioServerTransport();
  let closePromise: Promise<void> | undefined;
  const closeRuntime = (exitAfterClose = false) => {
    cleanupStdioListeners();
    closePromise ??= runtime
      .close()
      .catch((error) =>
        console.error("connexin runtime cleanup failed", error),
      );
    if (exitAfterClose) {
      void closePromise.finally(() => process.exit(0));
    }
  };
  const cleanupStdioListeners = () => {
    process.stdin.off("end", closeFromStdin);
    process.stdin.off("close", closeFromStdin);
  };
  const closeFromStdin = () => closeRuntime(true);
  process.stdin.once("end", closeFromStdin);
  process.stdin.once("close", closeFromStdin);
  transport.onclose = () => {
    closeRuntime();
  };
  await runtime.server.connect(transport);
}

export async function runHttp(
  options: Omit<PrepareRuntimeOptions, "mode"> = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const runtime = await prepareRuntime({ ...options, env, mode: "http" });
  let httpServer: HttpMcpServer;
  try {
    httpServer = await startHttpMcpServer({
      runtime,
      port: httpPortFromEnv(env),
    });
  } catch (error) {
    await runtime
      .close()
      .catch((closeError) =>
        console.error("connexin runtime cleanup failed", closeError),
      );
    throw error;
  }
  registerSignalCleanup({
    close: async () => {
      const errors: unknown[] = [];
      await httpServer.close().catch((error) => errors.push(error));
      await runtime.close().catch((error) => errors.push(error));
      if (errors.length > 0)
        throw new AggregateError(errors, "connexin HTTP cleanup failed");
    },
  });
  console.error(`connexin HTTP MCP listening at ${httpServer.baseUrl}/mcp`);
  console.error(
    `connexin terminal bridge listening at ${runtime.bridge.listenUrl}`,
  );
  if (runtime.bridge.baseUrl !== runtime.bridge.listenUrl) {
    console.error(
      `connexin terminal bridge public URL ${runtime.bridge.baseUrl}`,
    );
  }
}

export async function main(argv = process.argv): Promise<void> {
  const mode = argv.includes("--http") ? "http" : "stdio";
  if (mode === "http") {
    await runHttp();
  } else {
    await runStdio();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

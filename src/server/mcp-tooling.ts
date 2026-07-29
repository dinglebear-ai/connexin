import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { bridgeConnectDomains } from "./bridge-server.js";
import type { RuntimeConfig } from "./config.js";
import type { ConnexinSession } from "./session-manager.js";
import {
  CapabilityTokenSchema,
  ConnexinPublicSessionSchema,
  SessionIdSchema,
} from "../shared/protocol.js";
import type {
  ConnexinAppSession,
  ConnexinPublicSession,
} from "../shared/protocol.js";
import { utf8ByteLength } from "../shared/utf8.js";

export const APP_RESOURCE_URI = "ui://connexin/mcp-app.v5.html";
export const V4_APP_RESOURCE_URI = "ui://connexin/mcp-app.v4.html";
export const V3_APP_RESOURCE_URI = "ui://connexin/mcp-app.v3.html";
export const V2_APP_RESOURCE_URI = "ui://connexin/mcp-app.v2.html";
export const LEGACY_APP_RESOURCE_URI = "ui://connexin/mcp-app.html";
export const SERVER_INSTRUCTIONS =
  "connexin opens a human-controlled SSH terminal for an allowlisted SSH config host alias. Use open_connexin only when a remote agent is blocked by a one-off command; suggested_command is prefilled only, and the user must run commands, review output, and explicitly send output back.";

let appHtmlCache: string | undefined;

export const connexinPublicOutputSchema = ConnexinPublicSessionSchema.shape;

export const appResourceMeta = (bridgeBaseUrl: string) => ({
  csp: {
    connectDomains: bridgeConnectDomains(bridgeBaseUrl),
    resourceDomains: [],
    frameDomains: [],
    baseUriDomains: [],
  },
  prefersBorder: false,
});

export function toolMeta(
  visibility: Array<"model" | "app">,
  status?: {
    invoking?: string;
    invoked?: string;
  },
): Record<string, unknown> {
  const appVisible = visibility.includes("app");
  const modelVisible = visibility.includes("model");
  return {
    ui: {
      ...(modelVisible ? { resourceUri: APP_RESOURCE_URI } : {}),
      visibility,
    },
    ...(modelVisible ? { "openai/outputTemplate": APP_RESOURCE_URI } : {}),
    "openai/widgetAccessible": appVisible,
    "openai/visibility": modelVisible ? "public" : "private",
    ...(status?.invoking
      ? { "openai/toolInvocation/invoking": status.invoking }
      : {}),
    ...(status?.invoked
      ? { "openai/toolInvocation/invoked": status.invoked }
      : {}),
  };
}

export function modelToolMeta(status?: {
  invoking?: string;
  invoked?: string;
}): Record<string, unknown> {
  return {
    "openai/widgetAccessible": false,
    "openai/visibility": "public",
    ...(status?.invoking
      ? { "openai/toolInvocation/invoking": status.invoking }
      : {}),
    ...(status?.invoked
      ? { "openai/toolInvocation/invoked": status.invoked }
      : {}),
  };
}

export function toolAnnotations(
  title: string,
  hints: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
    idempotentHint?: boolean;
  },
) {
  return {
    title,
    ...hints,
  };
}

export function asStructuredContent(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export function publicStructuredContent(
  session: ConnexinPublicSession,
): ConnexinPublicSession {
  return ConnexinPublicSessionSchema.parse(session);
}

export function appSessionFor(
  session: ConnexinSession,
  config: RuntimeConfig,
  bridgeBaseUrl: string,
): ConnexinAppSession {
  return {
    ...session.publicSummary,
    wsUrl: bridgeWsUrl(bridgeBaseUrl, session.id),
    wsToken: session.wsToken,
    maxInputBytes: config.maxInputBytes,
    maxSubmitBytes: config.maxSubmitBytes,
    maxWsPayloadBytes: config.maxWsPayloadBytes,
    pingIntervalMs: pingIntervalMs(config),
    fileBaseUrl: bridgeBaseUrl,
    fileToken: session.fileToken,
    maxEmbeddedDownloadBytes: config.maxEmbeddedDownloadBytes,
  };
}

export function utf8Max(maxBytes: number) {
  return z
    .string()
    .refine(
      (value) => utf8ByteLength(value) <= maxBytes,
      `must be at most ${maxBytes} bytes`,
    );
}

export function appCapabilityInputSchema() {
  return {
    sessionId: SessionIdSchema.optional(),
    appToken: CapabilityTokenSchema.optional(),
  };
}

export function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim();
}

export async function readBuiltAppHtml(): Promise<string> {
  if (process.env.NODE_ENV !== "test" && appHtmlCache !== undefined)
    return appHtmlCache;

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const isBuiltServer = moduleDir.includes(
    `${join("dist", "server", "server")}`,
  );
  const sourceApp = isBuiltServer
    ? resolve(moduleDir, "../../../src/app/mcp-app.html")
    : resolve(moduleDir, "../app/mcp-app.html");
  const builtApp = isBuiltServer
    ? resolve(moduleDir, "../../app/src/app/mcp-app.html")
    : resolve(moduleDir, "../../dist/app/src/app/mcp-app.html");
  const candidates =
    process.env.NODE_ENV === "development"
      ? [sourceApp, builtApp]
      : [builtApp, sourceApp];

  // Every candidate's error is reported: surfacing only the last one sends the
  // operator chasing a "file not found" when the real cause was a permission
  // bit on a different path.
  const errors: unknown[] = [];
  for (const candidate of candidates) {
    try {
      const html = await readFile(candidate, "utf8");
      if (process.env.NODE_ENV !== "test") appHtmlCache = html;
      return html;
    } catch (error) {
      errors.push(error);
    }
  }

  throw new AggregateError(
    errors,
    `Unable to read built MCP app HTML from: ${candidates.join(", ")}`,
  );
}

export function resetAppHtmlCacheForTests(): void {
  appHtmlCache = undefined;
}

function bridgeWsUrl(baseUrl: string, sessionId: string): string {
  const url = new URL("/terminal", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("session", sessionId);
  return url.toString();
}

function pingIntervalMs(config: RuntimeConfig): number {
  return Math.max(100, Math.min(30_000, Math.floor(config.idleGraceMs / 2)));
}

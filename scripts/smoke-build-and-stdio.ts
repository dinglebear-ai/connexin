import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";

const APP_RESOURCE_URI = "ui://quick-shell/mcp-app.v2.html";

const tempDir = await mkdtemp(join(tmpdir(), "quick-shell-smoke-"));
const sshConfigPath = join(tempDir, "config");
await writeFile(sshConfigPath, "Host test-device\n  HostName 127.0.0.1\n  ConnectTimeout 1\n");

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value;
}
env.QUICK_SHELL_SSH_CONFIG = sshConfigPath;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/server/server/main.js", "--stdio"],
  env,
  stderr: "pipe",
});
const client = new Client({ name: "quick-shell-smoke", version: "0.1.0" });
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += String(chunk);
});

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} missing`);
  return value;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.once("close", () => resolve()));
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  if (!tools.some((tool) => tool.name === "open_quick_shell")) {
    throw new Error("open_quick_shell not found in tools/list");
  }
  if (!tools.some((tool) => tool.name === "get_quick_shell_session")) {
    throw new Error("get_quick_shell_session not found in tools/list");
  }
  if (!tools.some((tool) => tool.name === "close_quick_shell_session")) {
    throw new Error("close_quick_shell_session not found in tools/list");
  }

  const resource = await client.readResource({ uri: APP_RESOURCE_URI });
  if (!resource.contents.some((content) => "text" in content && String(content.text).includes("quick-shell"))) {
    throw new Error("quick-shell app resource did not load");
  }
  const appHtml = resource.contents.find((content) => "text" in content && typeof content.text === "string");
  if (!appHtml || !("text" in appHtml) || !appHtml.text.includes("data:application/wasm;base64,")) {
    throw new Error("quick-shell app resource did not inline Ghostty WASM");
  }
  const emittedAppFiles = await readdir("dist/app", { recursive: true });
  if (emittedAppFiles.some((file) => String(file).endsWith(".wasm"))) {
    throw new Error("quick-shell app emitted a sidecar WASM file");
  }

  const opened = await client.callTool({ name: "open_quick_shell", arguments: { device: "test-device" } });
  const quickShell = (opened._meta as Record<string, unknown> | undefined)?.quickShell as
    | Record<string, unknown>
    | undefined;
  const sessionId = requireString(quickShell?.sessionId, "sessionId");
  const appToken = requireString(quickShell?.appToken, "appToken");

  const modelVisible = JSON.stringify([opened.content, opened.structuredContent]);
  if (/appToken|wsToken/.test(modelVisible) || modelVisible.includes(appToken)) {
    throw new Error("open_quick_shell leaked token material into model-visible fields");
  }

  const details = await client.callTool({
    name: "get_quick_shell_session",
    arguments: { sessionId, appToken },
  });
  if (JSON.stringify(details.structuredContent).includes("wsUrl")) {
    throw new Error("get_quick_shell_session leaked WebSocket details into structured content");
  }
  const appSession = (details._meta as Record<string, unknown> | undefined)?.quickShellSession as
    | Record<string, unknown>
    | undefined;
  const wsUrl = requireString(appSession?.wsUrl, "wsUrl");
  const wsToken = requireString(new URL(wsUrl).searchParams.get("token"), "wsToken");
  if (JSON.stringify(details.content).includes(appToken) || JSON.stringify(details.content).includes(wsToken)) {
    throw new Error("get_quick_shell_session leaked token material into text content");
  }

  const ws = new WebSocket(wsUrl);
  const ready = nextMessage(ws);
  await waitForOpen(ws);
  const readyMessage = await ready;
  if (
    !readyMessage ||
    typeof readyMessage !== "object" ||
    (readyMessage as { type?: unknown }).type !== "ready"
  ) {
    throw new Error("terminal bridge did not send ready");
  }

  const closed = waitForClose(ws);
  const closeResult = await client.callTool({
    name: "close_quick_shell_session",
    arguments: { sessionId, appToken },
  });
  if ((closeResult.structuredContent as Record<string, unknown> | undefined)?.closed !== true) {
    throw new Error("close_quick_shell_session did not close session");
  }
  await closed;

  if (stderr.includes(appToken) || stderr.includes(wsToken) || /appToken|wsToken/.test(stderr)) {
    throw new Error("stdio smoke stderr included quick-shell token material");
  }

  console.log("stdio smoke passed");
} finally {
  await client.close().catch((error) => console.error("quick-shell smoke client close failed", error));
  await transport.close().catch((error) => console.error("quick-shell smoke transport close failed", error));
  await rm(tempDir, { recursive: true, force: true });
}

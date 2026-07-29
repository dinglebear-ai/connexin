import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";

const APP_RESOURCE_URI = "ui://connexin/mcp-app.v3.html";
const OPERATION_TIMEOUT_MS = 10_000;

const tempDir = await mkdtemp(join(tmpdir(), "connexin-smoke-"));
const sshConfigPath = join(tempDir, "config");
await writeFile(
  sshConfigPath,
  "Host test-device\n  HostName 127.0.0.1\n  ConnectTimeout 1\n",
);

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value;
}
env.CONNEXIN_SSH_CONFIG = sshConfigPath;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/server/server/main.js", "--stdio"],
  env,
  stderr: "pipe",
});
/**
 * open_connexin refuses to mint a session for a host that does not advertise
 * MCP Apps support, because the session tokens travel in `_meta` and only an
 * apps-aware host keeps that away from the model. This smoke client stands in
 * for a compliant host, so it has to declare the capability the same way the
 * unit tests' APP_HOST_CAPABILITIES does -- otherwise the refusal is the thing
 * being smoke-tested, and every assertion past the open is skipped.
 */
const client = new Client(
  { name: "connexin-smoke", version: "0.1.0" },
  {
    capabilities: {
      extensions: {
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    } as never,
  },
);
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += String(chunk);
});

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${name} missing`);
  return value;
}

function withTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = OPERATION_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    operation,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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
  await withTimeout(client.connect(transport), "MCP client connect");
  const tools = (await withTimeout(client.listTools(), "tools/list")).tools;
  if (!tools.some((tool) => tool.name === "open_connexin")) {
    throw new Error("open_connexin not found in tools/list");
  }
  if (!tools.some((tool) => tool.name === "list_connexin_devices")) {
    throw new Error("list_connexin_devices not found in tools/list");
  }
  if (!tools.some((tool) => tool.name === "get_connexin_session")) {
    throw new Error("get_connexin_session not found in tools/list");
  }
  if (!tools.some((tool) => tool.name === "close_connexin_session")) {
    throw new Error("close_connexin_session not found in tools/list");
  }
  for (const required of [
    "list_connexin_files",
    "prepare_connexin_file_operation",
    "mkdir_connexin_path",
    "rename_connexin_path",
    "delete_connexin_path",
  ]) {
    if (!tools.some((tool) => tool.name === required))
      throw new Error(`${required} not found in tools/list`);
  }

  const resource = await withTimeout(
    client.readResource({ uri: APP_RESOURCE_URI }),
    "app resource read",
  );
  if (
    !resource.contents.some(
      (content) =>
        "text" in content && String(content.text).includes("connexin"),
    )
  ) {
    throw new Error("connexin app resource did not load");
  }
  const appHtml = resource.contents.find(
    (content) => "text" in content && typeof content.text === "string",
  );
  if (
    !appHtml ||
    !("text" in appHtml) ||
    !appHtml.text.includes("data:application/wasm;base64,")
  ) {
    throw new Error("connexin app resource did not inline Ghostty WASM");
  }
  const emittedAppFiles = await readdir("dist/app", { recursive: true });
  if (emittedAppFiles.some((file) => String(file).endsWith(".wasm"))) {
    throw new Error("connexin app emitted a sidecar WASM file");
  }

  const opened = await withTimeout(
    client.callTool({
      name: "open_connexin",
      arguments: { device: "test-device" },
    }),
    "open_connexin",
  );
  const connexin = (opened._meta as Record<string, unknown> | undefined)
    ?.connexin as Record<string, unknown> | undefined;
  const sessionId = requireString(connexin?.sessionId, "sessionId");
  const appToken = requireString(connexin?.appToken, "appToken");

  const modelVisible = JSON.stringify([
    opened.content,
    opened.structuredContent,
  ]);
  if (
    /appToken|wsToken/.test(modelVisible) ||
    modelVisible.includes(appToken)
  ) {
    throw new Error(
      "open_connexin leaked token material into model-visible fields",
    );
  }

  const details = await withTimeout(
    client.callTool({
      name: "get_connexin_session",
      arguments: { sessionId, appToken },
    }),
    "get_connexin_session",
  );
  if (JSON.stringify(details.structuredContent).includes("wsUrl")) {
    throw new Error(
      "get_connexin_session leaked WebSocket details into structured content",
    );
  }
  const appSession = (details._meta as Record<string, unknown> | undefined)
    ?.connexinSession as Record<string, unknown> | undefined;
  const wsUrl = requireString(appSession?.wsUrl, "wsUrl");
  const wsToken = requireString(appSession?.wsToken, "wsToken");
  if (wsUrl.includes("token=")) {
    throw new Error("get_connexin_session embedded token material in wsUrl");
  }
  if (
    JSON.stringify(details.content).includes(appToken) ||
    JSON.stringify(details.content).includes(wsToken)
  ) {
    throw new Error(
      "get_connexin_session leaked token material into text content",
    );
  }

  const ws = new WebSocket(wsUrl);
  const ready = nextMessage(ws);
  await withTimeout(waitForOpen(ws), "terminal WebSocket open");
  ws.send(JSON.stringify({ type: "authenticate", token: wsToken }));
  const readyMessage = await withTimeout(ready, "terminal ready message");
  if (
    !readyMessage ||
    typeof readyMessage !== "object" ||
    (readyMessage as { type?: unknown }).type !== "ready"
  ) {
    throw new Error("terminal bridge did not send ready");
  }

  const closed = waitForClose(ws);
  const closeResult = await withTimeout(
    client.callTool({
      name: "close_connexin_session",
      arguments: { sessionId, appToken },
    }),
    "close_connexin_session",
  );
  if (
    (closeResult.structuredContent as Record<string, unknown> | undefined)
      ?.closed !== true
  ) {
    throw new Error("close_connexin_session did not close session");
  }
  await withTimeout(closed, "terminal WebSocket close");

  if (
    stderr.includes(appToken) ||
    stderr.includes(wsToken) ||
    /appToken|wsToken/.test(stderr)
  ) {
    throw new Error("stdio smoke stderr included connexin token material");
  }

  console.log("stdio smoke passed");
} finally {
  await client
    .close()
    .catch((error) =>
      console.error("connexin smoke client close failed", error),
    );
  await transport
    .close()
    .catch((error) =>
      console.error("connexin smoke transport close failed", error),
    );
  await rm(tempDir, { recursive: true, force: true });
}

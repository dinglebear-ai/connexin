import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { FitAddon, Terminal } from "ghostty-web";
import type {
  ClientTerminalMessage,
  QuickShellAppSession,
  QuickShellHiddenMeta,
  QuickShellPoll,
  QuickShellPublicSession,
  ServerTerminalMessage,
} from "../shared/protocol.js";
import {
  QuickShellAppSessionSchema,
  QuickShellHiddenMetaSchema,
  QuickShellPollSchema,
  QuickShellPublicSessionSchema,
  ServerTerminalMessageSchema,
} from "../shared/protocol.js";
import { BoundedTextBuffer } from "../shared/bounded-text-buffer.js";
import { buildInsertPayload, findSecretWarnings, normalizeTerminalOutput, truncateForSubmit } from "./output.js";
import { loadGhosttyRuntime } from "./ghostty-loader.js";
import "./styles.css";

type HostCapabilities = NonNullable<ReturnType<App["getHostCapabilities"]>>;
type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;

const DEFAULT_SUBMIT_BYTES = 64_000;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const FALLBACK_POLL_INTERVAL_MS = 500;
const MAX_PENDING_INPUT_BYTES = 16_384;

const app = new App(
  { name: "quick-shell", version: "0.1.0" },
  { availableDisplayModes: ["inline", "fullscreen"] },
  { autoResize: true },
);
const root = document.getElementById("app");
if (!root) throw new Error("missing app root");

let ws: WebSocket | undefined;
let terminal: Terminal | undefined;
let fitAddon: FitAddon | undefined;
let resizeObserver: ResizeObserver | undefined;
let terminalDataDisposable: { dispose(): void } | undefined;
let pingTimer: number | undefined;
let pollTimer: number | undefined;
let publicSession: QuickShellPublicSession | undefined;
let session: QuickShellAppSession | undefined;
let sessionDetails: QuickShellAppSession | undefined;
let sessionCapability: QuickShellHiddenMeta["quickShell"] | undefined;
let appToolTransport = false;
let polling = false;
let pollSeq = 0;
let fallbackWriteQueue: Promise<void> = Promise.resolve();
let outputBuffer = new BoundedTextBuffer(DEFAULT_SUBMIT_BYTES);
let pendingInput: string[] = [];
let pendingInputBytes = 0;
let connecting = false;
let connectingGeneration: number | undefined;
let connectionFailed = false;
let sending = false;
let hostContext: HostContext = {};
let lastModelContextKey: string | undefined;

const elements = buildShell();
root.replaceChildren(elements.container);
let toolResultGeneration = 0;

app.ontoolinputpartial = (params) => applyToolInput(params.arguments);
app.ontoolinput = (params) => applyToolInput(params.arguments);
app.onhostcontextchanged = (ctx) => applyHostContext(ctx);
app.ontoolcancelled = (params) => setStatus(params.reason ? `Cancelled: ${params.reason}` : "Cancelled");
app.ontoolresult = (params) => {
  void handleToolResult(params).catch((error) => renderError(error));
};
app.onteardown = async () => {
  await cleanup(true);
  return {};
};
window.addEventListener("error", (event) => renderError(event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => renderError(event.reason));

void start().catch((error) => renderError(error));

async function start(): Promise<void> {
  await app.connect();
  applyHostContext(app.getHostContext());
}

function buildShell() {
  const container = document.createElement("section");
  container.className = "shell";

  const header = document.createElement("header");
  header.className = "shell__header";
  const title = document.createElement("h1");
  title.textContent = "quick-shell";
  const status = document.createElement("p");
  status.className = "shell__status";
  status.textContent = "Waiting";
  header.append(title, status);

  const commandStrip = document.createElement("form");
  commandStrip.className = "command-strip";
  const commandInput = document.createElement("input");
  commandInput.type = "text";
  commandInput.autocomplete = "off";
  commandInput.spellcheck = false;
  commandInput.placeholder = "Suggested command";
  const insertButton = document.createElement("button");
  insertButton.type = "submit";
  insertButton.textContent = "Insert";
  insertButton.disabled = true;
  commandStrip.append(commandInput, insertButton);

  const terminalMount = document.createElement("div");
  terminalMount.className = "terminal";

  const actions = document.createElement("div");
  actions.className = "actions";
  const connectButton = document.createElement("button");
  connectButton.type = "button";
  connectButton.textContent = "Reconnect";
  connectButton.disabled = true;
  connectButton.hidden = true;
  const displayModeButton = document.createElement("button");
  displayModeButton.type = "button";
  displayModeButton.textContent = "Fullscreen";
  displayModeButton.hidden = true;
  const sendButton = document.createElement("button");
  sendButton.type = "button";
  sendButton.textContent = "Send output";
  sendButton.disabled = true;
  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.textContent = "Download output";
  downloadButton.disabled = true;
  downloadButton.hidden = true;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "Close";
  closeButton.disabled = true;
  actions.append(connectButton, displayModeButton, sendButton, downloadButton, closeButton);

  const dialog = document.createElement("dialog");
  dialog.className = "send-dialog";
  const dialogTitle = document.createElement("h2");
  dialogTitle.textContent = "Send output";
  const textarea = document.createElement("textarea");
  textarea.rows = 12;
  textarea.spellcheck = false;
  const meta = document.createElement("p");
  meta.className = "send-dialog__meta";
  const warnings = document.createElement("ul");
  warnings.className = "send-dialog__warnings";
  const fallback = document.createElement("textarea");
  fallback.className = "send-dialog__fallback";
  fallback.readOnly = true;
  fallback.hidden = true;
  const dialogActions = document.createElement("div");
  dialogActions.className = "send-dialog__actions";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.textContent = "Confirm";
  dialogActions.append(cancelButton, confirmButton);
  dialog.append(dialogTitle, textarea, meta, warnings, fallback, dialogActions);

  container.append(header, commandStrip, terminalMount, actions, dialog);

  commandStrip.addEventListener("submit", (event) => {
    event.preventDefault();
    const payload = buildInsertPayload(commandInput.value);
    if (payload && session) {
      sendTerminalInput(payload);
      setStatus("Inserted");
    }
  });

  connectButton.addEventListener("click", () => {
    void connectPendingSession().catch((error) => {
      renderError(error);
      updateControls();
    });
  });

  sendButton.addEventListener("click", () => {
    if (!session) return;
    const prepared = truncateForSubmit(normalizeTerminalOutput(outputBuffer.toString()), session.maxSubmitBytes);
    textarea.value = prepared.text;
    updateDialogMeta(prepared.text, session.maxSubmitBytes, prepared.truncated, meta, warnings);
    fallback.hidden = true;
    dialog.showModal();
  });

  displayModeButton.addEventListener("click", () => {
    void toggleDisplayMode().catch((error) => renderError(error));
  });

  downloadButton.addEventListener("click", () => {
    void downloadOutput().catch((error) => renderError(error));
  });

  textarea.addEventListener("input", () => {
    const maxBytes = session?.maxSubmitBytes ?? DEFAULT_SUBMIT_BYTES;
    const prepared = truncateForSubmit(normalizeTerminalOutput(textarea.value), maxBytes);
    if (prepared.text !== textarea.value) textarea.value = prepared.text;
    updateDialogMeta(textarea.value, maxBytes, prepared.truncated, meta, warnings);
  });

  cancelButton.addEventListener("click", () => dialog.close());
  confirmButton.addEventListener("click", () => {
    if (sending) return;
    const snapshot = textarea.value;
    void confirmSend(snapshot, fallback, dialog, cancelButton, confirmButton).catch((error) => {
      fallback.hidden = false;
      fallback.value = snapshot;
      setStatus(`Send failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  closeButton.addEventListener("click", () => {
    void cleanup(true).catch((error) => renderError(error));
  });

  return {
    container,
    status,
    commandInput,
    insertButton,
    connectButton,
    displayModeButton,
    sendButton,
    downloadButton,
    closeButton,
    cancelButton,
    confirmButton,
    terminalMount,
  };
}

function readPublicSession(value: unknown): QuickShellPublicSession | undefined {
  const parsed = QuickShellPublicSessionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readAppSession(value: unknown): QuickShellAppSession | undefined {
  const parsed = QuickShellAppSessionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readQuickShellMeta(value: unknown): QuickShellHiddenMeta["quickShell"] | undefined {
  const parsed = QuickShellHiddenMetaSchema.safeParse(value);
  return parsed.success ? parsed.data.quickShell : undefined;
}

function readQuickShellPoll(value: unknown): QuickShellPoll | undefined {
  const parsed = QuickShellPollSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

async function handleToolResult(params: {
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
}): Promise<void> {
  if (params.isError) {
    setStatus("Tool error");
    return;
  }

  const generation = ++toolResultGeneration;
  connecting = false;
  connectingGeneration = undefined;
  const nextPublicSession = readPublicSession(params.structuredContent);
  const quickShell = readQuickShellMeta(params._meta);
  const quickShellSession = readAppSession(params._meta?.quickShellSession);
  if (!nextPublicSession || !quickShell || quickShell.sessionId !== nextPublicSession.sessionId) {
    throw new Error("Missing quick-shell app capability");
  }
  if (quickShellSession && quickShellSession.sessionId !== nextPublicSession.sessionId) {
    throw new Error("Invalid quick-shell session capability");
  }

  const previousClosed = await cleanup(true).catch((error) => {
    console.error("quick-shell previous session close failed", error);
    setStatus("Could not close previous session; it will expire automatically.");
    return false;
  });
  if (!previousClosed) {
    await closeUnusedSession(quickShell);
    return;
  }
  if (generation !== toolResultGeneration) return;
  publicSession = nextPublicSession;
  sessionCapability = quickShell;
  sessionDetails = quickShellSession;
  session = undefined;
  outputBuffer = new BoundedTextBuffer(quickShellSession?.maxSubmitBytes ?? DEFAULT_SUBMIT_BYTES);
  elements.commandInput.value = nextPublicSession.suggestedCommand ?? "";
  setStatus(`Connecting ${nextPublicSession.device}`);
  updateModelContext("connecting");
  updateControls();
  void connectPendingSession().catch((error) => handleConnectFailure(error));
}

async function connectPendingSession(): Promise<void> {
  if (connecting || session || !publicSession || (!sessionCapability && !sessionDetails)) return;
  const generation = toolResultGeneration;
  const capability = sessionCapability;
  let detailsSession = sessionDetails;
  const requested = publicSession;
  connecting = true;
  connectingGeneration = generation;
  connectionFailed = false;
  setStatus(`Connecting ${requested.device}`);
  updateControls();

  try {
    if (!detailsSession) {
      if (!capability) throw new Error("Missing quick-shell app capability");
      const details = await app.callServerTool({
        name: "get_quick_shell_session",
        arguments: {
          sessionId: capability.sessionId,
          appToken: capability.appToken,
        },
      });
      if (details.isError) throw new Error(toolResultText(details, "Session capability rejected"));
      if (generation !== toolResultGeneration || sessionCapability !== capability) return;
      detailsSession = readAppSession((details as { _meta?: Record<string, unknown> })._meta?.quickShellSession);
    }
    if (!detailsSession || detailsSession.sessionId !== requested.sessionId) {
      throw new Error("Invalid quick-shell session details");
    }
    session = detailsSession;
    outputBuffer = new BoundedTextBuffer(detailsSession.maxSubmitBytes);
    updateModelContext("connecting");
    updateControls();
    try {
      await connectTerminal(detailsSession, generation);
    } catch (error) {
      if (generation === toolResultGeneration && session?.sessionId === detailsSession.sessionId) {
        disposeTerminal();
        session = undefined;
        outputBuffer = new BoundedTextBuffer(detailsSession.maxSubmitBytes);
      }
      throw error;
    }
  } finally {
    if (connectingGeneration !== generation) return;
    connecting = false;
    connectingGeneration = undefined;
    updateControls();
  }
}

async function connectTerminal(details: QuickShellAppSession, generation: number): Promise<void> {
  disposeTerminal();
  outputBuffer.clear();
  await loadGhosttyRuntime();
  if (!isCurrentGeneration(generation, details.sessionId)) return;

  const nextTerminal = new Terminal({
    cols: 100,
    rows: 30,
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 13,
    theme: {
      background: "#07131c",
      foreground: "#e6f4fb",
      cursor: "#29b6f6",
      selectionBackground: "#1d3d4e",
    },
  });
  const nextFitAddon = new FitAddon();
  nextTerminal.loadAddon(nextFitAddon);
  nextTerminal.open(elements.terminalMount);

  const nextTerminalDataDisposable = nextTerminal.onData((data) => {
    sendTerminalInput(data);
  });

  const socket = new WebSocket(details.wsUrl);
  if (!isCurrentGeneration(generation, details.sessionId)) {
    nextTerminalDataDisposable.dispose();
    nextFitAddon.dispose();
    nextTerminal.dispose();
    socket.close();
    return;
  }
  terminal = nextTerminal;
  fitAddon = nextFitAddon;
  terminalDataDisposable = nextTerminalDataDisposable;
  ws = socket;
  let socketOpened = false;
  socket.addEventListener("open", () => {
    if (ws !== socket) return;
    socketOpened = true;
    connectionFailed = false;
    fitAddon?.fit();
    sendResize();
    flushPendingInput();
    startPing(details.pingIntervalMs);
    setStatus("Connected");
    updateModelContext("connected");
    updateControls();
  });
  socket.addEventListener("message", (event) => handleTerminalMessage(socket, event.data));
  socket.addEventListener("close", () => {
    if (ws === socket) {
      disposeTerminal();
      session = undefined;
      connectionFailed = true;
      setStatus("Disconnected");
      updateModelContext("disconnected");
      updateControls();
    }
  });
  socket.addEventListener("error", () => {
    if (ws !== socket) return;
    setStatus("Connection error");
    if (!socketOpened) {
      ws = undefined;
      socket.close();
      void startAppToolTransport(details, generation).catch((error) => {
        handleConnectFailure(error);
        updateControls();
      });
    }
  });

  resizeObserver = new ResizeObserver(() => {
    fitAddon?.fit();
    sendResize();
  });
  resizeObserver.observe(elements.terminalMount);
}

function handleTerminalMessage(socket: WebSocket, data: unknown): void {
  if (ws !== socket) return;

  let message: ServerTerminalMessage;
  try {
    message = ServerTerminalMessageSchema.parse(JSON.parse(String(data)));
  } catch {
    setStatus("Bad bridge message");
    return;
  }

  switch (message.type) {
    case "ready":
      outputBuffer.clear();
      outputBuffer.append(message.scrollback);
      terminal?.write(message.scrollback);
      break;
    case "output":
      outputBuffer.append(message.data);
      terminal?.write(message.data);
      break;
    case "exit":
      setStatus(message.exitCode === null ? "Exited" : `Exited ${message.exitCode}`);
      break;
    case "error":
      setStatus(message.message);
      break;
    default:
      assertNever(message);
  }
}

function sendResize(): void {
  if (!terminal) return;
  const proposed = fitAddon?.proposeDimensions();
  const cols = clamp(proposed?.cols ?? terminal.cols, 20, 400);
  const rows = clamp(proposed?.rows ?? terminal.rows, 5, 200);
  terminal.resize(cols, rows);
  if (appToolTransport) {
    void resizeViaAppTool(cols, rows);
  } else if (ws?.readyState === WebSocket.OPEN) {
    sendTerminalMessage({ type: "resize", cols, rows });
  }
}

function sendTerminalMessage(message: ClientTerminalMessage): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendTerminalInput(data: string): void {
  if (appToolTransport) {
    enqueueFallbackInput(data);
    return;
  }

  if (ws?.readyState === WebSocket.OPEN) {
    sendTerminalMessage({ type: "input", data });
    return;
  }

  const bytes = new TextEncoder().encode(data).byteLength;
  if (pendingInputBytes + bytes > MAX_PENDING_INPUT_BYTES) {
    setStatus("Waiting for connection; input buffer full.");
    return;
  }

  pendingInput.push(data);
  pendingInputBytes += bytes;
  setStatus("Waiting for connection");
}

async function startAppToolTransport(details: QuickShellAppSession, generation: number): Promise<void> {
  if (!sessionCapability || !isCurrentGeneration(generation, details.sessionId)) return;
  stopPing();
  appToolTransport = true;
  polling = false;
  pollSeq = 0;

  const attached = await app.callServerTool({
    name: "get_quick_shell_session",
    arguments: sessionCapability,
  });
  if (attached.isError) throw new Error(toolResultText(attached, "Session capability rejected"));
  const attachedSession = readAppSession((attached as { _meta?: Record<string, unknown> })._meta?.quickShellSession) ?? details;
  if (!isCurrentGeneration(generation, details.sessionId) || attachedSession.sessionId !== details.sessionId) return;
  session = attachedSession;
  connectionFailed = false;
  setStatus("Connected");
  updateModelContext("connected");
  updateControls();
  await pollAppToolTransport(generation);
  if (!isCurrentGeneration(generation, details.sessionId)) return;
  pollTimer = window.setInterval(() => {
    void pollAppToolTransport(generation).catch((error) => {
      setStatus(`Poll failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, FALLBACK_POLL_INTERVAL_MS);
}

async function pollAppToolTransport(generation: number): Promise<void> {
  if (polling || !session || !sessionCapability || !appToolTransport || !isCurrentGeneration(generation, session.sessionId)) return;
  polling = true;
  try {
    const result = await app.callServerTool({
      name: "poll_quick_shell_session",
      arguments: {
        ...sessionCapability,
        afterSeq: pollSeq,
      },
    });
    if (result.isError) throw new Error(toolResultText(result, "Quick-shell poll failed"));
    const poll = readQuickShellPoll((result as { _meta?: Record<string, unknown> })._meta?.quickShellPoll);
    if (!poll || !isCurrentGeneration(generation, poll.sessionId)) return;
    for (const chunk of poll.chunks) {
      terminal?.write(chunk.data);
      outputBuffer.append(chunk.data);
    }
    pollSeq = poll.nextSeq;
    if (poll.exited) {
      setStatus(poll.exitCode === null ? "Exited" : `Exited ${poll.exitCode}`);
      stopPolling();
    } else {
      setStatus("Connected");
    }
  } finally {
    polling = false;
  }
}

function enqueueFallbackInput(data: string): void {
  if (!sessionCapability) return;
  const capability = sessionCapability;
  fallbackWriteQueue = fallbackWriteQueue
    .catch(() => {})
    .then(async () => {
      const result = await app.callServerTool({
        name: "write_quick_shell_input",
        arguments: {
          ...capability,
          data,
        },
      });
      if (result.isError) throw new Error(toolResultText(result, "Quick-shell input failed"));
    })
    .catch((error) => {
      setStatus(`Input failed: ${error instanceof Error ? error.message : String(error)}`);
    });
}

async function resizeViaAppTool(cols: number, rows: number): Promise<void> {
  if (!sessionCapability) return;
  await app.callServerTool({
    name: "resize_quick_shell_session",
    arguments: {
      ...sessionCapability,
      cols,
      rows,
    },
  }).catch((error) => console.error("quick-shell resize failed", error));
}

function flushPendingInput(): void {
  const queued = pendingInput;
  pendingInput = [];
  pendingInputBytes = 0;
  for (const data of queued) {
    sendTerminalMessage({ type: "input", data });
  }
}

async function confirmSend(
  text: string,
  fallback: HTMLTextAreaElement,
  dialog: HTMLDialogElement,
  cancelButton: HTMLButtonElement,
  confirmButton: HTMLButtonElement,
): Promise<void> {
  const maxBytes = session?.maxSubmitBytes ?? DEFAULT_SUBMIT_BYTES;
  const prepared = truncateForSubmit(normalizeTerminalOutput(text), maxBytes);
  sending = true;
  cancelButton.disabled = true;
  confirmButton.disabled = true;
  try {
    const result = await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: prepared.text }],
    });
    if (result.isError) {
      fallback.hidden = false;
      fallback.value = prepared.text;
      setStatus("Send failed; copy the fallback output manually.");
      return;
    }
    const byteCount = new TextEncoder().encode(prepared.text).byteLength;
    if (ws?.readyState === WebSocket.OPEN) {
      sendTerminalMessage({ type: "output_confirmed", byteCount });
    } else if (sessionCapability) {
      await app.callServerTool({
        name: "record_quick_shell_output_confirmed",
        arguments: {
          ...sessionCapability,
          byteCount,
        },
      }).catch((error) => console.error("quick-shell audit record failed", error));
    }
    dialog.close();
    setStatus("Sent");
    updateModelContext("output-sent");
  } finally {
    sending = false;
    cancelButton.disabled = false;
    confirmButton.disabled = false;
  }
}

function updateDialogMeta(
  text: string,
  maxBytes: number,
  truncated: boolean,
  meta: HTMLElement,
  warnings: HTMLElement,
): void {
  const bytes = new TextEncoder().encode(text).byteLength;
  meta.textContent = `${bytes}/${maxBytes} bytes${truncated ? " truncated" : ""}`;
  warnings.replaceChildren(
    ...findSecretWarnings(text).map((warning) => {
      const item = document.createElement("li");
      item.textContent = warning;
      return item;
    }),
  );
}

function disposeTerminal(): void {
  const socket = ws;
  stopPing();
  stopPolling();
  appToolTransport = false;
  resizeObserver?.disconnect();
  terminalDataDisposable?.dispose();
  fitAddon?.dispose();
  terminal?.dispose();
  pendingInput = [];
  pendingInputBytes = 0;
  resizeObserver = undefined;
  terminalDataDisposable = undefined;
  fitAddon = undefined;
  terminal = undefined;
  ws = undefined;
  socket?.close();
}

function stopPolling(): void {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

async function cleanup(closeSession: boolean): Promise<boolean> {
  const capability = sessionCapability;
  const closeViaBridge = closeSession && ws?.readyState === WebSocket.OPEN;
  if (closeViaBridge) {
    sendTerminalMessage({ type: "close" });
  } else if (closeSession && capability) {
    let closed;
    try {
      closed = await app.callServerTool({
        name: "close_quick_shell_session",
        arguments: capability,
      });
    } catch (error) {
      console.error("quick-shell session close failed", error);
      setStatus("Could not close session; it will expire automatically.");
      updateControls();
      return false;
    }

    if (closed.isError) {
      setStatus(toolResultText(closed, "Could not close session; it will expire automatically."));
      updateControls();
      return false;
    }
  }

  disposeTerminal();
  publicSession = undefined;
  session = undefined;
  sessionDetails = undefined;
  sessionCapability = undefined;
  connectionFailed = false;
  updateModelContext(closeSession ? "closed" : "idle");
  updateControls();
  return true;
}

async function closeUnusedSession(capability: QuickShellHiddenMeta["quickShell"]): Promise<void> {
  try {
    const closed = await app.callServerTool({
      name: "close_quick_shell_session",
      arguments: capability,
    });
    if (closed.isError) console.error("quick-shell unused session close failed");
  } catch (error) {
    console.error("quick-shell unused session close failed", error);
  }
}

function setStatus(message: string): void {
  elements.status.textContent = message;
}

function renderError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(message);
  sendHostLog("error", message);
}

function handleConnectFailure(error: unknown): void {
  connectionFailed = true;
  renderError(error);
  updateControls();
}

function toolResultText(result: { content?: Array<{ type?: string; text?: string }> }, fallback: string): string {
  const text = result.content
    ?.map((item) => (item.type === "text" ? item.text : undefined))
    .filter((item): item is string => Boolean(item?.trim()))
    .join("\n")
    .trim();
  return text || fallback;
}

function isCurrentGeneration(generation: number, sessionId: string): boolean {
  return generation === toolResultGeneration && session?.sessionId === sessionId;
}

function startPing(intervalMs = DEFAULT_PING_INTERVAL_MS): void {
  stopPing();
  pingTimer = window.setInterval(() => {
    sendTerminalMessage({ type: "ping" });
  }, intervalMs);
}

function stopPing(): void {
  if (pingTimer !== undefined) {
    window.clearInterval(pingTimer);
    pingTimer = undefined;
  }
}

function updateControls(): void {
  const capabilities = app.getHostCapabilities();
  const context = app.getHostContext() ?? hostContext;
  const displayTarget = nextDisplayMode(context);
  elements.displayModeButton.hidden = displayTarget === undefined;
  elements.displayModeButton.disabled = displayTarget === undefined;
  elements.displayModeButton.textContent = context.displayMode === "fullscreen" ? "Inline" : "Fullscreen";
  elements.downloadButton.hidden = capabilities?.downloadFile === undefined;
  elements.downloadButton.disabled = session === undefined || capabilities?.downloadFile === undefined;
  elements.connectButton.hidden = !connectionFailed || session !== undefined;
  elements.connectButton.disabled = connecting || (!sessionCapability && !sessionDetails) || session !== undefined;
  elements.insertButton.disabled = session === undefined;
  elements.sendButton.disabled = session === undefined;
  elements.closeButton.disabled = sessionCapability === undefined && sessionDetails === undefined && session === undefined;
}

function applyToolInput(args: Record<string, unknown> | undefined): void {
  if (!args) return;
  const device = typeof args.device === "string" ? args.device : undefined;
  const suggested = typeof args.suggested_command === "string" ? args.suggested_command : undefined;
  if (device && !publicSession) setStatus(`Preparing: ${device}`);
  if (suggested && !elements.commandInput.value) elements.commandInput.value = suggested;
}

function applyHostContext(ctx: HostContext | undefined): void {
  if (!ctx) return;
  hostContext = { ...hostContext, ...ctx };
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  const rootStyle = document.documentElement.style;
  const safeArea = hostContext.safeAreaInsets;
  rootStyle.setProperty("--qs-safe-area-top", `${safeArea?.top ?? 0}px`);
  rootStyle.setProperty("--qs-safe-area-right", `${safeArea?.right ?? 0}px`);
  rootStyle.setProperty("--qs-safe-area-bottom", `${safeArea?.bottom ?? 0}px`);
  rootStyle.setProperty("--qs-safe-area-left", `${safeArea?.left ?? 0}px`);
  if (hostContext.displayMode) {
    document.documentElement.dataset.displayMode = hostContext.displayMode;
  }
  if (hostContext.platform) {
    document.documentElement.dataset.platform = hostContext.platform;
  }
  updateControls();
}

function nextDisplayMode(ctx: HostContext | undefined): "inline" | "fullscreen" | undefined {
  const available = ctx?.availableDisplayModes ?? [];
  if (ctx?.displayMode === "fullscreen") return available.includes("inline") ? "inline" : undefined;
  return available.includes("fullscreen") ? "fullscreen" : undefined;
}

async function toggleDisplayMode(): Promise<void> {
  const target = nextDisplayMode(app.getHostContext() ?? hostContext);
  if (!target) return;
  const result = await app.requestDisplayMode({ mode: target });
  applyHostContext({ displayMode: result.mode });
}

async function downloadOutput(): Promise<void> {
  if (!session || app.getHostCapabilities()?.downloadFile === undefined) return;
  const prepared = truncateForSubmit(normalizeTerminalOutput(outputBuffer.toString()), session.maxSubmitBytes);
  const result = await app.downloadFile({
    contents: [
      {
        type: "resource",
        resource: {
          uri: "file:///quick-shell-output.txt",
          mimeType: "text/plain",
          text: prepared.text,
        },
      },
    ],
  });
  setStatus(result.isError ? "Download cancelled" : "Download requested");
}

function updateModelContext(state: string): void {
  const capabilities = app.getHostCapabilities();
  const updateCapabilities = capabilities?.updateModelContext;
  if (!updateCapabilities) return;
  const current = publicSession ?? session;
  const contextKey = JSON.stringify({
    state,
    sessionId: current?.sessionId,
    device: current?.device,
  });
  if (contextKey === lastModelContextKey) return;
  lastModelContextKey = contextKey;

  const payload: Parameters<App["updateModelContext"]>[0] = {};
  if (updateCapabilities.text) {
    const device = current?.device ? ` for ${current.device}` : "";
    payload.content = [
      {
        type: "text",
        text: `quick-shell state: ${state}${device}. The terminal connects automatically; output is sent back to Claude only when the user chooses Send output.`,
      },
    ];
  }
  if (updateCapabilities.structuredContent) {
    payload.structuredContent = {
      quickShell: {
        state,
        sessionId: current?.sessionId,
        device: current?.device,
      },
    };
  }
  if (!payload.content && !payload.structuredContent) return;
  void app.updateModelContext(payload).catch((error) => sendHostLog("warning", `updateModelContext failed: ${String(error)}`));
}

function sendHostLog(level: "warning" | "error", message: string): void {
  const capabilities: HostCapabilities | undefined = app.getHostCapabilities();
  if (!capabilities?.logging) return;
  void app.sendLog({ level, data: { message } }).catch(() => {});
}

function assertNever(value: never): never {
  throw new Error(`Unhandled terminal message: ${JSON.stringify(value)}`);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

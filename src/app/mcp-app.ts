import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
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
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
} from "../shared/terminal-defaults.js";
import { BoundedTextBuffer } from "../shared/bounded-text-buffer.js";
import { readTerminalTheme } from "./terminal-theme.js";
import {
  openTerminalSocket,
  sendTerminalTransportMessage,
} from "./terminal-transport.js";
import {
  buildInsertPayload,
  findSecretWarnings,
  normalizeTerminalOutput,
  truncateForSubmit,
} from "./output.js";
import { loadGhosttyRuntime } from "./ghostty-loader.js";
import { buildShell } from "./view.js";
import { FileApi } from "./file-api.js";
import { FileExplorerController } from "./file-explorer.js";
import "./styles.css";

type HostCapabilities = NonNullable<ReturnType<App["getHostCapabilities"]>>;
type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;
type ToolResultParams = {
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
};

type OpenAiBridge = {
  toolResponseMetadata?: unknown;
};

interface QueuedFallbackInput {
  data: string;
  bytes: number;
}

interface FallbackInputQueue {
  generation: number;
  sessionId: string;
  capability: QuickShellHiddenMeta["quickShell"];
  chunks: QueuedFallbackInput[];
  bytes: number;
  draining: boolean;
}

interface FallbackResizeQueue {
  generation: number;
  sessionId: string;
  capability: QuickShellHiddenMeta["quickShell"];
  pending?: { cols: number; rows: number };
  inFlight: boolean;
}

interface SocketBinding {
  socket: WebSocket;
  generation: number;
  sessionId: string;
  capability: QuickShellHiddenMeta["quickShell"];
  ready: boolean;
}

const DEFAULT_SUBMIT_BYTES = 64_000;
const DEFAULT_INPUT_BYTES = 16_384;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const FALLBACK_POLL_INTERVAL_MS = 500;
const FALLBACK_CONNECT_TIMEOUT_MS = 5_000;
const REMOTE_CLOSE_TIMEOUT_MS = 1_000;
const MAX_PENDING_INPUT_BYTES = 16_384;
const MAX_FALLBACK_INPUT_CHUNKS = 256;

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
let fallbackTimer: number | undefined;
let reconnectTimer: number | undefined;
let reconnectAttempts = 0;
let resizeFrame: number | undefined;
let transcriptFrame: number | undefined;
let publicSession: QuickShellPublicSession | undefined;
let session: QuickShellAppSession | undefined;
let sessionDetails: QuickShellAppSession | undefined;
let sessionCapability: QuickShellHiddenMeta["quickShell"] | undefined;
let appToolTransport = false;
let pollingGeneration: number | undefined;
let pollSeq = 0;
let fallbackInputQueue: FallbackInputQueue | undefined;
let fallbackResizeQueue: FallbackResizeQueue | undefined;
let outputBuffer = new BoundedTextBuffer(DEFAULT_SUBMIT_BYTES);
let pendingInput: string[] = [];
let pendingInputBytes = 0;
let pendingResize: { cols: number; rows: number } | undefined;
let socketBinding: SocketBinding | undefined;
let connecting = false;
let connectingGeneration: number | undefined;
let connectionFailed = false;
let sending = false;
let hostContext: HostContext = {};
let lastModelContextKey: string | undefined;
let fileExplorer: FileExplorerController | undefined;

const elements = buildShell();
root.replaceChildren(elements.container);
wireShellEvents();
let receivedToolResultOrder = 0;
let activeGeneration = 0;
let toolResultQueue: Promise<void> = Promise.resolve();

app.ontoolinputpartial = (params) => applyToolInput(params.arguments);
app.ontoolinput = (params) => applyToolInput(params.arguments);
app.onhostcontextchanged = (ctx) => applyHostContext(ctx);
app.ontoolcancelled = (params) =>
  setStatus(params.reason ? `Cancelled: ${params.reason}` : "Cancelled");
app.ontoolresult = (params) => {
  const order = ++receivedToolResultOrder;
  toolResultQueue = toolResultQueue
    .catch(() => {})
    .then(() => handleToolResult(params, order))
    .catch((error) => renderError(error));
};
app.onteardown = async () => {
  await cleanup(true);
  return {};
};
window.addEventListener("error", (event) =>
  renderError(event.error ?? event.message),
);
window.addEventListener("unhandledrejection", (event) =>
  renderError(event.reason),
);

void start().catch((error) => renderError(error));

async function start(): Promise<void> {
  await app.connect();
  applyHostContext(app.getHostContext());
}

function wireShellEvents(): void {
  elements.terminalTab.addEventListener("click", () => showTerminal());
  elements.filesTab.addEventListener("click", () => {
    void showFiles().catch((error) => renderError(error));
  });
  elements.commandStrip.addEventListener("submit", (event) => {
    event.preventDefault();
    const payload = buildInsertPayload(elements.commandInput.value);
    if (payload && session) {
      sendTerminalInput(payload);
      setStatus("Inserted");
    }
  });

  elements.connectButton.addEventListener("click", () => {
    const generation = activeGeneration;
    const capability = sessionCapability;
    void connectPendingSession().catch((error) => {
      handleConnectFailure(error, generation, capability);
    });
  });

  elements.sendButton.addEventListener("click", () => {
    if (!session) return;
    const prepared = truncateForSubmit(
      normalizeTerminalOutput(outputBuffer.toString()),
      session.maxSubmitBytes,
    );
    elements.textarea.value = prepared.text;
    updateDialogMeta(
      prepared.text,
      session.maxSubmitBytes,
      prepared.truncated,
      elements.meta,
      elements.warnings,
    );
    elements.fallback.hidden = true;
    elements.dialog.showModal();
  });

  elements.displayModeButton.addEventListener("click", () => {
    void toggleDisplayMode().catch((error) => renderError(error));
  });

  elements.downloadButton.addEventListener("click", () => {
    void downloadOutput().catch((error) => renderError(error));
  });

  elements.textarea.addEventListener("input", () => {
    const maxBytes = session?.maxSubmitBytes ?? DEFAULT_SUBMIT_BYTES;
    const prepared = truncateForSubmit(
      normalizeTerminalOutput(elements.textarea.value),
      maxBytes,
    );
    if (prepared.text !== elements.textarea.value)
      elements.textarea.value = prepared.text;
    updateDialogMeta(
      elements.textarea.value,
      maxBytes,
      prepared.truncated,
      elements.meta,
      elements.warnings,
    );
  });

  elements.cancelButton.addEventListener("click", () =>
    elements.dialog.close(),
  );
  elements.confirmButton.addEventListener("click", () => {
    if (sending) return;
    const snapshot = elements.textarea.value;
    void confirmSend(
      snapshot,
      elements.fallback,
      elements.dialog,
      elements.cancelButton,
      elements.confirmButton,
    ).catch((error) => console.error("quick-shell send failed", error));
  });

  elements.closeButton.addEventListener("click", () => {
    void cleanup(true).catch((error) => renderError(error));
  });
}

function readPublicSession(
  value: unknown,
): QuickShellPublicSession | undefined {
  const parsed = QuickShellPublicSessionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readAppSession(value: unknown): QuickShellAppSession | undefined {
  const parsed = QuickShellAppSessionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readQuickShellMeta(
  value: unknown,
): QuickShellHiddenMeta["quickShell"] | undefined {
  const parsed = QuickShellHiddenMetaSchema.safeParse(value);
  return parsed.success ? parsed.data.quickShell : undefined;
}

function readQuickShellPoll(value: unknown): QuickShellPoll | undefined {
  const parsed = QuickShellPollSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readOpenAiToolResult(): ToolResultParams | undefined {
  const bridge = (window as unknown as { openai?: OpenAiBridge }).openai;
  if (!bridge?.toolResponseMetadata) return undefined;
  const metadata = bridge.toolResponseMetadata;
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const record = metadata as Record<string, unknown>;
  if (record.quickShell || record.quickShellSession) {
    return { _meta: record };
  }
  for (const candidate of [
    record.mcp_tool_result,
    record.call_tool_result,
    metadata,
  ]) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const result = candidate as ToolResultParams;
    if (result._meta || result.structuredContent || result.content)
      return result;
  }
  return undefined;
}

async function handleToolResult(
  params: ToolResultParams,
  order: number,
): Promise<void> {
  if (params.isError) {
    setStatus(toolResultText(params, "Tool error"));
    return;
  }

  connecting = false;
  connectingGeneration = undefined;
  const nextPublicSession = readPublicSession(params.structuredContent);
  const hiddenMeta = params._meta ?? readOpenAiToolResult()?._meta;
  const quickShell = readQuickShellMeta(hiddenMeta);
  const quickShellSession = readAppSession(hiddenMeta?.quickShellSession);
  if (
    !nextPublicSession ||
    !quickShell ||
    quickShell.sessionId !== nextPublicSession.sessionId
  ) {
    throw new Error("Missing quick-shell app capability");
  }
  if (
    quickShellSession &&
    quickShellSession.sessionId !== nextPublicSession.sessionId
  ) {
    throw new Error("Invalid quick-shell session capability");
  }

  if (order !== receivedToolResultOrder) {
    await closeUnusedSession(quickShell);
    return;
  }

  const previousCapability = sessionCapability;
  await cleanup(true, previousCapability);
  if (order !== receivedToolResultOrder) {
    await closeUnusedSession(quickShell);
    return;
  }
  const generation = ++activeGeneration;
  publicSession = nextPublicSession;
  sessionCapability = quickShell;
  sessionDetails = quickShellSession;
  session = undefined;
  resetOutputBuffers(quickShellSession?.maxSubmitBytes ?? DEFAULT_SUBMIT_BYTES);
  elements.commandInput.value = nextPublicSession.suggestedCommand ?? "";
  updateSessionSummary();
  setStatus(`Connecting ${sessionDisplayName(nextPublicSession)}`);
  updateModelContext("connecting");
  updateControls();
  void connectPendingSession().catch((error) =>
    handleConnectFailure(error, generation, quickShell),
  );
}

async function connectPendingSession(): Promise<void> {
  if (
    connecting ||
    session ||
    !publicSession ||
    (!sessionCapability && !sessionDetails)
  )
    return;
  const generation = activeGeneration;
  const capability = sessionCapability;
  let detailsSession = sessionDetails;
  const requested = publicSession;
  connecting = true;
  connectingGeneration = generation;
  connectionFailed = false;
  setStatus(`Connecting ${sessionDisplayName(requested)}`);
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
      if (details.isError)
        throw new Error(toolResultText(details, "Session capability rejected"));
      if (generation !== activeGeneration || sessionCapability !== capability)
        return;
      detailsSession = readAppSession(
        (details as { _meta?: Record<string, unknown> })._meta
          ?.quickShellSession,
      );
    }
    if (!detailsSession || detailsSession.sessionId !== requested.sessionId) {
      throw new Error("Invalid quick-shell session details");
    }
    session = detailsSession;
    resetOutputBuffers(detailsSession.maxSubmitBytes);
    updateSessionSummary();
    updateModelContext("connecting");
    updateControls();
    try {
      await connectTerminal(detailsSession, generation);
    } catch (error) {
      if (
        generation === activeGeneration &&
        session?.sessionId === detailsSession.sessionId
      ) {
        disposeTerminal();
        session = undefined;
        resetOutputBuffers(detailsSession.maxSubmitBytes);
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

async function connectTerminal(
  details: QuickShellAppSession,
  generation: number,
): Promise<void> {
  disposeTerminal();
  outputBuffer.clear();
  resetAccessibleTranscript();
  await loadGhosttyRuntime();
  if (!isCurrentGeneration(generation, details.sessionId)) return;

  createTerminal(DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS);
  observeTerminalResize();
  let socket: WebSocket;
  try {
    socket = openTerminalSocket(details);
  } catch (error) {
    // The polled fallback is legitimate, but hiding why it engaged is not: a
    // bad bridge URL or a CSP connect-src block otherwise presents only as an
    // unexplained slow terminal.
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      "quick-shell websocket open failed; falling back to polling",
      error,
    );
    sendHostLog(
      "warning",
      `Live terminal unavailable (${detail}); using polled transport`,
    );
    await startAppToolTransport(details, generation);
    return;
  }
  if (!isCurrentGeneration(generation, details.sessionId)) {
    disposeTerminal();
    socket.close();
    return;
  }
  ws = socket;
  const capability = sessionCapability;
  if (!capability) {
    disposeTerminal();
    socket.close();
    return;
  }
  const binding: SocketBinding = {
    socket,
    generation,
    sessionId: details.sessionId,
    capability,
    ready: false,
  };
  socketBinding = binding;
  let fallbackStarted = false;
  const startFallback = () => {
    if (fallbackStarted || binding.ready || !isCurrentSocketBinding(binding))
      return;
    fallbackStarted = true;
    clearFallbackTimer();
    ws = undefined;
    socketBinding = undefined;
    socket.close();
    void startAppToolTransport(details, generation).catch((error) => {
      handleConnectFailure(error, generation, capability);
    });
  };
  fallbackTimer = window.setTimeout(startFallback, FALLBACK_CONNECT_TIMEOUT_MS);
  socket.addEventListener("open", () => {
    if (!isCurrentSocketBinding(binding)) return;
    socket.send(
      JSON.stringify({ type: "authenticate", token: details.wsToken }),
    );
    updateControls();
  });
  socket.addEventListener("message", (event) => {
    if (handleTerminalMessage(binding, event.data)) {
      binding.ready = true;
      reconnectAttempts = 0;
      clearFallbackTimer();
    }
  });
  socket.addEventListener("close", (event) => {
    if (isCurrentSocketBinding(binding) && !binding.ready) {
      startFallback();
      return;
    }
    if (isCurrentSocketBinding(binding)) {
      clearFallbackTimer();
      setStatus(`${disconnectStatus(event)}; reconnecting`);
      updateModelContext("reconnecting");
      updateControls();
      scheduleTerminalReconnect(details, generation, capability);
    }
  });
  socket.addEventListener("error", () => {
    if (!isCurrentSocketBinding(binding)) return;
    setStatus("Connection error");
    if (!binding.ready) startFallback();
  });
}

function observeTerminalResize(): void {
  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => {
    scheduleResize();
  });
  resizeObserver.observe(elements.terminalMount);
}

function createTerminal(cols: number, rows: number): Terminal {
  const nextTerminal = new Terminal({
    cols,
    rows,
    fontFamily:
      "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 13,
    theme: readTerminalTheme(),
  });
  const nextFitAddon = new FitAddon();
  nextTerminal.loadAddon(nextFitAddon);
  nextTerminal.open(elements.terminalMount);
  const nextTerminalDataDisposable = nextTerminal.onData((data) => {
    sendTerminalInput(data);
  });

  terminal = nextTerminal;
  fitAddon = nextFitAddon;
  terminalDataDisposable = nextTerminalDataDisposable;
  return nextTerminal;
}

function rebuildTerminalTheme(): void {
  if (!terminal) return;
  const cols = terminal.cols;
  const rows = terminal.rows;
  const snapshot = outputBuffer.toString();
  terminalDataDisposable?.dispose();
  fitAddon?.dispose();
  terminal.dispose();
  elements.terminalMount.replaceChildren();
  terminal = undefined;
  fitAddon = undefined;
  terminalDataDisposable = undefined;
  const rebuilt = createTerminal(cols, rows);
  if (snapshot) rebuilt.write(snapshot);
  scheduleResize();
}

function handleTerminalMessage(binding: SocketBinding, data: unknown): boolean {
  if (!isCurrentSocketBinding(binding)) return false;

  let message: ServerTerminalMessage;
  try {
    message = ServerTerminalMessageSchema.parse(JSON.parse(String(data)));
  } catch {
    setStatus("Bad bridge message");
    return false;
  }

  switch (message.type) {
    case "ready":
      if (message.sessionId !== binding.sessionId) {
        setStatus("Bad bridge session");
        return false;
      }
      outputBuffer.clear();
      resetAccessibleTranscript();
      appendTerminalOutput(message.scrollback);
      binding.ready = true;
      fitAddon?.fit();
      sendResize();
      flushPendingInputToWebSocket();
      startPing(session?.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);
      connectionFailed = false;
      setConnectedStatus();
      updateModelContext("connected");
      updateControls();
      return true;
    case "output":
      appendTerminalOutput(message.data);
      break;
    case "exit":
      setStatus(
        message.exitCode === null ? "Exited" : `Exited ${message.exitCode}`,
      );
      break;
    case "error":
      setStatus(message.message);
      break;
    default:
      assertNever(message);
  }
  return false;
}

function sendResize(): void {
  if (!terminal) return;
  const proposed = fitAddon?.proposeDimensions();
  const cols = clamp(
    proposed?.cols ?? terminal.cols,
    MIN_TERMINAL_COLS,
    MAX_TERMINAL_COLS,
  );
  const rows = clamp(
    proposed?.rows ?? terminal.rows,
    MIN_TERMINAL_ROWS,
    MAX_TERMINAL_ROWS,
  );
  terminal.resize(cols, rows);
  if (appToolTransport) {
    pendingResize = undefined;
    enqueueFallbackResize(cols, rows);
  } else if (socketBinding?.ready && isCurrentSocketBinding(socketBinding)) {
    pendingResize = undefined;
    sendTerminalMessage({ type: "resize", cols, rows });
  } else {
    pendingResize = { cols, rows };
  }
}

function scheduleResize(): void {
  if (elements.terminalMount.hidden) return;
  if (resizeFrame !== undefined) return;
  resizeFrame = window.requestAnimationFrame(() => {
    resizeFrame = undefined;
    fitAddon?.fit();
    sendResize();
  });
}

function sendTerminalMessage(message: ClientTerminalMessage): void {
  if (ws) sendTerminalTransportMessage(ws, message);
}

function utf8Bytes(data: string): number {
  return new TextEncoder().encode(data).byteLength;
}

function terminalMessageBytes(message: ClientTerminalMessage): number {
  return utf8Bytes(JSON.stringify(message));
}

function sendTerminalInput(data: string): void {
  const bytes = new TextEncoder().encode(data).byteLength;
  const maxInputBytes = session?.maxInputBytes ?? DEFAULT_INPUT_BYTES;
  if (bytes > maxInputBytes) {
    setStatus(`Input is larger than ${maxInputBytes} bytes.`);
    return;
  }

  if (appToolTransport) {
    enqueueFallbackInput(data);
    return;
  }

  const frameLimit = session?.maxWsPayloadBytes;
  if (
    frameLimit !== undefined &&
    terminalMessageBytes({ type: "input", data }) > frameLimit
  ) {
    setStatus(`Input frame is larger than ${frameLimit} bytes.`);
    return;
  }

  if (socketBinding?.ready && isCurrentSocketBinding(socketBinding)) {
    sendTerminalMessage({ type: "input", data });
    return;
  }

  if (pendingInputBytes + bytes > MAX_PENDING_INPUT_BYTES) {
    setStatus("Waiting for connection; input buffer full.");
    return;
  }

  pendingInput.push(data);
  pendingInputBytes += bytes;
  setStatus("Waiting for connection");
}

async function startAppToolTransport(
  details: QuickShellAppSession,
  generation: number,
): Promise<void> {
  if (!sessionCapability || !isCurrentGeneration(generation, details.sessionId))
    return;
  stopPing();
  appToolTransport = true;
  clearFallbackTimer();
  if (reconnectTimer !== undefined) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  pollingGeneration = undefined;
  pollSeq = 0;
  fallbackInputQueue = undefined;
  fallbackResizeQueue = undefined;

  const attached = await app.callServerTool({
    name: "get_quick_shell_session",
    arguments: sessionCapability,
  });
  if (attached.isError)
    throw new Error(toolResultText(attached, "Session capability rejected"));
  const attachedSession =
    readAppSession(
      (attached as { _meta?: Record<string, unknown> })._meta
        ?.quickShellSession,
    ) ?? details;
  if (
    !isCurrentGeneration(generation, details.sessionId) ||
    attachedSession.sessionId !== details.sessionId
  )
    return;
  session = attachedSession;
  connectionFailed = false;
  setConnectedStatus();
  updateModelContext("connected");
  updateControls();
  flushPendingInputToAppTool();
  flushPendingResizeToAppTool();
  await pollAppToolTransport(generation);
  if (!isCurrentGeneration(generation, details.sessionId)) return;
  pollTimer = window.setInterval(() => {
    void pollAppToolTransport(generation).catch((error) => {
      if (!isCurrentGeneration(generation, details.sessionId)) return;
      setStatus(
        `Poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, FALLBACK_POLL_INTERVAL_MS);
}

async function pollAppToolTransport(generation: number): Promise<void> {
  if (
    pollingGeneration === generation ||
    !session ||
    !sessionCapability ||
    !appToolTransport ||
    !isCurrentGeneration(generation, session.sessionId)
  )
    return;
  pollingGeneration = generation;
  const sessionId = session.sessionId;
  try {
    const result = await app.callServerTool({
      name: "poll_quick_shell_session",
      arguments: {
        ...sessionCapability,
        afterSeq: pollSeq,
      },
    });
    if (result.isError)
      throw new Error(toolResultText(result, "Quick-shell poll failed"));
    const poll = readQuickShellPoll(
      (result as { _meta?: Record<string, unknown> })._meta?.quickShellPoll,
    );
    if (!poll || !isCurrentGeneration(generation, poll.sessionId)) return;
    const truncated =
      (poll.truncatedBytes ?? 0) > 0 ||
      poll.chunks.some((chunk) => chunk.truncated);
    const chunks =
      poll.reset && poll.snapshot !== undefined
        ? poll.chunks.filter((chunk) => !chunk.snapshot)
        : poll.chunks;
    if (poll.reset) {
      resetTerminalOutput();
      if (poll.snapshot !== undefined) appendTerminalOutput(poll.snapshot);
    }
    for (const chunk of chunks) appendTerminalOutput(chunk.data);
    pollSeq = poll.nextSeq;
    if (poll.exited) {
      setStatus(poll.exitCode === null ? "Exited" : `Exited ${poll.exitCode}`);
      stopPolling();
    } else if (poll.reset && truncated) {
      setStatus(`${connectedLabel()}, earlier output was truncated`);
    } else {
      setConnectedStatus();
    }
  } finally {
    if (pollingGeneration === generation && session?.sessionId === sessionId) {
      pollingGeneration = undefined;
    }
  }
}

function enqueueFallbackInput(data: string): void {
  const generation = activeGeneration;
  const sessionId = session?.sessionId;
  if (!sessionCapability || !sessionId) return;
  const capability = sessionCapability;
  const bytes = utf8Bytes(data);
  const existing =
    fallbackInputQueue?.generation === generation &&
    fallbackInputQueue.sessionId === sessionId &&
    fallbackInputQueue.capability === capability
      ? fallbackInputQueue
      : undefined;
  const queue =
    existing ??
    ({
      generation,
      sessionId,
      capability,
      chunks: [],
      bytes: 0,
      draining: false,
    } satisfies FallbackInputQueue);
  if (
    queue.bytes + bytes > MAX_PENDING_INPUT_BYTES ||
    queue.chunks.length >= MAX_FALLBACK_INPUT_CHUNKS
  ) {
    setStatus("Fallback input buffer full.");
    return;
  }
  queue.chunks.push({ data, bytes });
  queue.bytes += bytes;
  fallbackInputQueue = queue;
  if (!queue.draining) void drainFallbackInputQueue(queue);
}

async function drainFallbackInputQueue(
  queue: FallbackInputQueue,
): Promise<void> {
  queue.draining = true;
  let failed = false;
  try {
    while (
      queue.chunks.length > 0 &&
      fallbackInputQueue === queue &&
      isCurrentGeneration(queue.generation, queue.sessionId) &&
      sessionCapability === queue.capability &&
      appToolTransport
    ) {
      const first = queue.chunks[0]!;
      let data = first.data;
      let bytes = first.bytes;
      let chunkCount = 1;
      while (chunkCount < queue.chunks.length) {
        const next = queue.chunks[chunkCount]!;
        if (
          bytes + next.bytes >
          (session?.maxInputBytes ?? DEFAULT_INPUT_BYTES)
        )
          break;
        data += next.data;
        bytes += next.bytes;
        chunkCount += 1;
      }
      const result = await app.callServerTool({
        name: "write_quick_shell_input",
        arguments: {
          ...queue.capability,
          data,
        },
      });
      if (
        !isCurrentGeneration(queue.generation, queue.sessionId) ||
        sessionCapability !== queue.capability ||
        !appToolTransport
      )
        return;
      if (result.isError)
        throw new Error(toolResultText(result, "Quick-shell input failed"));
      if (result.structuredContent?.written !== true)
        throw new Error("Quick-shell input was not acknowledged");
      queue.chunks.splice(0, chunkCount);
      queue.bytes -= bytes;
    }
  } catch (error) {
    failed = true;
    queue.chunks = [];
    queue.bytes = 0;
    if (
      isCurrentGeneration(queue.generation, queue.sessionId) &&
      sessionCapability === queue.capability
    ) {
      setStatus(
        `Input failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    if (fallbackInputQueue === queue) {
      queue.draining = false;
      if (failed || queue.chunks.length === 0) fallbackInputQueue = undefined;
      else void drainFallbackInputQueue(queue);
    }
  }
}

function enqueueFallbackResize(cols: number, rows: number): void {
  const generation = activeGeneration;
  const sessionId = session?.sessionId;
  if (!sessionCapability || !sessionId) return;
  const capability = sessionCapability;
  const queue =
    fallbackResizeQueue?.generation === generation &&
    fallbackResizeQueue.sessionId === sessionId &&
    fallbackResizeQueue.capability === capability
      ? fallbackResizeQueue
      : ({
          generation,
          sessionId,
          capability,
          inFlight: false,
        } satisfies FallbackResizeQueue);
  if (queue.pending?.cols === cols && queue.pending.rows === rows) return;
  queue.pending = { cols, rows };
  fallbackResizeQueue = queue;
  if (!queue.inFlight) void drainFallbackResizeQueue(queue);
}

async function drainFallbackResizeQueue(
  queue: FallbackResizeQueue,
): Promise<void> {
  queue.inFlight = true;
  try {
    while (
      queue.pending &&
      fallbackResizeQueue === queue &&
      isCurrentGeneration(queue.generation, queue.sessionId) &&
      sessionCapability === queue.capability &&
      appToolTransport
    ) {
      const next = queue.pending;
      queue.pending = undefined;
      await app.callServerTool({
        name: "resize_quick_shell_session",
        arguments: {
          ...queue.capability,
          cols: next.cols,
          rows: next.rows,
        },
      });
    }
  } catch (error) {
    console.error("quick-shell resize failed", error);
  } finally {
    if (fallbackResizeQueue === queue) {
      queue.inFlight = false;
      if (queue.pending) void drainFallbackResizeQueue(queue);
    }
  }
}

function drainPendingInput(send: (data: string) => void): void {
  const queued = pendingInput;
  pendingInput = [];
  pendingInputBytes = 0;
  for (const data of queued) {
    send(data);
  }
}

function flushPendingInputToWebSocket(): void {
  drainPendingInput((data) => sendTerminalMessage({ type: "input", data }));
}

function flushPendingInputToAppTool(): void {
  drainPendingInput((data) => enqueueFallbackInput(data));
}

function flushPendingResizeToAppTool(): void {
  const resize = pendingResize;
  pendingResize = undefined;
  if (resize) enqueueFallbackResize(resize.cols, resize.rows);
}

function appendTerminalOutput(data: string): void {
  if (data.length === 0) return;
  terminal?.write(data);
  outputBuffer.append(data);
  scheduleAccessibleTranscriptUpdate();
}

function resetTerminalOutput(): void {
  outputBuffer.clear();
  terminal?.reset();
  resetAccessibleTranscript();
}

function resetOutputBuffers(maxBytes = DEFAULT_SUBMIT_BYTES): void {
  outputBuffer = new BoundedTextBuffer(maxBytes);
  resetAccessibleTranscript();
}

function scheduleAccessibleTranscriptUpdate(): void {
  if (transcriptFrame !== undefined) return;
  transcriptFrame = window.requestAnimationFrame(() => {
    transcriptFrame = undefined;
    elements.transcript.textContent = normalizeTerminalOutput(
      outputBuffer.toString(),
    );
  });
}

function resetAccessibleTranscript(): void {
  if (transcriptFrame !== undefined) {
    window.cancelAnimationFrame(transcriptFrame);
    transcriptFrame = undefined;
  }
  elements.transcript.textContent = "";
}

async function confirmSend(
  text: string,
  fallback: HTMLTextAreaElement,
  dialog: HTMLDialogElement,
  cancelButton: HTMLButtonElement,
  confirmButton: HTMLButtonElement,
): Promise<void> {
  const capturedGeneration = activeGeneration;
  const capturedSession = session;
  const capturedCapability = sessionCapability;
  const capturedSocket = socketBinding;
  if (!capturedSession) return;
  const isCurrentSend = () =>
    activeGeneration === capturedGeneration &&
    session === capturedSession &&
    sessionCapability === capturedCapability;
  const maxBytes = capturedSession.maxSubmitBytes;
  const prepared = truncateForSubmit(normalizeTerminalOutput(text), maxBytes);
  sending = true;
  cancelButton.disabled = true;
  confirmButton.disabled = true;
  try {
    const result = await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: prepared.text }],
    });
    if (!isCurrentSend()) return;
    if (result.isError) {
      fallback.hidden = false;
      fallback.value = prepared.text;
      setStatus("Send failed; copy the fallback output manually.");
      return;
    }
    const byteCount = new TextEncoder().encode(prepared.text).byteLength;
    if (
      capturedSocket?.ready &&
      socketBinding === capturedSocket &&
      isCurrentSocketBinding(capturedSocket)
    ) {
      sendTerminalTransportMessage(capturedSocket.socket, {
        type: "output_confirmed",
        byteCount,
      });
    } else if (capturedCapability) {
      await app
        .callServerTool({
          name: "record_quick_shell_output_confirmed",
          arguments: {
            ...capturedCapability,
            byteCount,
          },
        })
        .catch((error) =>
          console.error("quick-shell audit record failed", error),
        );
    }
    if (!isCurrentSend()) return;
    dialog.close();
    setStatus("Sent");
    updateModelContext("output-sent");
  } catch (error) {
    if (isCurrentSend()) {
      fallback.hidden = false;
      fallback.value = prepared.text;
      setStatus(
        `Send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } else {
      console.error("quick-shell stale send failed", error);
    }
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
  clearFallbackTimer();
  appToolTransport = false;
  if (resizeFrame !== undefined) {
    window.cancelAnimationFrame(resizeFrame);
    resizeFrame = undefined;
  }
  resizeObserver?.disconnect();
  terminalDataDisposable?.dispose();
  fitAddon?.dispose();
  terminal?.dispose();
  pendingInput = [];
  pendingInputBytes = 0;
  pendingResize = undefined;
  fallbackInputQueue = undefined;
  fallbackResizeQueue = undefined;
  resizeObserver = undefined;
  terminalDataDisposable = undefined;
  fitAddon = undefined;
  terminal = undefined;
  ws = undefined;
  socketBinding = undefined;
  socket?.close();
}

function clearFallbackTimer(): void {
  if (fallbackTimer !== undefined) {
    window.clearTimeout(fallbackTimer);
    fallbackTimer = undefined;
  }
}

function scheduleTerminalReconnect(
  details: QuickShellAppSession,
  generation: number,
  capability: QuickShellHiddenMeta["quickShell"],
): void {
  if (reconnectTimer !== undefined) return;
  const delay = Math.min(4_000, 250 * 2 ** Math.min(reconnectAttempts, 4));
  reconnectAttempts += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    if (!isCurrentGeneration(generation, details.sessionId)) return;
    void connectTerminal(details, generation).catch((error) => {
      if (!isCurrentGeneration(generation, details.sessionId)) return;
      if (reconnectAttempts >= 5) {
        void startAppToolTransport(details, generation).catch((fallbackError) =>
          handleConnectFailure(fallbackError, generation, capability),
        );
        return;
      }
      console.error("quick-shell reconnect failed", error);
      scheduleTerminalReconnect(details, generation, capability);
    });
  }, delay);
}

function stopPolling(): void {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
  pollingGeneration = undefined;
}

async function cleanup(
  closeSession: boolean,
  expectedCapability = sessionCapability,
): Promise<boolean> {
  const capability = expectedCapability;
  const ownsCurrentSession = sessionCapability === expectedCapability;
  const binding = ownsCurrentSession ? socketBinding : undefined;
  const closeViaBridge = Boolean(
    closeSession &&
    binding?.ready &&
    binding.capability === capability &&
    isCurrentSocketBinding(binding),
  );

  if (closeViaBridge && binding) {
    sendTerminalTransportMessage(binding.socket, { type: "close" });
  }

  if (ownsCurrentSession) {
    activeGeneration += 1;
    reconnectAttempts = 0;
    disposeTerminal();
    publicSession = undefined;
    session = undefined;
    sessionDetails = undefined;
    sessionCapability = undefined;
    connectionFailed = false;
    elements.dialog.close();
    fileExplorer?.dispose();
    fileExplorer = undefined;
    showTerminal();
    updateSessionSummary();
    resetOutputBuffers();
    updateModelContext(closeSession ? "closed" : "idle");
    updateControls();
  }

  if (!closeSession || !capability || closeViaBridge) return true;
  const error = await closeRemoteSession(capability);
  if (!error) return true;
  console.error("quick-shell session close failed", error);
  if (ownsCurrentSession && sessionCapability === undefined) {
    setStatus(error);
    updateControls();
  }
  return false;
}

function showTerminal(): void {
  elements.terminalTab.setAttribute("aria-selected", "true");
  elements.filesTab.setAttribute("aria-selected", "false");
  elements.commandStrip.hidden = false;
  elements.terminalMount.hidden = false;
  elements.transcript.hidden = false;
  elements.actions.hidden = false;
  elements.filesMount.hidden = true;
  scheduleResize();
}

async function showFiles(): Promise<void> {
  if (
    !session ||
    !sessionCapability ||
    !session.fileBaseUrl ||
    !session.fileToken
  ) {
    setStatus("Connect before browsing files");
    return;
  }
  elements.terminalTab.setAttribute("aria-selected", "false");
  elements.filesTab.setAttribute("aria-selected", "true");
  elements.commandStrip.hidden = true;
  elements.terminalMount.hidden = true;
  elements.transcript.hidden = true;
  elements.actions.hidden = true;
  elements.filesMount.hidden = false;
  if (!fileExplorer) {
    const canDownload = app.getHostCapabilities()?.downloadFile !== undefined;
    fileExplorer = new FileExplorerController(
      elements.filesMount,
      new FileApi(
        app,
        sessionCapability,
        session.fileBaseUrl,
        session.fileToken,
      ),
      setStatus,
      canDownload ? downloadRemoteFile : undefined,
    );
  }
  await fileExplorer.load();
}

async function downloadRemoteFile(
  name: string,
  bytes: ArrayBuffer,
): Promise<void> {
  const data = new Uint8Array(bytes);
  let binary = "";
  for (let offset = 0; offset < data.length; offset += 32_768)
    binary += String.fromCharCode(...data.subarray(offset, offset + 32_768));
  const result = await app.downloadFile({
    contents: [
      {
        type: "resource",
        resource: {
          uri: `file:///${encodeURIComponent(name)}`,
          mimeType: "application/octet-stream",
          blob: btoa(binary),
        },
      },
    ],
  });
  if (result.isError) throw new Error("Download cancelled");
}

async function closeUnusedSession(
  capability: QuickShellHiddenMeta["quickShell"],
): Promise<void> {
  const error = await closeRemoteSession(capability);
  if (error) console.error("quick-shell unused session close failed", error);
}

async function closeRemoteSession(
  capability: QuickShellHiddenMeta["quickShell"],
): Promise<string | undefined> {
  let timeout: number | undefined;
  try {
    const closed = await Promise.race([
      app.callServerTool({
        name: "close_quick_shell_session",
        arguments: capability,
      }),
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(
          () => reject(new Error("Remote close timed out")),
          REMOTE_CLOSE_TIMEOUT_MS,
        );
      }),
    ]);
    return closed.isError
      ? toolResultText(
          closed,
          "Could not close session; it will expire automatically.",
        )
      : undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

function setStatus(message: string): void {
  elements.status.textContent = message;
  const normalized = message.toLowerCase();
  elements.status.dataset.tone = normalized.startsWith("connected")
    ? "success"
    : normalized.includes("connecting") || normalized.includes("waiting")
      ? "active"
      : normalized.includes("failed") ||
          normalized.includes("error") ||
          normalized.includes("disconnected")
        ? "error"
        : "neutral";
}

function sessionDisplayName(value: QuickShellPublicSession): string {
  return value.deviceLabel
    ? `${value.deviceLabel} (${value.device})`
    : value.device;
}

function connectedLabel(): string {
  const current = session ?? publicSession;
  return current ? `Connected to ${sessionDisplayName(current)}` : "Connected";
}

function setConnectedStatus(): void {
  setStatus(connectedLabel());
}

function disconnectStatus(event: Event): string {
  const close = event as CloseEvent;
  const suffix = close.reason ? `: ${close.reason}` : "";
  return `Disconnected${suffix}`;
}

function updateSessionSummary(): void {
  const current = session ?? publicSession;
  if (!current) {
    elements.sessionSummary.hidden = true;
    elements.sessionSummary.replaceChildren();
    return;
  }
  const items: HTMLElement[] = [];
  const add = (
    label: string,
    value: string | undefined,
    options: { danger?: QuickShellPublicSession["deviceDanger"] } = {},
  ) => {
    if (!value) return;
    const item = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = `${label}: `;
    item.append(strong, document.createTextNode(value));
    if (options.danger) item.dataset.danger = options.danger;
    items.push(item);
  };
  add("Device", sessionDisplayName(current), { danger: current.deviceDanger });
  add("Group", current.deviceGroup);
  add("Shell", current.deviceDefaultShell);
  add("Reason", current.reason);
  elements.sessionSummary.hidden = false;
  elements.sessionSummary.replaceChildren(...items);
}

function renderError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(message);
  sendHostLog("error", message);
}

function handleConnectFailure(
  error: unknown,
  generation: number,
  capability: QuickShellHiddenMeta["quickShell"] | undefined,
): void {
  if (
    generation !== activeGeneration ||
    sessionCapability !== capability ||
    (session && !isCurrentGeneration(generation, session.sessionId))
  )
    return;
  connectionFailed = true;
  renderError(connectFailureMessage(error));
  updateControls();
}

function connectFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/-32000\b.*MCP proxy request failed/i.test(message)) {
    return "Quick Shell could not attach through Labby. Reopen this shell; if it still fails, reconnect Labby. (MCP -32000)";
  }
  return message;
}

function toolResultText(
  result: { content?: Array<{ type?: string; text?: string }> },
  fallback: string,
): string {
  const text = result.content
    ?.map((item) => (item.type === "text" ? item.text : undefined))
    .filter((item): item is string => Boolean(item?.trim()))
    .join("\n")
    .trim();
  return text || fallback;
}

function isCurrentGeneration(generation: number, sessionId: string): boolean {
  return generation === activeGeneration && session?.sessionId === sessionId;
}

function isCurrentSocketBinding(binding: SocketBinding): boolean {
  return (
    socketBinding === binding &&
    ws === binding.socket &&
    sessionCapability === binding.capability &&
    isCurrentGeneration(binding.generation, binding.sessionId)
  );
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
  elements.displayModeButton.textContent =
    context.displayMode === "fullscreen" ? "Inline" : "Fullscreen";
  elements.downloadButton.hidden = capabilities?.downloadFile === undefined;
  elements.downloadButton.disabled =
    session === undefined || capabilities?.downloadFile === undefined;
  elements.connectButton.hidden = !connectionFailed || session !== undefined;
  elements.connectButton.disabled =
    connecting ||
    (!sessionCapability && !sessionDetails) ||
    session !== undefined;
  elements.insertButton.disabled = session === undefined;
  elements.sendButton.disabled = session === undefined;
  elements.closeButton.disabled =
    sessionCapability === undefined &&
    sessionDetails === undefined &&
    session === undefined;
}

function applyToolInput(args: Record<string, unknown> | undefined): void {
  if (!args) return;
  const device = typeof args.device === "string" ? args.device : undefined;
  const suggested =
    typeof args.suggested_command === "string"
      ? args.suggested_command
      : undefined;
  if (device && !publicSession) setStatus(`Preparing: ${device}`);
  if (suggested && !elements.commandInput.value)
    elements.commandInput.value = suggested;
}

function applyHostContext(ctx: HostContext | undefined): void {
  if (!ctx) return;
  const shouldRefreshTerminalTheme =
    Boolean(ctx.theme) || Boolean(ctx.styles?.variables);
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
  if (shouldRefreshTerminalTheme) rebuildTerminalTheme();
  fileExplorer?.setDownload(
    app.getHostCapabilities()?.downloadFile ? downloadRemoteFile : undefined,
  );
  updateControls();
}

function nextDisplayMode(
  ctx: HostContext | undefined,
): "inline" | "fullscreen" | undefined {
  const available = ctx?.availableDisplayModes ?? [];
  if (ctx?.displayMode === "fullscreen")
    return available.includes("inline") ? "inline" : undefined;
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
  const prepared = truncateForSubmit(
    normalizeTerminalOutput(outputBuffer.toString()),
    session.maxSubmitBytes,
  );
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
        text: `quick-shell state: ${state}${device}. The terminal connects automatically; output is sent back only when the user chooses Send output.`,
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
  void app
    .updateModelContext(payload)
    .catch((error) =>
      sendHostLog("warning", `updateModelContext failed: ${String(error)}`),
    );
}

function sendHostLog(level: "warning" | "error", message: string): void {
  const capabilities: HostCapabilities | undefined = app.getHostCapabilities();
  if (!capabilities?.logging) {
    console.error(`quick-shell [${level}] ${message}`);
    return;
  }
  // This is the error-reporting channel itself, so a swallowed failure loses
  // both the report and the reason it failed.
  void app.sendLog({ level, data: { message } }).catch((error: unknown) => {
    console.error(`quick-shell [${level}] ${message}`);
    console.error("quick-shell sendLog failed", error);
  });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled terminal message: ${JSON.stringify(value)}`);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

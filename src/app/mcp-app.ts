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
import "./styles.css";

type HostCapabilities = NonNullable<ReturnType<App["getHostCapabilities"]>>;
type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;
type ToolResultParams = {
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
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

const DEFAULT_SUBMIT_BYTES = 64_000;
const DEFAULT_INPUT_BYTES = 16_384;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const FALLBACK_POLL_INTERVAL_MS = 500;
const FALLBACK_CONNECT_TIMEOUT_MS = 5_000;
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
let resizeFrame: number | undefined;
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
let accessibleOutputBuffer = new BoundedTextBuffer(DEFAULT_SUBMIT_BYTES);
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
wireShellEvents();
let toolResultGeneration = 0;
let toolResultQueue: Promise<void> = Promise.resolve();

app.ontoolinputpartial = (params) => applyToolInput(params.arguments);
app.ontoolinput = (params) => applyToolInput(params.arguments);
app.onhostcontextchanged = (ctx) => applyHostContext(ctx);
app.ontoolcancelled = (params) =>
  setStatus(params.reason ? `Cancelled: ${params.reason}` : "Cancelled");
app.ontoolresult = (params) => {
  const generation = ++toolResultGeneration;
  toolResultQueue = toolResultQueue
    .catch(() => {})
    .then(() => handleToolResult(params, generation))
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
  elements.commandStrip.addEventListener("submit", (event) => {
    event.preventDefault();
    const payload = buildInsertPayload(elements.commandInput.value);
    if (payload && session) {
      sendTerminalInput(payload);
      setStatus("Inserted");
    }
  });

  elements.connectButton.addEventListener("click", () => {
    void connectPendingSession().catch((error) => {
      renderError(error);
      updateControls();
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
    ).catch((error) => {
      elements.fallback.hidden = false;
      elements.fallback.value = snapshot;
      setStatus(
        `Send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
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

async function handleToolResult(
  params: ToolResultParams,
  generation: number,
): Promise<void> {
  if (params.isError) {
    setStatus(toolResultText(params, "Tool error"));
    return;
  }

  connecting = false;
  connectingGeneration = undefined;
  const nextPublicSession = readPublicSession(params.structuredContent);
  const quickShell = readQuickShellMeta(params._meta);
  const quickShellSession = readAppSession(params._meta?.quickShellSession);
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

  if (generation !== toolResultGeneration) {
    await closeUnusedSession(quickShell);
    return;
  }

  const previousCapability = sessionCapability;
  const previousClosed = await cleanup(true, previousCapability).catch(
    (error) => {
      console.error("quick-shell previous session close failed", error);
      setStatus(
        "Could not close previous session; it will expire automatically.",
      );
      return false;
    },
  );
  if (!previousClosed) {
    await closeUnusedSession(quickShell);
    return;
  }
  if (generation !== toolResultGeneration) {
    await closeUnusedSession(quickShell);
    return;
  }
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
  void connectPendingSession().catch((error) => handleConnectFailure(error));
}

async function connectPendingSession(): Promise<void> {
  if (
    connecting ||
    session ||
    !publicSession ||
    (!sessionCapability && !sessionDetails)
  )
    return;
  const generation = toolResultGeneration;
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
      if (
        generation !== toolResultGeneration ||
        sessionCapability !== capability
      )
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
        generation === toolResultGeneration &&
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
  accessibleOutputBuffer.clear();
  await loadGhosttyRuntime();
  if (!isCurrentGeneration(generation, details.sessionId)) return;

  createTerminal(DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS);
  observeTerminalResize();
  let socket: WebSocket;
  try {
    socket = openTerminalSocket(details);
  } catch {
    await startAppToolTransport(details, generation);
    return;
  }
  if (!isCurrentGeneration(generation, details.sessionId)) {
    disposeTerminal();
    socket.close();
    return;
  }
  ws = socket;
  let socketReady = false;
  let fallbackStarted = false;
  const startFallback = () => {
    if (fallbackStarted || socketReady || ws !== socket) return;
    fallbackStarted = true;
    window.clearTimeout(fallbackTimer);
    ws = undefined;
    socket.close();
    void startAppToolTransport(details, generation).catch((error) => {
      handleConnectFailure(error);
      updateControls();
    });
  };
  const fallbackTimer = window.setTimeout(
    startFallback,
    FALLBACK_CONNECT_TIMEOUT_MS,
  );
  socket.addEventListener("open", () => {
    if (ws !== socket) return;
    socket.send(
      JSON.stringify({ type: "authenticate", token: details.wsToken }),
    );
    updateControls();
  });
  socket.addEventListener("message", (event) => {
    if (handleTerminalMessage(socket, event.data)) {
      socketReady = true;
      window.clearTimeout(fallbackTimer);
    }
  });
  socket.addEventListener("close", (event) => {
    if (ws === socket && !socketReady) {
      startFallback();
      return;
    }
    window.clearTimeout(fallbackTimer);
    if (ws === socket) {
      disposeTerminal();
      session = undefined;
      connectionFailed = true;
      setStatus(disconnectStatus(event));
      updateModelContext("disconnected");
      updateControls();
    }
  });
  socket.addEventListener("error", () => {
    if (ws !== socket) return;
    setStatus("Connection error");
    if (!socketReady) startFallback();
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

function handleTerminalMessage(socket: WebSocket, data: unknown): boolean {
  if (ws !== socket) return false;

  let message: ServerTerminalMessage;
  try {
    message = ServerTerminalMessageSchema.parse(JSON.parse(String(data)));
  } catch {
    setStatus("Bad bridge message");
    return false;
  }

  switch (message.type) {
    case "ready":
      outputBuffer.clear();
      accessibleOutputBuffer.clear();
      elements.transcript.textContent = "";
      appendTerminalOutput(message.scrollback);
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
    enqueueFallbackResize(cols, rows);
  } else if (ws?.readyState === WebSocket.OPEN) {
    sendTerminalMessage({ type: "resize", cols, rows });
  }
}

function scheduleResize(): void {
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

  if (ws?.readyState === WebSocket.OPEN) {
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
  await pollAppToolTransport(generation);
  if (!isCurrentGeneration(generation, details.sessionId)) return;
  pollTimer = window.setInterval(() => {
    void pollAppToolTransport(generation).catch((error) => {
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
  const generation = toolResultGeneration;
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
  try {
    while (
      queue.chunks.length > 0 &&
      fallbackInputQueue === queue &&
      isCurrentGeneration(queue.generation, queue.sessionId) &&
      sessionCapability === queue.capability &&
      appToolTransport
    ) {
      const first = queue.chunks.shift()!;
      queue.bytes -= first.bytes;
      let data = first.data;
      let bytes = first.bytes;
      while (queue.chunks.length > 0) {
        const next = queue.chunks[0]!;
        if (
          bytes + next.bytes >
          (session?.maxInputBytes ?? DEFAULT_INPUT_BYTES)
        )
          break;
        queue.chunks.shift();
        queue.bytes -= next.bytes;
        data += next.data;
        bytes += next.bytes;
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
    }
  } catch (error) {
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
      if (queue.chunks.length === 0) fallbackInputQueue = undefined;
      else void drainFallbackInputQueue(queue);
    }
  }
}

function enqueueFallbackResize(cols: number, rows: number): void {
  const generation = toolResultGeneration;
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

function appendTerminalOutput(data: string): void {
  if (data.length === 0) return;
  terminal?.write(data);
  outputBuffer.append(data);
  accessibleOutputBuffer.append(data);
  elements.transcript.textContent = normalizeTerminalOutput(
    accessibleOutputBuffer.toString(),
  );
}

function resetTerminalOutput(): void {
  outputBuffer.clear();
  accessibleOutputBuffer.clear();
  terminal?.reset();
  elements.transcript.textContent = "";
}

function resetOutputBuffers(maxBytes = DEFAULT_SUBMIT_BYTES): void {
  outputBuffer = new BoundedTextBuffer(maxBytes);
  accessibleOutputBuffer = new BoundedTextBuffer(maxBytes);
  elements.transcript.textContent = "";
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
      await app
        .callServerTool({
          name: "record_quick_shell_output_confirmed",
          arguments: {
            ...sessionCapability,
            byteCount,
          },
        })
        .catch((error) =>
          console.error("quick-shell audit record failed", error),
        );
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
  fallbackInputQueue = undefined;
  fallbackResizeQueue = undefined;
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
  pollingGeneration = undefined;
}

async function cleanup(
  closeSession: boolean,
  expectedCapability = sessionCapability,
): Promise<boolean> {
  const capability = expectedCapability;
  const ownsCurrentSession = () => sessionCapability === expectedCapability;
  const closeViaBridge = closeSession && ws?.readyState === WebSocket.OPEN;
  if (closeViaBridge && ownsCurrentSession()) {
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
      setStatus(
        toolResultText(
          closed,
          "Could not close session; it will expire automatically.",
        ),
      );
      updateControls();
      return false;
    }
  }

  if (!ownsCurrentSession()) return true;
  disposeTerminal();
  publicSession = undefined;
  session = undefined;
  sessionDetails = undefined;
  sessionCapability = undefined;
  connectionFailed = false;
  updateSessionSummary();
  resetOutputBuffers();
  updateModelContext(closeSession ? "closed" : "idle");
  updateControls();
  return true;
}

async function closeUnusedSession(
  capability: QuickShellHiddenMeta["quickShell"],
): Promise<void> {
  try {
    const closed = await app.callServerTool({
      name: "close_quick_shell_session",
      arguments: capability,
    });
    if (closed.isError)
      console.error("quick-shell unused session close failed");
  } catch (error) {
    console.error("quick-shell unused session close failed", error);
  }
}

function setStatus(message: string): void {
  elements.status.textContent = message;
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

function handleConnectFailure(error: unknown): void {
  connectionFailed = true;
  renderError(error);
  updateControls();
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
  return (
    generation === toolResultGeneration && session?.sessionId === sessionId
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
  if (!capabilities?.logging) return;
  void app.sendLog({ level, data: { message } }).catch(() => {});
}

function assertNever(value: never): never {
  throw new Error(`Unhandled terminal message: ${JSON.stringify(value)}`);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

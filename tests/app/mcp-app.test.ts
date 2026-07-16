// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

type ToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

type MockToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  content?: Array<{ type: "text"; text: string }>;
};

const harness = vi.hoisted(() => ({
  app: undefined as MockApp | undefined,
  deferInit: false,
  initError: undefined as Error | undefined,
  initResolvers: [] as Array<() => void>,
  terminals: [] as MockTerminal[],
  sockets: [] as MockWebSocket[],
  webSocketConstructorError: undefined as Error | undefined,
}));

type MockHostCapabilities = {
  downloadFile?: Record<string, never>;
  logging?: Record<string, never>;
  message?: Record<string, never>;
  updateModelContext?: {
    text?: Record<string, never>;
    structuredContent?: Record<string, never>;
  };
};

class MockApp {
  onhostcontextchanged?: (params: Record<string, unknown>) => void;
  ontoolinputpartial?: (params: {
    arguments?: Record<string, unknown>;
  }) => void;
  ontoolinput?: (params: { arguments?: Record<string, unknown> }) => void;
  ontoolcancelled?: (params: { reason?: string }) => void;
  ontoolresult?: (params: {
    structuredContent?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
    isError?: boolean;
  }) => void;
  onteardown?: () => Promise<Record<string, never>>;
  readonly serverToolCalls: ToolCall[] = [];
  readonly sendMessageCalls: unknown[] = [];
  readonly updateModelContextCalls: unknown[] = [];
  readonly downloadFileCalls: unknown[] = [];
  readonly sendLogCalls: unknown[] = [];
  hostCapabilities: MockHostCapabilities = { message: {} };
  hostContext: Record<string, unknown> = {};
  callServerToolImpl: (call: ToolCall) => Promise<MockToolResult> =
    async () => ({
      isError: true,
      content: [{ type: "text", text: "not mocked" }],
    });
  sendMessageImpl: (message: unknown) => Promise<{ isError?: boolean }> =
    async () => ({});

  constructor(_info?: unknown, _capabilities?: unknown, _options?: unknown) {
    harness.app = this;
  }

  async connect(): Promise<void> {}

  getHostCapabilities(): MockHostCapabilities {
    return this.hostCapabilities;
  }

  getHostContext(): Record<string, unknown> {
    return this.hostContext;
  }

  async callServerTool(call: ToolCall): Promise<MockToolResult> {
    this.serverToolCalls.push(call);
    return this.callServerToolImpl(call);
  }

  async requestDisplayMode(params: {
    mode: "inline" | "fullscreen" | "pip";
  }): Promise<{ mode: "inline" | "fullscreen" | "pip" }> {
    this.hostContext = { ...this.hostContext, displayMode: params.mode };
    return { mode: params.mode };
  }

  async downloadFile(params: unknown): Promise<{ isError?: boolean }> {
    this.downloadFileCalls.push(params);
    return {};
  }

  async sendMessage(message: unknown): Promise<{ isError?: boolean }> {
    this.sendMessageCalls.push(message);
    return this.sendMessageImpl(message);
  }

  async updateModelContext(message: unknown): Promise<{ isError?: boolean }> {
    this.updateModelContextCalls.push(message);
    return {};
  }

  async sendLog(message: unknown): Promise<void> {
    this.sendLogCalls.push(message);
  }
}

class MockFitAddon {
  dispose(): void {}

  fit(): void {}

  proposeDimensions(): { cols: number; rows: number } {
    return { cols: 80, rows: 24 };
  }
}

class MockTerminal {
  cols = 100;
  rows = 30;
  writes: string[] = [];
  disposed = false;
  resets = 0;
  private dataListener?: (data: string) => void;

  constructor() {
    harness.terminals.push(this);
  }

  loadAddon(): void {}

  open(): void {}

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListener = listener;
    return {
      dispose: () => {
        this.dataListener = undefined;
      },
    };
  }

  emitData(data: string): void {
    this.dataListener?.(data);
  }

  write(data: string): void {
    this.writes.push(data);
  }

  reset(): void {
    this.resets += 1;
    this.writes = [];
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  dispose(): void {
    this.disposed = true;
  }
}

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  readyState = MockWebSocket.CONNECTING;

  constructor(readonly url: string) {
    if (harness.webSocketConstructorError)
      throw harness.webSocketConstructorError;
    harness.sockets.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", {});
  }

  error(): void {
    this.emit("error", {});
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", {});
  }

  message(data: unknown): void {
    this.emit("message", { data: JSON.stringify(data) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class MockResizeObserver {
  observe(): void {}

  disconnect(): void {}
}

function openedResult(
  sessionId: string,
  device = sessionId,
  suggestedCommand?: string,
) {
  const structuredContent: Record<string, unknown> = { sessionId, device };
  if (suggestedCommand) structuredContent.suggestedCommand = suggestedCommand;
  return {
    structuredContent,
    _meta: { quickShell: { sessionId, appToken: `app-${sessionId}` } },
  };
}

function openedResultWithSession(
  sessionId: string,
  device = sessionId,
  suggestedCommand?: string,
) {
  const details = detailsResult(sessionId, device)._meta?.quickShellSession;
  if (!details) throw new Error("missing quick-shell session fixture");
  return {
    ...openedResult(sessionId, device, suggestedCommand),
    _meta: {
      quickShell: { sessionId, appToken: `app-${sessionId}` },
      quickShellSession: details,
    },
  };
}

function detailsResult(sessionId: string, device = sessionId): MockToolResult {
  return {
    structuredContent: {
      sessionId,
      device,
    },
    _meta: {
      quickShellSession: {
        sessionId,
        device,
        wsUrl: `ws://127.0.0.1/terminal?session=${sessionId}`,
        wsToken: `ws-${sessionId}`,
        maxInputBytes: 16_384,
        maxSubmitBytes: 64,
        pingIntervalMs: 1000,
      },
    },
  };
}

async function loadApp(): Promise<MockApp> {
  vi.resetModules();
  harness.app = undefined;
  harness.deferInit = false;
  harness.initError = undefined;
  harness.initResolvers = [];
  harness.terminals = [];
  harness.sockets = [];
  harness.webSocketConstructorError = undefined;
  document.body.innerHTML = '<main id="app"></main>';
  document.head.querySelector("#__test-host-fonts")?.remove();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-display-mode");
  document.documentElement.removeAttribute("data-platform");
  document.documentElement.removeAttribute("style");
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  globalThis.ResizeObserver =
    MockResizeObserver as unknown as typeof ResizeObserver;
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
  };
  vi.doMock("@modelcontextprotocol/ext-apps", () => ({
    App: MockApp,
    applyDocumentTheme: (theme: string) => {
      document.documentElement.setAttribute("data-theme", theme);
      document.documentElement.style.colorScheme = theme;
    },
    applyHostFonts: (fonts: string) => {
      const style = document.createElement("style");
      style.id = "__test-host-fonts";
      style.textContent = fonts;
      document.head.append(style);
    },
    applyHostStyleVariables: (variables: Record<string, string>) => {
      for (const [key, value] of Object.entries(variables)) {
        document.documentElement.style.setProperty(key, value);
      }
    },
  }));
  vi.doMock("ghostty-web", () => ({
    FitAddon: MockFitAddon,
    Terminal: MockTerminal,
  }));
  vi.doMock("../../src/app/ghostty-loader.js", () => ({
    loadGhosttyRuntime: () => {
      if (harness.initError) return Promise.reject(harness.initError);
      if (!harness.deferInit) return Promise.resolve();
      return new Promise<void>((resolve) =>
        harness.initResolvers.push(resolve),
      );
    },
  }));
  await import("../../src/app/mcp-app.js");
  await flush();
  if (!harness.app) throw new Error("mock app was not constructed");
  return harness.app;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!(found instanceof HTMLButtonElement))
    throw new Error(`button not found: ${label}`);
  return found;
}

function statusText(): string {
  return document.querySelector(".shell__status")?.textContent ?? "";
}

function openSocketWithReady(
  socket: MockWebSocket | undefined,
  sessionId = "s1",
): void {
  if (!socket) throw new Error("missing socket");
  socket.open();
  expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({
    type: "authenticate",
    token: `ws-${sessionId}`,
  });
  socket.message({ type: "ready", sessionId, scrollback: "" });
}

describe("quick-shell MCP app", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("provides host-neutral labels and live regions for assistive technology", async () => {
    await loadApp();

    expect(
      document.querySelector(".shell")?.getAttribute("aria-labelledby"),
    ).toBe("quick-shell-title");
    expect(document.querySelector(".shell__status")?.getAttribute("role")).toBe(
      "status",
    );
    expect(
      document.querySelector(".shell__status")?.getAttribute("aria-live"),
    ).toBe("polite");
    expect(
      document
        .querySelector(".command-strip input")
        ?.getAttribute("aria-label"),
    ).toBe("Suggested command");
    expect(document.querySelector(".terminal")?.getAttribute("role")).toBe(
      "region",
    );
    expect(
      document.querySelector(".terminal")?.getAttribute("aria-label"),
    ).toBe("Terminal output");
    expect(
      document.querySelector(".send-dialog")?.getAttribute("aria-labelledby"),
    ).toBe("quick-shell-send-title");
    expect(
      document
        .querySelector(".send-dialog textarea")
        ?.getAttribute("aria-label"),
    ).toBe("Output to send");
  });

  it("auto-connects and requests session details without a click", async () => {
    const app = await loadApp();
    app.callServerToolImpl = async (call) => {
      if (call.name === "get_quick_shell_session")
        return detailsResult("s1", "fileserver");
      return { structuredContent: { closed: true } };
    };

    app.ontoolresult?.(openedResult("s1", "fileserver", "uptime"));

    await waitForCondition(() => harness.sockets.length === 1);

    expect(button("Reconnect").hidden).toBe(true);
    expect(app.serverToolCalls.map((call) => call.name)).toEqual([
      "get_quick_shell_session",
    ]);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.sockets[0]?.url).toContain("session=s1");
  });

  it("auto-connects when the initial tool result includes hidden bridge details", async () => {
    const app = await loadApp();

    app.ontoolresult?.(openedResultWithSession("s1", "fileserver", "uptime"));

    await waitForCondition(() => harness.sockets.length === 1);
    expect(app.serverToolCalls).toEqual([]);
    expect(harness.sockets[0]?.url).toContain("session=s1");
    expect(statusText()).toBe("Connecting fileserver");
  });

  it("falls back to app-only terminal tools when the WebSocket is unreachable", async () => {
    const app = await loadApp();
    app.callServerToolImpl = async (call) => {
      if (call.name === "get_quick_shell_session")
        return detailsResult("s1", "fileserver");
      if (call.name === "poll_quick_shell_session") {
        return {
          structuredContent: {
            sessionId: "s1",
            device: "fileserver",
            exited: false,
            exitCode: null,
          },
          _meta: {
            quickShellPoll: {
              sessionId: "s1",
              chunks: [{ seq: 1, data: "hello from fallback" }],
              nextSeq: 1,
              reset: false,
              exited: false,
              exitCode: null,
            },
          },
        };
      }
      if (call.name === "write_quick_shell_input")
        return { structuredContent: { written: true } };
      return { structuredContent: { closed: true } };
    };

    app.ontoolresult?.(openedResultWithSession("s1", "fileserver"));
    await waitForCondition(
      () => harness.sockets.length === 1 && harness.terminals.length === 1,
    );
    harness.terminals[0]?.emitData("queued-before-fallback");
    harness.sockets[0]?.error();

    await waitForCondition(() =>
      harness.terminals[0]?.writes.includes("hello from fallback"),
    );
    expect(app.serverToolCalls.map((call) => call.name)).toContain(
      "get_quick_shell_session",
    );
    expect(app.serverToolCalls.map((call) => call.name)).toContain(
      "poll_quick_shell_session",
    );
    expect(statusText()).toBe("Connected");

    harness.terminals[0]?.emitData("whoami");
    await waitForCondition(
      () =>
        app.serverToolCalls.filter(
          (call) => call.name === "write_quick_shell_input",
        ).length === 2,
    );
    expect(
      app.serverToolCalls.filter(
        (call) => call.name === "write_quick_shell_input",
      ),
    ).toEqual([
      {
        name: "write_quick_shell_input",
        arguments: {
          sessionId: "s1",
          appToken: "app-s1",
          data: "queued-before-fallback",
        },
      },
      {
        name: "write_quick_shell_input",
        arguments: { sessionId: "s1", appToken: "app-s1", data: "whoami" },
      },
    ]);
  });

  it("falls back to app-only terminal tools when WebSocket construction fails", async () => {
    const app = await loadApp();
    harness.webSocketConstructorError = new Error("blocked by host policy");
    app.callServerToolImpl = async (call) => {
      if (call.name === "get_quick_shell_session")
        return detailsResult("s1", "fileserver");
      if (call.name === "poll_quick_shell_session") {
        return {
          structuredContent: {
            sessionId: "s1",
            device: "fileserver",
            exited: false,
            exitCode: null,
          },
          _meta: {
            quickShellPoll: {
              sessionId: "s1",
              chunks: [],
              nextSeq: 0,
              reset: false,
              exited: false,
              exitCode: null,
            },
          },
        };
      }
      return { structuredContent: { closed: true } };
    };

    app.ontoolresult?.(openedResultWithSession("s1", "fileserver"));

    await waitForCondition(() =>
      app.serverToolCalls.some(
        (call) => call.name === "poll_quick_shell_session",
      ),
    );
    expect(harness.sockets).toHaveLength(0);
    expect(statusText()).toBe("Connected");
  });

  it("applies fallback poll reset snapshots without duplicating snapshot chunks", async () => {
    const app = await loadApp();
    harness.webSocketConstructorError = new Error("blocked by host policy");
    let pollCount = 0;
    app.callServerToolImpl = async (call) => {
      if (call.name === "get_quick_shell_session")
        return detailsResult("s1", "fileserver");
      if (call.name === "poll_quick_shell_session") {
        pollCount += 1;
        if (pollCount === 1) {
          return {
            structuredContent: {
              sessionId: "s1",
              device: "fileserver",
              exited: false,
              exitCode: null,
            },
            _meta: {
              quickShellPoll: {
                sessionId: "s1",
                chunks: [{ seq: 1, data: "first" }],
                nextSeq: 1,
                reset: false,
                exited: false,
                exitCode: null,
              },
            },
          };
        }
        return {
          structuredContent: {
            sessionId: "s1",
            device: "fileserver",
            exited: false,
            exitCode: null,
          },
          _meta: {
            quickShellPoll: {
              sessionId: "s1",
              chunks: [
                { seq: 2, data: "snapshot", snapshot: true },
                { seq: 3, data: "delta" },
              ],
              nextSeq: 3,
              reset: true,
              resetReason: "stale_cursor",
              snapshot: "snapshot",
              snapshotBytes: 8,
              snapshotSeq: 2,
              truncatedBytes: 5,
              exited: false,
              exitCode: null,
            },
          },
        };
      }
      return { structuredContent: { closed: true } };
    };

    app.ontoolresult?.(openedResultWithSession("s1", "fileserver"));

    await waitForCondition(() =>
      harness.terminals[0]?.writes.includes("first"),
    );
    await waitForCondition(() =>
      harness.terminals[0]?.writes.includes("delta"),
    );
    expect(harness.terminals[0]?.resets).toBeGreaterThan(0);
    expect(harness.terminals[0]?.writes).toEqual(["snapshot", "delta"]);
    expect(statusText()).toBe("Connected, earlier output was truncated");
  });

  it("does not let stale fallback writes block a newer session", async () => {
    const app = await loadApp();
    harness.webSocketConstructorError = new Error("blocked by host policy");
    let releaseOldWrite: (() => void) | undefined;
    app.callServerToolImpl = async (call) => {
      const sessionId = String(call.arguments.sessionId);
      if (call.name === "get_quick_shell_session")
        return detailsResult(sessionId);
      if (call.name === "poll_quick_shell_session") {
        return {
          structuredContent: {
            sessionId,
            device: sessionId,
            exited: false,
            exitCode: null,
          },
          _meta: {
            quickShellPoll: {
              sessionId,
              chunks: [],
              nextSeq: 0,
              reset: false,
              exited: false,
              exitCode: null,
            },
          },
        };
      }
      if (call.name === "write_quick_shell_input") {
        if (
          call.arguments.sessionId === "s1" &&
          call.arguments.data === "old-one"
        ) {
          return new Promise<MockToolResult>((resolve) => {
            releaseOldWrite = () =>
              resolve({ structuredContent: { written: true } });
          });
        }
        return { structuredContent: { written: true } };
      }
      return { structuredContent: { closed: true } };
    };

    app.ontoolresult?.(openedResultWithSession("s1"));
    await waitForCondition(() =>
      app.serverToolCalls.some(
        (call) => call.name === "poll_quick_shell_session",
      ),
    );
    harness.terminals[0]?.emitData("old-one");
    harness.terminals[0]?.emitData("old-two");
    await waitForCondition(() =>
      app.serverToolCalls.some(
        (call) =>
          call.name === "write_quick_shell_input" &&
          call.arguments.data === "old-one",
      ),
    );

    app.ontoolresult?.(openedResultWithSession("s2"));
    await waitForCondition(() =>
      app.serverToolCalls.some(
        (call) => call.name === "close_quick_shell_session",
      ),
    );
    await waitForCondition(() =>
      app.serverToolCalls.some(
        (call) =>
          call.name === "poll_quick_shell_session" &&
          call.arguments.sessionId === "s2",
      ),
    );
    harness.terminals[1]?.emitData("fresh");

    await waitForCondition(() =>
      app.serverToolCalls.some(
        (call) =>
          call.name === "write_quick_shell_input" &&
          call.arguments.data === "fresh",
      ),
    );
    expect(app.serverToolCalls).not.toContainEqual({
      name: "write_quick_shell_input",
      arguments: { sessionId: "s1", appToken: "app-s1", data: "old-two" },
    });
    releaseOldWrite?.();
    await flush();
    expect(app.serverToolCalls).not.toContainEqual({
      name: "write_quick_shell_input",
      arguments: { sessionId: "s1", appToken: "app-s1", data: "old-two" },
    });
  });

  it("rejects terminal input larger than the advertised byte limit", async () => {
    const app = await loadApp();
    app.callServerToolImpl = async (call) => {
      if (call.name === "get_quick_shell_session") {
        const result = detailsResult("s1", "fileserver");
        const quickShellSession = result._meta?.quickShellSession as Record<
          string,
          unknown
        >;
        quickShellSession.maxInputBytes = 4;
        return result;
      }
      return { structuredContent: { closed: true } };
    };

    app.ontoolresult?.(openedResult("s1", "fileserver"));
    await waitForCondition(
      () => harness.sockets.length === 1 && harness.terminals.length === 1,
    );
    openSocketWithReady(harness.sockets[0]);

    harness.terminals[0]?.emitData("🙂x");

    expect(statusText()).toBe("Input is larger than 4 bytes.");
    expect(
      harness.sockets[0]?.sent.map((message) => JSON.parse(message)),
    ).not.toContainEqual({
      type: "input",
      data: "🙂x",
    });
  });

  it("adopts host context and requests fullscreen only when the host offers it", async () => {
    const app = await loadApp();
    app.hostContext = {
      availableDisplayModes: ["inline", "fullscreen"],
      displayMode: "inline",
      platform: "mobile",
      safeAreaInsets: { top: 2, right: 3, bottom: 4, left: 5 },
      styles: {
        variables: { "--color-text-primary": "#123456" },
        css: { fonts: "body { font-family: TestSans; }" },
      },
      theme: "light",
    };

    app.onhostcontextchanged?.(app.hostContext);

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.platform).toBe("mobile");
    expect(
      document.documentElement.style.getPropertyValue("--color-text-primary"),
    ).toBe("#123456");
    expect(
      document.documentElement.style.getPropertyValue("--qs-safe-area-left"),
    ).toBe("5px");
    expect(
      document.head.querySelector("#__test-host-fonts")?.textContent,
    ).toContain("TestSans");
    expect(button("Fullscreen").hidden).toBe(false);

    button("Fullscreen").click();
    await flush();

    expect(app.hostContext.displayMode).toBe("fullscreen");
    expect(document.documentElement.dataset.displayMode).toBe("fullscreen");
    expect(button("Inline").hidden).toBe(false);
  });

  it("keeps a stale slow init from taking over a newer session", async () => {
    const app = await loadApp();
    harness.deferInit = true;
    app.callServerToolImpl = async (call) => {
      if (call.name === "get_quick_shell_session")
        return detailsResult(String(call.arguments.sessionId));
      return { structuredContent: { closed: true } };
    };

    app.ontoolresult?.(openedResult("s1"));
    await waitForCondition(() => harness.initResolvers.length === 1);

    app.ontoolresult?.(openedResult("s2"));
    await waitForCondition(() => harness.initResolvers.length === 2);

    harness.initResolvers[0]?.();
    await flush();
    expect(harness.sockets).toEqual([]);

    harness.initResolvers[1]?.();
    await waitForCondition(() => harness.sockets.length === 1);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.sockets[0]?.url).toContain("session=s2");
  });

  it("closes a stale rapid tool-result session before the newer one takes over", async () => {
    const app = await loadApp();
    app.callServerToolImpl = async (call) => {
      if (call.name === "get_quick_shell_session")
        return detailsResult(String(call.arguments.sessionId));
      return { structuredContent: { closed: true } };
    };

    app.ontoolresult?.(openedResult("s1"));
    app.ontoolresult?.(openedResult("s2"));

    await waitForCondition(() =>
      app.serverToolCalls.some(
        (call) => call.name === "close_quick_shell_session",
      ),
    );
    expect(app.serverToolCalls).toContainEqual({
      name: "close_quick_shell_session",
      arguments: { sessionId: "s1", appToken: "app-s1" },
    });
    await waitForCondition(() => harness.sockets.length === 1);
    expect(harness.sockets[0]?.url).toContain("session=s2");
  });

  it("queues terminal input until the WebSocket opens", async () => {
    const app = await loadApp();
    app.callServerToolImpl = async (call) => {
      if (call.name === "get_quick_shell_session")
        return detailsResult("s1", "fileserver");
      return { structuredContent: { closed: true } };
    };

    app.ontoolresult?.(openedResult("s1", "fileserver"));
    await waitForCondition(
      () => harness.sockets.length === 1 && harness.terminals.length === 1,
    );

    harness.terminals[0]?.emitData("whoami");
    expect(harness.sockets[0]?.sent).toEqual([]);

    harness.sockets[0]?.open();
    expect(
      harness.sockets[0]?.sent.map((message) => JSON.parse(message)),
    ).toEqual([{ type: "authenticate", token: "ws-s1" }]);

    harness.sockets[0]?.message({
      type: "ready",
      sessionId: "s1",
      scrollback: "",
    });
    expect(
      harness.sockets[0]?.sent.map((message) => JSON.parse(message)),
    ).toContainEqual({
      type: "input",
      data: "whoami",
    });
  });

  it("uses the bridge close message when closing an active terminal", async () => {
    const app = await loadApp();
    app.callServerToolImpl = async (call) => {
      if (call.name === "get_quick_shell_session")
        return detailsResult("s1", "fileserver");
      return { structuredContent: { closed: true } };
    };
    app.ontoolresult?.(openedResult("s1", "fileserver"));
    await waitForCondition(() => harness.sockets.length === 1);
    openSocketWithReady(harness.sockets[0]);
    const socket = harness.sockets[0];
    if (!socket) throw new Error("missing socket");
    socket.sent.length = 0;

    button("Close").click();
    await flush();

    expect(app.serverToolCalls.map((call) => call.name)).toEqual([
      "get_quick_shell_session",
    ]);
    expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({
      type: "close",
    });
  });

  it("keeps the previous capability and closes the unused new session when switching cannot close the old one", async () => {
    const app = await loadApp();
    app.callServerToolImpl = async (call) => {
      if (
        call.name === "close_quick_shell_session" &&
        call.arguments.sessionId === "s1"
      ) {
        return {
          isError: true,
          content: [{ type: "text", text: "close failed" }],
        };
      }
      return { structuredContent: { closed: true } };
    };

    app.ontoolresult?.(openedResultWithSession("s1", "fileserver", "uptime"));
    await waitForCondition(() => harness.sockets.length === 1);
    app.ontoolresult?.(openedResult("s2", "admin-box", "hostname"));
    await waitForCondition(() => app.serverToolCalls.length === 2);

    expect(statusText()).toBe("close failed");
    expect(button("Reconnect").hidden).toBe(true);
    expect(
      (
        document.querySelector(
          ".command-strip input",
        ) as HTMLInputElement | null
      )?.value,
    ).toBe("uptime");
    expect(app.serverToolCalls).toEqual([
      {
        name: "close_quick_shell_session",
        arguments: { sessionId: "s1", appToken: "app-s1" },
      },
      {
        name: "close_quick_shell_session",
        arguments: { sessionId: "s2", appToken: "app-s2" },
      },
    ]);
  });

  it("returns to a reconnectable state when the WebSocket closes", async () => {
    const app = await loadApp();
    app.callServerToolImpl = async (call) => {
      if (call.name === "get_quick_shell_session")
        return detailsResult("s1", "fileserver");
      return { structuredContent: { closed: true } };
    };

    app.ontoolresult?.(openedResult("s1", "fileserver"));
    await waitForCondition(() => harness.sockets.length === 1);
    openSocketWithReady(harness.sockets[0]);
    expect(button("Send output").disabled).toBe(false);

    harness.sockets[0]?.close();

    expect(statusText()).toBe("Disconnected");
    expect(button("Reconnect").disabled).toBe(false);
    expect(button("Insert").disabled).toBe(true);
    expect(button("Send output").disabled).toBe(true);
  });

  it("uses host download and model-context capabilities without exposing terminal secrets", async () => {
    const app = await loadApp();
    app.hostCapabilities = {
      downloadFile: {},
      message: {},
      updateModelContext: { text: {}, structuredContent: {} },
    };
    app.callServerToolImpl = async (call) => {
      if (call.name === "get_quick_shell_session")
        return detailsResult("s1", "fileserver");
      return { structuredContent: { closed: true } };
    };

    app.ontoolresult?.(openedResult("s1", "fileserver"));
    await waitForCondition(() => harness.sockets.length === 1);
    openSocketWithReady(harness.sockets[0]);
    harness.sockets[0]?.message({
      type: "output",
      data: "visible\u001b]52;c;secret\u0007",
    });

    expect(button("Download output").hidden).toBe(false);
    button("Download output").click();
    await flush();

    expect(app.downloadFileCalls).toHaveLength(1);
    expect(app.downloadFileCalls[0]).toMatchObject({
      contents: [
        {
          type: "resource",
          resource: {
            uri: "file:///quick-shell-output.txt",
            mimeType: "text/plain",
            text: "visible",
          },
        },
      ],
    });
    expect(JSON.stringify(app.updateModelContextCalls)).toContain(
      "quick-shell state",
    );
    expect(JSON.stringify(app.updateModelContextCalls)).not.toMatch(
      /token=|app-s1|ws-s1/,
    );
  });

  it("rolls back active session state when terminal initialization fails", async () => {
    const app = await loadApp();
    harness.initError = new Error("ghostty init failed");
    app.callServerToolImpl = async (call) => {
      if (call.name === "get_quick_shell_session")
        return detailsResult("s1", "fileserver");
      return { structuredContent: { closed: true } };
    };

    app.ontoolresult?.(openedResult("s1", "fileserver"));
    await waitForCondition(() => statusText() === "ghostty init failed");

    expect(button("Reconnect").disabled).toBe(false);
    expect(button("Insert").disabled).toBe(true);
    expect(button("Send output").disabled).toBe(true);
    expect(button("Close").disabled).toBe(false);
  });

  it("does not call the app close tool for an active terminal", async () => {
    const app = await loadApp();
    app.callServerToolImpl = async (call) => {
      if (call.name === "get_quick_shell_session")
        return detailsResult("s1", "fileserver");
      if (call.name === "close_quick_shell_session")
        throw new Error("gateway unavailable");
      return { structuredContent: { closed: true } };
    };

    app.ontoolresult?.(openedResult("s1", "fileserver"));
    await waitForCondition(() => harness.sockets.length === 1);
    openSocketWithReady(harness.sockets[0]);

    button("Close").click();
    await flush();

    expect(app.serverToolCalls.map((call) => call.name)).toEqual([
      "get_quick_shell_session",
    ]);
    expect(
      harness.sockets[0]?.sent.map((message) => JSON.parse(message)),
    ).toContainEqual({ type: "close" });
  });

  it("gates confirm send while a host send is pending", async () => {
    const app = await loadApp();
    let resolveSend: (() => void) | undefined;
    app.sendMessageImpl = async () =>
      new Promise((resolve) => {
        resolveSend = () => resolve({});
      });
    app.callServerToolImpl = async (call) => {
      if (call.name === "get_quick_shell_session")
        return detailsResult("s1", "fileserver");
      return { structuredContent: { closed: true } };
    };

    app.ontoolresult?.(openedResult("s1", "fileserver"));
    await waitForCondition(() => harness.sockets.length === 1);
    openSocketWithReady(harness.sockets[0]);
    harness.sockets[0]?.message({ type: "output", data: "hello" });
    button("Send output").click();

    button("Confirm").click();
    button("Confirm").click();

    expect(app.sendMessageCalls).toHaveLength(1);
    expect(button("Confirm").disabled).toBe(true);
    resolveSend?.();
    await waitForCondition(() => !button("Confirm").disabled);
    expect(button("Confirm").disabled).toBe(false);
  });

  it("sanitizes terminal controls before review and send", async () => {
    const app = await loadApp();
    app.callServerToolImpl = async (call) => {
      if (call.name === "get_quick_shell_session")
        return detailsResult("s1", "fileserver");
      return { structuredContent: { closed: true } };
    };

    app.ontoolresult?.(openedResult("s1", "fileserver"));
    await waitForCondition(() => harness.sockets.length === 1);
    openSocketWithReady(harness.sockets[0]);
    harness.sockets[0]?.message({
      type: "output",
      data: "visible\u001b]52;c;secret\u0007\u001b[2K",
    });
    button("Send output").click();

    const textarea = document.querySelector(
      ".send-dialog textarea:not(.send-dialog__fallback)",
    ) as HTMLTextAreaElement | null;
    if (!textarea) throw new Error("send textarea not found");
    expect(textarea.value).toBe("visible");

    textarea.value = "clean\u001b]52;c;hidden\u0007";
    textarea.dispatchEvent(new Event("input"));
    expect(textarea.value).toBe("clean");
    button("Confirm").click();
    await flush();

    expect(app.sendMessageCalls[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "clean" }],
    });
  });
});

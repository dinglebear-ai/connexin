import {
  getUiCapability,
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RuntimeConfig } from "./config.js";
import { registerHealthTool } from "./health-tool.js";
import type {
  QuickShellSession,
  QuickShellSessionManager,
  StartedQuickShellSession,
} from "./session-manager.js";
import {
  APP_RESOURCE_URI,
  LEGACY_APP_RESOURCE_URI,
  V2_APP_RESOURCE_URI,
  V3_APP_RESOURCE_URI,
  V4_APP_RESOURCE_URI,
  SERVER_INSTRUCTIONS,
  appCapabilityInputSchema,
  appResourceMeta,
  appSessionFor,
  asStructuredContent,
  modelToolMeta,
  publicStructuredContent,
  quickShellPublicOutputSchema,
  readBuiltAppHtml,
  resetAppHtmlCacheForTests,
  safeErrorMessage,
  toolAnnotations,
  toolMeta,
  utf8Max,
} from "./mcp-tooling.js";
import type { QuickShellHiddenMeta } from "../shared/protocol.js";
import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
} from "../shared/terminal-defaults.js";

export interface CreateServerOptions {
  bridgeBaseUrl: string;
  config: RuntimeConfig;
  manager: QuickShellSessionManager;
}

export { resetAppHtmlCacheForTests };

interface AppCapabilityArgs {
  sessionId?: string;
  appToken?: string;
}

function toolError(text: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
  };
}

/**
 * Whether the connected client advertises MCP Apps support for our resource
 * type.
 *
 * "unknown" is a real third state, not a stand-in for "no". In stateless
 * `--http` mode a fresh server is constructed per request, so any request other
 * than `initialize` reaches a server that never saw the handshake and has no
 * capabilities to inspect. Refusing there would break HTTP mode outright, and
 * silently treating it as support would hide that the check did not run --
 * hence the explicit state, which the caller audits.
 */
type AppHostSupport = "supported" | "unsupported" | "unknown";

function hostRendersApps(server: McpServer): AppHostSupport {
  const capabilities = server.server.getClientCapabilities();
  if (!capabilities) return "unknown";
  const capability = getUiCapability(capabilities);
  return capability?.mimeTypes?.includes(RESOURCE_MIME_TYPE)
    ? "supported"
    : "unsupported";
}

function requireAppCapability(
  manager: QuickShellSessionManager,
  args: AppCapabilityArgs,
  options: {
    missingReason: string;
    missingMessage: string;
    invalidReason: string;
    auditFields?: Record<string, unknown>;
  },
): { session: QuickShellSession } | { error: ReturnType<typeof toolError> } {
  if (!args.sessionId || !args.appToken) {
    manager.recordAuditEvent("app_session_rejected", {
      sessionId: args.sessionId,
      reason: options.missingReason,
      hasAppToken:
        typeof args.appToken === "string" && args.appToken.length > 0,
      ...options.auditFields,
    });
    return { error: toolError(options.missingMessage) };
  }

  const session = manager.authenticateApp(args.sessionId, args.appToken);
  if (!session) {
    manager.recordAuditEvent("app_session_rejected", {
      sessionId: args.sessionId,
      reason: options.invalidReason,
      ...options.auditFields,
    });
    return { error: toolError("Invalid quick-shell app capability.") };
  }
  return { session };
}

function startAppSession(
  manager: QuickShellSessionManager,
  session: QuickShellSession,
  failureReason: string,
):
  | { session: StartedQuickShellSession }
  | { error: ReturnType<typeof toolError> } {
  try {
    const started = manager.startSession(session.id);
    if (started) return { session: started };
    manager.recordAuditEvent("app_session_rejected", {
      sessionId: session.id,
      device: session.publicSummary.device,
      reason: "missing_session",
    });
    return { error: toolError("Quick-shell session is no longer available.") };
  } catch (error) {
    manager.closeSession(session.id);
    const cause = safeErrorMessage(error);
    manager.recordAuditEvent("app_session_rejected", {
      sessionId: session.id,
      device: session.publicSummary.device,
      reason: failureReason,
      error: cause,
    });
    return {
      error: toolError(
        `Unable to start quick-shell SSH session for ${session.publicSummary.device}${cause ? `: ${cause}` : "."}`,
      ),
    };
  }
}

export function createServer(options: CreateServerOptions): McpServer {
  const server = new McpServer(
    { name: "quick-shell", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const { bridgeBaseUrl, config, manager } = options;

  registerHealthTool(server, config, manager);

  registerAppTool(
    server,
    "list_quick_shell_devices",
    {
      title: "List Quick Shell Devices",
      description:
        "List SSH-configured quick-shell device aliases and non-secret metadata.",
      inputSchema: {},
      outputSchema: {
        devices: z.array(
          z.object({
            alias: z.string(),
            label: z.string().optional(),
            group: z.string().optional(),
            danger: z.enum(["normal", "caution", "danger"]).optional(),
            defaultShell: z.string().optional(),
          }),
        ),
      },
      annotations: toolAnnotations("List Quick Shell Devices", {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      _meta: modelToolMeta({
        invoking: "Listing devices",
        invoked: "Devices listed",
      }),
    },
    async () => {
      const devices = manager.listDevices();
      return {
        content: [
          {
            type: "text",
            text:
              devices.length === 0
                ? "No quick-shell devices are currently listed in SSH config."
                : `Found ${devices.length} quick-shell device${devices.length === 1 ? "" : "s"}.`,
          },
        ],
        structuredContent: { devices },
      };
    },
  );

  registerAppTool(
    server,
    "open_quick_shell",
    {
      title: "Open Quick Shell",
      description:
        "Request a human-controlled SSH terminal for an allowlisted SSH config host alias.",
      inputSchema: {
        device: z.string().max(config.maxDeviceLength),
        reason: z.string().max(config.maxReasonLength).optional(),
        suggested_command: z
          .string()
          .max(config.maxSuggestedCommandLength)
          .optional(),
      },
      outputSchema: quickShellPublicOutputSchema,
      annotations: toolAnnotations("Open Quick Shell", {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      }),
      _meta: toolMeta(["model"], {
        invoking: "Opening shell",
        invoked: "Shell ready",
      }),
    },
    async (args) => {
      // The whole consent model assumes the app renders and the host keeps
      // _meta away from the model. `ui.visibility` is advisory metadata, and a
      // host that does not implement MCP Apps does not implement visibility
      // filtering either -- so on such a host the tokens below would land in
      // the transcript and the model could drive the terminal and read
      // scrollback without the user ever pressing Send output. Verify support
      // before minting a session rather than trusting the host to hide it.
      const appHostSupport = hostRendersApps(server);
      if (config.requireAppHost && appHostSupport !== "supported") {
        manager.recordAuditEvent("session_open_refused", {
          device: args.device,
          error: "host_lacks_mcp_apps",
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `This host does not advertise MCP Apps support, so the quick-shell terminal cannot be rendered and no session was opened. Run "quick-shell ${args.device}" locally instead. (If this host does render MCP Apps but does not advertise the capability, set QUICK_SHELL_REQUIRE_APP_HOST=0.)`,
            },
          ],
        };
      }
      let session;
      try {
        session = await manager.createSession({
          device: args.device,
          reason: args.reason,
          suggested: args.suggested_command,
        });
      } catch (error) {
        manager.recordAuditEvent("session_open_failed", {
          device: args.device,
          error: safeErrorMessage(error),
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Unable to open quick-shell session.",
            },
          ],
        };
      }
      const quickShell = {
        sessionId: session.id,
        appToken: session.appToken,
      } satisfies QuickShellHiddenMeta["quickShell"];
      const quickShellSession = appSessionFor(session, config, bridgeBaseUrl);

      return {
        content: [
          {
            type: "text",
            text: `Prepared quick-shell session for ${session.publicSummary.device}. The SSH terminal starts only when a compatible MCP App host renders the quick-shell UI; the user controls the terminal and must explicitly send output back. If no app appears, run quick-shell ${session.publicSummary.device} locally or retry from a host with MCP Apps support.`,
          },
        ],
        structuredContent: asStructuredContent(
          publicStructuredContent(session.publicSummary),
        ),
        _meta: {
          quickShell,
          quickShellSession,
        },
      };
    },
  );

  registerAppTool(
    server,
    "get_quick_shell_session",
    {
      title: "Get Quick Shell Session",
      description: "App-only quick-shell session detail lookup.",
      inputSchema: {
        ...appCapabilityInputSchema(),
      },
      outputSchema: quickShellPublicOutputSchema,
      annotations: toolAnnotations("Get Quick Shell Session", {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      }),
      _meta: toolMeta(["app"], {
        invoking: "Connecting shell",
        invoked: "Shell connected",
      }),
    },
    async (args) => {
      manager.recordAuditEvent("app_session_requested", {
        sessionId: args.sessionId,
        hasSessionId:
          typeof args.sessionId === "string" && args.sessionId.length > 0,
        hasAppToken:
          typeof args.appToken === "string" && args.appToken.length > 0,
      });
      const capability = requireAppCapability(manager, args, {
        missingReason: "missing_app_capability",
        missingMessage: "Missing quick-shell app capability.",
        invalidReason: "invalid_app_capability",
      });
      if ("error" in capability) return capability.error;
      const startup = startAppSession(
        manager,
        capability.session,
        "ssh_start_failed",
      );
      if ("error" in startup) return startup.error;
      const started = startup.session;

      const appSession = appSessionFor(started, config, bridgeBaseUrl);
      manager.recordAuditEvent("app_session_attached", {
        sessionId: started.id,
        device: started.publicSummary.device,
      });
      return {
        content: [
          {
            type: "text",
            text: "Quick-shell session details are available to the app.",
          },
        ],
        structuredContent: asStructuredContent(
          publicStructuredContent(started.publicSummary),
        ),
        _meta: {
          quickShellSession: appSession,
        },
      };
    },
  );

  registerAppTool(
    server,
    "record_quick_shell_output_confirmed",
    {
      title: "Record Quick Shell Output Confirmed",
      description:
        "App-only audit breadcrumb for user-confirmed output return.",
      inputSchema: {
        ...appCapabilityInputSchema(),
        byteCount: z
          .number()
          .int()
          .min(0)
          .max(config.maxSubmitBytes)
          .optional(),
      },
      outputSchema: {
        recorded: z.boolean(),
      },
      annotations: toolAnnotations("Record Quick Shell Output Confirmed", {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      }),
      _meta: toolMeta(["app"], {
        invoking: "Recording output send",
        invoked: "Output send recorded",
      }),
    },
    async (args) => {
      if (args.byteCount === undefined) {
        manager.recordAuditEvent("app_session_rejected", {
          sessionId: args.sessionId,
          reason: "missing_output_confirm_capability",
          hasAppToken:
            typeof args.appToken === "string" && args.appToken.length > 0,
          hasByteCount: args.byteCount !== undefined,
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Missing quick-shell output confirmation capability.",
            },
          ],
        };
      }
      const capability = requireAppCapability(manager, args, {
        missingReason: "missing_output_confirm_capability",
        missingMessage: "Missing quick-shell output confirmation capability.",
        invalidReason: "invalid_output_confirm_capability",
        auditFields: { hasByteCount: true },
      });
      if ("error" in capability) return capability.error;
      const session = capability.session;

      manager.recordOutputConfirmed(session.id, args.byteCount);
      return {
        content: [
          { type: "text", text: "Quick-shell output confirmation recorded." },
        ],
        structuredContent: { recorded: true },
      };
    },
  );

  registerAppTool(
    server,
    "poll_quick_shell_session",
    {
      title: "Poll Quick Shell Session",
      description:
        "App-only quick-shell terminal output poll for hosts that cannot reach the WebSocket bridge.",
      inputSchema: {
        ...appCapabilityInputSchema(),
        afterSeq: z.number().int().min(0).optional(),
      },
      outputSchema: {
        sessionId: z.string(),
        device: z.string(),
        exited: z.boolean(),
        exitCode: z.number().nullable(),
      },
      annotations: toolAnnotations("Poll Quick Shell Session", {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      }),
      _meta: toolMeta(["app"], {
        invoking: "Polling shell",
        invoked: "Shell output checked",
      }),
    },
    async (args) => {
      const capability = requireAppCapability(manager, args, {
        missingReason: "missing_poll_capability",
        missingMessage: "Missing quick-shell poll capability.",
        invalidReason: "invalid_poll_capability",
      });
      if ("error" in capability) return capability.error;
      const startup = startAppSession(
        manager,
        capability.session,
        "poll_ssh_start_failed",
      );
      if ("error" in startup) return startup.error;
      const started = startup.session;
      const poll = manager.pollSession(started.id, args.afterSeq ?? 0);
      if (!poll) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Quick-shell session is no longer available.",
            },
          ],
        };
      }
      return {
        content: [
          { type: "text", text: "Quick-shell output is available to the app." },
        ],
        structuredContent: {
          sessionId: started.id,
          device: started.publicSummary.device,
          exited: poll.exited,
          exitCode: poll.exitCode,
        },
        _meta: {
          quickShellPoll: poll,
        },
      };
    },
  );

  registerAppTool(
    server,
    "write_quick_shell_input",
    {
      title: "Write Quick Shell Input",
      description:
        "App-only quick-shell terminal input for hosts that cannot reach the WebSocket bridge.",
      inputSchema: {
        ...appCapabilityInputSchema(),
        data: utf8Max(config.maxInputBytes).optional(),
      },
      outputSchema: {
        written: z.boolean(),
      },
      annotations: toolAnnotations("Write Quick Shell Input", {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      }),
      _meta: toolMeta(["app"], {
        invoking: "Writing shell input",
        invoked: "Shell input written",
      }),
    },
    async (args) => {
      if (args.data === undefined) {
        manager.recordAuditEvent("app_session_rejected", {
          sessionId: args.sessionId,
          reason: "missing_write_capability",
          hasAppToken:
            typeof args.appToken === "string" && args.appToken.length > 0,
          hasData: args.data !== undefined,
        });
        return {
          isError: true,
          content: [
            { type: "text", text: "Missing quick-shell write capability." },
          ],
        };
      }
      const capability = requireAppCapability(manager, args, {
        missingReason: "missing_write_capability",
        missingMessage: "Missing quick-shell write capability.",
        invalidReason: "invalid_write_capability",
        auditFields: { hasData: true },
      });
      if ("error" in capability) return capability.error;
      const startup = startAppSession(
        manager,
        capability.session,
        "write_ssh_start_failed",
      );
      if ("error" in startup) return startup.error;
      const session = startup.session;
      const result = manager.writeInput(session.id, args.data);
      if (!result.written) {
        // A dropped write is a failure, not a quiet success: without this the
        // model proceeds as though the input reached the shell.
        manager.recordAuditEvent("app_session_rejected", {
          sessionId: session.id,
          device: session.publicSummary.device,
          reason: `write_ignored_${result.reason}`,
        });
        return toolError(
          `Quick-shell input not delivered: session ${result.reason}.`,
        );
      }
      return {
        content: [{ type: "text", text: "Quick-shell input written." }],
        structuredContent: { written: true },
      };
    },
  );

  registerAppTool(
    server,
    "resize_quick_shell_session",
    {
      title: "Resize Quick Shell Session",
      description:
        "App-only quick-shell terminal resize for hosts that cannot reach the WebSocket bridge.",
      inputSchema: {
        ...appCapabilityInputSchema(),
        cols: z
          .number()
          .int()
          .min(MIN_TERMINAL_COLS)
          .max(MAX_TERMINAL_COLS)
          .optional(),
        rows: z
          .number()
          .int()
          .min(MIN_TERMINAL_ROWS)
          .max(MAX_TERMINAL_ROWS)
          .optional(),
      },
      outputSchema: {
        resized: z.boolean(),
      },
      annotations: toolAnnotations("Resize Quick Shell Session", {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      }),
      _meta: toolMeta(["app"], {
        invoking: "Resizing shell",
        invoked: "Shell resized",
      }),
    },
    async (args) => {
      if (args.cols === undefined || args.rows === undefined) {
        manager.recordAuditEvent("app_session_rejected", {
          sessionId: args.sessionId,
          reason: "missing_resize_capability",
          hasAppToken:
            typeof args.appToken === "string" && args.appToken.length > 0,
          hasCols: args.cols !== undefined,
          hasRows: args.rows !== undefined,
        });
        return {
          isError: true,
          content: [
            { type: "text", text: "Missing quick-shell resize capability." },
          ],
        };
      }
      const capability = requireAppCapability(manager, args, {
        missingReason: "missing_resize_capability",
        missingMessage: "Missing quick-shell resize capability.",
        invalidReason: "invalid_resize_capability",
        auditFields: { hasCols: true, hasRows: true },
      });
      if ("error" in capability) return capability.error;
      const startup = startAppSession(
        manager,
        capability.session,
        "resize_ssh_start_failed",
      );
      if ("error" in startup) return startup.error;
      const session = startup.session;
      const result = manager.resizeSession(session.id, args.cols, args.rows);
      if (!result.resized) {
        manager.recordAuditEvent("app_session_rejected", {
          sessionId: session.id,
          device: session.publicSummary.device,
          reason: `resize_ignored_${result.reason}`,
        });
        return toolError(
          `Quick-shell resize not applied: session ${result.reason}.`,
        );
      }
      return {
        content: [{ type: "text", text: "Quick-shell session resized." }],
        structuredContent: { resized: true },
      };
    },
  );

  registerAppTool(
    server,
    "close_quick_shell_session",
    {
      title: "Close Quick Shell Session",
      description: "App-only quick-shell session close.",
      inputSchema: {
        ...appCapabilityInputSchema(),
      },
      outputSchema: {
        closed: z.boolean(),
        alreadyClosed: z.boolean().optional(),
      },
      annotations: toolAnnotations("Close Quick Shell Session", {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      _meta: toolMeta(["app"], {
        invoking: "Closing shell",
        invoked: "Shell closed",
      }),
    },
    async (args) => {
      manager.recordAuditEvent("app_session_close_requested", {
        sessionId: args.sessionId,
        hasSessionId:
          typeof args.sessionId === "string" && args.sessionId.length > 0,
        hasAppToken:
          typeof args.appToken === "string" && args.appToken.length > 0,
      });
      const closeCapability = {
        missingReason: "missing_close_capability",
        missingMessage: "Missing quick-shell close capability.",
        invalidReason: "invalid_close_capability",
      };
      if (!args.sessionId || !args.appToken) {
        const capability = requireAppCapability(manager, args, closeCapability);
        // requireAppCapability always errors on this same condition, so the
        // narrowing below is for the type checker rather than a real branch.
        if ("error" in capability) return capability.error;
        return toolError(closeCapability.missingMessage);
      }
      // Existence is checked before authentication so that closing an
      // already-closed session stays idempotent: once a session is gone there is
      // no token left to authenticate against. The cost is that an unknown id is
      // distinguishable from a known one without a token, which is acceptable
      // only because ids are unguessable randomUUID values.
      const existing = manager.getSession(args.sessionId);
      if (!existing) {
        return {
          content: [
            { type: "text", text: "Quick-shell session already closed." },
          ],
          structuredContent: { closed: true, alreadyClosed: true },
        };
      }

      if (existing.appToken !== args.appToken) {
        return toolError("Invalid quick-shell app capability.");
      }
      const session = existing;

      const closed = manager.closeSession(session.id);
      return {
        content: [
          {
            type: "text",
            text: closed
              ? "Quick-shell session closed."
              : "Unable to close quick-shell session; termination will be retried.",
          },
        ],
        structuredContent: { closed },
      };
    },
  );

  registerAppTool(
    server,
    "list_quick_shell_files",
    {
      title: "List Quick Shell Files",
      description: "App-only confined SFTP directory listing.",
      inputSchema: {
        ...appCapabilityInputSchema(),
        path: utf8Max(config.maxFilePathBytes).optional(),
      },
      outputSchema: { count: z.number().int().min(0) },
      annotations: toolAnnotations("List Quick Shell Files", {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      }),
      _meta: toolMeta(["app"], {
        invoking: "Listing files",
        invoked: "Files listed",
      }),
    },
    async (args) => {
      const capability = requireAppCapability(manager, args, {
        missingReason: "missing_file_capability",
        missingMessage: "Missing quick-shell file capability.",
        invalidReason: "invalid_file_capability",
      });
      if ("error" in capability) return capability.error;
      try {
        const entries = await manager
          .getFileSession(capability.session.id)!
          .list(args.path ?? ".");
        return {
          content: [
            {
              type: "text",
              text: "Quick-shell file listing is available to the app.",
            },
          ],
          structuredContent: { count: entries.length },
          _meta: {
            quickShellFiles: {
              path: args.path ?? ".",
              entries,
              maxEmbeddedDownloadBytes: config.maxEmbeddedDownloadBytes,
            },
          },
        };
      } catch (error) {
        return toolError(
          `Unable to list quick-shell files: ${safeFileError(error)}.`,
        );
      }
    },
  );

  registerAppTool(
    server,
    "prepare_quick_shell_file_operation",
    {
      title: "Prepare Quick Shell File Operation",
      description: "App-only short-lived file operation capability.",
      inputSchema: {
        ...appCapabilityInputSchema(),
        operation: z.enum(["mkdir", "rename", "delete", "upload", "download"]),
        path: utf8Max(config.maxFilePathBytes).optional(),
        from: utf8Max(config.maxFilePathBytes).optional(),
        to: utf8Max(config.maxFilePathBytes).optional(),
        expectedFingerprint: z.string().min(16).max(128).optional(),
        targetFingerprint: z.string().min(16).max(128).optional(),
        kind: z.enum(["file", "directory", "symlink"]).optional(),
        bytes: z.number().int().min(0).max(config.maxTransferBytes).optional(),
        overwrite: z.boolean().optional(),
      },
      outputSchema: { prepared: z.boolean() },
      annotations: toolAnnotations("Prepare Quick Shell File Operation", {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      }),
      _meta: toolMeta(["app"], {
        invoking: "Preparing file action",
        invoked: "File action prepared",
      }),
    },
    async (args) => {
      const capability = requireAppCapability(manager, args, {
        missingReason: "missing_file_capability",
        missingMessage: "Missing quick-shell file capability.",
        invalidReason: "invalid_file_capability",
      });
      if ("error" in capability) return capability.error;
      try {
        const lease = await manager
          .getFileSession(capability.session.id)!
          .prepare(parsePrepareOperation(args));
        manager.recordAuditEvent("file_operation_prepared", {
          sessionId: capability.session.id,
          device: capability.session.publicSummary.device,
          operation: args.operation,
          outcome: "prepared",
        });
        return {
          content: [
            {
              type: "text",
              text: "Quick-shell file operation prepared for the app.",
            },
          ],
          structuredContent: { prepared: true },
          _meta: { quickShellFiles: { lease } },
        };
      } catch (error) {
        manager.recordAuditEvent("file_operation_failed", {
          sessionId: capability.session.id,
          device: capability.session.publicSummary.device,
          operation: args.operation,
          outcome: "failed",
          errorCode: safeFileError(error),
        });
        return toolError(
          `Unable to prepare quick-shell file operation: ${safeFileError(error)}.`,
        );
      }
    },
  );

  for (const [toolName, operation, title] of [
    ["mkdir_quick_shell_path", "mkdir", "Create Quick Shell Folder"],
    ["rename_quick_shell_path", "rename", "Rename Quick Shell Path"],
    ["delete_quick_shell_path", "delete", "Delete Quick Shell Path"],
  ] as const) {
    registerAppTool(
      server,
      toolName,
      {
        title,
        description: "App-only confirmed SFTP mutation using a one-time lease.",
        inputSchema: {
          ...appCapabilityInputSchema(),
          lease: z.string().min(16).max(256),
        },
        outputSchema: { completed: z.boolean() },
        annotations: toolAnnotations(title, {
          readOnlyHint: false,
          destructiveHint: operation !== "mkdir",
          openWorldHint: true,
        }),
        _meta: toolMeta(["app"], {
          invoking: "Applying file action",
          invoked: "File action applied",
        }),
      },
      async (args) => {
        const capability = requireAppCapability(manager, args, {
          missingReason: "missing_file_capability",
          missingMessage: "Missing quick-shell file capability.",
          invalidReason: "invalid_file_capability",
        });
        if ("error" in capability) return capability.error;
        try {
          await manager
            .getFileSession(capability.session.id)!
            .mutate(args.lease, operation);
          manager.recordAuditEvent("file_operation_completed", {
            sessionId: capability.session.id,
            device: capability.session.publicSummary.device,
            operation,
            outcome: "completed",
          });
          return {
            content: [
              { type: "text", text: "Quick-shell file operation completed." },
            ],
            structuredContent: { completed: true },
          };
        } catch (error) {
          manager.recordAuditEvent("file_operation_failed", {
            sessionId: capability.session.id,
            device: capability.session.publicSummary.device,
            operation,
            outcome: "failed",
            errorCode: safeFileError(error),
          });
          return toolError(
            `Quick-shell file operation failed: ${safeFileError(error)}.`,
          );
        }
      },
    );
  }

  for (const [name, uri] of [
    ["quick-shell", APP_RESOURCE_URI],
    ["quick-shell-v4", V4_APP_RESOURCE_URI],
    ["quick-shell-v3", V3_APP_RESOURCE_URI],
    ["quick-shell-v2", V2_APP_RESOURCE_URI],
    ["quick-shell-legacy", LEGACY_APP_RESOURCE_URI],
  ] as const) {
    registerAppResource(
      server,
      name,
      uri,
      {
        description: "quick-shell MCP App",
        _meta: {
          ui: appResourceMeta(bridgeBaseUrl),
        },
      },
      async () => {
        const text = await readBuiltAppHtml();
        manager.recordAuditEvent("app_resource_read", {
          uri,
          bytes: new TextEncoder().encode(text).byteLength,
        });
        return {
          contents: [
            {
              uri,
              mimeType: RESOURCE_MIME_TYPE,
              text,
              _meta: {
                ui: appResourceMeta(bridgeBaseUrl),
              },
            },
          ],
        };
      },
    );
  }

  return server;
}

function safeFileError(error: unknown): string {
  const code = error instanceof Error ? error.message : "operation_failed";
  return /^[a-z_]+$/.test(code) ? code : "operation_failed";
}

function parsePrepareOperation(args: Record<string, unknown>) {
  const operation = args.operation;
  if (operation === "mkdir" && typeof args.path === "string")
    return { operation, path: args.path } as const;
  if (
    operation === "rename" &&
    typeof args.from === "string" &&
    typeof args.to === "string" &&
    typeof args.expectedFingerprint === "string"
  )
    return {
      operation,
      from: args.from,
      to: args.to,
      expectedFingerprint: args.expectedFingerprint,
      overwrite: args.overwrite === true,
      targetFingerprint:
        typeof args.targetFingerprint === "string"
          ? args.targetFingerprint
          : undefined,
    } as const;
  if (
    operation === "delete" &&
    typeof args.path === "string" &&
    typeof args.expectedFingerprint === "string" &&
    (args.kind === "file" ||
      args.kind === "directory" ||
      args.kind === "symlink")
  )
    return {
      operation,
      path: args.path,
      expectedFingerprint: args.expectedFingerprint,
      kind: args.kind,
    } as const;
  if (
    operation === "upload" &&
    typeof args.path === "string" &&
    typeof args.bytes === "number"
  )
    return {
      operation,
      path: args.path,
      bytes: args.bytes,
      overwrite: args.overwrite === true,
      expectedFingerprint:
        typeof args.expectedFingerprint === "string"
          ? args.expectedFingerprint
          : undefined,
    } as const;
  if (
    operation === "download" &&
    typeof args.path === "string" &&
    typeof args.expectedFingerprint === "string" &&
    typeof args.bytes === "number"
  )
    return {
      operation,
      path: args.path,
      expectedFingerprint: args.expectedFingerprint,
      bytes: args.bytes,
    } as const;
  throw new Error("invalid_operation");
}

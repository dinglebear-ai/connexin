import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RuntimeConfig } from "./config.js";
import { registerHealthTool } from "./health-tool.js";
import type { QuickShellSessionManager } from "./session-manager.js";
import {
  APP_RESOURCE_URI,
  SERVER_INSTRUCTIONS,
  appCapabilityInputSchema,
  appResourceMeta,
  appSessionFor,
  asStructuredContent,
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

export function createServer(options: CreateServerOptions): McpServer {
  const server = new McpServer(
    { name: "quick-shell", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const { bridgeBaseUrl, config, manager } = options;

  registerHealthTool(server, config, manager);

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
            text: `Opened quick-shell session for ${session.publicSummary.device}. The terminal is controlled by the user.`,
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
      if (!args.sessionId || !args.appToken) {
        manager.recordAuditEvent("app_session_rejected", {
          sessionId: args.sessionId,
          reason: "missing_app_capability",
        });
        return {
          isError: true,
          content: [
            { type: "text", text: "Missing quick-shell app capability." },
          ],
        };
      }

      const session = manager.authenticateApp(args.sessionId, args.appToken);
      if (!session) {
        manager.recordAuditEvent("app_session_rejected", {
          sessionId: args.sessionId,
          reason: "invalid_app_capability",
        });
        return {
          isError: true,
          content: [
            { type: "text", text: "Invalid quick-shell app capability." },
          ],
        };
      }

      let started;
      try {
        started = manager.startSession(session.id);
      } catch (error) {
        manager.closeSession(session.id);
        const cause = safeErrorMessage(error);
        manager.recordAuditEvent("app_session_rejected", {
          sessionId: session.id,
          device: session.publicSummary.device,
          reason: "ssh_start_failed",
          error: cause,
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unable to start quick-shell SSH session for ${session.publicSummary.device}${cause ? `: ${cause}` : "."}`,
            },
          ],
        };
      }
      if (!started) {
        manager.recordAuditEvent("app_session_rejected", {
          sessionId: session.id,
          device: session.publicSummary.device,
          reason: "missing_session",
        });
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
      if (!args.sessionId || !args.appToken || args.byteCount === undefined) {
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
      const session = manager.authenticateApp(args.sessionId, args.appToken);
      if (!session) {
        manager.recordAuditEvent("app_session_rejected", {
          sessionId: args.sessionId,
          reason: "invalid_output_confirm_capability",
        });
        return {
          isError: true,
          content: [
            { type: "text", text: "Invalid quick-shell app capability." },
          ],
        };
      }

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
      if (!args.sessionId || !args.appToken) {
        manager.recordAuditEvent("app_session_rejected", {
          sessionId: args.sessionId,
          reason: "missing_poll_capability",
          hasAppToken:
            typeof args.appToken === "string" && args.appToken.length > 0,
        });
        return {
          isError: true,
          content: [
            { type: "text", text: "Missing quick-shell poll capability." },
          ],
        };
      }
      const session = manager.authenticateApp(args.sessionId, args.appToken);
      if (!session) {
        manager.recordAuditEvent("app_session_rejected", {
          sessionId: args.sessionId,
          reason: "invalid_poll_capability",
        });
        return {
          isError: true,
          content: [
            { type: "text", text: "Invalid quick-shell app capability." },
          ],
        };
      }
      let started;
      try {
        started = manager.startSession(session.id);
      } catch (error) {
        manager.closeSession(session.id);
        const cause = safeErrorMessage(error);
        manager.recordAuditEvent("app_session_rejected", {
          sessionId: session.id,
          device: session.publicSummary.device,
          reason: "poll_ssh_start_failed",
          error: cause,
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unable to start quick-shell SSH session for ${session.publicSummary.device}.`,
            },
          ],
        };
      }
      if (!started) {
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
      if (!args.sessionId || !args.appToken || args.data === undefined) {
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
      const session = manager.authenticateApp(args.sessionId, args.appToken);
      if (!session) {
        return {
          isError: true,
          content: [
            { type: "text", text: "Invalid quick-shell app capability." },
          ],
        };
      }
      try {
        manager.startSession(session.id);
      } catch (error) {
        manager.closeSession(session.id);
        return {
          isError: true,
          content: [
            { type: "text", text: "Unable to start quick-shell SSH session." },
          ],
        };
      }
      const written = manager.writeInput(session.id, args.data);
      return {
        content: [
          {
            type: "text",
            text: written
              ? "Quick-shell input written."
              : "Quick-shell input ignored.",
          },
        ],
        structuredContent: { written },
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
      if (
        !args.sessionId ||
        !args.appToken ||
        args.cols === undefined ||
        args.rows === undefined
      ) {
        return {
          isError: true,
          content: [
            { type: "text", text: "Missing quick-shell resize capability." },
          ],
        };
      }
      const session = manager.authenticateApp(args.sessionId, args.appToken);
      if (!session) {
        return {
          isError: true,
          content: [
            { type: "text", text: "Invalid quick-shell app capability." },
          ],
        };
      }
      try {
        manager.startSession(session.id);
      } catch (error) {
        manager.closeSession(session.id);
        return {
          isError: true,
          content: [
            { type: "text", text: "Unable to start quick-shell SSH session." },
          ],
        };
      }
      const resized = manager.resizeSession(session.id, args.cols, args.rows);
      return {
        content: [
          {
            type: "text",
            text: resized
              ? "Quick-shell session resized."
              : "Quick-shell resize ignored.",
          },
        ],
        structuredContent: { resized },
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
      if (!args.sessionId || !args.appToken) {
        manager.recordAuditEvent("app_session_rejected", {
          sessionId: args.sessionId,
          reason: "missing_close_capability",
        });
        return {
          isError: true,
          content: [
            { type: "text", text: "Missing quick-shell close capability." },
          ],
        };
      }
      const existing = manager.getSession(args.sessionId);
      if (!existing) {
        return {
          content: [
            { type: "text", text: "Quick-shell session already closed." },
          ],
          structuredContent: { closed: true, alreadyClosed: true },
        };
      }

      const session = manager.authenticateApp(args.sessionId, args.appToken);
      if (!session) {
        manager.recordAuditEvent("app_session_rejected", {
          sessionId: args.sessionId,
          reason: "invalid_close_capability",
        });
        return {
          isError: true,
          content: [
            { type: "text", text: "Invalid quick-shell app capability." },
          ],
        };
      }

      const closed = manager.closeSession(session.id);
      return {
        content: [
          {
            type: "text",
            text: closed
              ? "Quick-shell session closed."
              : "Quick-shell session already closed.",
          },
        ],
        structuredContent: { closed },
      };
    },
  );

  registerAppResource(
    server,
    "quick-shell",
    APP_RESOURCE_URI,
    {
      description: "quick-shell MCP App",
      _meta: {
        ui: appResourceMeta(bridgeBaseUrl),
      },
    },
    async () => {
      const text = await readBuiltAppHtml();
      manager.recordAuditEvent("app_resource_read", {
        uri: APP_RESOURCE_URI,
        bytes: new TextEncoder().encode(text).byteLength,
      });
      return {
        contents: [
          {
            uri: APP_RESOURCE_URI,
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

  return server;
}

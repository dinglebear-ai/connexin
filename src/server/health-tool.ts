import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RuntimeConfig } from "./config.js";
import type { QuickShellSessionManager } from "./session-manager.js";
import { toolAnnotations } from "./mcp-tooling.js";

export function registerHealthTool(
  server: McpServer,
  config: RuntimeConfig,
  manager: QuickShellSessionManager,
): void {
  server.registerTool(
    "check_quick_shell",
    {
      title: "Check Quick Shell",
      description:
        "Side-effect-free quick-shell health check for gateway verification.",
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        activeSessions: z.number().int().min(0),
        startedSessions: z.number().int().min(0),
        maxSessions: z.number().int().min(1),
        publicBridge: z.boolean(),
      },
      annotations: toolAnnotations("Check Quick Shell", {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
    },
    async () => {
      const sessions = manager.listSessions();
      const startedSessions = sessions.filter(
        (session) => session.pty !== undefined,
      ).length;
      return {
        content: [
          {
            type: "text",
            text: `quick-shell is available (${sessions.length}/${config.maxSessions} sessions active).`,
          },
        ],
        structuredContent: {
          ok: true,
          activeSessions: sessions.length,
          startedSessions,
          maxSessions: config.maxSessions,
          publicBridge: config.bridgePublicUrl !== undefined,
        },
      };
    },
  );
}

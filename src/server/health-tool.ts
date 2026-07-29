import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RuntimeConfig } from "./config.js";
import type { ConnexinSessionManager } from "./session-manager.js";
import { toolAnnotations } from "./mcp-tooling.js";

export function registerHealthTool(
  server: McpServer,
  config: RuntimeConfig,
  manager: ConnexinSessionManager,
): void {
  server.registerTool(
    "check_connexin",
    {
      title: "Check Connexin",
      description:
        "Side-effect-free connexin health check for gateway verification.",
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        activeSessions: z.number().int().min(0),
        startedSessions: z.number().int().min(0),
        maxSessions: z.number().int().min(1),
        publicBridge: z.boolean(),
        auditHealthy: z.boolean(),
        droppedAuditRecords: z.number().int().min(0),
      },
      annotations: toolAnnotations("Check Connexin", {
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
      const audit = manager.auditHealth();
      const summary = `${sessions.length}/${config.maxSessions} sessions active`;
      return {
        content: [
          {
            type: "text",
            text: audit.healthy
              ? `connexin is available (${summary}).`
              : `connexin is degraded: audit log unwritable, ${audit.droppedRecords} record(s) dropped${
                  audit.error ? ` (${audit.error})` : ""
                } (${summary}).`,
          },
        ],
        structuredContent: {
          ok: audit.healthy,
          activeSessions: sessions.length,
          startedSessions,
          maxSessions: config.maxSessions,
          publicBridge: config.bridgePublicUrl !== undefined,
          auditHealthy: audit.healthy,
          droppedAuditRecords: audit.droppedRecords,
        },
      };
    },
  );
}

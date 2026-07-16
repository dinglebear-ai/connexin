import { z } from "zod";

export type SessionId = string;

export const SessionIdSchema = z.string();

export const QuickShellPublicSessionSchema = z.object({
  sessionId: SessionIdSchema,
  device: z.string(),
  reason: z.string().optional(),
  suggestedCommand: z.string().optional(),
  deviceLabel: z.string().optional(),
  deviceGroup: z.string().optional(),
  deviceDanger: z.enum(["normal", "caution", "danger"]).optional(),
  deviceDefaultShell: z.string().optional(),
});
export type QuickShellPublicSession = z.infer<typeof QuickShellPublicSessionSchema>;

export const QuickShellAppSessionSchema = QuickShellPublicSessionSchema.extend({
  wsUrl: z.string(),
  maxSubmitBytes: z.number(),
  pingIntervalMs: z.number(),
});
export type QuickShellAppSession = z.infer<typeof QuickShellAppSessionSchema>;

export const QuickShellOutputChunkSchema = z.object({
  seq: z.number().int().min(1),
  data: z.string(),
});
export type QuickShellOutputChunk = z.infer<typeof QuickShellOutputChunkSchema>;

export const QuickShellPollSchema = z.object({
  sessionId: SessionIdSchema,
  chunks: z.array(QuickShellOutputChunkSchema),
  nextSeq: z.number().int().min(0),
  reset: z.boolean(),
  exited: z.boolean(),
  exitCode: z.number().nullable(),
});
export type QuickShellPoll = z.infer<typeof QuickShellPollSchema>;

export const QuickShellHiddenMetaSchema = z.object({
  quickShell: z.object({
    sessionId: SessionIdSchema,
    appToken: z.string(),
  }),
  quickShellSession: QuickShellAppSessionSchema.optional(),
});
export type QuickShellHiddenMeta = z.infer<typeof QuickShellHiddenMetaSchema>;

export const clientTerminalMessageSchema = (maxBytes: number) =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("input"), data: z.string().max(maxBytes) }),
    z.object({
      type: z.literal("resize"),
      cols: z.number().int().min(20).max(400),
      rows: z.number().int().min(5).max(200),
    }),
    z.object({ type: z.literal("close") }),
    z.object({ type: z.literal("output_confirmed"), byteCount: z.number().int().min(0).max(maxBytes) }),
    z.object({ type: z.literal("ping") }),
  ]);
export type ClientTerminalMessage = z.infer<ReturnType<typeof clientTerminalMessageSchema>>;

export const ServerTerminalMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), sessionId: SessionIdSchema, scrollback: z.string() }),
  z.object({ type: z.literal("output"), data: z.string() }),
  z.object({ type: z.literal("exit"), exitCode: z.number().nullable() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerTerminalMessage = z.infer<typeof ServerTerminalMessageSchema>;

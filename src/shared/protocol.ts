import { z } from "zod";
import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
} from "./terminal-defaults.js";
import { utf8ByteLength } from "./utf8.js";

export type SessionId = string;

export const SessionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const CapabilityTokenSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._~+-]+$/);
export const QuickShellAppCapabilitySchema = z.object({
  sessionId: SessionIdSchema,
  appToken: CapabilityTokenSchema,
});
export type QuickShellAppCapability = z.infer<
  typeof QuickShellAppCapabilitySchema
>;

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
export type QuickShellPublicSession = z.infer<
  typeof QuickShellPublicSessionSchema
>;

export const QuickShellAppSessionSchema = QuickShellPublicSessionSchema.extend({
  wsUrl: z.string().min(1),
  wsToken: CapabilityTokenSchema,
  maxInputBytes: z.number().int().positive(),
  maxSubmitBytes: z.number().int().positive(),
  maxWsPayloadBytes: z.number().int().positive(),
  pingIntervalMs: z.number().int().positive(),
});
export type QuickShellAppSession = z.infer<typeof QuickShellAppSessionSchema>;

export const QuickShellOutputChunkSchema = z.object({
  seq: z.number().int().min(1),
  data: z.string(),
  snapshot: z.boolean().optional(),
  truncated: z.boolean().optional(),
  originalBytes: z.number().int().min(0).optional(),
  retainedBytes: z.number().int().min(0).optional(),
});
export type QuickShellOutputChunk = z.infer<typeof QuickShellOutputChunkSchema>;

export const QuickShellPollResetReasonSchema = z.enum([
  "stale_cursor",
  "cursor_ahead",
  "truncated_output",
]);
export type QuickShellPollResetReason = z.infer<
  typeof QuickShellPollResetReasonSchema
>;

export const QuickShellPollSchema = z.object({
  sessionId: SessionIdSchema,
  chunks: z.array(QuickShellOutputChunkSchema),
  nextSeq: z.number().int().min(0),
  reset: z.boolean(),
  resetReason: QuickShellPollResetReasonSchema.optional(),
  snapshot: z.string().optional(),
  snapshotBytes: z.number().int().min(0).optional(),
  snapshotSeq: z.number().int().min(0).optional(),
  droppedBeforeSeq: z.number().int().min(0).optional(),
  truncatedBytes: z.number().int().min(0).optional(),
  exited: z.boolean(),
  exitCode: z.number().nullable(),
});
export type QuickShellPoll = z.infer<typeof QuickShellPollSchema>;

export const QuickShellHiddenMetaSchema = z.object({
  quickShell: QuickShellAppCapabilitySchema,
  quickShellSession: QuickShellAppSessionSchema.optional(),
});
export type QuickShellHiddenMeta = z.infer<typeof QuickShellHiddenMetaSchema>;

export interface ClientTerminalMessageLimits {
  maxInputBytes: number;
  maxSubmitBytes: number;
}

const utf8Max = (maxBytes: number) =>
  z
    .string()
    .refine((value) => utf8ByteLength(value) <= maxBytes, "too many bytes");

export const clientTerminalMessageSchema = (
  limits: ClientTerminalMessageLimits,
) =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("authenticate"), token: CapabilityTokenSchema }),
    z.object({ type: z.literal("input"), data: utf8Max(limits.maxInputBytes) }),
    z.object({
      type: z.literal("resize"),
      cols: z.number().int().min(MIN_TERMINAL_COLS).max(MAX_TERMINAL_COLS),
      rows: z.number().int().min(MIN_TERMINAL_ROWS).max(MAX_TERMINAL_ROWS),
    }),
    z.object({ type: z.literal("close") }),
    z.object({
      type: z.literal("output_confirmed"),
      byteCount: z.number().int().min(0).max(limits.maxSubmitBytes),
    }),
    z.object({ type: z.literal("ping") }),
  ]);
export type ClientTerminalMessage = z.infer<
  ReturnType<typeof clientTerminalMessageSchema>
>;

export const ServerTerminalMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    sessionId: SessionIdSchema,
    scrollback: z.string(),
  }),
  z.object({ type: z.literal("output"), data: z.string() }),
  z.object({ type: z.literal("exit"), exitCode: z.number().nullable() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerTerminalMessage = z.infer<typeof ServerTerminalMessageSchema>;

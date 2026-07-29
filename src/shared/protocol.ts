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
export const ConnexinAppCapabilitySchema = z.object({
  sessionId: SessionIdSchema,
  appToken: CapabilityTokenSchema,
});
export type ConnexinAppCapability = z.infer<typeof ConnexinAppCapabilitySchema>;

export const ConnexinPublicSessionSchema = z.object({
  sessionId: SessionIdSchema,
  device: z.string().min(1),
  reason: z.string().optional(),
  suggestedCommand: z.string().optional(),
  deviceLabel: z.string().optional(),
  deviceGroup: z.string().optional(),
  deviceDanger: z.enum(["normal", "caution", "danger"]).optional(),
  deviceDefaultShell: z.string().optional(),
});
export type ConnexinPublicSession = z.infer<typeof ConnexinPublicSessionSchema>;

export const ConnexinAppSessionSchema = ConnexinPublicSessionSchema.extend({
  wsUrl: z.string().min(1),
  wsToken: CapabilityTokenSchema,
  maxInputBytes: z.number().int().positive(),
  maxSubmitBytes: z.number().int().positive(),
  maxWsPayloadBytes: z.number().int().positive(),
  pingIntervalMs: z.number().int().positive(),
  fileBaseUrl: z.string().min(1).optional(),
  fileToken: CapabilityTokenSchema.optional(),
  maxEmbeddedDownloadBytes: z.number().int().positive().optional(),
});
export type ConnexinAppSession = z.infer<typeof ConnexinAppSessionSchema>;

export const ConnexinOutputChunkSchema = z.object({
  seq: z.number().int().min(1),
  data: z.string(),
  snapshot: z.boolean().optional(),
  truncated: z.boolean().optional(),
  originalBytes: z.number().int().min(0).optional(),
  retainedBytes: z.number().int().min(0).optional(),
});
export type ConnexinOutputChunk = z.infer<typeof ConnexinOutputChunkSchema>;

export const ConnexinPollResetReasonSchema = z.enum([
  "stale_cursor",
  "cursor_ahead",
  "truncated_output",
]);
export type ConnexinPollResetReason = z.infer<
  typeof ConnexinPollResetReasonSchema
>;

export const ConnexinPollSchema = z.object({
  sessionId: SessionIdSchema,
  chunks: z.array(ConnexinOutputChunkSchema),
  nextSeq: z.number().int().min(0),
  reset: z.boolean(),
  resetReason: ConnexinPollResetReasonSchema.optional(),
  snapshot: z.string().optional(),
  snapshotBytes: z.number().int().min(0).optional(),
  snapshotSeq: z.number().int().min(0).optional(),
  droppedBeforeSeq: z.number().int().min(0).optional(),
  truncatedBytes: z.number().int().min(0).optional(),
  exited: z.boolean(),
  exitCode: z.number().nullable(),
});
export type ConnexinPoll = z.infer<typeof ConnexinPollSchema>;

export const ConnexinHiddenMetaSchema = z.object({
  connexin: ConnexinAppCapabilitySchema,
  connexinSession: ConnexinAppSessionSchema.optional(),
});
export type ConnexinHiddenMeta = z.infer<typeof ConnexinHiddenMetaSchema>;

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

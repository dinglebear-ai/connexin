import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AuditEvent =
  | "runtime_started"
  | "runtime_closed"
  | "bridge_listening"
  | "bridge_bind_retry"
  | "bridge_connection_rejected"
  | "bridge_connected"
  | "bridge_disconnected"
  | "bridge_message_rejected"
  | "bridge_backpressure_closed"
  | "bridge_io_failed"
  | "session_opened"
  | "session_open_failed"
  /** Client does not advertise MCP Apps support; no session or token minted. */
  | "session_open_refused"
  /** Capabilities were unavailable (stateless HTTP), so the gate did not run. */
  | "app_host_check_skipped"
  | "session_started"
  | "session_exited"
  | "session_closed"
  | "session_expired"
  | "app_resource_read"
  | "app_session_requested"
  | "app_session_attached"
  | "app_session_rejected"
  | "app_session_close_requested"
  | "output_confirmed"
  | "ssh_start_failed"
  | "file_operation_prepared"
  | "file_operation_completed"
  | "file_operation_failed"
  | "file_request_rejected"
  | "file_transfer_completed"
  | "file_transfer_failed"
  | "audit_sink_recovered";

export type AuditFields = Record<string, unknown>;

export interface AuditRecord extends AuditFields {
  event: AuditEvent;
  at: string;
}

export interface AuditSink {
  write(record: AuditRecord): void;
  flush?(): Promise<void>;
}

export interface AuditLogger {
  record(event: AuditEvent, fields?: AuditFields): void;
  flush?(): Promise<void>;
}

export interface AuditRateLimiter {
  record(writeDetailedRecord: () => void): void;
}

/**
 * Bounds detailed audit records to `maxEvents` per window while keeping the
 * suppression itself auditable. Two markers per window at most, so cardinality
 * stays fixed under a flood:
 *
 * - `onSuppressionStarted` fires as soon as records begin being dropped, so an
 *   in-progress flood is visible without waiting for the window to close.
 * - `onSuppressionSummary` fires at window close with the total dropped.
 */
export function createAuditRateLimiter(options: {
  maxEvents: number;
  windowMs: number;
  onSuppressionStarted: () => void;
  onSuppressionSummary: (suppressedCount: number) => void;
  now?: () => number;
}): AuditRateLimiter {
  const now = options.now ?? Date.now;
  let windowStartedAt = now();
  let eventCount = 0;
  let suppressedCount = 0;
  let summaryTimer: NodeJS.Timeout | undefined;

  const flushSummary = () => {
    if (summaryTimer) clearTimeout(summaryTimer);
    summaryTimer = undefined;
    if (suppressedCount > 0) options.onSuppressionSummary(suppressedCount);
  };

  return {
    record(writeDetailedRecord) {
      const currentTime = now();
      if (currentTime - windowStartedAt >= options.windowMs) {
        flushSummary();
        windowStartedAt = currentTime;
        eventCount = 0;
        suppressedCount = 0;
      }
      if (eventCount < options.maxEvents) {
        eventCount += 1;
        writeDetailedRecord();
        return;
      }
      suppressedCount += 1;
      if (suppressedCount === 1) {
        options.onSuppressionStarted();
        const remaining = Math.max(
          0,
          options.windowMs - (currentTime - windowStartedAt),
        );
        summaryTimer = setTimeout(flushSummary, remaining);
        summaryTimer.unref();
      }
    },
  };
}

const REDACTED_FIELD_PATTERN =
  /token|output|suggestedcommand|suggested_command|path|filename|url|authorization|headers|nonce|lease|capability|secret|contents/i;

/**
 * Keys that match REDACTED_FIELD_PATTERN by substring but carry no secret. The
 * pattern stays deliberately broad so unforeseen secret-bearing fields are
 * redacted by default; anything provably safe is named here instead of loosening
 * it. `hasAppToken` is a boolean that distinguishes "no token supplied" from
 * "wrong token supplied" during incident review.
 *
 * The four startup fields are local config paths and the bridge's own loopback
 * URLs -- operator-known deployment facts, not credentials. They matched
 * `path`/`url` by substring and were silently dropped, which left
 * runtime_started and bridge_listening with none of the detail they were
 * written to capture and broke the deployment verifier's documented baseUrl
 * check (scripts/verify-deployment.ts), since it greps for a field that could
 * never be written.
 */
const SAFE_FIELD_ALLOWLIST = new Set([
  "hasAppToken",
  "sshConfigPath",
  "connexinConfigPath",
  "baseUrl",
  "listenUrl",
]);

function isRedactedKey(key: string): boolean {
  if (SAFE_FIELD_ALLOWLIST.has(key)) return false;
  return REDACTED_FIELD_PATTERN.test(key);
}

function redact(fields: AuditFields): AuditFields {
  const safe: AuditFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (isRedactedKey(key)) continue;
    safe[key] = redactValue(value);
  }
  return safe;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (!value || typeof value !== "object") return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;

  const safe: AuditFields = {};
  for (const [key, nested] of Object.entries(value as AuditFields)) {
    if (isRedactedKey(key)) continue;
    safe[key] = redactValue(nested);
  }
  return safe;
}

export function createMemoryAuditSink(): AuditSink & {
  records: AuditRecord[];
} {
  const records: AuditRecord[] = [];
  return {
    records,
    write(record) {
      records.push(record);
    },
  };
}

function createFileSink(path: string): AuditSink {
  mkdirSync(dirname(path), { recursive: true });
  return {
    write(record) {
      // appendFileSync returns only once the write(2) completes, so records are
      // already durable by the time write() returns; flush has nothing to drain.
      appendFileSync(path, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    },
  };
}

function createStderrSink(): AuditSink {
  return {
    write(record) {
      process.stderr.write(`${JSON.stringify(record)}\n`);
    },
    // In stdio mode stderr is a pipe, so writes queue asynchronously and are
    // lost if the process exits before they drain.
    flush: () =>
      new Promise<void>((resolve) => {
        if (process.stderr.write("")) {
          resolve();
          return;
        }
        process.stderr.once("drain", () => resolve());
      }),
  };
}

export function createAuditLogger(
  options: { sink?: AuditSink; path?: string } = {},
): AuditLogger {
  const sink =
    options.sink ??
    (options.path ? createFileSink(options.path) : createStderrSink());
  const sinkFlush = sink.flush;
  return {
    record(event, fields = {}) {
      sink.write({
        event,
        at: new Date().toISOString(),
        ...redact(fields),
      });
    },
    flush: sinkFlush ? () => sinkFlush.call(sink) : undefined,
  };
}

export const noopAuditLogger: AuditLogger = {
  record() {},
};

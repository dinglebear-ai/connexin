import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AuditEvent =
  | "runtime_started"
  | "runtime_closed"
  | "bridge_listening"
  | "bridge_connection_rejected"
  | "bridge_connected"
  | "bridge_disconnected"
  | "bridge_message_rejected"
  | "bridge_backpressure_closed"
  | "bridge_io_failed"
  | "session_opened"
  | "session_open_failed"
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
  | "ssh_start_failed";

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

export function createAuditRateLimiter(options: {
  maxEvents: number;
  windowMs: number;
  onSuppressed: () => void;
  now?: () => number;
}): AuditRateLimiter {
  const now = options.now ?? Date.now;
  let windowStartedAt = now();
  let eventCount = 0;
  let suppressionRecorded = false;

  return {
    record(writeDetailedRecord) {
      const currentTime = now();
      if (currentTime - windowStartedAt >= options.windowMs) {
        windowStartedAt = currentTime;
        eventCount = 0;
        suppressionRecorded = false;
      }
      if (eventCount < options.maxEvents) {
        eventCount += 1;
        writeDetailedRecord();
        return;
      }
      if (!suppressionRecorded) {
        suppressionRecorded = true;
        options.onSuppressed();
      }
    },
  };
}

const REDACTED_FIELD_PATTERN =
  /token|output|suggestedcommand|suggested_command/i;

function redact(fields: AuditFields): AuditFields {
  const safe: AuditFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED_FIELD_PATTERN.test(key)) continue;
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
    if (REDACTED_FIELD_PATTERN.test(key)) continue;
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
      appendFileSync(path, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    },
    async flush() {},
  };
}

function createStderrSink(): AuditSink {
  return {
    write(record) {
      process.stderr.write(`${JSON.stringify(record)}\n`);
    },
  };
}

export function createAuditLogger(
  options: { sink?: AuditSink; path?: string } = {},
): AuditLogger {
  const sink =
    options.sink ??
    (options.path ? createFileSink(options.path) : createStderrSink());
  return {
    record(event, fields = {}) {
      sink.write({
        event,
        at: new Date().toISOString(),
        ...redact(fields),
      });
    },
    flush: sink.flush,
  };
}

export const noopAuditLogger: AuditLogger = {
  record() {},
};

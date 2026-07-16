import { join } from "node:path";

export interface RuntimeConfig {
  maxSessions: number;
  maxDeviceLength: number;
  maxReasonLength: number;
  maxSuggestedCommandLength: number;
  maxScrollbackBytes: number;
  maxSubmitBytes: number;
  maxWsPayloadBytes: number;
  wsBufferedAmountLimitBytes: number;
  maxSessionAgeMs: number;
  idleGraceMs: number;
  cleanupIntervalMs: number;
  sshConfigPath: string;
  quickShellConfigPath: string;
  auditLogPath?: string;
  httpToken?: string;
  allowedOrigins: string[];
  bridgeHost: string;
  bridgePort: number;
  bridgePublicUrl?: string;
}

const DEFAULTS = {
  maxSessions: 4,
  maxDeviceLength: 128,
  maxReasonLength: 1000,
  maxSuggestedCommandLength: 4000,
  maxScrollbackBytes: 128_000,
  maxSubmitBytes: 64_000,
  maxWsPayloadBytes: 16_384,
  wsBufferedAmountLimitBytes: 1_000 * 1_000,
  maxSessionAgeMs: 30 * 60_000,
  idleGraceMs: 5 * 60_000,
  cleanupIntervalMs: 30_000,
} as const;

function numberFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive number`);
  }

  return parsed;
}

function portFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`${key} must be a TCP port between 0 and 65535`);
  }

  return parsed;
}

function optionalBaseUrl(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${key} must start with http:// or https://`);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function defaultSshConfigPath(env: NodeJS.ProcessEnv): string {
  return env.QUICK_SHELL_SSH_CONFIG ?? join(env.HOME ?? process.cwd(), ".ssh", "config");
}

function defaultQuickShellConfigPath(env: NodeJS.ProcessEnv): string {
  return env.QUICK_SHELL_CONFIG ?? join(env.HOME ?? process.cwd(), ".config", "quick-shell", "quick-shell.toml");
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    maxSessions: numberFromEnv(env, "QUICK_SHELL_MAX_SESSIONS", DEFAULTS.maxSessions),
    maxDeviceLength: numberFromEnv(env, "QUICK_SHELL_MAX_DEVICE_LENGTH", DEFAULTS.maxDeviceLength),
    maxReasonLength: numberFromEnv(env, "QUICK_SHELL_MAX_REASON_LENGTH", DEFAULTS.maxReasonLength),
    maxSuggestedCommandLength: numberFromEnv(
      env,
      "QUICK_SHELL_MAX_SUGGESTED_COMMAND_LENGTH",
      DEFAULTS.maxSuggestedCommandLength,
    ),
    maxScrollbackBytes: numberFromEnv(env, "QUICK_SHELL_MAX_SCROLLBACK_BYTES", DEFAULTS.maxScrollbackBytes),
    maxSubmitBytes: numberFromEnv(env, "QUICK_SHELL_MAX_SUBMIT_BYTES", DEFAULTS.maxSubmitBytes),
    maxWsPayloadBytes: numberFromEnv(env, "QUICK_SHELL_MAX_WS_PAYLOAD_BYTES", DEFAULTS.maxWsPayloadBytes),
    wsBufferedAmountLimitBytes: numberFromEnv(
      env,
      "QUICK_SHELL_WS_BUFFERED_AMOUNT_LIMIT_BYTES",
      DEFAULTS.wsBufferedAmountLimitBytes,
    ),
    maxSessionAgeMs: numberFromEnv(env, "QUICK_SHELL_MAX_SESSION_AGE_MS", DEFAULTS.maxSessionAgeMs),
    idleGraceMs: numberFromEnv(env, "QUICK_SHELL_IDLE_GRACE_MS", DEFAULTS.idleGraceMs),
    cleanupIntervalMs: numberFromEnv(env, "QUICK_SHELL_CLEANUP_INTERVAL_MS", DEFAULTS.cleanupIntervalMs),
    sshConfigPath: defaultSshConfigPath(env),
    quickShellConfigPath: defaultQuickShellConfigPath(env),
    auditLogPath: env.QUICK_SHELL_AUDIT_LOG,
    httpToken: env.QUICK_SHELL_HTTP_TOKEN,
    allowedOrigins: (env.QUICK_SHELL_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    bridgeHost: env.QUICK_SHELL_BRIDGE_HOST?.trim() || "127.0.0.1",
    bridgePort: portFromEnv(env, "QUICK_SHELL_BRIDGE_PORT", 0),
    bridgePublicUrl: optionalBaseUrl(env, "QUICK_SHELL_BRIDGE_PUBLIC_URL"),
  };
}

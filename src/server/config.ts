import { join } from "node:path";

export interface RuntimeConfig {
  maxSessions: number;
  maxDeviceLength: number;
  maxReasonLength: number;
  maxSuggestedCommandLength: number;
  maxScrollbackBytes: number;
  maxInputBytes: number;
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
  maxInputBytes: 16_384,
  maxSubmitBytes: 64_000,
  maxWsPayloadBytes: 16_384,
  wsBufferedAmountLimitBytes: 1_000 * 1_000,
  maxSessionAgeMs: 30 * 60_000,
  idleGraceMs: 5 * 60_000,
  cleanupIntervalMs: 30_000,
} as const;

function numberFromEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive number`);
  }

  return parsed;
}

function portFromEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`${key} must be a TCP port between 0 and 65535`);
  }

  return parsed;
}

function parseHttpOrigin(raw: string, key: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${key} entries must be valid URL origins`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${key} entries must start with http:// or https://`);
  }
  // WHATWG URL accepts "*" inside hostnames, so a stray wildcard would
  // otherwise become a dead exact-match entry instead of a config error.
  if (parsed.origin.includes("*")) {
    throw new Error(
      `${key} entries may only use "*" as a full leading label (https://*.example.com)`,
    );
  }
  return parsed.origin;
}

const WILDCARD_ORIGIN_ENTRY = /^(https?):\/\/\*\.([^/]+)$/;

function parseAllowedOriginEntry(raw: string, key: string): string {
  const wildcard = WILDCARD_ORIGIN_ENTRY.exec(raw);
  if (!wildcard) return parseHttpOrigin(raw, key);
  const [, scheme, suffix] = wildcard;
  const base = parseHttpOrigin(`${scheme}://${suffix}`, key);
  return `${new URL(base).protocol}//*.${new URL(base).host}`;
}

function allowedOriginsFromEnv(env: NodeJS.ProcessEnv): string[] {
  return [
    ...new Set(
      (env.QUICK_SHELL_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
        .map((origin) =>
          parseAllowedOriginEntry(origin, "QUICK_SHELL_ALLOWED_ORIGINS"),
        ),
    ),
  ];
}

export function isOriginAllowed(
  allowedOrigins: readonly string[],
  requestOrigin: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(requestOrigin);
  } catch {
    return false;
  }
  const normalized = parsed.origin;
  for (const entry of allowedOrigins) {
    const wildcardAt = entry.indexOf("//*.");
    if (wildcardAt === -1) {
      if (entry === normalized) return true;
      continue;
    }
    if (`${parsed.protocol}//*.` !== entry.slice(0, wildcardAt + 4)) continue;
    const suffix = entry.slice(wildcardAt + 4);
    if (!parsed.host.endsWith(`.${suffix}`)) continue;
    const label = parsed.host.slice(0, -(suffix.length + 1));
    // Exactly one additional label: "a.example.com" matches *.example.com,
    // "a.b.example.com" and the bare "example.com" do not.
    if (label.length > 0 && !label.includes(".")) return true;
  }
  return false;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.startsWith("127.") ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function optionalBaseUrl(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${key} must start with http:// or https://`);
  }
  if (
    parsed.protocol === "http:" &&
    !isLoopbackHostname(parsed.hostname) &&
    env.QUICK_SHELL_ALLOW_INSECURE_PUBLIC_BRIDGE !== "1"
  ) {
    throw new Error(
      `${key} must use https:// for non-loopback hosts; set QUICK_SHELL_ALLOW_INSECURE_PUBLIC_BRIDGE=1 only for local development`,
    );
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(
      `${key} must not include a path prefix because quick-shell v1 proxies /terminal at the origin root`,
    );
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function defaultSshConfigPath(env: NodeJS.ProcessEnv): string {
  return (
    env.QUICK_SHELL_SSH_CONFIG ??
    join(env.HOME ?? process.cwd(), ".ssh", "config")
  );
}

function defaultQuickShellConfigPath(env: NodeJS.ProcessEnv): string {
  return (
    env.QUICK_SHELL_CONFIG ??
    join(
      env.HOME ?? process.cwd(),
      ".config",
      "quick-shell",
      "quick-shell.toml",
    )
  );
}

export function httpPortFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return portFromEnv(env, "QUICK_SHELL_HTTP_PORT", 0);
}

export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const allowedOrigins = allowedOriginsFromEnv(env);
  const bridgePublicUrl = optionalBaseUrl(env, "QUICK_SHELL_BRIDGE_PUBLIC_URL");
  if (bridgePublicUrl && allowedOrigins.length === 0) {
    throw new Error(
      "QUICK_SHELL_ALLOWED_ORIGINS must include at least one origin when QUICK_SHELL_BRIDGE_PUBLIC_URL is set",
    );
  }

  return {
    maxSessions: numberFromEnv(
      env,
      "QUICK_SHELL_MAX_SESSIONS",
      DEFAULTS.maxSessions,
    ),
    maxDeviceLength: numberFromEnv(
      env,
      "QUICK_SHELL_MAX_DEVICE_LENGTH",
      DEFAULTS.maxDeviceLength,
    ),
    maxReasonLength: numberFromEnv(
      env,
      "QUICK_SHELL_MAX_REASON_LENGTH",
      DEFAULTS.maxReasonLength,
    ),
    maxSuggestedCommandLength: numberFromEnv(
      env,
      "QUICK_SHELL_MAX_SUGGESTED_COMMAND_LENGTH",
      DEFAULTS.maxSuggestedCommandLength,
    ),
    maxScrollbackBytes: numberFromEnv(
      env,
      "QUICK_SHELL_MAX_SCROLLBACK_BYTES",
      DEFAULTS.maxScrollbackBytes,
    ),
    maxInputBytes: numberFromEnv(
      env,
      "QUICK_SHELL_MAX_INPUT_BYTES",
      DEFAULTS.maxInputBytes,
    ),
    maxSubmitBytes: numberFromEnv(
      env,
      "QUICK_SHELL_MAX_SUBMIT_BYTES",
      DEFAULTS.maxSubmitBytes,
    ),
    maxWsPayloadBytes: numberFromEnv(
      env,
      "QUICK_SHELL_MAX_WS_PAYLOAD_BYTES",
      DEFAULTS.maxWsPayloadBytes,
    ),
    wsBufferedAmountLimitBytes: numberFromEnv(
      env,
      "QUICK_SHELL_WS_BUFFERED_AMOUNT_LIMIT_BYTES",
      DEFAULTS.wsBufferedAmountLimitBytes,
    ),
    maxSessionAgeMs: numberFromEnv(
      env,
      "QUICK_SHELL_MAX_SESSION_AGE_MS",
      DEFAULTS.maxSessionAgeMs,
    ),
    idleGraceMs: numberFromEnv(
      env,
      "QUICK_SHELL_IDLE_GRACE_MS",
      DEFAULTS.idleGraceMs,
    ),
    cleanupIntervalMs: numberFromEnv(
      env,
      "QUICK_SHELL_CLEANUP_INTERVAL_MS",
      DEFAULTS.cleanupIntervalMs,
    ),
    sshConfigPath: defaultSshConfigPath(env),
    quickShellConfigPath: defaultQuickShellConfigPath(env),
    auditLogPath: env.QUICK_SHELL_AUDIT_LOG,
    httpToken: env.QUICK_SHELL_HTTP_TOKEN,
    allowedOrigins,
    bridgeHost: env.QUICK_SHELL_BRIDGE_HOST?.trim() || "127.0.0.1",
    bridgePort: portFromEnv(env, "QUICK_SHELL_BRIDGE_PORT", 0),
    bridgePublicUrl,
  };
}

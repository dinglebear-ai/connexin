import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  connexinConfigPath: string;
  auditLogPath?: string;
  httpToken?: string;
  allowedOrigins: string[];
  bridgeHost: string;
  bridgePort: number;
  bridgePublicUrl?: string;
  sftpHelperPath: string;
  maxFileEntries: number;
  maxFileMetadataBytes: number;
  maxFilePathBytes: number;
  maxFileComponentBytes: number;
  maxFilePathDepth: number;
  maxFileQueuedOperations: number;
  maxTransferBytes: number;
  maxEmbeddedDownloadBytes: number;
  fileOperationLeaseTtlMs: number;
  maxFileOperationLeases: number;
  fileMetadataTimeoutMs: number;
  fileTransferMaxDurationMs: number;
  fileShutdownTimeoutMs: number;
  /**
   * Refuse to mint a session (and its tokens) unless the client advertises MCP
   * Apps support. Defaults on. The escape hatch exists because this is a gate
   * on host-advertised capability: if a host renders apps correctly but does
   * not advertise the extension, setting CONNEXIN_REQUIRE_APP_HOST=0
   * restores the previous fail-open behaviour.
   */
  requireAppHost: boolean;
  /** File operations require a remotely enforced root (for example, chrooted internal-sftp). */
  fileRootConfinementEnforced: boolean;
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
  maxFileEntries: 1000,
  maxFileMetadataBytes: 512 * 1024,
  maxFilePathBytes: 4096,
  maxFileComponentBytes: 255,
  maxFilePathDepth: 64,
  maxFileQueuedOperations: 8,
  maxTransferBytes: 512 * 1024 * 1024,
  maxEmbeddedDownloadBytes: 8 * 1024 * 1024,
  requireAppHost: true,
  fileRootConfinementEnforced: false,
  fileOperationLeaseTtlMs: 60_000,
  maxFileOperationLeases: 16,
  fileMetadataTimeoutMs: 30_000,
  fileTransferMaxDurationMs: 30 * 60_000,
  fileShutdownTimeoutMs: 5_000,
} as const;

/** Only an explicit "0"/"false"/"no" disables; anything else keeps the default. */
function booleanFromEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean,
): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  throw new Error(`${key} must be a boolean`);
}

function numberFromEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
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
      (env.CONNEXIN_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
        .map((origin) =>
          parseAllowedOriginEntry(origin, "CONNEXIN_ALLOWED_ORIGINS"),
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
    env.CONNEXIN_ALLOW_INSECURE_PUBLIC_BRIDGE !== "1"
  ) {
    throw new Error(
      `${key} must use https:// for non-loopback hosts; set CONNEXIN_ALLOW_INSECURE_PUBLIC_BRIDGE=1 only for local development`,
    );
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(
      `${key} must not include a path prefix because connexin v1 proxies /terminal at the origin root`,
    );
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function defaultSshConfigPath(env: NodeJS.ProcessEnv): string {
  return (
    env.CONNEXIN_SSH_CONFIG ?? join(env.HOME ?? process.cwd(), ".ssh", "config")
  );
}

function defaultConnexinConfigPath(env: NodeJS.ProcessEnv): string {
  return (
    env.CONNEXIN_CONFIG ??
    join(env.HOME ?? process.cwd(), ".config", "connexin", "connexin.toml")
  );
}

const RUNTIME_ENV_KEYS = new Set([
  "CONNEXIN_MAX_SESSIONS",
  "CONNEXIN_MAX_DEVICE_LENGTH",
  "CONNEXIN_MAX_REASON_LENGTH",
  "CONNEXIN_MAX_SUGGESTED_COMMAND_LENGTH",
  "CONNEXIN_MAX_SCROLLBACK_BYTES",
  "CONNEXIN_MAX_INPUT_BYTES",
  "CONNEXIN_MAX_SUBMIT_BYTES",
  "CONNEXIN_MAX_WS_PAYLOAD_BYTES",
  "CONNEXIN_WS_BUFFERED_AMOUNT_LIMIT_BYTES",
  "CONNEXIN_MAX_SESSION_AGE_MS",
  "CONNEXIN_IDLE_GRACE_MS",
  "CONNEXIN_CLEANUP_INTERVAL_MS",
  "CONNEXIN_BRIDGE_HOST",
  "CONNEXIN_BRIDGE_PORT",
  "CONNEXIN_MAX_FILE_ENTRIES",
  "CONNEXIN_MAX_FILE_METADATA_BYTES",
  "CONNEXIN_MAX_FILE_PATH_BYTES",
  "CONNEXIN_MAX_FILE_COMPONENT_BYTES",
  "CONNEXIN_MAX_FILE_PATH_DEPTH",
  "CONNEXIN_MAX_FILE_QUEUED_OPERATIONS",
  "CONNEXIN_MAX_TRANSFER_BYTES",
  "CONNEXIN_MAX_EMBEDDED_DOWNLOAD_BYTES",
  "CONNEXIN_FILE_OPERATION_LEASE_TTL_MS",
  "CONNEXIN_MAX_FILE_OPERATION_LEASES",
  "CONNEXIN_FILE_METADATA_TIMEOUT_MS",
  "CONNEXIN_FILE_TRANSFER_MAX_DURATION_MS",
  "CONNEXIN_FILE_SHUTDOWN_TIMEOUT_MS",
  "CONNEXIN_REQUIRE_APP_HOST",
  "CONNEXIN_FILE_ROOT_CONFINEMENT_ENFORCED",
]);

function stripTomlComment(line: string): string {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index - 1] !== "\\") quoted = !quoted;
    if (!quoted && char === "#") return line.slice(0, index);
  }
  return line;
}

function parseRuntimeScalar(raw: string, lineNumber: number): string {
  if (!raw.startsWith('"')) return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "string") throw new Error("not a string");
    return parsed;
  } catch {
    throw new Error(
      `connexin.toml line ${lineNumber}: runtime strings must be valid quoted strings`,
    );
  }
}

/**
 * Runtime tuning lives in the optional `[runtime]` table of connexin.toml.
 * Environment variables are intentionally reserved for deployment-specific
 * paths, URLs, credentials, and one-off overrides.
 */
function runtimeEnvFromConfig(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const configPath = defaultConnexinConfigPath(env);
  let source: string;
  try {
    source = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return env;
    throw error;
  }
  const values: NodeJS.ProcessEnv = { ...env };
  const configEnvKeys = new Set<string>();
  let runtime = false;
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (line === "[runtime]") {
      runtime = true;
      continue;
    }
    if (line.startsWith("[")) {
      runtime = false;
      continue;
    }
    if (!runtime) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (!/^[a-z0-9_]+$/.test(key))
      throw new Error(`connexin.toml runtime key ${key} is invalid`);
    const value = parseRuntimeScalar(raw, lineNumber);
    const envKey = `CONNEXIN_${key.toUpperCase()}`;
    if (!RUNTIME_ENV_KEYS.has(envKey)) {
      throw new Error(
        `connexin.toml line ${lineNumber}: unknown runtime key ${key}`,
      );
    }
    if (configEnvKeys.has(envKey)) {
      throw new Error(
        `connexin.toml line ${lineNumber}: duplicate runtime key ${key}`,
      );
    }
    configEnvKeys.add(envKey);
    if (values[envKey] === undefined) values[envKey] = String(value);
  }
  return values;
}

export function defaultSftpHelperPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.CONNEXIN_SFTP_HELPER?.trim()) return env.CONNEXIN_SFTP_HELPER.trim();
  // Must match helperDestination() in scripts/sftp-helper-target.mjs: the
  // installer writes connexin-sftp.exe on Windows, and looking for the
  // extensionless name there would report the helper as permanently missing.
  const binary = platform === "win32" ? "connexin-sftp.exe" : "connexin-sftp";
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return moduleDir.includes(`${join("dist", "server", "server")}`)
    ? resolve(moduleDir, "../../bin", binary)
    : resolve(moduleDir, "../../dist/bin", binary);
}

export function httpPortFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return portFromEnv(env, "CONNEXIN_HTTP_PORT", 0);
}

export function loadRuntimeConfig(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const env = runtimeEnvFromConfig(sourceEnv);
  const allowedOrigins = allowedOriginsFromEnv(env);
  const bridgePublicUrl = optionalBaseUrl(env, "CONNEXIN_BRIDGE_PUBLIC_URL");
  if (bridgePublicUrl && allowedOrigins.length === 0) {
    throw new Error(
      "CONNEXIN_ALLOWED_ORIGINS must include at least one origin when CONNEXIN_BRIDGE_PUBLIC_URL is set",
    );
  }

  return {
    maxSessions: numberFromEnv(
      env,
      "CONNEXIN_MAX_SESSIONS",
      DEFAULTS.maxSessions,
    ),
    maxDeviceLength: numberFromEnv(
      env,
      "CONNEXIN_MAX_DEVICE_LENGTH",
      DEFAULTS.maxDeviceLength,
    ),
    maxReasonLength: numberFromEnv(
      env,
      "CONNEXIN_MAX_REASON_LENGTH",
      DEFAULTS.maxReasonLength,
    ),
    maxSuggestedCommandLength: numberFromEnv(
      env,
      "CONNEXIN_MAX_SUGGESTED_COMMAND_LENGTH",
      DEFAULTS.maxSuggestedCommandLength,
    ),
    maxScrollbackBytes: numberFromEnv(
      env,
      "CONNEXIN_MAX_SCROLLBACK_BYTES",
      DEFAULTS.maxScrollbackBytes,
    ),
    maxInputBytes: numberFromEnv(
      env,
      "CONNEXIN_MAX_INPUT_BYTES",
      DEFAULTS.maxInputBytes,
    ),
    maxSubmitBytes: numberFromEnv(
      env,
      "CONNEXIN_MAX_SUBMIT_BYTES",
      DEFAULTS.maxSubmitBytes,
    ),
    maxWsPayloadBytes: numberFromEnv(
      env,
      "CONNEXIN_MAX_WS_PAYLOAD_BYTES",
      DEFAULTS.maxWsPayloadBytes,
    ),
    wsBufferedAmountLimitBytes: numberFromEnv(
      env,
      "CONNEXIN_WS_BUFFERED_AMOUNT_LIMIT_BYTES",
      DEFAULTS.wsBufferedAmountLimitBytes,
    ),
    maxSessionAgeMs: numberFromEnv(
      env,
      "CONNEXIN_MAX_SESSION_AGE_MS",
      DEFAULTS.maxSessionAgeMs,
    ),
    idleGraceMs: numberFromEnv(
      env,
      "CONNEXIN_IDLE_GRACE_MS",
      DEFAULTS.idleGraceMs,
    ),
    cleanupIntervalMs: numberFromEnv(
      env,
      "CONNEXIN_CLEANUP_INTERVAL_MS",
      DEFAULTS.cleanupIntervalMs,
    ),
    sshConfigPath: defaultSshConfigPath(env),
    connexinConfigPath: defaultConnexinConfigPath(env),
    auditLogPath: env.CONNEXIN_AUDIT_LOG,
    httpToken: env.CONNEXIN_HTTP_TOKEN,
    allowedOrigins,
    bridgeHost: env.CONNEXIN_BRIDGE_HOST?.trim() || "127.0.0.1",
    bridgePort: portFromEnv(env, "CONNEXIN_BRIDGE_PORT", 0),
    bridgePublicUrl,
    sftpHelperPath: defaultSftpHelperPath(env),
    maxFileEntries: numberFromEnv(
      env,
      "CONNEXIN_MAX_FILE_ENTRIES",
      DEFAULTS.maxFileEntries,
    ),
    maxFileMetadataBytes: numberFromEnv(
      env,
      "CONNEXIN_MAX_FILE_METADATA_BYTES",
      DEFAULTS.maxFileMetadataBytes,
    ),
    maxFilePathBytes: numberFromEnv(
      env,
      "CONNEXIN_MAX_FILE_PATH_BYTES",
      DEFAULTS.maxFilePathBytes,
    ),
    maxFileComponentBytes: numberFromEnv(
      env,
      "CONNEXIN_MAX_FILE_COMPONENT_BYTES",
      DEFAULTS.maxFileComponentBytes,
    ),
    maxFilePathDepth: numberFromEnv(
      env,
      "CONNEXIN_MAX_FILE_PATH_DEPTH",
      DEFAULTS.maxFilePathDepth,
    ),
    maxFileQueuedOperations: numberFromEnv(
      env,
      "CONNEXIN_MAX_FILE_QUEUED_OPERATIONS",
      DEFAULTS.maxFileQueuedOperations,
    ),
    maxTransferBytes: numberFromEnv(
      env,
      "CONNEXIN_MAX_TRANSFER_BYTES",
      DEFAULTS.maxTransferBytes,
    ),
    maxEmbeddedDownloadBytes: numberFromEnv(
      env,
      "CONNEXIN_MAX_EMBEDDED_DOWNLOAD_BYTES",
      DEFAULTS.maxEmbeddedDownloadBytes,
    ),
    requireAppHost: booleanFromEnv(
      env,
      "CONNEXIN_REQUIRE_APP_HOST",
      DEFAULTS.requireAppHost,
    ),
    fileRootConfinementEnforced: booleanFromEnv(
      env,
      "CONNEXIN_FILE_ROOT_CONFINEMENT_ENFORCED",
      DEFAULTS.fileRootConfinementEnforced,
    ),
    fileOperationLeaseTtlMs: numberFromEnv(
      env,
      "CONNEXIN_FILE_OPERATION_LEASE_TTL_MS",
      DEFAULTS.fileOperationLeaseTtlMs,
    ),
    maxFileOperationLeases: numberFromEnv(
      env,
      "CONNEXIN_MAX_FILE_OPERATION_LEASES",
      DEFAULTS.maxFileOperationLeases,
    ),
    fileMetadataTimeoutMs: numberFromEnv(
      env,
      "CONNEXIN_FILE_METADATA_TIMEOUT_MS",
      DEFAULTS.fileMetadataTimeoutMs,
    ),
    fileTransferMaxDurationMs: numberFromEnv(
      env,
      "CONNEXIN_FILE_TRANSFER_MAX_DURATION_MS",
      DEFAULTS.fileTransferMaxDurationMs,
    ),
    fileShutdownTimeoutMs: numberFromEnv(
      env,
      "CONNEXIN_FILE_SHUTDOWN_TIMEOUT_MS",
      DEFAULTS.fileShutdownTimeoutMs,
    ),
  };
}

import type { RuntimeConfig } from "../../../src/server/config.js";

export function testRuntimeConfig(
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
  return {
    maxSessions: 4,
    maxDeviceLength: 128,
    maxReasonLength: 1000,
    maxSuggestedCommandLength: 4000,
    maxScrollbackBytes: 128_000,
    maxInputBytes: 16_384,
    maxSubmitBytes: 64_000,
    maxWsPayloadBytes: 16_384,
    wsBufferedAmountLimitBytes: 1_000_000,
    maxSessionAgeMs: 30 * 60_000,
    idleGraceMs: 5 * 60_000,
    cleanupIntervalMs: 30_000,
    sshConfigPath: "/tmp/config",
    quickShellConfigPath: "/tmp/quick-shell.toml",
    auditLogPath: undefined,
    allowedOrigins: [],
    bridgeHost: "127.0.0.1",
    bridgePort: 0,
    bridgePublicUrl: undefined,
    ...overrides,
  };
}

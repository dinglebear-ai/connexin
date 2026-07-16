import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/server/config.js";

describe("loadRuntimeConfig", () => {
  it("loads numeric overrides", () => {
    expect(loadRuntimeConfig({ QUICK_SHELL_MAX_SESSIONS: "3" }).maxSessions).toBe(3);
  });

  it("loads HTTP bearer token", () => {
    expect(loadRuntimeConfig({ QUICK_SHELL_HTTP_TOKEN: "secret" }).httpToken).toBe("secret");
  });

  it("rejects invalid numeric overrides", () => {
    expect(() => loadRuntimeConfig({ QUICK_SHELL_MAX_SESSIONS: "0" })).toThrow("positive number");
    expect(() => loadRuntimeConfig({ QUICK_SHELL_MAX_SESSIONS: "nope" })).toThrow("positive number");
  });

  it("parses allowed origins", () => {
    expect(
      loadRuntimeConfig({
        QUICK_SHELL_ALLOWED_ORIGINS: " https://one.example,https://two.example ,, ",
      }).allowedOrigins,
    ).toEqual(["https://one.example", "https://two.example"]);
  });

  it("loads bridge listen and public URL settings", () => {
    expect(
      loadRuntimeConfig({
        QUICK_SHELL_BRIDGE_HOST: "0.0.0.0",
        QUICK_SHELL_BRIDGE_PORT: "48765",
        QUICK_SHELL_BRIDGE_PUBLIC_URL: "https://quick-shell.example/",
      }),
    ).toMatchObject({
      bridgeHost: "0.0.0.0",
      bridgePort: 48765,
      bridgePublicUrl: "https://quick-shell.example",
    });
  });

  it("rejects invalid bridge ports and public URL schemes", () => {
    expect(() => loadRuntimeConfig({ QUICK_SHELL_BRIDGE_PORT: "70000" })).toThrow("TCP port");
    expect(() => loadRuntimeConfig({ QUICK_SHELL_BRIDGE_PUBLIC_URL: "ftp://quick-shell.example" })).toThrow(
      "http:// or https://",
    );
  });
});

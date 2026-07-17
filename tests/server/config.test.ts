import { describe, expect, it } from "vitest";
import {
  httpPortFromEnv,
  isOriginAllowed,
  loadRuntimeConfig,
} from "../../src/server/config.js";

describe("loadRuntimeConfig", () => {
  it("loads numeric overrides", () => {
    expect(
      loadRuntimeConfig({ QUICK_SHELL_MAX_SESSIONS: "3" }).maxSessions,
    ).toBe(3);
  });

  it("loads HTTP bearer token", () => {
    expect(
      loadRuntimeConfig({ QUICK_SHELL_HTTP_TOKEN: "secret" }).httpToken,
    ).toBe("secret");
  });

  it("rejects invalid numeric overrides", () => {
    expect(() => loadRuntimeConfig({ QUICK_SHELL_MAX_SESSIONS: "0" })).toThrow(
      "positive number",
    );
    expect(() =>
      loadRuntimeConfig({ QUICK_SHELL_MAX_SESSIONS: "nope" }),
    ).toThrow("positive number");
  });

  it("parses allowed origins", () => {
    expect(
      loadRuntimeConfig({
        QUICK_SHELL_ALLOWED_ORIGINS:
          " https://one.example/,https://two.example/path ,, ",
      }).allowedOrigins,
    ).toEqual(["https://one.example", "https://two.example"]);
  });

  it("parses wildcard subdomain origin entries", () => {
    expect(
      loadRuntimeConfig({
        QUICK_SHELL_ALLOWED_ORIGINS:
          "https://*.claudemcpcontent.com,https://claude.ai",
      }).allowedOrigins,
    ).toEqual(["https://*.claudemcpcontent.com", "https://claude.ai"]);
    expect(
      loadRuntimeConfig({
        QUICK_SHELL_ALLOWED_ORIGINS: "http://*.local.example:8080",
      }).allowedOrigins,
    ).toEqual(["http://*.local.example:8080"]);
  });

  it("rejects wildcards that are not a full leading label", () => {
    for (const entry of [
      "https://a.*.example.com",
      "https://*example.com",
      "https://*",
      "https://*.",
    ]) {
      expect(() =>
        loadRuntimeConfig({ QUICK_SHELL_ALLOWED_ORIGINS: entry }),
      ).toThrow();
    }
  });

  it("loads bridge listen and public URL settings", () => {
    expect(
      loadRuntimeConfig({
        QUICK_SHELL_BRIDGE_HOST: "0.0.0.0",
        QUICK_SHELL_BRIDGE_PORT: "48765",
        QUICK_SHELL_BRIDGE_PUBLIC_URL: "https://quick-shell.example/",
        QUICK_SHELL_ALLOWED_ORIGINS: "https://chatgpt.com",
      }),
    ).toMatchObject({
      bridgeHost: "0.0.0.0",
      bridgePort: 48765,
      bridgePublicUrl: "https://quick-shell.example",
    });
  });

  it("rejects invalid bridge ports and public URL schemes", () => {
    expect(() =>
      loadRuntimeConfig({ QUICK_SHELL_BRIDGE_PORT: "70000" }),
    ).toThrow("TCP port");
    expect(() => httpPortFromEnv({ QUICK_SHELL_HTTP_PORT: "-1" })).toThrow(
      "TCP port",
    );
    expect(() =>
      loadRuntimeConfig({
        QUICK_SHELL_BRIDGE_PUBLIC_URL: "ftp://quick-shell.example",
      }),
    ).toThrow("http:// or https://");
    expect(() =>
      loadRuntimeConfig({ QUICK_SHELL_ALLOWED_ORIGINS: "not a url" }),
    ).toThrow("valid URL origins");
  });

  it("requires TLS for non-loopback public bridge URLs", () => {
    expect(() =>
      loadRuntimeConfig({
        QUICK_SHELL_BRIDGE_PUBLIC_URL: "http://quick-shell.example",
        QUICK_SHELL_ALLOWED_ORIGINS: "https://chatgpt.com",
      }),
    ).toThrow("must use https://");
    expect(
      loadRuntimeConfig({
        QUICK_SHELL_BRIDGE_PUBLIC_URL: "http://127.0.0.1:40123",
        QUICK_SHELL_ALLOWED_ORIGINS: "https://chatgpt.com",
      }).bridgePublicUrl,
    ).toBe("http://127.0.0.1:40123");
    expect(
      loadRuntimeConfig({
        QUICK_SHELL_BRIDGE_PUBLIC_URL: "http://quick-shell.example",
        QUICK_SHELL_ALLOWED_ORIGINS: "https://chatgpt.com",
        QUICK_SHELL_ALLOW_INSECURE_PUBLIC_BRIDGE: "1",
      }).bridgePublicUrl,
    ).toBe("http://quick-shell.example");
  });

  it("requires explicit allowed origins when a public bridge URL is configured", () => {
    expect(() =>
      loadRuntimeConfig({
        QUICK_SHELL_BRIDGE_PUBLIC_URL: "https://quick-shell.example",
      }),
    ).toThrow("QUICK_SHELL_ALLOWED_ORIGINS");
  });

  it("rejects public bridge URL path prefixes", () => {
    expect(() =>
      loadRuntimeConfig({
        QUICK_SHELL_BRIDGE_PUBLIC_URL: "https://quick-shell.example/prefix/",
        QUICK_SHELL_ALLOWED_ORIGINS: "https://chatgpt.com",
      }),
    ).toThrow(
      "QUICK_SHELL_BRIDGE_PUBLIC_URL must not include a path prefix because quick-shell v1 proxies /terminal at the origin root",
    );
  });
});

describe("isOriginAllowed", () => {
  const allowed = ["https://*.claudemcpcontent.com", "https://claude.ai"];

  it("matches exact origins", () => {
    expect(isOriginAllowed(allowed, "https://claude.ai")).toBe(true);
    expect(isOriginAllowed(allowed, "https://claude.ai/")).toBe(true);
    expect(isOriginAllowed(allowed, "https://evil.example")).toBe(false);
  });

  it("matches exactly one subdomain label under a wildcard entry", () => {
    expect(
      isOriginAllowed(
        allowed,
        "https://9a87468183112cbe85de8e92775f197d.claudemcpcontent.com",
      ),
    ).toBe(true);
    expect(isOriginAllowed(allowed, "https://claudemcpcontent.com")).toBe(
      false,
    );
    expect(isOriginAllowed(allowed, "https://a.b.claudemcpcontent.com")).toBe(
      false,
    );
    expect(isOriginAllowed(allowed, "https://evilclaudemcpcontent.com")).toBe(
      false,
    );
  });

  it("requires scheme and port to match wildcard entries", () => {
    expect(isOriginAllowed(allowed, "http://abc.claudemcpcontent.com")).toBe(
      false,
    );
    expect(
      isOriginAllowed(allowed, "https://abc.claudemcpcontent.com:8443"),
    ).toBe(false);
    expect(
      isOriginAllowed(
        ["http://*.local.example:8080"],
        "http://a.local.example:8080",
      ),
    ).toBe(true);
    expect(
      isOriginAllowed(
        ["http://*.local.example:8080"],
        "http://a.local.example",
      ),
    ).toBe(false);
  });

  it("rejects malformed request origins", () => {
    expect(isOriginAllowed(allowed, "null")).toBe(false);
    expect(isOriginAllowed(allowed, "")).toBe(false);
    expect(isOriginAllowed(allowed, "claudemcpcontent.com")).toBe(false);
  });
});

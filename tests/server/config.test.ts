import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  httpPortFromEnv,
  isOriginAllowed,
  loadRuntimeConfig,
} from "../../src/server/config.js";

describe("loadRuntimeConfig", () => {
  it("loads numeric overrides", () => {
    expect(loadRuntimeConfig({ CONNEXIN_MAX_SESSIONS: "3" }).maxSessions).toBe(
      3,
    );
  });

  it("loads HTTP bearer token", () => {
    expect(loadRuntimeConfig({ CONNEXIN_HTTP_TOKEN: "secret" }).httpToken).toBe(
      "secret",
    );
  });

  it("loads runtime tuning from connexin.toml and lets explicit environment overrides win", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connexin-config-"));
    const path = join(directory, "connexin.toml");
    await writeFile(
      path,
      '[runtime]\nmax_sessions = 9\nbridge_host = "0.0.0.0" # proxy listener\nrequire_app_host = false\n',
    );

    try {
      expect(loadRuntimeConfig({ CONNEXIN_CONFIG: path })).toMatchObject({
        maxSessions: 9,
        bridgeHost: "0.0.0.0",
        requireAppHost: false,
      });
      expect(
        loadRuntimeConfig({
          CONNEXIN_CONFIG: path,
          CONNEXIN_MAX_SESSIONS: "2",
        }).maxSessions,
      ).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unknown runtime keys instead of silently ignoring a typo", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connexin-config-"));
    const path = join(directory, "connexin.toml");
    await writeFile(path, "[runtime]\nmax_sesions = 3\n");

    try {
      expect(() => loadRuntimeConfig({ CONNEXIN_CONFIG: path })).toThrow(
        "unknown runtime key max_sesions",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects duplicate runtime keys even when an environment override exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connexin-config-"));
    const path = join(directory, "connexin.toml");
    await writeFile(
      path,
      "[runtime]\nrequire_app_host = false\nrequire_app_host = true\n",
    );

    try {
      expect(() =>
        loadRuntimeConfig({
          CONNEXIN_CONFIG: path,
          CONNEXIN_REQUIRE_APP_HOST: "true",
        }),
      ).toThrow("duplicate runtime key require_app_host");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("defaults file operations to server-enforced confinement", () => {
    expect(loadRuntimeConfig({}).fileRootConfinementEnforced).toBe(false);
    expect(
      loadRuntimeConfig({ CONNEXIN_FILE_ROOT_CONFINEMENT_ENFORCED: "1" })
        .fileRootConfinementEnforced,
    ).toBe(true);
  });

  it("rejects invalid numeric overrides", () => {
    expect(() => loadRuntimeConfig({ CONNEXIN_MAX_SESSIONS: "0" })).toThrow(
      "positive integer",
    );
    expect(() => loadRuntimeConfig({ CONNEXIN_MAX_SESSIONS: "nope" })).toThrow(
      "positive integer",
    );
    expect(() => loadRuntimeConfig({ CONNEXIN_MAX_SESSIONS: "1.5" })).toThrow(
      "positive integer",
    );
  });

  it("parses allowed origins", () => {
    expect(
      loadRuntimeConfig({
        CONNEXIN_ALLOWED_ORIGINS:
          " https://one.example/,https://two.example/path ,, ",
      }).allowedOrigins,
    ).toEqual(["https://one.example", "https://two.example"]);
  });

  it("parses wildcard subdomain origin entries", () => {
    expect(
      loadRuntimeConfig({
        CONNEXIN_ALLOWED_ORIGINS:
          "https://*.claudemcpcontent.com,https://claude.ai",
      }).allowedOrigins,
    ).toEqual(["https://*.claudemcpcontent.com", "https://claude.ai"]);
    expect(
      loadRuntimeConfig({
        CONNEXIN_ALLOWED_ORIGINS: "http://*.local.example:8080",
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
        loadRuntimeConfig({ CONNEXIN_ALLOWED_ORIGINS: entry }),
      ).toThrow();
    }
  });

  it("loads bridge listen and public URL settings", () => {
    expect(
      loadRuntimeConfig({
        CONNEXIN_BRIDGE_HOST: "0.0.0.0",
        CONNEXIN_BRIDGE_PORT: "48765",
        CONNEXIN_BRIDGE_PUBLIC_URL: "https://connexin.example/",
        CONNEXIN_ALLOWED_ORIGINS: "https://chatgpt.com",
      }),
    ).toMatchObject({
      bridgeHost: "0.0.0.0",
      bridgePort: 48765,
      bridgePublicUrl: "https://connexin.example",
    });
  });

  it("rejects invalid bridge ports and public URL schemes", () => {
    expect(() => loadRuntimeConfig({ CONNEXIN_BRIDGE_PORT: "70000" })).toThrow(
      "TCP port",
    );
    expect(() => httpPortFromEnv({ CONNEXIN_HTTP_PORT: "-1" })).toThrow(
      "TCP port",
    );
    expect(() =>
      loadRuntimeConfig({
        CONNEXIN_BRIDGE_PUBLIC_URL: "ftp://connexin.example",
      }),
    ).toThrow("http:// or https://");
    expect(() =>
      loadRuntimeConfig({ CONNEXIN_ALLOWED_ORIGINS: "not a url" }),
    ).toThrow("valid URL origins");
  });

  it("requires TLS for non-loopback public bridge URLs", () => {
    expect(() =>
      loadRuntimeConfig({
        CONNEXIN_BRIDGE_PUBLIC_URL: "http://connexin.example",
        CONNEXIN_ALLOWED_ORIGINS: "https://chatgpt.com",
      }),
    ).toThrow("must use https://");
    expect(
      loadRuntimeConfig({
        CONNEXIN_BRIDGE_PUBLIC_URL: "http://127.0.0.1:40123",
        CONNEXIN_ALLOWED_ORIGINS: "https://chatgpt.com",
      }).bridgePublicUrl,
    ).toBe("http://127.0.0.1:40123");
    expect(
      loadRuntimeConfig({
        CONNEXIN_BRIDGE_PUBLIC_URL: "http://connexin.example",
        CONNEXIN_ALLOWED_ORIGINS: "https://chatgpt.com",
        CONNEXIN_ALLOW_INSECURE_PUBLIC_BRIDGE: "1",
      }).bridgePublicUrl,
    ).toBe("http://connexin.example");
  });

  it("requires explicit allowed origins when a public bridge URL is configured", () => {
    expect(() =>
      loadRuntimeConfig({
        CONNEXIN_BRIDGE_PUBLIC_URL: "https://connexin.example",
      }),
    ).toThrow("CONNEXIN_ALLOWED_ORIGINS");
  });

  it("rejects public bridge URL path prefixes", () => {
    expect(() =>
      loadRuntimeConfig({
        CONNEXIN_BRIDGE_PUBLIC_URL: "https://connexin.example/prefix/",
        CONNEXIN_ALLOWED_ORIGINS: "https://chatgpt.com",
      }),
    ).toThrow(
      "CONNEXIN_BRIDGE_PUBLIC_URL must not include a path prefix because connexin v1 proxies /terminal at the origin root",
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

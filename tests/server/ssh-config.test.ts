import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAllowedSshHosts, parseSshConfigHosts } from "../../src/server/ssh-config.js";

describe("parseSshConfigHosts", () => {
  it("returns explicit host aliases", () => {
    expect(parseSshConfigHosts("Host fileserver devbox\n  HostName 192.0.2.10\n")).toEqual([
      "fileserver",
      "devbox",
    ]);
  });

  it("excludes wildcard and negated aliases", () => {
    expect(parseSshConfigHosts("Host *\nHost prod-*\nHost !blocked good\n")).toEqual(["good"]);
  });

  it("does not treat inline comments as aliases", () => {
    expect(parseSshConfigHosts("Host prod # production box\n  HostName 192.0.2.10\n")).toEqual(["prod"]);
  });

  it("rejects host aliases that use local-exec SSH directives", () => {
    expect(() => parseSshConfigHosts("Host jumpy\n  ProxyCommand nc %h %p\n")).toThrow(
      "Host jumpy uses unsupported ProxyCommand",
    );
    expect(() => parseSshConfigHosts("Host run-local\n  PermitLocalCommand yes\n")).toThrow(
      "Host run-local uses unsupported PermitLocalCommand",
    );
  });

  it("rejects Match exec blocks because ssh evaluates them locally", () => {
    expect(() => parseSshConfigHosts("Host safe\n  HostName 127.0.0.1\nMatch exec \"test -f ~/.flag\"\n")).toThrow(
      "Match exec is unsupported",
    );
  });

  it("rejects global local-exec directives before host blocks", () => {
    expect(() => parseSshConfigHosts("ProxyCommand nc %h %p\nHost safe\n  HostName 127.0.0.1\n")).toThrow(
      "global scope uses unsupported ProxyCommand",
    );
  });

  it("loads aliases from Include globs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quick-shell-ssh-"));
    await mkdir(join(dir, "config.d"));
    await writeFile(join(dir, "config"), "Host root\nInclude config.d/*\n");
    await writeFile(join(dir, "config.d", "hosts"), "Host included\n  HostName 127.0.0.1\n");

    await expect(loadAllowedSshHosts(join(dir, "config"))).resolves.toEqual(new Set(["root", "included"]));
  });

  it("fails when the primary SSH config cannot be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quick-shell-ssh-"));

    await expect(loadAllowedSshHosts(join(dir, "missing"))).rejects.toThrow("Unable to read SSH config");
  });
});

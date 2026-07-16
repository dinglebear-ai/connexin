import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSshCommandArgs,
  loadAllowedSshHosts,
  parseSshConfigHosts,
} from "../../src/server/ssh-config.js";

describe("parseSshConfigHosts", () => {
  it("returns explicit host aliases", () => {
    expect(
      parseSshConfigHosts("Host fileserver devbox\n  HostName 192.0.2.10\n"),
    ).toEqual(["fileserver", "devbox"]);
  });

  it("accepts OpenSSH keyword=value syntax", () => {
    expect(
      parseSshConfigHosts("Host=fileserver\n  HostName=192.0.2.10\n"),
    ).toEqual(["fileserver"]);
    expect(
      parseSshConfigHosts("Host = devbox\n  HostName = 192.0.2.11\n"),
    ).toEqual(["devbox"]);
  });

  it("excludes wildcard and negated aliases", () => {
    expect(
      parseSshConfigHosts("Host *\nHost prod-*\nHost !blocked good\n"),
    ).toEqual(["good"]);
  });

  it("does not treat inline comments as aliases", () => {
    expect(
      parseSshConfigHosts(
        "Host prod # production box\n  HostName 192.0.2.10\n",
      ),
    ).toEqual(["prod"]);
  });

  it("rejects host aliases that use local-exec SSH directives", () => {
    expect(() =>
      parseSshConfigHosts("Host jumpy\n  ProxyCommand nc %h %p\n"),
    ).toThrow("Host jumpy uses unsupported ProxyCommand");
    expect(() =>
      parseSshConfigHosts("Host jumpy\n  ProxyCommand=nc %h %p\n"),
    ).toThrow("Host jumpy uses unsupported ProxyCommand");
    expect(() =>
      parseSshConfigHosts("Host jumpy\n  ProxyCommand = nc %h %p\n"),
    ).toThrow("Host jumpy uses unsupported ProxyCommand");
    expect(() =>
      parseSshConfigHosts("Host hostkey\n  KnownHostsCommand lookup-host %h\n"),
    ).toThrow("Host hostkey uses unsupported KnownHostsCommand");
    expect(() =>
      parseSshConfigHosts("Host run-local\n  PermitLocalCommand yes\n"),
    ).toThrow("Host run-local uses unsupported PermitLocalCommand");
    expect(() =>
      parseSshConfigHosts("Host run-local\n  PermitLocalCommand=yes\n"),
    ).toThrow("Host run-local uses unsupported PermitLocalCommand");
  });

  it("rejects host aliases that auto-run a remote command", () => {
    expect(() =>
      parseSshConfigHosts("Host auto-run\n  RemoteCommand uptime\n"),
    ).toThrow("Host auto-run uses unsupported RemoteCommand");
    expect(() =>
      parseSshConfigHosts("Host auto-run\n  RemoteCommand=uptime\n"),
    ).toThrow("Host auto-run uses unsupported RemoteCommand");
  });

  it("builds ssh arguments with the same config path used for validation", () => {
    expect(
      buildSshCommandArgs("/tmp/quick-shell-ssh-config", "fileserver"),
    ).toEqual(["-F", "/tmp/quick-shell-ssh-config", "fileserver"]);
  });

  it("rejects Match exec blocks because ssh evaluates them locally", () => {
    expect(() =>
      parseSshConfigHosts(
        'Host safe\n  HostName 127.0.0.1\nMatch exec "test -f ~/.flag"\n',
      ),
    ).toThrow("Match exec is unsupported");
    expect(() =>
      parseSshConfigHosts(
        'Host safe\n  HostName 127.0.0.1\nMatch=exec "test -f ~/.flag"\n',
      ),
    ).toThrow("Match exec is unsupported");
    expect(() =>
      parseSshConfigHosts(
        'Host safe\n  HostName 127.0.0.1\nMatch !exec "test -f ~/.flag"\n',
      ),
    ).toThrow("Match exec is unsupported");
    expect(() =>
      parseSshConfigHosts(
        'Host safe\n  HostName 127.0.0.1\nMatch !exec="test -f ~/.flag"\n',
      ),
    ).toThrow("Match exec is unsupported");
  });

  it("rejects global local-exec directives before host blocks", () => {
    expect(() =>
      parseSshConfigHosts(
        "ProxyCommand nc %h %p\nHost safe\n  HostName 127.0.0.1\n",
      ),
    ).toThrow("global scope uses unsupported ProxyCommand");
  });

  it("loads aliases from Include globs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quick-shell-ssh-"));
    await mkdir(join(dir, "config.d"));
    await writeFile(
      join(dir, "config"),
      `Host root\nInclude ${dir}/config.d/*\n`,
    );
    await writeFile(
      join(dir, "config.d", "hosts"),
      "Host included\n  HostName 127.0.0.1\n",
    );

    await expect(loadAllowedSshHosts(join(dir, "config"))).resolves.toEqual(
      new Set(["root", "included"]),
    );
  });

  it("loads aliases from Include globs with keyword=value syntax", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quick-shell-ssh-"));
    await mkdir(join(dir, "config.d"));
    await writeFile(
      join(dir, "config"),
      `Host root\nInclude=${dir}/config.d/*\n`,
    );
    await writeFile(
      join(dir, "config.d", "hosts"),
      "Host included\n  HostName 127.0.0.1\n",
    );

    await expect(loadAllowedSshHosts(join(dir, "config"))).resolves.toEqual(
      new Set(["root", "included"]),
    );
  });

  it("resolves relative Include paths under the user's .ssh directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quick-shell-ssh-"));
    const originalHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      await mkdir(join(dir, ".ssh", "config.d"), { recursive: true });
      await writeFile(join(dir, "config"), "Host root\nInclude config.d/*\n");
      await writeFile(
        join(dir, ".ssh", "config.d", "hosts"),
        "Host included\n  HostName 127.0.0.1\n",
      );

      await expect(loadAllowedSshHosts(join(dir, "config"))).resolves.toEqual(
        new Set(["root", "included"]),
      );
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("rejects Include patterns with unsupported OpenSSH expansion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quick-shell-ssh-"));
    await writeFile(
      join(dir, "config"),
      "Host root\nInclude %d/.ssh/config.d/*\n",
    );

    await expect(loadAllowedSshHosts(join(dir, "config"))).rejects.toThrow(
      "OpenSSH tokens or environment variables",
    );

    await writeFile(
      join(dir, "config"),
      "Host root\nInclude ${HOME}/.ssh/config.d/*\n",
    );
    await expect(loadAllowedSshHosts(join(dir, "config"))).rejects.toThrow(
      "OpenSSH tokens or environment variables",
    );

    await writeFile(
      join(dir, "config"),
      "Host root\nInclude ~root/.ssh/config\n",
    );
    await expect(loadAllowedSshHosts(join(dir, "config"))).rejects.toThrow(
      "other-user home expansion",
    );
  });

  it("fails when the primary SSH config cannot be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quick-shell-ssh-"));

    await expect(loadAllowedSshHosts(join(dir, "missing"))).rejects.toThrow(
      "Unable to read SSH config",
    );
  });
});

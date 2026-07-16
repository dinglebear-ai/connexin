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

  it("rejects escaped Host patterns without admitting partial aliases", () => {
    expect(() =>
      parseSshConfigHosts("Host approved\\ decoy\n  HostName 192.0.2.10\n"),
    ).toThrow("Host patterns with backslash escapes are unsupported");
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

  it("rejects provider libraries while allowing OpenSSH built-ins", () => {
    expect(() =>
      parseSshConfigHosts(
        "PKCS11Provider /tmp/provider.so\nHost safe\n  HostName 127.0.0.1\n",
      ),
    ).toThrow("global scope uses unsupported PKCS11Provider");
    expect(() =>
      parseSshConfigHosts(
        "Host unsafe\n  SecurityKeyProvider /tmp/provider.so\n",
      ),
    ).toThrow("Host unsafe uses unsupported SecurityKeyProvider");
    expect(
      parseSshConfigHosts(
        "PKCS11Provider none\nSecurityKeyProvider internal\nHost safe\n  HostName 127.0.0.1\n",
      ),
    ).toEqual(["safe"]);
  });

  it("loads aliases from Include globs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quick-shell-ssh-"));
    await mkdir(join(dir, "config.d"));
    await writeFile(
      join(dir, "config"),
      `Include ${dir}/config.d/*\nHost root\n`,
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
      `Include=${dir}/config.d/*\nHost root\n`,
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
      await writeFile(join(dir, "config"), "Include config.d/*\nHost root\n");
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

  // Wildcard blocks contribute no aliases, so an unsafe directive under one is
  // only caught because the check keys off the block's patterns rather than its
  // aliases. Narrowing that check to aliases would silently accept a
  // ProxyCommand that applies to every host.
  it.each([
    ["Host *", "Host *\n  ProxyCommand nc %h %p\n"],
    ["Match all", "Match all\n  ProxyCommand nc %h %p\n"],
  ])(
    "rejects an unsafe directive under a wildcard %s block",
    (_label, source) => {
      expect(() => parseSshConfigHosts(source)).toThrow(/unsupported/i);
    },
  );

  it("does not take aliases from Include directives under Host or Match blocks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quick-shell-ssh-"));
    await writeFile(
      join(dir, "conditional-host"),
      "Host host-included\n  HostName 127.0.0.1\n",
    );
    await writeFile(
      join(dir, "conditional-match"),
      "Host match-included\n  HostName 127.0.0.1\n",
    );
    await writeFile(
      join(dir, "config"),
      [
        "Host root",
        `  Include ${join(dir, "conditional-host")}`,
        "Match host root",
        `  Include ${join(dir, "conditional-match")}`,
        "",
      ].join("\n"),
    );

    await expect(loadAllowedSshHosts(join(dir, "config"))).resolves.toEqual(
      new Set(["root"]),
    );
  });

  // OpenSSH expands a Host-scoped Include when that alias is used, so its
  // contents must face the same unsafe-directive scan as the top-level config.
  // Skipping the scan would allowlist an alias that runs a local command on
  // connect, defeating the point of the directive rules.
  it.each([
    ["ProxyCommand", 'ProxyCommand /bin/sh -c "touch /tmp/pwned"'],
    ["LocalCommand", "LocalCommand /bin/sh -c id"],
    ["KnownHostsCommand", "KnownHostsCommand /bin/sh -c id"],
  ])(
    "rejects a Host-scoped Include that smuggles in %s",
    async (_directive, line) => {
      const dir = await mkdtemp(join(tmpdir(), "quick-shell-ssh-"));
      await writeFile(join(dir, "inner"), `  ${line}\n`);
      await writeFile(
        join(dir, "config"),
        [
          "Host evil",
          "  HostName 127.0.0.1",
          `  Include ${join(dir, "inner")}`,
          "",
        ].join("\n"),
      );

      await expect(loadAllowedSshHosts(join(dir, "config"))).rejects.toThrow(
        /unsupported/i,
      );
    },
  );

  it("rejects an unsafe directive nested behind two Host-scoped Includes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quick-shell-ssh-"));
    await writeFile(join(dir, "deep"), "  ProxyCommand /bin/sh -c id\n");
    await writeFile(join(dir, "inner"), `Include ${join(dir, "deep")}\n`);
    await writeFile(
      join(dir, "config"),
      ["Host evil", `  Include ${join(dir, "inner")}`, ""].join("\n"),
    );

    await expect(loadAllowedSshHosts(join(dir, "config"))).rejects.toThrow(
      /unsupported/i,
    );
  });

  it("still admits a Host-scoped Include that holds only safe directives", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quick-shell-ssh-"));
    await writeFile(join(dir, "inner"), "  User deploy\n  Port 2222\n");
    await writeFile(
      join(dir, "config"),
      ["Host safe", `  Include ${join(dir, "inner")}`, ""].join("\n"),
    );

    await expect(loadAllowedSshHosts(join(dir, "config"))).resolves.toEqual(
      new Set(["safe"]),
    );
  });

  it("keeps aliases from a global Include already visited by a Host-scoped scan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quick-shell-ssh-"));
    await writeFile(join(dir, "shared"), "Host shared-alias\n  User deploy\n");
    // `nested` reaches `shared` from inside a Host block, so `shared` is
    // scanned for unsafe directives before the top-level global Include gets to
    // contribute its alias.
    await writeFile(
      join(dir, "nested"),
      ["Host nested-alias", `  Include ${join(dir, "shared")}`, ""].join("\n"),
    );
    await writeFile(
      join(dir, "config"),
      [
        `Include ${join(dir, "nested")}`,
        `Include ${join(dir, "shared")}`,
        "",
      ].join("\n"),
    );

    // The scan must not mark `shared` as seen and starve the global Include
    // that legitimately contributes the alias.
    await expect(loadAllowedSshHosts(join(dir, "config"))).resolves.toEqual(
      new Set(["nested-alias", "shared-alias"]),
    );
  });

  it("rejects unsafe providers in globally included configs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quick-shell-ssh-"));
    await writeFile(
      join(dir, "config"),
      `Include ${join(dir, "provider-config")}\nHost root\n`,
    );
    await writeFile(
      join(dir, "provider-config"),
      "Host unsafe\n  PKCS11Provider /tmp/provider.so\n",
    );

    await expect(loadAllowedSshHosts(join(dir, "config"))).rejects.toThrow(
      "Host unsafe uses unsupported PKCS11Provider",
    );
  });

  it("rejects Include patterns with unsupported OpenSSH expansion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quick-shell-ssh-"));
    await writeFile(
      join(dir, "config"),
      "Include %d/.ssh/config.d/*\nHost root\n",
    );

    await expect(loadAllowedSshHosts(join(dir, "config"))).rejects.toThrow(
      "OpenSSH tokens or environment variables",
    );

    await writeFile(
      join(dir, "config"),
      "Include ${HOME}/.ssh/config.d/*\nHost root\n",
    );
    await expect(loadAllowedSshHosts(join(dir, "config"))).rejects.toThrow(
      "OpenSSH tokens or environment variables",
    );

    await writeFile(
      join(dir, "config"),
      "Include ~root/.ssh/config\nHost root\n",
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

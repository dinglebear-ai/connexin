import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  parseCliArgs,
  runQuickShellCli,
  type CliPtyProcess,
} from "../../src/cli/main.js";
import { testRuntimeConfig } from "../server/helpers/runtime-config.js";

class FakeCliPty implements CliPtyProcess {
  readonly writes: string[] = [];
  readonly data = new EventEmitter();
  readonly exits = new EventEmitter();
  killed = false;

  onData(listener: (data: string) => void) {
    this.data.on("data", listener);
    return { dispose: () => this.data.off("data", listener) };
  }

  onExit(listener: (event: { exitCode: number | null }) => void) {
    this.exits.on("exit", listener);
    return { dispose: () => this.exits.off("exit", listener) };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(): void {}

  kill(): void {
    this.killed = true;
  }

  exit(exitCode: number | null = 0): void {
    this.exits.emit("exit", { exitCode });
  }
}

class FakeInput extends EventEmitter {
  isTTY = true;
  rawMode = false;

  setRawMode(enabled: boolean): void {
    this.rawMode = enabled;
  }

  resume(): void {}
}

describe("parseCliArgs", () => {
  it("parses a device and suggested command", () => {
    expect(parseCliArgs(["devbox", "--suggest", "hostname"])).toEqual({
      device: "devbox",
      suggestedCommand: "hostname",
      list: false,
      help: false,
    });
  });

  it("parses --list without a device", () => {
    expect(parseCliArgs(["--list"])).toMatchObject({ list: true, help: false });
  });

  it("rejects a missing device unless listing or showing help", () => {
    expect(() => parseCliArgs([])).toThrow("device is required");
  });

  it("rejects the removed timed prefill option", () => {
    expect(() => parseCliArgs(["devbox", "--prefill-delay-ms", "0"])).toThrow(
      "unknown option: --prefill-delay-ms",
    );
  });
});

describe("runQuickShellCli", () => {
  it("lists explicit SSH aliases with labels", async () => {
    let output = "";

    const result = await runQuickShellCli({
      args: ["--list"],
      config: testRuntimeConfig(),
      allowedHosts: new Set(["devbox", "fileserver"]),
      deviceMetadata: {
        devices: new Map([["devbox", { label: "Dev Box", group: "dev" }]]),
      },
      stdout: { write: (chunk: string) => (output += chunk) },
      stderr: { write: () => undefined },
    });

    expect(result.exitCode).toBe(0);
    expect(output).toContain("devbox\tDev Box\tdev");
    expect(output).toContain("fileserver");
  });

  it("rejects devices that are not explicit SSH aliases", async () => {
    let error = "";

    const result = await runQuickShellCli({
      args: ["unknown"],
      config: testRuntimeConfig(),
      allowedHosts: new Set(["devbox"]),
      deviceMetadata: { devices: new Map([["unknown", { label: "Unknown" }]]) },
      stdout: { write: () => undefined },
      stderr: { write: (chunk: string) => (error += chunk) },
    });

    expect(result.exitCode).toBe(2);
    expect(error).toContain("not listed in SSH config");
  });

  it("inserts a suggestion only after the user presses Ctrl-G", async () => {
    const ptys: FakeCliPty[] = [];
    const calls: Array<{ file: string; args: string[] }> = [];
    const stdin = new FakeInput();
    let error = "";
    const running = runQuickShellCli({
      args: ["devbox", "--suggest", "hostname"],
      config: testRuntimeConfig(),
      allowedHosts: new Set(["devbox"]),
      deviceMetadata: { devices: new Map() },
      stdin,
      stdout: { write: () => undefined },
      stderr: { write: (chunk: string) => (error += chunk) },
      ptyFactory: (file, args) => {
        calls.push({ file, args });
        const pty = new FakeCliPty();
        ptys.push(pty);
        return pty;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    ptys[0]?.data.emit("data", "Password: ");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ptys[0]?.writes).toEqual([]);

    stdin.emit("data", "\u0007");
    ptys[0]?.exit(0);
    const result = await running;

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      { file: "ssh", args: ["-F", "/tmp/config", "devbox"] },
    ]);
    expect(ptys[0]?.writes).toEqual(["hostname"]);
    expect(error).toContain("press Ctrl-G to insert it without submitting");
  });

  it("never writes an uninserted suggestion when ssh exits", async () => {
    const ptys: FakeCliPty[] = [];
    const running = runQuickShellCli({
      args: ["devbox", "--suggest", "hostname"],
      config: testRuntimeConfig(),
      allowedHosts: new Set(["devbox"]),
      deviceMetadata: { devices: new Map() },
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      ptyFactory: () => {
        const pty = new FakeCliPty();
        ptys.push(pty);
        return pty;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    ptys[0]?.exit(0);
    await expect(running).resolves.toEqual({ exitCode: 0 });

    expect(ptys[0]?.writes).toEqual([]);
  });

  it("forwards ordinary input and keeps explicit insertion available", async () => {
    const ptys: FakeCliPty[] = [];
    const stdin = new FakeInput();
    const running = runQuickShellCli({
      args: ["devbox", "--suggest", "hostname"],
      config: testRuntimeConfig(),
      allowedHosts: new Set(["devbox"]),
      deviceMetadata: { devices: new Map() },
      stdin,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      ptyFactory: () => {
        const pty = new FakeCliPty();
        ptys.push(pty);
        return pty;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    stdin.emit("data", "typed");
    stdin.emit("data", "\u0007");
    ptys[0]?.exit(0);
    await expect(running).resolves.toEqual({ exitCode: 0 });

    expect(ptys[0]?.writes).toEqual(["typed", "hostname"]);
  });

  it("reports unknown PTY termination as failure", async () => {
    const ptys: FakeCliPty[] = [];
    let error = "";
    const running = runQuickShellCli({
      args: ["devbox"],
      config: testRuntimeConfig(),
      allowedHosts: new Set(["devbox"]),
      deviceMetadata: { devices: new Map() },
      stdout: { write: () => undefined },
      stderr: { write: (chunk: string) => (error += chunk) },
      ptyFactory: () => {
        const pty = new FakeCliPty();
        ptys.push(pty);
        return pty;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    ptys[0]?.exit(null);
    const result = await running;

    expect(result.exitCode).toBe(1);
    expect(error).toContain("ended without an exit code");
  });
});

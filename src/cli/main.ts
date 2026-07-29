#!/usr/bin/env node
import { spawn as spawnPty } from "node-pty";
import { loadRuntimeConfig, type RuntimeConfig } from "../server/config.js";
import {
  loadDeviceMetadata,
  type DeviceMetadataConfig,
} from "../server/device-metadata.js";
import { sanitizeSuggestedCommand, validateDevice } from "../server/device.js";
import {
  buildSshCommandArgs,
  loadAllowedSshHosts,
} from "../server/ssh-config.js";

export interface CliPtyProcess {
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number | null }) => void): {
    dispose(): void;
  };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type CliPtyFactory = (
  file: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd?: string;
    env: Record<string, string>;
  },
) => CliPtyProcess;

export interface CliArgs {
  device?: string;
  suggestedCommand?: string;
  list: boolean;
  help: boolean;
}

export interface CliResult {
  exitCode: number;
}

export interface WritableLike {
  write(chunk: string): unknown;
}

export interface ReadableLike {
  on?(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off?(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  isTTY?: boolean;
  setRawMode?(enabled: boolean): void;
  resume?(): void;
}

export interface RunConnexinCliOptions {
  args: string[];
  config?: RuntimeConfig;
  allowedHosts?: ReadonlySet<string>;
  deviceMetadata?: DeviceMetadataConfig;
  ptyFactory?: CliPtyFactory;
  stdin?: ReadableLike;
  stdout?: WritableLike;
  stderr?: WritableLike;
}

const USAGE = `Usage:
  connexin --list
  connexin <device> [--suggest <command>]

With --suggest, press Ctrl-G to insert the command without submitting it.
`;

const INSERT_SUGGESTION_KEY = "\u0007";

const ENV_ALLOWLIST = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "SSH_AUTH_SOCK",
  "TERM",
];

function defaultPtyFactory(): CliPtyFactory {
  return (file, args, options) => spawnPty(file, args, options);
}

function ptyEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.TERM = env.TERM || "xterm-256color";
  return env;
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return value;
}

export function parseCliArgs(args: string[]): CliArgs {
  const parsed: CliArgs = {
    list: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--list") {
      parsed.list = true;
    } else if (arg === "--suggest" || arg === "--suggested-command") {
      parsed.suggestedCommand = readFlagValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else if (!parsed.device) {
      parsed.device = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  if (!parsed.help && !parsed.list && !parsed.device)
    throw new Error("device is required");
  return parsed;
}

function formatDevices(
  allowedHosts: ReadonlySet<string>,
  metadata: DeviceMetadataConfig,
): string {
  const lines = [...allowedHosts].sort().map((alias) => {
    const device = metadata.devices.get(alias);
    return [
      alias,
      device?.label ?? "",
      device?.group ?? "",
      device?.danger ?? "",
    ]
      .join("\t")
      .replace(/\t+$/g, "");
  });
  return `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

async function loadDefaults(options: RunConnexinCliOptions): Promise<{
  config: RuntimeConfig;
  allowedHosts: ReadonlySet<string>;
  deviceMetadata: DeviceMetadataConfig;
}> {
  const config = options.config ?? loadRuntimeConfig();
  const [allowedHosts, deviceMetadata] = await Promise.all([
    options.allowedHosts
      ? Promise.resolve(options.allowedHosts)
      : loadAllowedSshHosts(config.sshConfigPath),
    options.deviceMetadata
      ? Promise.resolve(options.deviceMetadata)
      : loadDeviceMetadata(config.connexinConfigPath),
  ]);
  return { config, allowedHosts, deviceMetadata };
}

export async function runConnexinCli(
  options: RunConnexinCliOptions,
): Promise<CliResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let parsed: CliArgs;
  try {
    parsed = parseCliArgs(options.args);
  } catch (error) {
    stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return { exitCode: 2 };
  }

  if (parsed.help) {
    stdout.write(USAGE);
    return { exitCode: 0 };
  }

  const { config, allowedHosts, deviceMetadata } = await loadDefaults(options);
  if (parsed.list) {
    stdout.write(formatDevices(allowedHosts, deviceMetadata));
    return { exitCode: 0 };
  }

  try {
    const device = validateDevice(
      parsed.device!,
      allowedHosts,
      config.maxDeviceLength,
    );
    const suggested = sanitizeSuggestedCommand(
      parsed.suggestedCommand,
      config.maxSuggestedCommandLength,
    );
    const ptyFactory = options.ptyFactory ?? defaultPtyFactory();
    const pty = ptyFactory(
      "ssh",
      buildSshCommandArgs(config.sshConfigPath, device),
      {
        name: "xterm-256color",
        cols: Number(process.env.COLUMNS) || 100,
        rows: Number(process.env.LINES) || 30,
        cwd: process.env.HOME,
        env: ptyEnv(),
      },
    );

    const stdin = options.stdin ?? process.stdin;
    let suggestionInserted = false;
    const onInput = (chunk: Buffer | string) => {
      const input = String(chunk);
      if (!suggested || suggestionInserted) {
        pty.write(input);
        return;
      }

      const insertAt = input.indexOf(INSERT_SUGGESTION_KEY);
      if (insertAt === -1) {
        pty.write(input);
        return;
      }

      suggestionInserted = true;
      const before = input.slice(0, insertAt);
      const after = input.slice(insertAt + INSERT_SUGGESTION_KEY.length);
      if (before) pty.write(before);
      pty.write(suggested);
      if (after) pty.write(after);
    };
    const dataDisposable = pty.onData((data) => stdout.write(data));
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      dataDisposable.dispose();
      if (stdin.off) stdin.off("data", onInput);
      if (stdin.isTTY) stdin.setRawMode?.(false);
      process.off("exit", cleanup);
    };
    process.once("exit", cleanup);
    if (stdin.on) {
      stdin.on("data", onInput);
      stdin.resume?.();
      if (stdin.isTTY) stdin.setRawMode?.(true);
    }

    if (suggested)
      stderr.write(
        "Suggestion ready; press Ctrl-G to insert it without submitting.\n",
      );

    return await new Promise<CliResult>((resolve) => {
      pty.onExit((event) => {
        cleanup();
        if (event.exitCode === null) {
          stderr.write("connexin SSH session ended without an exit code\n");
          resolve({ exitCode: 1 });
          return;
        }
        resolve({ exitCode: event.exitCode });
      });
    });
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 2 };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runConnexinCli({ args: process.argv.slice(2) })
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}

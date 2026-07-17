#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { z } from "zod";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<CommandResult>;

export interface VerifyDeploymentResult {
  ok: boolean;
  failures: string[];
  recoveryHint: string;
}

function envValue(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

function optionalEnvValue(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function envList(name: string, fallback: string[]): string[] {
  const value = optionalEnvValue(name);
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((entry) => typeof entry === "string")
    )
      return parsed;
  } catch {
    // Fall through to shell-like whitespace splitting for simple deployments.
  }
  return value.split(/\s+/).filter(Boolean);
}

const UPSTREAM = envValue("QUICK_SHELL_VERIFY_UPSTREAM", "quick-shell");
const CONTAINER_NAME = optionalEnvValue("QUICK_SHELL_VERIFY_CONTAINER");
const CONTAINER_USER = optionalEnvValue("QUICK_SHELL_VERIFY_USER");
const CONTAINER_HOME = optionalEnvValue("QUICK_SHELL_VERIFY_HOME");
const GATEWAY_CLI = envValue("QUICK_SHELL_VERIFY_GATEWAY_CLI", "gatewayctl");
const GATEWAY_CONFIG_PATH = optionalEnvValue(
  "QUICK_SHELL_VERIFY_GATEWAY_CONFIG",
);
const CONTAINER_PATH = envValue("QUICK_SHELL_VERIFY_PATH", "/opt/quick-shell");
const EXPECTED_GATEWAY_COMMAND = envValue("QUICK_SHELL_VERIFY_COMMAND", "node");
const EXPECTED_GATEWAY_ARGS = envList("QUICK_SHELL_VERIFY_ARGS", [
  `${CONTAINER_PATH}/dist/server/server/main.js`,
  "--stdio",
]);
const EXPECTED_AUDIT_LOG = optionalEnvValue("QUICK_SHELL_VERIFY_AUDIT_LOG");
const EXPECTED_BRIDGE_HOST = optionalEnvValue("QUICK_SHELL_VERIFY_BRIDGE_HOST");
const EXPECTED_BRIDGE_PORT = optionalEnvValue("QUICK_SHELL_VERIFY_BRIDGE_PORT");
const EXPECTED_BRIDGE_PUBLIC_URL = optionalEnvValue(
  "QUICK_SHELL_VERIFY_BRIDGE_PUBLIC_URL",
);
const APP_RESOURCE_URI = "ui://quick-shell/mcp-app.v3.html";
const BUILD_MANIFEST_PATH = "dist/quick-shell-build-manifest.json";
const manifestFilePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) => !path.startsWith("/") && !path.split("/").includes(".."),
    "must be a relative path inside the build",
  );
const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 hex digest");
const buildManifestSchema = z
  .object({
    version: z.number(),
    packageName: z.string().min(1),
    gitSha: z.string().min(1),
    gitDirty: z.boolean().optional(),
    builtAt: z.string().optional(),
    files: z.record(manifestFilePathSchema, sha256Schema),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (Object.keys(manifest.files).length === 0) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "must contain at least one file",
      });
    }
  });
export type BuildManifest = z.infer<typeof buildManifestSchema>;

const gatewayGetSchema = z
  .object({
    config: z
      .object({
        enabled: z.boolean().optional(),
        command: z.string().nullable().optional(),
        args: z.array(z.string()).nullable().optional(),
      })
      .passthrough()
      .optional(),
    runtime: z
      .object({
        exposed_tool_count: z.number().int().nonnegative().optional(),
        last_error: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const gatewayListSchema = z.array(
  z
    .object({
      name: z.string(),
      connected: z.boolean().optional(),
      exposed_tool_count: z.number().int().nonnegative().optional(),
      likely_stale_count: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
);
const codeSearchSchema = z
  .object({
    result: z.array(z.object({ id: z.string().optional() }).passthrough()),
  })
  .passthrough();
const toolSmokeSchema = z
  .object({
    result: z
      .object({
        ok: z.boolean().optional(),
        message: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();
const resourceSmokeSchema = z
  .object({
    toolNames: z.array(z.string()),
    resourceCount: z.number().int().nonnegative(),
    mimeType: z.string().optional(),
  })
  .passthrough();
const EXPECTED_GATEWAY_PROCESS = {
  command: EXPECTED_GATEWAY_COMMAND,
  args: EXPECTED_GATEWAY_ARGS,
};
// Tool ids are namespaced by the gateway upstream name, so they follow
// QUICK_SHELL_VERIFY_UPSTREAM rather than hardcoding the default.
const qualifiedTool = (name: string) => `${UPSTREAM}::${name}`;
const REQUIRED_MODEL_TOOLS = [
  "check_quick_shell",
  "list_quick_shell_devices",
  "open_quick_shell",
].map(qualifiedTool);
const APP_ONLY_TOOLS = [
  "get_quick_shell_session",
  "poll_quick_shell_session",
  "write_quick_shell_input",
  "resize_quick_shell_session",
  "close_quick_shell_session",
  "record_quick_shell_output_confirmed",
  "list_quick_shell_files",
  "prepare_quick_shell_file_operation",
  "mkdir_quick_shell_path",
  "rename_quick_shell_path",
  "delete_quick_shell_path",
].map(qualifiedTool);
const REQUIRED_RUNTIME_TOOLS = [...REQUIRED_MODEL_TOOLS, ...APP_ONLY_TOOLS];
const REQUIRED_RUNTIME_TOOL_NAMES = REQUIRED_RUNTIME_TOOLS.map((tool) =>
  tool.replace(/^quick-shell::/, ""),
);

const RECOVERY_HINT = [
  "Recovery:",
  "  Restart or recycle the configured gateway upstream for quick-shell.",
  "  Then rerun npm run verify:deployment with the same QUICK_SHELL_VERIFY_* environment.",
].join("\n");

function insideDeploymentTarget(): boolean {
  if (CONTAINER_HOME && process.cwd().startsWith(`${CONTAINER_HOME}/`))
    return true;
  return process.cwd().startsWith(`${CONTAINER_PATH}/`);
}

function containerShellCommand(shellCommand: string): {
  command: string;
  args: string[];
} {
  if (insideDeploymentTarget() || !CONTAINER_NAME)
    return { command: "bash", args: ["-lc", shellCommand] };
  if (!CONTAINER_USER)
    return {
      command: "incus",
      args: ["exec", CONTAINER_NAME, "--", "bash", "-lc", shellCommand],
    };
  return {
    command: "incus",
    args: [
      "exec",
      CONTAINER_NAME,
      "--",
      "su",
      "-",
      CONTAINER_USER,
      "-c",
      shellCommand,
    ],
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function gatewayCommand(args: string[]): { command: string; args: string[] } {
  if (insideDeploymentTarget() || !CONTAINER_NAME)
    return { command: GATEWAY_CLI, args };
  return containerShellCommand(
    [GATEWAY_CLI, ...args].map(shellQuote).join(" "),
  );
}

export const defaultRunner: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const errorMessage = error instanceof Error ? error.message : "";
        const stderrText = [String(stderr), errorMessage]
          .filter(Boolean)
          .join("\n");
        resolve({
          stdout: String(stdout),
          stderr: stderrText,
          exitCode:
            error === null
              ? 0
              : typeof (error as { code?: unknown }).code === "number"
                ? (error as { code: number }).code
                : 1,
        });
      },
    );
  });

function parseJson(
  label: string,
  source: string,
  failures: string[],
): unknown | undefined {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    failures.push(
      `${label}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function formatZodPath(path: PropertyKey[]): string {
  return path.length > 0
    ? path.map((segment) => String(segment)).join(".")
    : "<root>";
}

function parseJsonShape<T extends z.ZodType>(
  label: string,
  source: string,
  schema: T,
  failures: string[],
): z.infer<T> | undefined {
  const parsed = parseJson(label, source, failures);
  if (parsed === undefined) return undefined;
  const result = schema.safeParse(parsed);
  if (result.success) return result.data;
  const details = result.error.issues
    .map((issue) => `${formatZodPath(issue.path)} ${issue.message}`)
    .join("; ");
  failures.push(`${label}: invalid JSON shape: ${details}`);
  return undefined;
}

async function readLocalBuildManifest(
  failures: string[],
): Promise<BuildManifest | undefined> {
  try {
    return parseJsonShape(
      "local build manifest",
      await readFile(BUILD_MANIFEST_PATH, "utf8"),
      buildManifestSchema,
      failures,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(
      `local build manifest: run npm run build before verify:deployment (${message})`,
    );
    return undefined;
  }
}

function parseSha256Lines(source: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(trimmed);
    if (match) hashes.set(match[2]!, match[1]!);
  }
  return hashes;
}

function compareBuildManifest(
  expected: BuildManifest,
  deployed: BuildManifest,
  failures: string[],
): void {
  if (deployed.version !== expected.version)
    failures.push(
      "build manifest: deployed version does not match local build",
    );
  if (deployed.packageName !== expected.packageName)
    failures.push(
      "build manifest: deployed package name does not match local build",
    );
  if (deployed.gitSha !== expected.gitSha) {
    failures.push(
      `build manifest: deployed gitSha ${deployed.gitSha} does not match local ${expected.gitSha}`,
    );
  }
  if (Boolean(deployed.gitDirty) !== Boolean(expected.gitDirty)) {
    failures.push(
      "build manifest: deployed dirty state does not match local build",
    );
  }
  for (const [path, expectedHash] of Object.entries(expected.files)) {
    if (deployed.files?.[path] !== expectedHash)
      failures.push(`build manifest: deployed hash mismatch for ${path}`);
  }
  for (const path of Object.keys(deployed.files)) {
    if (expected.files[path] === undefined)
      failures.push(
        `build manifest: deployed contains unexpected file ${path}`,
      );
  }
}

function compareDeployedHashes(
  paths: string[],
  deployed: BuildManifest,
  hashes: Map<string, string>,
  failures: string[],
): void {
  for (const path of paths) {
    const manifestHash = deployed.files?.[path];
    const actualHash = hashes.get(path);
    if (!manifestHash)
      failures.push(`deployed hashes: manifest missing ${path}`);
    else if (!actualHash)
      failures.push(`deployed hashes: sha256sum missing ${path}`);
    else if (actualHash !== manifestHash)
      failures.push(`deployed hashes: ${path} does not match build manifest`);
  }
}

function arraysEqual(
  left: readonly string[] | undefined,
  right: readonly string[],
): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

async function verifyLocalManifestHead(
  run: CommandRunner,
  manifest: BuildManifest,
  failures: string[],
): Promise<void> {
  if (insideDeploymentTarget()) return;
  const result = await run("git", ["rev-parse", "HEAD"]);
  if (result.exitCode !== 0) {
    failures.push(
      `local git HEAD: exited ${result.exitCode}: ${result.stderr || result.stdout}`.trim(),
    );
    return;
  }
  const head = result.stdout.trim();
  if (head && manifest.gitSha !== head) {
    failures.push(
      `local build manifest: gitSha ${manifest.gitSha} does not match current HEAD ${head}`,
    );
  }
}

function verifyLocalManifestClean(
  manifest: BuildManifest,
  failures: string[],
): void {
  if (manifest.gitDirty)
    failures.push(
      "local build manifest: build was created from a dirty working tree",
    );
}

async function expectCommandOk(
  run: CommandRunner,
  label: string,
  command: string,
  args: string[],
  failures: string[],
): Promise<CommandResult | undefined> {
  const result = await run(command, args);
  if (result.exitCode !== 0) {
    failures.push(
      `${label}: exited ${result.exitCode}: ${result.stderr || result.stdout}`.trim(),
    );
    return undefined;
  }
  return result;
}

export async function runVerifyDeployment(
  options: { run?: CommandRunner; expectedManifest?: BuildManifest } = {},
): Promise<VerifyDeploymentResult> {
  const run = options.run ?? defaultRunner;
  const failures: string[] = [];
  const expectedManifest =
    options.expectedManifest ?? (await readLocalBuildManifest(failures));
  if (expectedManifest) {
    verifyLocalManifestClean(expectedManifest, failures);
    if (!options.expectedManifest)
      await verifyLocalManifestHead(run, expectedManifest, failures);
  }

  const sourceCheck = containerShellCommand(
    `test -d ${CONTAINER_PATH} && test -f ${CONTAINER_PATH}/dist/server/server/main.js`,
  );
  await expectCommandOk(
    run,
    "container source",
    sourceCheck.command,
    sourceCheck.args,
    failures,
  );

  const manifestCheck = containerShellCommand(
    `cd ${CONTAINER_PATH} && test -f ${BUILD_MANIFEST_PATH} && cat ${BUILD_MANIFEST_PATH}`,
  );
  const manifestResult = await expectCommandOk(
    run,
    "container build manifest",
    manifestCheck.command,
    manifestCheck.args,
    failures,
  );
  const deployedManifest = manifestResult
    ? parseJsonShape(
        "container build manifest",
        manifestResult.stdout,
        buildManifestSchema,
        failures,
      )
    : undefined;
  if (expectedManifest && deployedManifest)
    compareBuildManifest(expectedManifest, deployedManifest, failures);

  if (deployedManifest) {
    const manifestFiles = Object.keys(deployedManifest.files ?? {}).sort();
    if (manifestFiles.length === 0) {
      failures.push("deployed hashes: manifest contains no files");
    } else {
      const hashCheck = containerShellCommand(
        `cd ${CONTAINER_PATH} && sha256sum ${manifestFiles.map(shellQuote).join(" ")}`,
      );
      const hashResult = await expectCommandOk(
        run,
        "container build hashes",
        hashCheck.command,
        hashCheck.args,
        failures,
      );
      if (hashResult)
        compareDeployedHashes(
          manifestFiles,
          deployedManifest,
          parseSha256Lines(hashResult.stdout),
          failures,
        );
    }
  }

  if (failures.length > 0) {
    return { ok: false, failures, recoveryHint: "" };
  }

  const envExpectations = [
    EXPECTED_AUDIT_LOG
      ? `QUICK_SHELL_AUDIT_LOG = "${EXPECTED_AUDIT_LOG}"`
      : undefined,
    EXPECTED_BRIDGE_HOST
      ? `QUICK_SHELL_BRIDGE_HOST = "${EXPECTED_BRIDGE_HOST}"`
      : undefined,
    EXPECTED_BRIDGE_PORT
      ? `QUICK_SHELL_BRIDGE_PORT = "${EXPECTED_BRIDGE_PORT}"`
      : undefined,
    EXPECTED_BRIDGE_PUBLIC_URL
      ? `QUICK_SHELL_BRIDGE_PUBLIC_URL = "${EXPECTED_BRIDGE_PUBLIC_URL}"`
      : undefined,
  ].filter((value): value is string => Boolean(value));
  if (GATEWAY_CONFIG_PATH && envExpectations.length > 0) {
    const envConfigCheck = containerShellCommand(
      [
        `section=$(sed -n '/^name = "${UPSTREAM}"$/,/^\\[\\[upstream\\]\\]/p' ${shellQuote(GATEWAY_CONFIG_PATH)})`,
        ...envExpectations.map(
          (expectation) =>
            `printf '%s\\n' "$section" | grep -F ${shellQuote(expectation)} >/dev/null`,
        ),
      ].join(" && "),
    );
    await expectCommandOk(
      run,
      "gateway config env",
      envConfigCheck.command,
      envConfigCheck.args,
      failures,
    );
  }

  const getCommand = gatewayCommand(["gateway", "get", "--json", UPSTREAM]);
  const getResult = await expectCommandOk(
    run,
    "gateway get",
    getCommand.command,
    getCommand.args,
    failures,
  );
  const gateway = getResult
    ? parseJsonShape(
        "gateway get",
        getResult.stdout,
        gatewayGetSchema,
        failures,
      )
    : undefined;
  if (gateway) {
    if (gateway.config?.enabled !== true)
      failures.push("gateway get: quick-shell is not enabled");
    if (gateway.config?.command !== EXPECTED_GATEWAY_PROCESS.command) {
      failures.push(
        `gateway get: command ${gateway.config?.command ?? "<missing>"} does not match ${EXPECTED_GATEWAY_PROCESS.command}`,
      );
    }
    if (
      !arraysEqual(
        gateway.config?.args ?? undefined,
        EXPECTED_GATEWAY_PROCESS.args,
      )
    ) {
      failures.push(
        `gateway get: args ${(gateway.config?.args ?? []).join(" ")} do not match ${EXPECTED_GATEWAY_PROCESS.args.join(" ")}`,
      );
    }
    if (
      (gateway.runtime?.exposed_tool_count ?? 0) < REQUIRED_RUNTIME_TOOLS.length
    ) {
      failures.push(
        `gateway get: expected at least ${REQUIRED_RUNTIME_TOOLS.length} exposed tools`,
      );
    }
    if (gateway.runtime?.last_error)
      failures.push(`gateway get: ${gateway.runtime.last_error}`);
  }

  const listCommand = gatewayCommand(["gateway", "mcp", "list", "--json"]);
  const listResult = await expectCommandOk(
    run,
    "gateway mcp list",
    listCommand.command,
    listCommand.args,
    failures,
  );
  const runtimes = listResult
    ? parseJsonShape(
        "gateway mcp list",
        listResult.stdout,
        gatewayListSchema,
        failures,
      )
    : undefined;
  const runtime = runtimes?.find((entry) => entry.name === UPSTREAM);
  if (!runtime) failures.push("gateway mcp list: quick-shell not found");
  else {
    if (runtime.connected !== true)
      failures.push("gateway mcp list: quick-shell is not connected");
    if ((runtime.exposed_tool_count ?? 0) < REQUIRED_RUNTIME_TOOLS.length) {
      failures.push(
        `gateway mcp list: expected at least ${REQUIRED_RUNTIME_TOOLS.length} exposed tools`,
      );
    }
    if ((runtime.likely_stale_count ?? 0) > 0)
      failures.push("gateway mcp list: quick-shell has likely stale processes");
  }

  const code = `async () => {
    const queries = ["quick shell terminal", "quick_shell open_quick_shell", "human ssh terminal"];
    const all = [];
    for (const query of queries) {
      const hits = await codemode.search({ query, limit: 50 });
      all.push(...hits.results);
    }
    return Array.from(
      new Map(
        all
          .filter(t => t.namespace === ${JSON.stringify(UPSTREAM)} || t.id?.startsWith(${JSON.stringify(`${UPSTREAM}::`)}))
          .map(t => [t.id, { id: t.id }]),
      ).values(),
    );
  }`;
  const codeCommand = gatewayCommand([
    "gateway",
    "code",
    "exec",
    "--json",
    "--code",
    code,
  ]);
  const codeResult = await expectCommandOk(
    run,
    "gateway code search",
    codeCommand.command,
    codeCommand.args,
    failures,
  );
  const codeTrace = codeResult
    ? parseJsonShape(
        "gateway code search",
        codeResult.stdout,
        codeSearchSchema,
        failures,
      )
    : undefined;
  const ids = new Set(
    (codeTrace?.result ?? []).map((entry) => entry.id).filter(Boolean),
  );
  for (const required of REQUIRED_MODEL_TOOLS) {
    if (!ids.has(required))
      failures.push(`gateway code search: missing ${required}`);
  }
  for (const appOnly of APP_ONLY_TOOLS) {
    if (ids.has(appOnly))
      failures.push(
        `gateway code search: app-only tool ${appOnly} is visible to model discovery`,
      );
  }

  const toolSmokeCode = `async () => {
    const result = await callTool("quick-shell::check_quick_shell", {});
    return { ok: result && result.ok === true, result };
  }`;
  const toolSmokeCommand = gatewayCommand([
    "gateway",
    "code",
    "exec",
    "--json",
    "--code",
    toolSmokeCode,
  ]);
  const toolSmokeResult = await expectCommandOk(
    run,
    "gateway tool smoke",
    toolSmokeCommand.command,
    toolSmokeCommand.args,
    failures,
  );
  const toolSmoke = toolSmokeResult
    ? parseJsonShape(
        "gateway tool smoke",
        toolSmokeResult.stdout,
        toolSmokeSchema,
        failures,
      )
    : undefined;
  if (toolSmoke && toolSmoke.result?.ok !== true) {
    failures.push(
      `gateway tool smoke: ${toolSmoke.result?.message ?? "did not execute quick-shell tool through deployment"}`,
    );
  }

  if (EXPECTED_AUDIT_LOG) {
    const auditSmoke = [
      `test -s ${shellQuote(EXPECTED_AUDIT_LOG)}`,
      `tail -n 80 ${shellQuote(EXPECTED_AUDIT_LOG)} | grep -E '"event":"(runtime_started|bridge_listening)"' >/dev/null`,
      EXPECTED_BRIDGE_PUBLIC_URL
        ? `tail -n 80 ${shellQuote(EXPECTED_AUDIT_LOG)} | grep -F '"baseUrl":"${EXPECTED_BRIDGE_PUBLIC_URL}"' >/dev/null`
        : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" && ");
    const auditCheck = containerShellCommand(auditSmoke);
    await expectCommandOk(
      run,
      "audit log smoke",
      auditCheck.command,
      auditCheck.args,
      failures,
    );
  }

  const resourceCode = `
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({
  command: ${JSON.stringify(EXPECTED_GATEWAY_PROCESS.command)},
  args: ${JSON.stringify(EXPECTED_GATEWAY_PROCESS.args)},
  env: {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
  },
});
const client = new Client({ name: "quick-shell-deployment-verify", version: "0.0.0" });
await client.connect(transport);
const tools = await client.listTools();
const resource = await client.readResource({ uri: "${APP_RESOURCE_URI}" });
console.log(JSON.stringify({ toolNames: tools.tools.map((tool) => tool.name), resourceCount: resource.contents.length, mimeType: resource.contents[0]?.mimeType }));
await client.close();
`;
  const encodedResourceCode = Buffer.from(resourceCode, "utf8").toString(
    "base64",
  );
  const smokeHome = CONTAINER_HOME
    ? shellQuote(CONTAINER_HOME)
    : '"${HOME:-/tmp}"';
  const resourceSmoke = [
    ": resource_smoke",
    'smoke=$(mktemp "${TMPDIR:-/tmp}/quick-shell-resource-smoke.XXXXXX.mjs")',
    "trap 'rm -f \"$smoke\"' EXIT",
    `printf %s ${shellQuote(encodedResourceCode)} | base64 -d > "$smoke"`,
    `cd ${shellQuote(CONTAINER_PATH)}`,
    `env -i PATH="\${PATH:-/usr/local/bin:/usr/bin:/bin}" HOME=${smokeHome} node "$smoke"`,
  ].join(" && ");
  const resourceCheck = containerShellCommand(resourceSmoke);
  const resourceResult = await expectCommandOk(
    run,
    "resource smoke",
    resourceCheck.command,
    resourceCheck.args,
    failures,
  );
  const resource = resourceResult
    ? parseJsonShape(
        "resource smoke",
        resourceResult.stdout,
        resourceSmokeSchema,
        failures,
      )
    : undefined;
  if (resource) {
    if (resource.resourceCount < 1)
      failures.push("resource smoke: no app resource returned");
    if (resource.mimeType !== "text/html;profile=mcp-app")
      failures.push(
        `resource smoke: unexpected mime type ${resource.mimeType}`,
      );
    for (const required of REQUIRED_RUNTIME_TOOL_NAMES) {
      if (!resource.toolNames.includes(required))
        failures.push(`resource smoke: missing ${required}`);
    }
  }

  const stale = failures.some((failure) =>
    /Transport closed|not connected|stale|dead PID/i.test(failure),
  );
  return {
    ok: failures.length === 0,
    failures,
    recoveryHint: stale ? RECOVERY_HINT : "",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runVerifyDeployment()
    .then((result) => {
      if (result.ok) {
        console.log("quick-shell deployment verification passed");
        return;
      }
      console.error("quick-shell deployment verification failed");
      for (const failure of result.failures) console.error(`- ${failure}`);
      if (result.recoveryHint) console.error(result.recoveryHint);
      process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}

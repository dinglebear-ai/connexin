import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve, sep } from "node:path";

const MAX_INCLUDE_DEPTH = 16;

function isExplicitAlias(alias: string): boolean {
  return (
    alias !== "*" &&
    !alias.includes("*") &&
    !alias.includes("?") &&
    !alias.startsWith("!")
  );
}

function tokenizeOpenSshLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;

    if (!quote && char === "#") break;
    if (quote === undefined && (char === '"' || char === "'")) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = undefined;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) tokens.push(current);
  if (tokens[0]?.includes("=")) {
    const [keyword, ...rest] = tokens[0].split("=");
    if (keyword) {
      const value = rest.join("=");
      tokens.splice(0, 1, keyword, ...(value.length > 0 ? [value] : []));
    }
  }
  if (tokens[1] === "=") tokens.splice(1, 1);
  return tokens;
}

export function buildSshCommandArgs(
  configPath: string,
  device: string,
): string[] {
  return ["-F", configPath, device];
}

export function parseSshConfigHosts(source: string): string[] {
  const seen = new Set<string>();
  const hosts: string[] = [];
  let currentAliases: string[] = [];
  let currentPatterns: string[] = [];
  let currentUnsafeDirective: string | undefined;

  const flushHostBlock = () => {
    if (currentUnsafeDirective && currentPatterns.length > 0) {
      throw new Error(
        `SSH config Host ${currentPatterns.join(" ")} uses unsupported ${currentUnsafeDirective}`,
      );
    }
    for (const alias of currentAliases) {
      if (seen.has(alias)) continue;
      seen.add(alias);
      hosts.push(alias);
    }
    currentAliases = [];
    currentPatterns = [];
    currentUnsafeDirective = undefined;
  };

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const [keyword, ...args] = tokenizeOpenSshLine(trimmed);
    const normalizedKeyword = keyword?.toLowerCase();
    if (normalizedKeyword === "host") {
      flushHostBlock();
      currentPatterns = args;
      currentAliases = args.filter(isExplicitAlias);
      continue;
    }

    if (normalizedKeyword === "match") {
      flushHostBlock();
      if (args.some((arg) => arg.toLowerCase() === "exec")) {
        throw new Error(
          "SSH config Match exec is unsupported because it can execute local commands",
        );
      }
      continue;
    }

    const unsafeDirective = unsafeExecutionDirective(normalizedKeyword, args);
    if (unsafeDirective && currentPatterns.length === 0) {
      throw new Error(
        `SSH config global scope uses unsupported ${unsafeDirective}`,
      );
    }
    currentUnsafeDirective ??= unsafeDirective;
  }

  flushHostBlock();
  return hosts;
}

function unsafeExecutionDirective(
  keyword: string | undefined,
  args: string[],
): string | undefined {
  if (keyword === "proxycommand" && args.join(" ").toLowerCase() !== "none")
    return "ProxyCommand";
  if (
    keyword === "knownhostscommand" &&
    args.join(" ").toLowerCase() !== "none"
  )
    return "KnownHostsCommand";
  if (keyword === "localcommand") return "LocalCommand";
  if (keyword === "remotecommand" && args.join(" ").toLowerCase() !== "none")
    return "RemoteCommand";
  if (
    keyword === "permitlocalcommand" &&
    ["yes", "true", "1"].includes(args[0]?.toLowerCase() ?? "")
  ) {
    return "PermitLocalCommand";
  }
  return undefined;
}

function lineTokens(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  return tokenizeOpenSshLine(trimmed);
}

function includePatterns(source: string): string[] {
  const patterns: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const [keyword, ...rest] = lineTokens(line) ?? [];
    if (keyword?.toLowerCase() === "include") patterns.push(...rest);
  }
  return patterns;
}

function expandHome(path: string): string {
  if (path === "~") return process.env.HOME ?? path;
  if (path.startsWith("~/"))
    return resolve(process.env.HOME ?? ".", path.slice(2));
  return path;
}

function resolveIncludePattern(pattern: string, basePath: string): string {
  const expanded = expandHome(pattern);
  return isAbsolute(expanded) ? expanded : resolve(dirname(basePath), expanded);
}

function globSegmentToRegExp(segment: string): RegExp {
  const escaped = segment
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

function hasGlob(path: string): boolean {
  return path.includes("*") || path.includes("?");
}

async function expandIncludePath(pattern: string): Promise<string[]> {
  if (!hasGlob(pattern)) return [pattern];

  const { root } = parse(pattern);
  const segments = pattern.slice(root.length).split(sep).filter(Boolean);
  const matches: string[] = [];

  async function walk(base: string, index: number): Promise<void> {
    if (index >= segments.length) {
      matches.push(base);
      return;
    }

    const segment = segments[index]!;
    if (!hasGlob(segment)) {
      await walk(resolve(base, segment), index + 1);
      return;
    }

    const entries = await readdir(base, {
      withFileTypes: true,
      encoding: "utf8",
    }).catch(() => undefined);
    if (!entries) return;

    const pattern = globSegmentToRegExp(segment);
    for (const entry of entries) {
      if (!pattern.test(entry.name)) continue;
      if (index < segments.length - 1 && !entry.isDirectory()) continue;
      await walk(resolve(base, entry.name), index + 1);
    }
  }

  await walk(root || sep, 0);
  return matches.sort();
}

async function collectSshConfigHosts(
  configPath: string,
  seenFiles: Set<string>,
  depth: number,
  required: boolean,
): Promise<string[]> {
  if (depth > MAX_INCLUDE_DEPTH)
    throw new Error("SSH config Include depth exceeded");

  const path = resolve(configPath);
  if (seenFiles.has(path)) return [];
  seenFiles.add(path);

  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (required) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read SSH config ${path}: ${message}`);
    }
    return [];
  }

  const hosts = parseSshConfigHosts(source);
  for (const include of includePatterns(source)) {
    const pattern = resolveIncludePattern(include, path);
    for (const includedPath of await expandIncludePath(pattern)) {
      hosts.push(
        ...(await collectSshConfigHosts(
          includedPath,
          seenFiles,
          depth + 1,
          false,
        )),
      );
    }
  }

  return hosts;
}

export async function loadAllowedSshHosts(
  configPath: string,
): Promise<Set<string>> {
  return new Set(await collectSshConfigHosts(configPath, new Set(), 0, true));
}

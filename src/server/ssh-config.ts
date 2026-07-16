import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, parse, resolve, sep } from "node:path";

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
      if (args.some((arg) => arg.includes("\\"))) {
        throw new Error(
          "SSH config Host patterns with backslash escapes are unsupported",
        );
      }
      flushHostBlock();
      currentPatterns = args;
      currentAliases = args.filter(isExplicitAlias);
      continue;
    }

    if (normalizedKeyword === "match") {
      flushHostBlock();
      if (args.some(isMatchExecCriterion)) {
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

function isMatchExecCriterion(arg: string): boolean {
  const criterion = arg.toLowerCase().split("=")[0]?.replace(/^!+/, "");
  return criterion === "exec";
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
  if (keyword === "pkcs11provider" && args.join(" ").toLowerCase() !== "none")
    return "PKCS11Provider";
  if (
    keyword === "securitykeyprovider" &&
    args.join(" ").toLowerCase() !== "internal"
  )
    return "SecurityKeyProvider";
  return undefined;
}

function lineTokens(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  return tokenizeOpenSshLine(trimmed);
}

interface IncludePattern {
  pattern: string;
  /**
   * Only global-scope Includes contribute aliases, because a Host-scoped
   * Include's contents apply solely to the enclosing block. Host-scoped
   * Includes are still traversed for the unsafe-directive scan: OpenSSH expands
   * them when the alias is used, so skipping them would let a Host block smuggle
   * in a ProxyCommand that runs on connect while the alias stays allowlisted.
   */
  globalScope: boolean;
}

function includePatterns(source: string): IncludePattern[] {
  const patterns: IncludePattern[] = [];
  let globalScope = true;
  for (const line of source.split(/\r?\n/)) {
    const [keyword, ...rest] = lineTokens(line) ?? [];
    const normalizedKeyword = keyword?.toLowerCase();
    if (normalizedKeyword === "host" || normalizedKeyword === "match") {
      globalScope = false;
      continue;
    }
    if (normalizedKeyword === "include") {
      for (const pattern of rest) patterns.push({ pattern, globalScope });
    }
  }
  return patterns;
}

function expandHome(path: string): string {
  if (path === "~") return process.env.HOME ?? path;
  if (path.startsWith("~/"))
    return resolve(process.env.HOME ?? ".", path.slice(2));
  if (path.startsWith("~")) {
    throw new Error(
      "SSH config Include entries with other-user home expansion are unsupported",
    );
  }
  return path;
}

function expandSupportedIncludePattern(pattern: string): string {
  if (/%(?!%)/.test(pattern) || /\$\{[^}]+}/.test(pattern)) {
    throw new Error(
      "SSH config Include entries with OpenSSH tokens or environment variables are unsupported",
    );
  }
  return pattern.replace(/%%/g, "%");
}

function resolveIncludePattern(pattern: string): string {
  const supported = expandSupportedIncludePattern(pattern);
  const userSshDir = resolve(process.env.HOME ?? ".", ".ssh");
  const expanded = expandHome(supported);
  return isAbsolute(expanded) ? expanded : resolve(userSshDir, expanded);
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

    // A missing directory legitimately means "no matches", but EACCES and
    // friends must not masquerade as one: that would quietly drop hosts from
    // the allowlist and leave the user staring at a config that looks correct.
    const entries = await readdir(base, {
      withFileTypes: true,
      encoding: "utf8",
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw new Error(
        `Unable to expand SSH config Include ${base}: ${error.message}`,
      );
    });
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

interface IncludeTraversal {
  /** Cycle guard for Includes that contribute aliases. */
  seenFiles: Set<string>;
  /**
   * Cycle guard for the unsafe-directive scan. Kept separate from `seenFiles`
   * so a Host-scoped Include cannot mark a file as visited and suppress the
   * aliases a later global-scope Include of that same file would contribute.
   */
  scannedFiles: Set<string>;
}

async function readSshConfigSource(
  path: string,
  required: boolean,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // OpenSSH ignores optional Includes that do not resolve, but an existing
    // file we cannot read is a real error: swallowing it would silently drop
    // hosts from the allowlist, or worse, skip an unsafe-directive scan.
    if (!required && (code === "ENOENT" || code === "ENOTDIR"))
      return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read SSH config ${path}: ${message}`);
  }
}

/**
 * Parses an included file purely to enforce the unsafe-directive rules; any
 * aliases it declares are discarded because a Host-scoped Include cannot
 * contribute aliases of its own.
 */
async function scanSshConfigForUnsafeDirectives(
  configPath: string,
  traversal: IncludeTraversal,
  depth: number,
): Promise<void> {
  if (depth > MAX_INCLUDE_DEPTH)
    throw new Error("SSH config Include depth exceeded");

  const path = resolve(configPath);
  if (traversal.scannedFiles.has(path)) return;
  traversal.scannedFiles.add(path);

  const source = await readSshConfigSource(path, false);
  if (source === undefined) return;

  try {
    parseSshConfigHosts(source);
  } catch (error) {
    // Name the file: the directive is nested inside an Include, so the bare
    // message would send the reader looking through the wrong config.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} (in SSH config Include ${path})`);
  }
  for (const include of includePatterns(source)) {
    const pattern = resolveIncludePattern(include.pattern);
    for (const includedPath of await expandIncludePath(pattern)) {
      await scanSshConfigForUnsafeDirectives(
        includedPath,
        traversal,
        depth + 1,
      );
    }
  }
}

async function collectSshConfigHosts(
  configPath: string,
  traversal: IncludeTraversal,
  depth: number,
  required: boolean,
): Promise<string[]> {
  if (depth > MAX_INCLUDE_DEPTH)
    throw new Error("SSH config Include depth exceeded");

  const path = resolve(configPath);
  if (traversal.seenFiles.has(path)) return [];
  traversal.seenFiles.add(path);

  const source = await readSshConfigSource(path, required);
  if (source === undefined) return [];

  const hosts = parseSshConfigHosts(source);
  for (const include of includePatterns(source)) {
    const pattern = resolveIncludePattern(include.pattern);
    for (const includedPath of await expandIncludePath(pattern)) {
      if (include.globalScope) {
        hosts.push(
          ...(await collectSshConfigHosts(
            includedPath,
            traversal,
            depth + 1,
            false,
          )),
        );
        continue;
      }
      await scanSshConfigForUnsafeDirectives(
        includedPath,
        traversal,
        depth + 1,
      );
    }
  }

  return hosts;
}

export async function loadAllowedSshHosts(
  configPath: string,
): Promise<Set<string>> {
  const traversal: IncludeTraversal = {
    seenFiles: new Set(),
    scannedFiles: new Set(),
  };
  return new Set(await collectSshConfigHosts(configPath, traversal, 0, true));
}

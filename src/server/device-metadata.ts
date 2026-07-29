import { readFile } from "node:fs/promises";

export type DeviceDanger = "normal" | "caution" | "danger";

export interface DeviceMetadata {
  label?: string;
  group?: string;
  danger?: DeviceDanger;
  defaultShell?: string;
}

export interface DeviceMetadataConfig {
  devices: Map<string, DeviceMetadata>;
}

function emptyConfig(): DeviceMetadataConfig {
  return { devices: new Map() };
}

function stripComment(line: string): string {
  let quote: '"' | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index - 1] !== "\\")
      quote = quote ? undefined : '"';
    if (!quote && char === "#") return line.slice(0, index);
  }
  return line;
}

function parseStringLiteral(raw: string, lineNumber: number): string {
  const value = raw.trim();
  if (!value.startsWith('"') || !value.endsWith('"')) {
    throw new Error(
      `connexin.toml line ${lineNumber}: values must be quoted strings`,
    );
  }
  try {
    return JSON.parse(value) as string;
  } catch {
    throw new Error(`connexin.toml line ${lineNumber}: invalid string literal`);
  }
}

function parseDeviceHeader(
  raw: string,
  lineNumber: number,
): string | undefined {
  const header = raw.trim();
  if (!header.startsWith("[") || !header.endsWith("]")) return undefined;

  const body = header.slice(1, -1).trim();
  if (!body.startsWith("devices.")) return undefined;

  const alias = body.slice("devices.".length).trim();
  if (alias.startsWith('"') && alias.endsWith('"')) {
    try {
      const parsed = JSON.parse(alias) as unknown;
      if (typeof parsed !== "string") throw new Error("not a string");
      return parsed;
    } catch {
      throw new Error(
        `connexin.toml line ${lineNumber}: invalid device table name`,
      );
    }
  }
  if (/^[A-Za-z0-9_.-]+$/.test(alias)) return alias;
  throw new Error(
    `connexin.toml line ${lineNumber}: invalid device table name`,
  );
}

export function parseConnexinToml(source: string): DeviceMetadataConfig {
  const devices = new Map<string, DeviceMetadata>();
  let currentAlias: string | undefined;
  let inRuntimeTable = false;

  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      if (line === "[runtime]") {
        currentAlias = undefined;
        inRuntimeTable = true;
        continue;
      }

      const headerAlias = parseDeviceHeader(line, lineNumber);
      if (headerAlias !== undefined) {
        currentAlias = headerAlias;
        inRuntimeTable = false;
        if (!devices.has(currentAlias)) devices.set(currentAlias, {});
        continue;
      }

      throw new Error(`connexin.toml line ${lineNumber}: invalid table name`);
    }

    if (inRuntimeTable) continue;

    if (!currentAlias) {
      throw new Error(
        `connexin.toml line ${lineNumber}: expected [devices.<alias>] before key`,
      );
    }

    const separator = line.indexOf("=");
    if (separator === -1)
      throw new Error(
        `connexin.toml line ${lineNumber}: expected key = "value"`,
      );

    const key = line.slice(0, separator).trim();
    const value = parseStringLiteral(line.slice(separator + 1), lineNumber);
    const metadata = devices.get(currentAlias)!;

    if (key === "label") metadata.label = value;
    else if (key === "group") metadata.group = value;
    else if (key === "default_shell") metadata.defaultShell = value;
    else if (key === "danger") {
      if (value !== "normal" && value !== "caution" && value !== "danger") {
        throw new Error("danger must be normal, caution, or danger");
      }
      metadata.danger = value;
    } else {
      throw new Error(`connexin.toml line ${lineNumber}: unknown key ${key}`);
    }
  }

  return { devices };
}

export async function loadDeviceMetadata(
  path: string,
): Promise<DeviceMetadataConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return emptyConfig();
    throw error;
  }
  return parseConnexinToml(source);
}

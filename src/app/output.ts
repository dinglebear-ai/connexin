import { takeLastUtf8Bytes, utf8ByteLength } from "../shared/utf8.js";

export interface SubmitText {
  text: string;
  bytes: number;
  truncated: boolean;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]+/, "Possible OpenAI API key"],
  [/BEGIN OPENSSH PRIVATE KEY/, "Possible SSH private key"],
  [/\bpassword\s*=/i, "Possible password assignment"],
  [/\btoken\s*=/i, "Possible token assignment"],
  [/Authorization:\s*Bearer\s+\S+/i, "Possible bearer token"],
];

const OSC_SEQUENCE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
const STRING_CONTROL_SEQUENCE = /\u001b[PX^_][\s\S]*?\u001b\\/g;
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const C1_CSI_SEQUENCE = /\u009b[0-?]*[ -/]*[@-~]/g;
const ESCAPE_SEQUENCE = /\u001b[ -/]*[@-~]/g;
const CONTROL_CHARACTERS_EXCEPT_TAB_AND_LF =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function normalizeTerminalOutput(output: string): string {
  return output
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(OSC_SEQUENCE, "")
    .replace(STRING_CONTROL_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(C1_CSI_SEQUENCE, "")
    .replace(ESCAPE_SEQUENCE, "")
    .replace(CONTROL_CHARACTERS_EXCEPT_TAB_AND_LF, "");
}

export function truncateForSubmit(
  output: string,
  maxBytes: number,
): SubmitText {
  const bytes = utf8ByteLength(output);
  if (bytes <= maxBytes) {
    return { text: output, bytes, truncated: false };
  }

  return { ...takeLastUtf8Bytes(output, maxBytes), truncated: true };
}

export function findSecretWarnings(output: string): string[] {
  return SECRET_PATTERNS.flatMap(([pattern, warning]) =>
    pattern.test(output) ? [warning] : [],
  );
}

export function buildInsertPayload(command: string): string {
  return command.replace(/[\r\n\u0000-\u0009\u000b-\u001f\u007f]+/g, " ");
}

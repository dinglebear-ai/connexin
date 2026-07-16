import { describe, expect, it } from "vitest";
import {
  buildInsertPayload,
  findSecretWarnings,
  normalizeTerminalOutput,
  truncateForSubmit,
} from "../../src/app/output.js";

describe("normalizeTerminalOutput", () => {
  it("removes common ANSI SGR sequences and normalizes CRLF", () => {
    expect(normalizeTerminalOutput("\u001b[31mred\u001b[0m\r\nnext\rline")).toBe("red\nnext\nline");
  });

  it("removes OSC clipboard, hyperlink, CSI control, BEL, and C1/C0 controls", () => {
    expect(
      normalizeTerminalOutput(
        [
          "safe",
          "\u001b]52;c;c2VjcmV0\u0007",
          "\u001b]8;;https://example.test\u001b\\link\u001b]8;;\u001b\\",
          "\u001b[2K",
          "\u001b[3;4H",
          "\u0007",
          "\u009b31m",
          "\u0000",
          "\n\tkept",
        ].join(""),
      ),
    ).toBe("safelink\n\tkept");
  });
});

describe("truncateForSubmit", () => {
  it("enforces byte cap and reports truncation", () => {
    const result = truncateForSubmit("hello world", 5);

    expect(result.text).toBe("world");
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(5);
  });

  it("truncates on byte boundaries without splitting multibyte text", () => {
    const result = truncateForSubmit("a🙂b", 5);

    expect(result.text).toBe("🙂b");
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(5);
  });

  it("drops a whole multibyte character when only part of it would fit", () => {
    const result = truncateForSubmit("a🙂b", 4);

    expect(result.text).toBe("b");
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(1);
  });
});

describe("findSecretWarnings", () => {
  it("warns for likely secret material", () => {
    const warnings = findSecretWarnings(
      "sk-test\nBEGIN OPENSSH PRIVATE KEY\npassword=hi\ntoken=abc\nAuthorization: Bearer secret",
    );

    expect(warnings).toEqual([
      "Possible OpenAI API key",
      "Possible SSH private key",
      "Possible password assignment",
      "Possible token assignment",
      "Possible bearer token",
    ]);
  });
});

describe("buildInsertPayload", () => {
  it("sanitizes CR/LF and never appends enter", () => {
    expect(buildInsertPayload("echo ok\r\nwhoami")).toBe("echo ok whoami");
    expect(buildInsertPayload("uptime")).not.toMatch(/[\r\n]$/);
  });

  it("preserves user whitespace apart from terminal control characters", () => {
    expect(buildInsertPayload("  printf 'a  b'  ")).toBe("  printf 'a  b'  ");
  });
});

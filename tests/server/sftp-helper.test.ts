import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ChildSftpHelper } from "../../src/server/sftp-helper.js";

function child() {
  const process = new EventEmitter() as any;
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stdio = [
    process.stdin,
    process.stdout,
    new PassThrough(),
    new PassThrough(),
    new PassThrough(),
  ];
  process.exitCode = null;
  process.signalCode = null;
  process.kill = () => true;
  return process;
}

describe("ChildSftpHelper", () => {
  it("correlates sanitized NDJSON responses", async () => {
    const process = child();
    const helper = new ChildSftpHelper(process);
    const pending = helper.request<{ protocol: number }>("hello", {});
    process.stdout.write('{"version":1,"id":1,"data":{"protocol":1}}\n');
    await expect(pending).resolves.toEqual({ protocol: 1 });
  });

  it("rejects stable helper errors", async () => {
    const process = child();
    const helper = new ChildSftpHelper(process);
    const pending = helper.request("list", { path: ".", limit: 10 });
    process.stdout.write('{"version":1,"id":1,"code":"permission_denied"}\n');
    await expect(pending).rejects.toThrow("permission_denied");
  });

  it("bounds pending control requests", async () => {
    const helper = new ChildSftpHelper(child(), 1);
    void helper.request("hello", {});
    await expect(helper.request("hello", {})).rejects.toThrow("queue_full");
  });
});

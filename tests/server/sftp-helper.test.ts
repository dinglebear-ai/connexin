import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ChildSftpHelper } from "../../src/server/sftp-helper.js";

function child() {
  const process = new EventEmitter() as any;
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.stdio = [
    process.stdin,
    process.stdout,
    new PassThrough(),
    new PassThrough(),
    new PassThrough(),
  ];
  process.exitCode = null;
  process.signalCode = null;
  process.kill = vi.fn(() => true);
  return process;
}

describe("ChildSftpHelper", () => {
  it("correlates sanitized NDJSON responses", async () => {
    const process = child();
    const helper = new ChildSftpHelper(process);
    const controlWrites: string[] = [];
    process.stdin.on("data", (chunk: Buffer) =>
      controlWrites.push(chunk.toString("utf8")),
    );
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

  it("drains bounded stderr without blocking protocol readiness", async () => {
    const process = child();
    const helper = new ChildSftpHelper(process);
    process.stderr.write(Buffer.alloc(256 * 1024, 1));
    const pending = helper.request("hello", {});
    process.stdout.write('{"version":1,"id":1,"data":{"protocol":1}}\n');
    await expect(pending).resolves.toEqual({ protocol: 1 });
  });

  it("poisons the helper when an active transfer aborts", async () => {
    const process = child();
    const helper = new ChildSftpHelper(process);
    const controller = new AbortController();
    const pending = helper.upload(
      new PassThrough(),
      { path: "/tmp/a", bytes: 1, overwrite: false },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(helper.request("hello", {})).rejects.toThrow("helper_closed");
  });

  it("cleans transfer abort listeners after a successful transfer", async () => {
    const process = child();
    const helper = new ChildSftpHelper(process);
    const controlWrites: string[] = [];
    process.stdin.on("data", (chunk: Buffer) =>
      controlWrites.push(chunk.toString("utf8")),
    );
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const transfer = helper.upload(
      new PassThrough(),
      { path: "/tmp/b", bytes: 1, overwrite: false },
      controller.signal,
    );

    await vi.waitFor(() => expect(controlWrites.join("")).toContain('"id":1'));
    process.stdout.write('{"version":1,"id":1,"data":{"bytes":1}}\n');
    await expect(transfer).resolves.toEqual({ bytes: 1 });

    expect(add).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenNthCalledWith(1, "abort", expect.any(Function));
  });
});

import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { spawnSftpHelper } from "../src/server/sftp-helper.js";

const [helperPath, sshConfigPath, device] = process.argv.slice(2);
if (!helperPath || !sshConfigPath || !device)
  throw new Error("usage: sftp-integration <helper> <ssh-config> <device>");

const helper = spawnSftpHelper({
  helperPath,
  sshConfigPath,
  device,
  cwd: process.env.HOME,
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  connectTimeoutSeconds: 10,
});
const root = await helper.request<{ path: string }>("root", {});
const directory = `${root.path}/.quick-shell-integration-${randomUUID()}`;
const target = `${directory}/marker.bin`;
const renamed = `${directory}/renamed.bin`;
const first = Buffer.from("first-marker");
const second = Buffer.from("atomic-overwrite-marker");

try {
  await helper.request("mkdir", { path: directory });
  await helper.upload(
    Readable.from(first),
    { path: target, bytes: first.length, overwrite: false },
    new AbortController().signal,
  );
  await expectBytes(target, first);
  let rejected = false;
  try {
    await helper.upload(
      Readable.from(second),
      { path: target, bytes: second.length, overwrite: false },
      new AbortController().signal,
    );
  } catch (error) {
    rejected = error instanceof Error && error.message === "already_exists";
  }
  if (!rejected) throw new Error("unconfirmed overwrite was not rejected");
  await expectBytes(target, first);
  await helper.upload(
    Readable.from(second),
    { path: target, bytes: second.length, overwrite: true },
    new AbortController().signal,
  );
  await expectBytes(target, second);
  await helper.request("rename", {
    from: target,
    to: renamed,
    overwrite: false,
  });
  await helper.request("remove", { path: renamed, directory: false });
  await helper.request("remove", { path: directory, directory: true });
  console.log("real OpenSSH SFTP integration passed");
} finally {
  await helper
    .request("remove", { path: target, directory: false })
    .catch(() => undefined);
  await helper
    .request("remove", { path: renamed, directory: false })
    .catch(() => undefined);
  await helper
    .request("remove", { path: directory, directory: true })
    .catch(() => undefined);
  helper.dispose();
  await helper.drain(2_000);
}

async function expectBytes(path: string, expected: Buffer): Promise<void> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const result = await helper.download(
    sink,
    { path, maxBytes: expected.length },
    new AbortController().signal,
  );
  const actual = Buffer.concat(chunks);
  if (result.bytes !== expected.length || !actual.equals(expected))
    throw new Error("download marker mismatch");
}

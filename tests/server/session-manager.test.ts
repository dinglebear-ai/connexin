import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../../src/server/config.js";
import { QuickShellSessionManager } from "../../src/server/session-manager.js";
import { FakePty } from "./helpers/fake-pty.js";
import { testRuntimeConfig } from "./helpers/runtime-config.js";

function manager(overrides: Partial<RuntimeConfig> = {}) {
  const ptys: FakePty[] = [];
  const calls: Array<{ file: string; args: string[] }> = [];
  const instance = new QuickShellSessionManager({
    config: testRuntimeConfig({ maxScrollbackBytes: 10, maxSessionAgeMs: 1_000, idleGraceMs: 100, ...overrides }),
    allowedHosts: new Set(["fileserver", "admin-box"]),
    ptyFactory: (file, args) => {
      calls.push({ file, args });
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    },
  });
  return { instance, ptys, calls };
}

describe("QuickShellSessionManager", () => {
  it("rejects targets not in the SSH config allowlist", async () => {
    const { instance } = manager();
    await expect(instance.createSession({ device: "unknown" })).rejects.toThrow("not listed in SSH config");
  });

  it("throws when max sessions is reached", async () => {
    const { instance } = manager({ maxSessions: 1 });
    await instance.createSession({ device: "fileserver" });
    await expect(instance.createSession({ device: "admin-box" })).rejects.toThrow("maximum quick-shell sessions");
  });

  it("creates a pending session without spawning ssh", async () => {
    const { instance, ptys, calls } = manager();
    const session = await instance.createSession({ device: "fileserver", suggested: "uptime" });

    expect(session.pty).toBeUndefined();
    expect(calls).toEqual([]);
    expect(ptys).toEqual([]);
  });

  it("starts ssh exactly once when the app attaches and does not write suggested command", async () => {
    const { instance, ptys, calls } = manager();
    const session = await instance.createSession({ device: "fileserver", suggested: "uptime" });
    const started = instance.startSession(session.id);
    const startedAgain = instance.startSession(session.id);

    expect(started).toBe(startedAgain);
    expect(calls).toMatchObject([{ file: "ssh", args: ["fileserver"] }]);
    expect(ptys[0]?.writes).toEqual([]);
  });

  it("stores distinct app and ws tokens outside the public summary", async () => {
    const { instance } = manager();
    const session = await instance.createSession({ device: "fileserver" });
    instance.startSession(session.id);

    expect(session.appToken).toBeTruthy();
    expect(session.wsToken).toBeTruthy();
    expect(session.appToken).not.toBe(session.wsToken);
    expect(session.publicSummary).toEqual({ sessionId: session.id, device: "fileserver" });
  });

  it("caps scrollback and updates activity on PTY data", async () => {
    const { instance, ptys } = manager({ maxScrollbackBytes: 5 });
    const session = await instance.createSession({ device: "fileserver" });
    instance.startSession(session.id);
    const before = session.lastActivityAt;

    ptys[0]?.emitData("hello world");

    expect(session.scrollback.toString()).toBe("world");
    expect(session.lastActivityAt).toBeGreaterThanOrEqual(before);
  });

  it("caps scrollback without splitting multibyte text", async () => {
    const { instance, ptys } = manager({ maxScrollbackBytes: 5 });
    const session = await instance.createSession({ device: "fileserver" });
    instance.startSession(session.id);

    ptys[0]?.emitData("a🙂b");

    expect(session.scrollback.toString()).toBe("🙂b");
  });

  it("records explicit activity", async () => {
    const { instance } = manager();
    const session = await instance.createSession({ device: "fileserver" });
    session.lastActivityAt = 1;

    expect(instance.recordActivity(session.id)).toBe(true);
    expect(session.lastActivityAt).toBeGreaterThan(1);
  });

  it("kills PTY and disposes listeners on close", async () => {
    const { instance, ptys } = manager();
    const session = await instance.createSession({ device: "fileserver" });
    instance.startSession(session.id);
    const pty = ptys[0]!;

    expect(pty.data.listenerCount("data")).toBe(1);
    instance.closeSession(session.id);

    expect(pty.killed).toBe(true);
    expect(pty.data.listenerCount("data")).toBe(0);
    expect(instance.getSession(session.id)).toBeUndefined();
  });

  it("cleans sessions past max age or idle grace", async () => {
    const { instance, ptys } = manager({ maxSessionAgeMs: 1_000, idleGraceMs: 100 });
    const old = await instance.createSession({ device: "fileserver" });
    const idle = await instance.createSession({ device: "admin-box" });
    instance.startSession(old.id);
    instance.startSession(idle.id);
    old.createdAt = 0;
    old.lastActivityAt = 900;
    idle.createdAt = 1_500;
    idle.lastActivityAt = 1_800;

    const closed = instance.cleanupExpiredSessions(2_000);

    expect(closed).toBe(2);
    expect(ptys.every((pty) => pty.killed)).toBe(true);
  });

  it("kills every PTY on closeAll", async () => {
    const { instance, ptys } = manager();
    const first = await instance.createSession({ device: "fileserver" });
    const second = await instance.createSession({ device: "admin-box" });
    instance.startSession(first.id);
    instance.startSession(second.id);

    instance.closeAll();

    expect(ptys.every((pty) => pty.killed)).toBe(true);
  });
});

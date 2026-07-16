import { describe, expect, it, vi } from "vitest";
import type { AuditLogger } from "../../src/server/audit-log.js";
import type { RuntimeConfig } from "../../src/server/config.js";
import {
  QuickShellSessionManager,
  type PtyFactory,
} from "../../src/server/session-manager.js";
import { FakePty } from "./helpers/fake-pty.js";
import { testRuntimeConfig } from "./helpers/runtime-config.js";

function manager(
  overrides: Partial<RuntimeConfig> = {},
  options: { audit?: AuditLogger; ptyFactory?: PtyFactory } = {},
) {
  const ptys: FakePty[] = [];
  const calls: Array<{ file: string; args: string[] }> = [];
  const instance = new QuickShellSessionManager({
    config: testRuntimeConfig({
      maxScrollbackBytes: 10,
      maxSessionAgeMs: 1_000,
      idleGraceMs: 100,
      ...overrides,
    }),
    allowedHosts: new Set(["fileserver", "admin-box"]),
    audit: options.audit,
    ptyFactory:
      options.ptyFactory ??
      ((file, args) => {
        calls.push({ file, args });
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      }),
  });
  return { instance, ptys, calls };
}

describe("QuickShellSessionManager", () => {
  it("rejects targets not in the SSH config allowlist", async () => {
    const { instance } = manager();
    await expect(instance.createSession({ device: "unknown" })).rejects.toThrow(
      "not listed in SSH config",
    );
  });

  it("throws when max sessions is reached", async () => {
    const { instance } = manager({ maxSessions: 1 });
    await instance.createSession({ device: "fileserver" });
    await expect(
      instance.createSession({ device: "admin-box" }),
    ).rejects.toThrow("maximum quick-shell sessions");
  });

  it("creates a pending session without spawning ssh", async () => {
    const { instance, ptys, calls } = manager();
    const session = await instance.createSession({
      device: "fileserver",
      suggested: "uptime",
    });

    expect(session.pty).toBeUndefined();
    expect(calls).toEqual([]);
    expect(ptys).toEqual([]);
  });

  it("starts ssh exactly once when the app attaches and does not write suggested command", async () => {
    const { instance, ptys, calls } = manager();
    const session = await instance.createSession({
      device: "fileserver",
      suggested: "uptime",
    });
    const started = instance.startSession(session.id);
    const startedAgain = instance.startSession(session.id);

    expect(started).toBe(startedAgain);
    expect(calls).toMatchObject([
      { file: "ssh", args: ["-F", "/tmp/config", "fileserver"] },
    ]);
    expect(ptys[0]?.writes).toEqual([]);
  });

  it("stores distinct app and ws tokens outside the public summary", async () => {
    const { instance } = manager();
    const session = await instance.createSession({ device: "fileserver" });
    instance.startSession(session.id);

    expect(session.appToken).toBeTruthy();
    expect(session.wsToken).toBeTruthy();
    expect(session.appToken).not.toBe(session.wsToken);
    expect(session.publicSummary).toEqual({
      sessionId: session.id,
      device: "fileserver",
    });
  });

  it("caps scrollback and updates activity on PTY data", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { instance, ptys } = manager({ maxScrollbackBytes: 5 });
    try {
      const session = await instance.createSession({ device: "fileserver" });
      instance.startSession(session.id);
      const before = session.lastActivityAt;
      vi.setSystemTime(before + 1_000);

      ptys[0]?.emitData("hello world");

      expect(session.scrollback.toString()).toBe("world");
      expect(session.lastActivityAt).toBe(before + 1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps scrollback without splitting multibyte text", async () => {
    const { instance, ptys } = manager({ maxScrollbackBytes: 5 });
    const session = await instance.createSession({ device: "fileserver" });
    instance.startSession(session.id);

    ptys[0]?.emitData("a🙂b");

    expect(session.scrollback.toString()).toBe("🙂b");
  });

  it("returns reset snapshot metadata when polling from a stale cursor", async () => {
    const { instance, ptys } = manager({ maxScrollbackBytes: 5 });
    const session = await instance.createSession({ device: "fileserver" });
    instance.startSession(session.id);

    ptys[0]?.emitData("abcde");
    ptys[0]?.emitData("fghij");
    ptys[0]?.emitData("k");

    const poll = instance.pollSession(session.id, 1);

    expect(poll).toMatchObject({
      reset: true,
      resetReason: "stale_cursor",
      nextSeq: 3,
      snapshot: "ghijk",
      snapshotBytes: 5,
      snapshotSeq: 3,
      droppedBeforeSeq: 2,
    });
    expect(poll?.chunks).toEqual([]);
  });

  it("snapshot-resets an initial poll after older chunks were evicted", async () => {
    const { instance, ptys } = manager({ maxScrollbackBytes: 5 });
    const session = await instance.createSession({ device: "fileserver" });
    instance.startSession(session.id);

    ptys[0]?.emitData("abcde");
    ptys[0]?.emitData("fghij");

    const poll = instance.pollSession(session.id, 0);

    expect(poll).toMatchObject({
      reset: true,
      resetReason: "stale_cursor",
      nextSeq: 2,
      snapshot: "fghij",
      snapshotBytes: 5,
      snapshotSeq: 2,
      droppedBeforeSeq: 1,
    });
    expect(poll?.chunks).toEqual([]);
  });

  it("retains oversized polling chunks as truncated tail output", async () => {
    const { instance, ptys } = manager({ maxScrollbackBytes: 5 });
    const session = await instance.createSession({ device: "fileserver" });
    instance.startSession(session.id);

    ptys[0]?.emitData("hello world");

    const poll = instance.pollSession(session.id, 0);

    expect(poll).toMatchObject({
      reset: true,
      resetReason: "truncated_output",
      nextSeq: 1,
      truncatedBytes: 6,
    });
    expect(poll?.chunks).toEqual([
      {
        seq: 1,
        data: "world",
        truncated: true,
        originalBytes: 11,
        retainedBytes: 5,
      },
    ]);
  });

  it("truncates polling chunks on UTF-8 code point boundaries", async () => {
    const { instance, ptys } = manager({ maxScrollbackBytes: 5 });
    const session = await instance.createSession({ device: "fileserver" });
    instance.startSession(session.id);

    ptys[0]?.emitData("a🙂b");

    const poll = instance.pollSession(session.id, 0);

    expect(poll?.chunks).toEqual([
      {
        seq: 1,
        data: "🙂b",
        truncated: true,
        originalBytes: 6,
        retainedBytes: 5,
      },
    ]);
    expect(poll?.truncatedBytes).toBe(1);
  });

  it("records explicit activity", async () => {
    const { instance } = manager();
    const session = await instance.createSession({ device: "fileserver" });
    session.lastActivityAt = 1;

    expect(instance.recordActivity(session.id)).toBe(true);
    expect(session.lastActivityAt).toBeGreaterThan(1);
  });

  it("disposes the data listener when exit listener registration fails", async () => {
    const pty = new FakePty();
    vi.spyOn(pty, "onExit").mockImplementation(() => {
      throw new Error("exit registration failed");
    });
    const { instance } = manager({}, { ptyFactory: () => pty });
    const session = await instance.createSession({ device: "fileserver" });

    expect(() => instance.startSession(session.id)).toThrow(
      "exit registration failed",
    );
    expect(pty.data.listenerCount("data")).toBe(0);
    expect(pty.killed).toBe(true);
    expect(session.disposables).toEqual([]);
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

  it("isolates throwing audit sinks across create, start, and close", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const audit: AuditLogger = {
      record: vi.fn(() => {
        throw new Error("audit failed");
      }),
    };
    try {
      const { instance, ptys } = manager({}, { audit });

      const session = await instance.createSession({ device: "fileserver" });
      expect(instance.getSession(session.id)).toBe(session);

      const started = instance.startSession(session.id);
      expect(started?.pty).toBe(ptys[0]);

      expect(instance.closeSession(session.id)).toBe(true);
      expect(ptys[0]?.killed).toBe(true);
      expect(instance.getSession(session.id)).toBeUndefined();
      expect(audit.record).toHaveBeenCalledTimes(3);
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("retains non-writable PTY ownership and retries after kill throws", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const record = vi.fn();
      const { instance, ptys } = manager({}, { audit: { record } });
      const session = await instance.createSession({ device: "fileserver" });
      instance.startSession(session.id);
      const pty = ptys[0]!;
      const closed = vi.fn();
      instance.onSessionClosed(closed);
      let killAttempts = 0;
      pty.kill = () => {
        killAttempts += 1;
        if (killAttempts === 1) throw new Error("kill failed");
        pty.killed = true;
      };

      expect(instance.closeSession(session.id)).toBe(false);
      expect(instance.getSession(session.id)).toBe(session);
      expect(session.pty).toBe(pty);
      expect(session.closing).toBe(true);
      expect(instance.writeInput(session.id, "whoami\n")).toEqual({
        written: false,
        reason: "closing",
      });
      expect(instance.resizeSession(session.id, 80, 24)).toEqual({
        resized: false,
        reason: "closing",
      });
      // Restarting a closing session would spawn a second ssh PTY and orphan
      // the one whose kill just failed.
      expect(instance.startSession(session.id)).toBeUndefined();
      expect(session.pty).toBe(pty);
      expect(pty.data.listenerCount("data")).toBe(0);
      expect(pty.exit.listenerCount("exit")).toBe(0);
      expect(session.disposables).toEqual([]);
      expect(closed).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalledWith(
        "session_closed",
        expect.anything(),
      );

      expect(instance.closeSession(session.id)).toBe(true);

      expect(killAttempts).toBe(2);
      expect(pty.killed).toBe(true);
      expect(instance.getSession(session.id)).toBeUndefined();
      expect(session.pty).toBeUndefined();
      expect(closed).toHaveBeenCalledOnce();
      expect(record).toHaveBeenCalledWith(
        "session_closed",
        expect.objectContaining({ sessionId: session.id }),
      );
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("notifies all close listeners after session removal even when one throws", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const { instance } = manager();
      const session = await instance.createSession({ device: "fileserver" });
      const calls: Array<{ id: string; removed: boolean; listener: string }> =
        [];
      instance.onSessionClosed((sessionId) => {
        calls.push({
          id: sessionId,
          removed: instance.getSession(sessionId) === undefined,
          listener: "first",
        });
        throw new Error("listener failed");
      });
      instance.onSessionClosed((sessionId) => {
        calls.push({
          id: sessionId,
          removed: instance.getSession(sessionId) === undefined,
          listener: "second",
        });
      });

      expect(instance.closeSession(session.id)).toBe(true);

      expect(calls).toEqual([
        { id: session.id, removed: true, listener: "first" },
        { id: session.id, removed: true, listener: "second" },
      ]);
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("cleans sessions past max age or idle grace", async () => {
    const { instance, ptys } = manager({
      maxSessionAgeMs: 1_000,
      idleGraceMs: 100,
    });
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

  it("continues cleanupExpiredSessions when one session cleanup throws", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const { instance, ptys } = manager({
        maxSessionAgeMs: 1_000,
        idleGraceMs: 100,
      });
      const first = await instance.createSession({ device: "fileserver" });
      const second = await instance.createSession({ device: "admin-box" });
      instance.startSession(first.id);
      instance.startSession(second.id);
      first.createdAt = 0;
      first.lastActivityAt = 0;
      second.createdAt = 0;
      second.lastActivityAt = 0;
      ptys[0]!.kill = () => {
        ptys[0]!.killed = true;
        throw new Error("kill failed");
      };

      const closed = instance.cleanupExpiredSessions(2_000);

      expect(closed).toBe(1);
      expect(ptys.every((pty) => pty.killed)).toBe(true);
      expect(instance.getSession(first.id)).toBe(first);
      expect(instance.getSession(second.id)).toBeUndefined();
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
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

  it("continues closeAll when one session cleanup throws", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const { instance, ptys } = manager();
      const first = await instance.createSession({ device: "fileserver" });
      const second = await instance.createSession({ device: "admin-box" });
      instance.startSession(first.id);
      instance.startSession(second.id);
      ptys[0]!.kill = () => {
        ptys[0]!.killed = true;
        throw new Error("kill failed");
      };

      instance.closeAll();

      expect(ptys.every((pty) => pty.killed)).toBe(true);
      expect(instance.getSession(first.id)).toBe(first);
      expect(instance.getSession(second.id)).toBeUndefined();
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

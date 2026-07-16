import { EventEmitter } from "node:events";
import type { PtyProcess } from "../../../src/server/session-manager.js";

export class FakePty implements PtyProcess {
  readonly data = new EventEmitter();
  readonly exit = new EventEmitter();
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;

  onData(listener: (data: string) => void): { dispose(): void } {
    this.data.on("data", listener);
    return { dispose: () => this.data.off("data", listener) };
  }

  onExit(listener: (event: { exitCode: number | null }) => void): { dispose(): void } {
    this.exit.on("exit", listener);
    return { dispose: () => this.exit.off("exit", listener) };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
  }

  emitData(data: string): void {
    this.data.emit("data", data);
  }

  emitExit(exitCode: number | null): void {
    this.exit.emit("exit", { exitCode });
  }
}

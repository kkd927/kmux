import { EventEmitter } from "node:events";
import { fork, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Id,
  PtyEvent,
  PtyRequest,
  SurfaceSnapshotPayload,
  TerminalKeyInput
} from "@kmux/proto";
import { makeId } from "@kmux/proto";

export class PtyHostManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private readonly pendingSnapshots = new Map<
    string,
    (payload: SurfaceSnapshotPayload | null) => void
  >();

  start(): void {
    if (this.child) {
      return;
    }

    const currentDir = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(currentDir, "../../../..");
    const devEntry = resolve(repoRoot, "apps/desktop/src/pty-host/index.ts");
    const buildEntry = resolve(
      repoRoot,
      "apps/desktop/dist/pty-host/index.cjs"
    );

    this.child = fork(
      process.env.NODE_ENV === "production" ? buildEntry : devEntry,
      [],
      {
        cwd: repoRoot,
        execArgv:
          process.env.NODE_ENV === "production" ? [] : ["--import", "tsx"],
        stdio: ["inherit", "inherit", "inherit", "ipc"]
      }
    );

    this.child.on("message", (event: PtyEvent) => {
      if (event.type === "snapshot") {
        const resolver = this.pendingSnapshots.get(event.requestId);
        if (resolver) {
          this.pendingSnapshots.delete(event.requestId);
          resolver(event.payload);
        }
        return;
      }
      this.emit("event", event);
    });

    this.child.on("exit", () => {
      this.child = null;
      this.emit("event", {
        type: "error",
        message: "pty-host exited unexpectedly"
      } satisfies PtyEvent);
    });
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }

  send(message: PtyRequest): void {
    this.child?.send(message);
  }

  snapshot(
    sessionId: Id,
    surfaceId: Id
  ): Promise<SurfaceSnapshotPayload | null> {
    const requestId = makeId("snapshot");
    this.send({
      type: "snapshot",
      sessionId,
      surfaceId,
      requestId
    });
    return new Promise((resolve) => {
      this.pendingSnapshots.set(requestId, resolve);
      setTimeout(() => {
        const pending = this.pendingSnapshots.get(requestId);
        if (pending) {
          this.pendingSnapshots.delete(requestId);
          pending(null);
        }
      }, 500);
    });
  }

  resize(sessionId: Id, cols: number, rows: number): void {
    this.send({ type: "resize", sessionId, cols, rows });
  }

  sendText(sessionId: Id, text: string): void {
    this.send({ type: "input:text", sessionId, text });
  }

  sendKey(sessionId: Id, input: TerminalKeyInput): void {
    this.send({ type: "input:key", sessionId, input });
  }
}

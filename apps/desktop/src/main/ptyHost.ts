import { EventEmitter } from "node:events";
import { type ChildProcess, fork } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Id,
  PtyEvent,
  PtyRequest,
  SurfaceSnapshotOptions,
  SurfaceSnapshotPayload,
  TerminalKeyInput
} from "@kmux/proto";
import { makeId } from "@kmux/proto";

export interface PtyHostLaunchOptions {
  cwd: string;
  entry: string;
  execArgv: string[];
}

export function resolvePtyHostLaunchOptions(
  currentDir: string,
  nodeEnv: string | undefined = process.env.NODE_ENV,
  resourcesPath: string | undefined = process.resourcesPath
): PtyHostLaunchOptions {
  const asarSegment = `${sep}app.asar${sep}`;
  const isPackagedApp = currentDir.includes(asarSegment);

  if (isPackagedApp && resourcesPath) {
    return {
      entry: join(resourcesPath, "app.asar.unpacked/dist/pty-host/index.cjs"),
      cwd: resourcesPath,
      execArgv: []
    };
  }

  const repoRoot = resolve(currentDir, "../../../..");
  if (nodeEnv === "production") {
    return {
      entry: resolve(repoRoot, "apps/desktop/dist/pty-host/index.cjs"),
      cwd: repoRoot,
      execArgv: []
    };
  }

  return {
    entry: resolve(repoRoot, "apps/desktop/src/pty-host/index.ts"),
    cwd: repoRoot,
    execArgv: ["--import", "tsx"]
  };
}

const RESIZE_ACK_TIMEOUT_MS = 2000;

export class PtyHostManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private stopping = false;
  private readonly readySessions = new Set<Id>();
  private readonly pendingSnapshots = new Map<
    string,
    (payload: SurfaceSnapshotPayload | null) => void
  >();
  private readonly pendingResizes = new Map<string, () => void>();
  private readonly queuedRequests = new Map<Id, PtyRequest[]>();

  constructor(private readonly forkProcess: typeof fork = fork) {
    super();
  }

  start(env: NodeJS.ProcessEnv = process.env): void {
    if (this.child) {
      return;
    }

    const currentDir = dirname(fileURLToPath(import.meta.url));
    const launchOptions = resolvePtyHostLaunchOptions(currentDir);

    const child = this.forkProcess(launchOptions.entry, [], {
      cwd: launchOptions.cwd,
      execArgv: launchOptions.execArgv,
      env,
      stdio: ["inherit", "inherit", "inherit", "ipc"]
    });
    this.child = child;
    this.stopping = false;

    child.on("message", (event: PtyEvent) => {
      if (event.type === "snapshot") {
        const resolver = this.pendingSnapshots.get(event.requestId);
        if (resolver) {
          this.pendingSnapshots.delete(event.requestId);
          resolver(event.payload);
        }
        return;
      }
      if (event.type === "resize:ack") {
        const resolver = this.pendingResizes.get(event.requestId);
        if (resolver) {
          this.pendingResizes.delete(event.requestId);
          resolver();
        }
        return;
      }
      if (event.type === "spawned") {
        this.readySessions.add(event.sessionId);
        this.flushQueuedRequests(event.sessionId);
      }
      if (event.type === "exit" || event.type === "error") {
        const sessionId =
          event.type === "exit" ? event.payload.sessionId : event.sessionId;
        if (sessionId) {
          this.readySessions.delete(sessionId);
          this.queuedRequests.delete(sessionId);
        }
      }
      this.emit("event", event);
    });

    child.on("exit", () => {
      const expectedExit = this.stopping;
      this.stopping = false;
      if (this.child === child) {
        this.child = null;
      }
      this.readySessions.clear();
      this.queuedRequests.clear();
      this.flushPendingResizes();
      if (expectedExit) {
        return;
      }
      this.emit("event", {
        type: "error",
        message: "pty-host exited unexpectedly"
      } satisfies PtyEvent);
    });

    child.on("error", (error) => {
      this.emit("event", {
        type: "error",
        message: `pty-host failed to start: ${error.message}`
      } satisfies PtyEvent);
    });
  }

  stop(): void {
    if (!this.child) {
      return;
    }
    this.stopping = true;
    this.child.kill();
    this.child = null;
    this.readySessions.clear();
    this.queuedRequests.clear();
    this.flushPendingResizes();
  }

  send(message: PtyRequest): void {
    const child = this.child;
    if (!child || !child.connected) {
      this.emit("event", {
        type: "error",
        message: "pty-host IPC channel is not available"
      } satisfies PtyEvent);
      return;
    }

    try {
      child.send(message);
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : String(error);
      this.emit("event", {
        type: "error",
        message: `pty-host IPC send failed: ${messageText}`
      } satisfies PtyEvent);
    }
  }

  snapshot(
    sessionId: Id,
    surfaceId: Id,
    options: SurfaceSnapshotOptions = {}
  ): Promise<SurfaceSnapshotPayload | null> {
    const requestId = makeId("snapshot");
    const settleForMs = normalizeSettleDuration(options.settleForMs);
    const timeoutMs = normalizeSnapshotTimeout(options.timeoutMs, settleForMs);
    const request = {
      type: "snapshot",
      sessionId,
      surfaceId,
      requestId,
      ...(settleForMs > 0 ? { settleForMs } : {})
    } satisfies PtyRequest;
    this.sendWhenReady(sessionId, request);
    return new Promise((resolve) => {
      this.pendingSnapshots.set(requestId, resolve);
      setTimeout(() => {
        const pending = this.pendingSnapshots.get(requestId);
        if (pending) {
          this.pendingSnapshots.delete(requestId);
          pending(null);
        }
      }, timeoutMs);
    });
  }

  resize(sessionId: Id, cols: number, rows: number): Promise<void> {
    const requestId = makeId("resize");
    const request: PtyRequest = {
      type: "resize",
      sessionId,
      cols,
      rows,
      requestId
    };
    return new Promise((resolve) => {
      this.pendingResizes.set(requestId, resolve);
      const timeout = setTimeout(() => {
        const pending = this.pendingResizes.get(requestId);
        if (pending) {
          this.pendingResizes.delete(requestId);
          pending();
        }
      }, RESIZE_ACK_TIMEOUT_MS);
      if (typeof timeout === "object" && timeout && "unref" in timeout) {
        timeout.unref();
      }
      this.sendWhenReady(sessionId, request);
    });
  }

  private flushPendingResizes(): void {
    const resolvers = Array.from(this.pendingResizes.values());
    this.pendingResizes.clear();
    for (const resolve of resolvers) {
      resolve();
    }
  }

  sendText(sessionId: Id, text: string): void {
    this.sendWhenReady(sessionId, { type: "input:text", sessionId, text });
  }

  sendKey(sessionId: Id, input: TerminalKeyInput): void {
    this.sendWhenReady(sessionId, { type: "input:key", sessionId, input });
  }

  private sendWhenReady(sessionId: Id, message: PtyRequest): void {
    if (this.readySessions.has(sessionId)) {
      this.send(message);
      return;
    }
    const queued = this.queuedRequests.get(sessionId) ?? [];
    queued.push(message);
    this.queuedRequests.set(sessionId, queued);
  }

  private flushQueuedRequests(sessionId: Id): void {
    const queued = this.queuedRequests.get(sessionId);
    if (!queued || queued.length === 0) {
      return;
    }
    this.queuedRequests.delete(sessionId);
    for (const request of queued) {
      this.send(request);
    }
  }
}

function normalizeSettleDuration(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function normalizeSnapshotTimeout(
  value: number | undefined,
  settleForMs: number
): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(250, Math.round(value));
  }
  return Math.max(2000, settleForMs + 1500);
}

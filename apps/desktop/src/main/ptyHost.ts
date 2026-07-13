import { EventEmitter } from "node:events";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ForkOptions, MessagePortMain, UtilityProcess } from "electron";

import type {
  Id,
  SurfaceSnapshotOptions,
  SurfaceSnapshotPayload,
  TerminalSessionRef,
  TerminalKeyInput
} from "@kmux/proto";
import { makeId } from "@kmux/proto";
import type { PtyEvent, PtyRequest } from "../shared/ptyProtocol";
import {
  applyDiagnosticsLogPath,
  DIAGNOSTICS_LOG_PATH_ENV,
  PTY_STDOUT_LOGS_ENV,
  resolveDiagnosticsLogPath
} from "../shared/diagnostics";
import {
  KMUX_PROFILE_LOG_PATH_ENV,
  isSmoothnessProfileLogPathAllowed
} from "../shared/smoothnessProfile";

export interface PtyHostLaunchOptions {
  cwd: string;
  entry: string;
  execArgv: string[];
  enableStdoutLogs: boolean;
}

export function resolvePtyHostLaunchOptions(
  currentDir: string,
  nodeEnv: string | undefined = process.env.NODE_ENV,
  resourcesPath: string | undefined = process.resourcesPath,
  stdoutLogs?: string
): PtyHostLaunchOptions {
  const asarSegment = `${sep}app.asar${sep}`;
  const isPackagedApp = currentDir.includes(asarSegment);

  if (isPackagedApp && resourcesPath) {
    return {
      entry: join(resourcesPath, "app.asar.unpacked/dist/pty-host/index.cjs"),
      cwd: resourcesPath,
      execArgv: [],
      enableStdoutLogs: false
    };
  }

  const repoRoot = resolve(currentDir, "../../../..");
  if (nodeEnv === "production") {
    return {
      entry: resolve(repoRoot, "apps/desktop/dist/pty-host/index.cjs"),
      cwd: repoRoot,
      execArgv: [],
      enableStdoutLogs: false
    };
  }

  return {
    entry: resolve(repoRoot, "apps/desktop/src/pty-host/dev-entry.cjs"),
    cwd: repoRoot,
    execArgv: [],
    enableStdoutLogs: stdoutLogs === "1"
  };
}

const SHUTDOWN_ACK_TIMEOUT_MS = 2000;

export type ForkPtyHostProcess = (
  modulePath: string,
  args?: string[],
  options?: ForkOptions
) => UtilityProcess;

interface PendingStop {
  child: UtilityProcess;
  requestId: Id;
  promise: Promise<void>;
  resolve: () => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class PtyHostManager extends EventEmitter {
  private child: UtilityProcess | null = null;
  private intentionallyStopped = false;
  private lastStartEnv: NodeJS.ProcessEnv | null = null;
  private pendingStop: PendingStop | null = null;
  private readonly expectedExits = new WeakSet<UtilityProcess>();
  private readonly readySessions = new Set<Id>();
  private readonly inputReadySessions = new Set<Id>();
  private readonly exitedSessions = new Set<Id>();
  private readonly pendingSnapshots = new Map<
    string,
    {
      sessionId: Id;
      resolve: (payload: SurfaceSnapshotPayload | null) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly queuedRequests = new Map<Id, PtyRequest[]>();
  private readonly queuedInputRequests = new Map<Id, PtyRequest[]>();
  private readonly sessionRefs = new Map<Id, TerminalSessionRef>();
  constructor(private readonly forkProcess: ForkPtyHostProcess) {
    super();
  }

  start(env: NodeJS.ProcessEnv = process.env): void {
    if (this.child) {
      return;
    }

    this.intentionallyStopped = false;
    this.lastStartEnv = { ...env };

    const currentDir = dirname(fileURLToPath(import.meta.url));
    const launchOptions = resolvePtyHostLaunchOptions(
      currentDir,
      process.env.NODE_ENV,
      process.resourcesPath,
      env[PTY_STDOUT_LOGS_ENV]
    );
    const diagnosticsLogPath = resolveDiagnosticsLogPath(
      env[DIAGNOSTICS_LOG_PATH_ENV]
    );
    const smoothnessProfileLogPath = env[KMUX_PROFILE_LOG_PATH_ENV]?.trim();
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      [PTY_STDOUT_LOGS_ENV]: launchOptions.enableStdoutLogs ? "1" : "0"
    };
    if (diagnosticsLogPath) {
      childEnv[DIAGNOSTICS_LOG_PATH_ENV] = diagnosticsLogPath;
    } else {
      delete childEnv[DIAGNOSTICS_LOG_PATH_ENV];
    }
    if (isSmoothnessProfileLogPathAllowed(smoothnessProfileLogPath)) {
      childEnv[KMUX_PROFILE_LOG_PATH_ENV] = smoothnessProfileLogPath;
    } else {
      delete childEnv[KMUX_PROFILE_LOG_PATH_ENV];
    }

    let child: UtilityProcess;
    try {
      child = this.forkProcess(launchOptions.entry, [], {
        cwd: launchOptions.cwd,
        execArgv: launchOptions.execArgv,
        env: childEnv as Record<string, string>,
        stdio: ["ignore", "inherit", "inherit"],
        serviceName: "kmux PTY Supervisor"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("event", {
        type: "error",
        message: `pty-host failed to start: ${message}`
      } satisfies PtyEvent);
      return;
    }
    this.child = child;

    child.on("message", (event: PtyEvent) => {
      if (event.type === "shutdown:ack") {
        const pendingStop = this.pendingStop;
        if (
          pendingStop?.child === child &&
          pendingStop.requestId === event.requestId
        ) {
          this.completeStop(pendingStop, true);
        }
        return;
      }
      if (event.type === "snapshot") {
        this.resolvePendingSnapshot(event.requestId, event.payload);
        return;
      }
      if (event.type === "spawned") {
        this.readySessions.add(event.sessionId);
        this.flushQueuedRequests(event.sessionId);
        if (event.shellInputReady) {
          this.inputReadySessions.add(event.sessionId);
          this.flushQueuedInputRequests(event.sessionId);
        }
      }
      if (event.type === "shell.ready") {
        this.inputReadySessions.add(event.sessionId);
        this.flushQueuedInputRequests(event.sessionId);
      }
      if (event.type === "exit") {
        const sessionId = event.payload.sessionId;
        this.exitedSessions.add(sessionId);
        this.inputReadySessions.delete(sessionId);
        this.queuedInputRequests.delete(sessionId);
      } else if (event.type === "error") {
        const sessionId = event.sessionId;
        if (sessionId) {
          this.sessionRefs.delete(sessionId);
          this.exitedSessions.delete(sessionId);
          this.readySessions.delete(sessionId);
          this.inputReadySessions.delete(sessionId);
          this.queuedRequests.delete(sessionId);
          this.queuedInputRequests.delete(sessionId);
          this.flushPendingSnapshotsForSession(sessionId);
        }
      }
      this.emit("event", event);
    });

    child.on("exit", () => {
      const expectedExit = this.expectedExits.has(child);
      const lostSessions = expectedExit
        ? []
        : [...this.sessionRefs.values()]
            .filter((session) => !this.exitedSessions.has(session.sessionId))
            .map((session) => ({ ...session }));
      this.expectedExits.delete(child);
      const pendingStop = this.pendingStop;
      if (pendingStop?.child === child) {
        this.completeStop(pendingStop, false);
      }
      if (this.child === child) {
        this.child = null;
        this.clearRuntimeState();
      }
      if (expectedExit) {
        return;
      }
      if (lostSessions.length > 0) {
        this.emit("event", {
          type: "runtime.lost",
          sessions: lostSessions
        } satisfies PtyEvent);
      }
      this.emit("event", {
        type: "error",
        message: "pty-host exited unexpectedly"
      } satisfies PtyEvent);
    });

    child.on("error", (type, location) => {
      this.emit("event", {
        type: "error",
        message: `pty-host utility process failed: ${type}${
          location ? ` at ${location}` : ""
        }`
      } satisfies PtyEvent);
    });
  }

  configureDiagnosticsLogPath(logPath: string | undefined): boolean {
    const resolvedLogPath = resolveDiagnosticsLogPath(logPath);
    if (this.lastStartEnv) {
      applyDiagnosticsLogPath(this.lastStartEnv, resolvedLogPath);
    }

    const child = this.child;
    if (!child) {
      return true;
    }

    try {
      child.postMessage({
        type: "diagnostics.configure",
        ...(resolvedLogPath ? { logPath: resolvedLogPath } : {})
      } satisfies PtyRequest);
      return true;
    } catch {
      return false;
    }
  }

  stop(): Promise<void> {
    this.intentionallyStopped = true;
    this.clearRuntimeState();

    const child = this.child;
    if (!child) {
      return Promise.resolve();
    }
    if (this.pendingStop?.child === child) {
      return this.pendingStop.promise;
    }

    const requestId = makeId("shutdown");
    let resolveStop!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    const timeout = setTimeout(() => {
      const pendingStop = this.pendingStop;
      if (pendingStop?.child === child) {
        this.completeStop(pendingStop, true);
      }
    }, SHUTDOWN_ACK_TIMEOUT_MS);
    if (typeof timeout === "object" && timeout && "unref" in timeout) {
      timeout.unref();
    }
    const pendingStop: PendingStop = {
      child,
      requestId,
      promise,
      resolve: resolveStop,
      timeout
    };
    this.pendingStop = pendingStop;
    this.expectedExits.add(child);

    try {
      child.postMessage({ type: "shutdown", requestId } satisfies PtyRequest);
    } catch {
      this.completeStop(pendingStop, true);
    }

    return promise;
  }

  private completeStop(pendingStop: PendingStop, terminate: boolean): void {
    if (this.pendingStop !== pendingStop) {
      return;
    }
    this.pendingStop = null;
    clearTimeout(pendingStop.timeout);
    if (this.child === pendingStop.child) {
      this.child = null;
    }
    if (terminate) {
      try {
        pendingStop.child.kill();
      } catch {
        // The process may have exited between its acknowledgement and kill().
      }
    }
    pendingStop.resolve();
  }

  private clearRuntimeState(): void {
    this.readySessions.clear();
    this.inputReadySessions.clear();
    this.exitedSessions.clear();
    this.queuedRequests.clear();
    this.queuedInputRequests.clear();
    this.sessionRefs.clear();
    this.flushPendingSnapshots();
  }

  send(message: PtyRequest): void {
    let child = this.child;
    if (
      !child &&
      message.type === "spawn" &&
      !this.intentionallyStopped &&
      this.lastStartEnv
    ) {
      this.start(this.lastStartEnv);
      child = this.child;
    }
    if (!child) {
      this.reportRequestDeliveryFailure(
        message,
        "pty-host IPC channel is not available"
      );
      return;
    }

    try {
      child.postMessage(message);
      if (message.type === "spawn") {
        this.exitedSessions.delete(message.spec.sessionId);
        this.sessionRefs.set(message.spec.sessionId, {
          surfaceId: message.spec.surfaceId,
          sessionId: message.spec.sessionId,
          epoch: message.spec.runtimeEpoch
        });
      } else if (message.type === "close") {
        this.sessionRefs.delete(message.sessionId);
        this.exitedSessions.delete(message.sessionId);
      }
    } catch (error) {
      if (message.type === "spawn") {
        this.sessionRefs.delete(message.spec.sessionId);
        this.exitedSessions.delete(message.spec.sessionId);
      } else if (message.type === "close") {
        this.sessionRefs.delete(message.sessionId);
        this.exitedSessions.delete(message.sessionId);
      }
      const messageText =
        error instanceof Error ? error.message : String(error);
      this.reportRequestDeliveryFailure(
        message,
        `pty-host IPC send failed: ${messageText}`
      );
    }
  }

  private reportRequestDeliveryFailure(
    request: PtyRequest,
    message: string
  ): void {
    const sessionId = requestSessionId(request);
    this.emit("event", {
      type: "error",
      ...(sessionId ? { sessionId } : {}),
      message
    } satisfies PtyEvent);

    if (request.type !== "spawn") {
      return;
    }

    // The utility host reports an exit after a PTY spawn failure. Mirror that
    // contract when the spawn request itself cannot reach the utility process,
    // so restored sessions leave "pending" instead of waiting forever.
    this.emit("event", {
      type: "exit",
      payload: {
        surfaceId: request.spec.surfaceId,
        sessionId: request.spec.sessionId
      }
    } satisfies PtyEvent);
  }

  sessionRef(surfaceId: Id, sessionId: Id): TerminalSessionRef | null {
    const session = this.sessionRefs.get(sessionId);
    if (!session || session.surfaceId !== surfaceId) {
      return null;
    }
    return { ...session };
  }

  bindTerminalStream(
    attachId: Id,
    session: TerminalSessionRef,
    port: MessagePortMain
  ): boolean {
    const current = this.sessionRef(session.surfaceId, session.sessionId);
    const child = this.child;
    if (!child || !current || current.epoch !== session.epoch) {
      return false;
    }
    try {
      child.postMessage(
        { type: "stream.bind", attachId, session } satisfies PtyRequest,
        [port]
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("event", {
        type: "error",
        sessionId: session.sessionId,
        message: `pty-host terminal stream bind failed: ${message}`
      } satisfies PtyEvent);
      return false;
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
      ...(settleForMs > 0 ? { settleForMs } : {}),
      ...(options.includeRawOutputTail ? { includeRawOutputTail: true } : {})
    } satisfies PtyRequest;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.resolvePendingSnapshot(requestId, null);
      }, timeoutMs);
      if (typeof timeout === "object" && timeout && "unref" in timeout) {
        timeout.unref();
      }
      this.pendingSnapshots.set(requestId, {
        sessionId,
        resolve,
        timeout
      });
      this.sendWhenReady(sessionId, request);
    });
  }

  private resolvePendingSnapshot(
    requestId: string,
    payload: SurfaceSnapshotPayload | null
  ): void {
    const pending = this.pendingSnapshots.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingSnapshots.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve(payload);
  }

  private flushPendingSnapshots(): void {
    const pendingSnapshots = Array.from(this.pendingSnapshots.values());
    this.pendingSnapshots.clear();
    for (const pending of pendingSnapshots) {
      clearTimeout(pending.timeout);
      pending.resolve(null);
    }
  }

  private flushPendingSnapshotsForSession(sessionId: Id): void {
    for (const [requestId, pending] of [...this.pendingSnapshots.entries()]) {
      if (pending.sessionId !== sessionId) {
        continue;
      }
      this.pendingSnapshots.delete(requestId);
      clearTimeout(pending.timeout);
      pending.resolve(null);
    }
  }

  sendText(sessionId: Id, text: string): void {
    this.sendWhenInputReady(sessionId, { type: "input:text", sessionId, text });
  }

  sendKey(sessionId: Id, input: TerminalKeyInput): void {
    this.sendWhenInputReady(sessionId, { type: "input:key", sessionId, input });
  }

  private sendWhenInputReady(sessionId: Id, message: PtyRequest): void {
    if (this.inputReadySessions.has(sessionId)) {
      this.send(message);
      return;
    }
    const queued = this.queuedInputRequests.get(sessionId) ?? [];
    queued.push(message);
    this.queuedInputRequests.set(sessionId, queued);
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

  private flushQueuedInputRequests(sessionId: Id): void {
    const queued = this.queuedInputRequests.get(sessionId);
    if (!queued || queued.length === 0) {
      return;
    }
    this.queuedInputRequests.delete(sessionId);
    for (const request of queued) {
      this.send(request);
    }
  }
}

function requestSessionId(request: PtyRequest): Id | undefined {
  switch (request.type) {
    case "spawn":
      return request.spec.sessionId;
    case "close":
    case "input:text":
    case "input:key":
    case "snapshot":
      return request.sessionId;
    case "stream.bind":
      return request.session.sessionId;
    case "diagnostics.configure":
    case "shutdown":
      return undefined;
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

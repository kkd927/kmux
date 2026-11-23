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
import type {
  PtyEvent,
  PtyGenerationRef,
  PtyRequest
} from "../shared/ptyProtocol";
import type { DiagnosticsRecord } from "../shared/diagnostics";
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
const DIAGNOSTICS_CONFIGURATION_ACK_TIMEOUT_MS = 2000;

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

interface PendingSessionClose {
  session: TerminalSessionRef;
  resolve: (
    outcome: "terminated" | "already-exited" | "input-observed"
  ) => void;
  reject: (error: Error) => void;
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
  private readonly sessionPids = new Map<Id, number>();
  private readonly pendingSessionPids = new Map<
    Id,
    Array<{
      resolve: (pid: number) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }>
  >();
  private readonly commandExitResults = new Map<
    Id,
    Extract<PtyEvent, { type: "orchestration.command.exit" }>
  >();
  private readonly pendingCommandExits = new Map<
    Id,
    {
      session: PtyGenerationRef;
      resolve: (
        event: Extract<PtyEvent, { type: "orchestration.command.exit" }>
      ) => void;
      reject: (error: Error) => void;
      timeout?: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly pendingDiagnosticsConfigurations = new Map<
    Id,
    {
      resolve: (configured: boolean) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly pendingSessionCloses = new Map<Id, PendingSessionClose>();
  private readonly pendingOrchestrationControls = new Map<
    Id,
    {
      resolve: (event: PtyEvent) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
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
      if (event.type === "diagnostics.batch") {
        this.emit("diagnostics", event.records satisfies DiagnosticsRecord[]);
        return;
      }
      if (
        event.type === "diagnostics.configured" ||
        event.type === "diagnostics.flushed"
      ) {
        this.completeDiagnosticsRequest(event.requestId, true);
        return;
      }
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
      if (
        event.type === "agent.readiness.ack" ||
        event.type === "input.delivery.ack" ||
        event.type === "input.delivery.status"
      ) {
        this.resolveOrchestrationControl(event.requestId, event);
        return;
      }
      if (event.type === "close.ack") {
        const pending = this.pendingSessionCloses.get(event.requestId);
        if (!pending) return;
        this.pendingSessionCloses.delete(event.requestId);
        clearTimeout(pending.timeout);
        if (
          event.sessionId !== pending.session.sessionId ||
          event.surfaceId !== pending.session.surfaceId ||
          event.runtimeEpoch !== pending.session.epoch ||
          event.outcome === "generation-mismatch"
        ) {
          pending.reject(
            new Error("local session close acknowledgement generation differs")
          );
          return;
        }
        if (event.outcome !== "input-observed") {
          this.sessionRefs.delete(event.sessionId);
          this.exitedSessions.delete(event.sessionId);
          this.rejectCommandExitWaiters(event.sessionId);
        }
        pending.resolve(event.outcome);
        return;
      }
      if (event.type === "history.ready") {
        this.readySessions.add(event.sessionId);
        this.flushQueuedRequests(event.sessionId);
      }
      if (event.type === "spawned") {
        this.sessionPids.set(event.sessionId, event.pid);
        for (const pending of this.pendingSessionPids.get(event.sessionId) ??
          []) {
          clearTimeout(pending.timeout);
          pending.resolve(event.pid);
        }
        this.pendingSessionPids.delete(event.sessionId);
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
      if (event.type === "orchestration.command.exit") {
        const pending = this.pendingCommandExits.get(event.operationId);
        if (pending) {
          this.pendingCommandExits.delete(event.operationId);
          clearTimeout(pending.timeout);
          if (
            pending.session.sessionId !== event.session.sessionId ||
            pending.session.surfaceId !== event.session.surfaceId ||
            pending.session.runtimeEpoch !== event.session.runtimeEpoch
          ) {
            pending.reject(
              new Error(
                "managed command exit came from another terminal generation"
              )
            );
          } else {
            pending.resolve(event);
          }
        } else {
          this.commandExitResults.set(event.operationId, event);
        }
      }
      if (event.type === "exit") {
        const sessionId = event.payload.sessionId;
        this.rejectCommandExitWaiters(sessionId);
        this.exitedSessions.add(sessionId);
        this.inputReadySessions.delete(sessionId);
        this.queuedInputRequests.delete(sessionId);
      } else if (event.type === "error") {
        const sessionId = event.sessionId;
        if (sessionId) {
          this.rejectCommandExitWaiters(sessionId);
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

  configureDiagnosticsLogPath(logPath: string | undefined): Promise<boolean> {
    const resolvedLogPath = resolveDiagnosticsLogPath(logPath);
    if (this.lastStartEnv) {
      applyDiagnosticsLogPath(this.lastStartEnv, resolvedLogPath);
    }

    const child = this.child;
    if (!child) {
      return Promise.resolve(true);
    }

    const requestId = makeId("diagnostics");
    const configured = this.waitForDiagnosticsRequest(requestId);
    try {
      child.postMessage({
        type: "diagnostics.configure",
        requestId,
        ...(resolvedLogPath ? { logPath: resolvedLogPath } : {})
      } satisfies PtyRequest);
      return configured;
    } catch {
      this.completeDiagnosticsRequest(requestId, false);
      return Promise.resolve(false);
    }
  }

  flushDiagnostics(): Promise<boolean> {
    const child = this.child;
    if (!child) {
      return Promise.resolve(true);
    }
    const requestId = makeId("diagnostics");
    const flushed = this.waitForDiagnosticsRequest(requestId);
    try {
      child.postMessage({
        type: "diagnostics.flush",
        requestId
      } satisfies PtyRequest);
      return flushed;
    } catch {
      this.completeDiagnosticsRequest(requestId, false);
      return Promise.resolve(false);
    }
  }

  private waitForDiagnosticsRequest(requestId: Id): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.completeDiagnosticsRequest(requestId, false);
      }, DIAGNOSTICS_CONFIGURATION_ACK_TIMEOUT_MS);
      timeout.unref?.();
      this.pendingDiagnosticsConfigurations.set(requestId, {
        resolve,
        timeout
      });
    });
  }

  private completeDiagnosticsRequest(requestId: Id, completed: boolean): void {
    const pending = this.pendingDiagnosticsConfigurations.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingDiagnosticsConfigurations.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve(completed);
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
    for (const pending of this.pendingDiagnosticsConfigurations.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    }
    this.pendingDiagnosticsConfigurations.clear();
    for (const pending of this.pendingSessionCloses.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        new Error("pty-host exited before local session close acknowledgement")
      );
    }
    this.pendingSessionCloses.clear();
    for (const pending of this.pendingOrchestrationControls.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        new Error(
          "pty-host exited before orchestration control acknowledgement"
        )
      );
    }
    this.pendingOrchestrationControls.clear();
    this.rejectCommandExitWaiters();
    this.commandExitResults.clear();
    this.flushPendingSnapshots();
  }

  private rejectCommandExitWaiters(sessionId?: Id): void {
    for (const [operationId, pending] of this.pendingCommandExits) {
      if (sessionId !== undefined && pending.session.sessionId !== sessionId)
        continue;
      this.pendingCommandExits.delete(operationId);
      clearTimeout(pending.timeout);
      pending.reject(
        new Error("managed command session ended before an exit receipt")
      );
    }
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
      } else if (
        message.type === "close" &&
        message.expectedRuntimeEpoch === undefined
      ) {
        this.sessionRefs.delete(message.sessionId);
        this.exitedSessions.delete(message.sessionId);
      }
    } catch (error) {
      if (message.type === "spawn") {
        this.sessionRefs.delete(message.spec.sessionId);
        this.exitedSessions.delete(message.spec.sessionId);
      } else if (
        message.type === "close" &&
        message.expectedRuntimeEpoch === undefined
      ) {
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
    if (request.type === "close" && request.requestId) {
      const pending = this.pendingSessionCloses.get(request.requestId);
      if (pending) {
        this.pendingSessionCloses.delete(request.requestId);
        clearTimeout(pending.timeout);
        pending.reject(new Error(message));
      }
    }
    if (
      (request.type === "agent.readiness.register" ||
        request.type === "input:orchestrated" ||
        request.type === "input:delivery.query") &&
      request.requestId
    ) {
      const pending = this.pendingOrchestrationControls.get(request.requestId);
      if (pending) {
        this.pendingOrchestrationControls.delete(request.requestId);
        clearTimeout(pending.timeout);
        pending.reject(new Error(message));
      }
    }
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

  closeSessionGeneration(
    session: TerminalSessionRef,
    timeoutMs?: number
  ): Promise<"terminated" | "already-exited">;
  closeSessionGeneration(
    session: TerminalSessionRef,
    timeoutMs: number,
    preserveIfDirectInputAfter: string
  ): Promise<"terminated" | "already-exited" | "input-observed">;
  closeSessionGeneration(
    session: TerminalSessionRef,
    timeoutMs = 10_000,
    preserveIfDirectInputAfter?: string
  ): Promise<"terminated" | "already-exited" | "input-observed"> {
    const current = this.sessionRef(session.surfaceId, session.sessionId);
    if (!current) return Promise.resolve("already-exited");
    if (current.epoch !== session.epoch) {
      return Promise.reject(
        new Error("local session generation changed before conversion cleanup")
      );
    }
    const requestId = makeId("pty-close");
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingSessionCloses.delete(requestId)) {
          reject(new Error("local session close acknowledgement timed out"));
        }
      }, timeoutMs);
      this.pendingSessionCloses.set(requestId, {
        session: { ...session },
        resolve,
        reject,
        timeout
      });
      this.send({
        type: "close",
        requestId,
        sessionId: session.sessionId,
        surfaceId: session.surfaceId,
        expectedRuntimeEpoch: session.epoch,
        ...(preserveIfDirectInputAfter ? { preserveIfDirectInputAfter } : {})
      });
    });
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

  waitForInputReady(
    session: TerminalSessionRef,
    timeoutMs = 30_000
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        this.off("event", check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        const current = this.sessionRef(session.surfaceId, session.sessionId);
        if (
          !this.child ||
          current?.epoch !== session.epoch ||
          this.exitedSessions.has(session.sessionId)
        ) {
          finish(
            new Error(
              "terminal generation changed before shell input became ready"
            )
          );
        } else if (this.inputReadySessions.has(session.sessionId)) {
          finish();
        }
      };
      const timeout = setTimeout(
        () => finish(new Error("timed out waiting for shell input readiness")),
        timeoutMs
      );
      timeout.unref?.();
      this.on("event", check);
      check();
    });
  }

  registerAgentReadiness(input: {
    session: PtyGenerationRef;
    authorityRef: Id;
    receiptId: Id;
    agentId: Id;
    agentInstanceId: Id;
    readyEpoch: Id;
  }): Promise<Extract<PtyEvent, { type: "agent.readiness.ack" }>> {
    return this.sendOrchestrationControl({
      type: "agent.readiness.register",
      requestId: makeId("pty-agent-ready"),
      ...input
    });
  }

  sessionPid(sessionId: Id): number | undefined {
    return this.sessionPids.get(sessionId);
  }

  waitForSessionPid(sessionId: Id, timeoutMs = 10_000): Promise<number> {
    const existing = this.sessionPids.get(sessionId);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingSessionPids.get(sessionId) ?? [];
        this.pendingSessionPids.set(
          sessionId,
          pending.filter((entry) => entry.resolve !== resolve)
        );
        reject(new Error("timed out waiting for managed terminal process"));
      }, timeoutMs);
      timeout.unref?.();
      const pending = this.pendingSessionPids.get(sessionId) ?? [];
      pending.push({ resolve, reject, timeout });
      this.pendingSessionPids.set(sessionId, pending);
    });
  }

  waitForCommandExit(input: {
    operationId: Id;
    session: PtyGenerationRef;
    timeoutMs?: number;
  }): Promise<Extract<PtyEvent, { type: "orchestration.command.exit" }>> {
    const existing = this.commandExitResults.get(input.operationId);
    if (existing) {
      this.commandExitResults.delete(input.operationId);
      if (
        existing.session.sessionId !== input.session.sessionId ||
        existing.session.surfaceId !== input.session.surfaceId ||
        existing.session.runtimeEpoch !== input.session.runtimeEpoch
      ) {
        return Promise.reject(
          new Error(
            "managed command result belongs to another terminal generation"
          )
        );
      }
      return Promise.resolve(existing);
    }
    if (this.pendingCommandExits.has(input.operationId)) {
      return Promise.reject(
        new Error("managed command exit already has a waiter")
      );
    }
    return new Promise((resolve, reject) => {
      const timeout =
        input.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pendingCommandExits.delete(input.operationId);
              reject(new Error("timed out waiting for managed command exit"));
            }, input.timeoutMs);
      timeout?.unref?.();
      this.pendingCommandExits.set(input.operationId, {
        session: input.session,
        resolve,
        reject,
        timeout
      });
    });
  }

  deliverOrchestratedInput(input: {
    session: PtyGenerationRef;
    authorityRef: Id;
    readinessReceiptId: Id;
    readyEpoch: Id;
    operationId: Id;
    payloadHash: string;
    text: string;
    verificationText: string;
    encoding?: "orchestration-result-json";
  }): Promise<Extract<PtyEvent, { type: "input.delivery.ack" }>> {
    return this.sendOrchestrationControl(
      {
        type: "input:orchestrated",
        requestId: makeId("pty-delivery"),
        ...input
      },
      true
    );
  }

  queryOrchestratedDelivery(input: {
    session: PtyGenerationRef;
    operationId: Id;
    payloadHash: string;
  }): Promise<Extract<PtyEvent, { type: "input.delivery.status" }>> {
    return this.sendOrchestrationControl({
      type: "input:delivery.query",
      requestId: makeId("pty-delivery-query"),
      ...input
    });
  }

  private sendOrchestrationControl<
    TEvent extends Extract<
      PtyEvent,
      {
        type:
          | "agent.readiness.ack"
          | "input.delivery.ack"
          | "input.delivery.status";
      }
    >
  >(request: PtyRequest, requireInputReady = false): Promise<TEvent> {
    const requestId =
      "requestId" in request && typeof request.requestId === "string"
        ? request.requestId
        : undefined;
    const sessionId = requestSessionId(request);
    if (!requestId || !sessionId) {
      return Promise.reject(
        new Error("orchestration PTY control requires request and session IDs")
      );
    }
    return new Promise<TEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingOrchestrationControls.delete(requestId);
        this.removeQueuedRequest(requestId);
        reject(
          new Error("timed out waiting for orchestration PTY acknowledgement")
        );
      }, 5_000);
      this.pendingOrchestrationControls.set(requestId, {
        resolve: (event) => {
          if (!isMatchingOrchestrationControlAck(request, event)) {
            reject(
              new Error(
                "orchestration PTY acknowledgement does not match its request"
              )
            );
            return;
          }
          resolve(event as TEvent);
        },
        reject,
        timeout
      });
      if (requireInputReady) {
        this.sendWhenInputReady(sessionId, request);
      } else {
        this.sendWhenReady(sessionId, request);
      }
    });
  }

  private resolveOrchestrationControl(requestId: Id, event: PtyEvent): void {
    const pending = this.pendingOrchestrationControls.get(requestId);
    if (!pending) return;
    this.pendingOrchestrationControls.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve(event);
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

  private removeQueuedRequest(requestId: Id): void {
    for (const queue of [this.queuedRequests, this.queuedInputRequests]) {
      for (const [sessionId, requests] of queue) {
        const remaining = requests.filter(
          (request) =>
            !("requestId" in request && request.requestId === requestId)
        );
        if (remaining.length === requests.length) continue;
        if (remaining.length === 0) queue.delete(sessionId);
        else queue.set(sessionId, remaining);
      }
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
    case "agent.readiness.register":
    case "input:orchestrated":
    case "input:delivery.query":
    case "snapshot":
      return "session" in request
        ? request.session.sessionId
        : request.sessionId;
    case "stream.bind":
      return request.session.sessionId;
    case "diagnostics.configure":
    case "diagnostics.flush":
    case "shutdown":
      return undefined;
  }
}

function isMatchingOrchestrationControlAck(
  request: PtyRequest,
  event: PtyEvent
): boolean {
  if (
    !("requestId" in request) ||
    !("requestId" in event) ||
    request.requestId !== event.requestId
  ) {
    return false;
  }
  if (
    request.type === "agent.readiness.register" &&
    event.type === "agent.readiness.ack"
  ) {
    return (
      sameGeneration(request.session, event.session) &&
      request.receiptId === event.receiptId
    );
  }
  if (
    request.type === "input:orchestrated" &&
    event.type === "input.delivery.ack"
  ) {
    return (
      sameGeneration(request.session, event.session) &&
      request.operationId === event.operationId &&
      request.payloadHash === event.payloadHash
    );
  }
  if (
    request.type === "input:delivery.query" &&
    event.type === "input.delivery.status"
  ) {
    return (
      sameGeneration(request.session, event.session) &&
      request.operationId === event.operationId &&
      request.payloadHash === event.payloadHash
    );
  }
  return false;
}

function sameGeneration(
  left: PtyGenerationRef,
  right: PtyGenerationRef
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.surfaceId === right.surfaceId &&
    left.runtimeEpoch === right.runtimeEpoch
  );
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

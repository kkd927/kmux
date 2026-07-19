import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import type {
  ChildProcess,
  ChildProcessWithoutNullStreams
} from "node:child_process";

import {
  createOpenSshEnvironment,
  OpenSshProcessError,
  runOpenSshCommand,
  validateHostAlias
} from "./openSshProcess";

const MASTER_START_TIMEOUT_MS = 30_000;
const MASTER_STOP_TIMEOUT_MS = 5_000;
const MASTER_DIAGNOSTIC_LIMIT_BYTES = 256 * 1024;
const CONSERVATIVE_UNIX_SOCKET_PATH_BYTES = 96;
const PARENT_DEATH_GUARD_CANCEL_TIMEOUT_MS = 2_000;
const PARENT_DEATH_GUARD_FINAL_WAIT_MS = 250;
const PARENT_DEATH_GUARD_SCRIPT = `
watched_pid=$1
ready_socket=$2
shift 2
if IFS= read -r command && [ "$command" = cancel ]; then
  exit 0
fi
attempt=0
while kill -0 "$watched_pid" 2>/dev/null && [ ! -S "$ready_socket" ] && [ "$attempt" -lt 300 ]; do
  attempt=$((attempt + 1))
  sleep 0.1
done
if kill -0 "$watched_pid" 2>/dev/null && [ -S "$ready_socket" ]; then
  "$@" >/dev/null 2>&1 &
  cleanup_pid=$!
  (
    attempt=0
    while kill -0 "$cleanup_pid" 2>/dev/null && [ "$attempt" -lt 50 ]; do
      attempt=$((attempt + 1))
      sleep 0.1
    done
    if kill -0 "$cleanup_pid" 2>/dev/null; then
      kill -TERM "$cleanup_pid" 2>/dev/null || true
      sleep 1
      kill -KILL "$cleanup_pid" 2>/dev/null || true
    fi
  ) &
  watchdog_pid=$!
  wait "$cleanup_pid" 2>/dev/null
  cleanup_status=$?
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  exit "$cleanup_status"
fi
exit 0
`;

export type SshTransportPoolErrorCode =
  | "invalid-request"
  | "attempt-conflict"
  | "attempt-missing"
  | "target-policy-mismatch"
  | "master-start-failed"
  | "master-closed";

export class SshTransportPoolError extends Error {
  readonly code: SshTransportPoolErrorCode;

  constructor(
    code: SshTransportPoolErrorCode,
    message: string,
    options: { cause?: unknown } = {}
  ) {
    super(message, options);
    this.name = "SshTransportPoolError";
    this.code = code;
  }
}

export interface SshMasterLaunchRequest {
  connectionAttemptId: string;
  effectiveConnectionPolicyHash: string;
  sshPath: string;
  configPath: string;
  host: string;
  controlRoot?: string;
  askpassPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunningSshMaster {
  readonly connectionAttemptId: string;
  readonly effectiveConnectionPolicyHash: string;
  readonly generation: string;
  readonly controlPath: string;
  readonly sshPath: string;
  readonly configPath: string;
  readonly host: string;
  readonly closed: Promise<void>;
  isRunning(): boolean;
  check(): Promise<void>;
  stop(): Promise<void>;
}

export interface ParentDeathGuard {
  readonly closed: Promise<void>;
  wasCancelled(): boolean;
  cancel(): Promise<void>;
  /** Explicitly closes the owner lease; used by crash harnesses. */
  cleanupNow(): Promise<void>;
}

export type SshMasterFactory = (
  request: SshMasterLaunchRequest
) => Promise<RunningSshMaster>;

export interface AssignedSshMaster {
  targetId: string;
  effectiveConnectionPolicyHash: string;
  generation: string;
  master: RunningSshMaster;
}

export interface SshTargetLostEvent {
  targetId: string;
  masterGeneration: string;
  code: "master-closed";
  message: string;
}

interface ProvisionalEntry {
  policyHash: string;
  launchHash: string;
  masterPromise: Promise<RunningSshMaster>;
}

export class SshTransportPool {
  private readonly provisional = new Map<string, ProvisionalEntry>();
  /**
   * Masters that have completed transport setup but whose remote authority is
   * still being verified. They are intentionally absent from `assigned`, so
   * no target-scoped feature channel can resolve them before Main chooses the
   * immutable target ID.
   */
  private readonly verifying = new Map<string, AssignedSshMaster>();
  private readonly assigned = new Map<string, AssignedSshMaster>();
  private readonly targetLostListeners = new Set<
    (event: SshTargetLostEvent) => void
  >();
  private closing = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly masterFactory: SshMasterFactory = startOpenSshControlMaster
  ) {}

  async connectProvisional(
    request: SshMasterLaunchRequest
  ): Promise<RunningSshMaster> {
    this.assertOpen();
    validatePoolKey(request.connectionAttemptId, "connectionAttemptId");
    validatePolicyHash(request.effectiveConnectionPolicyHash);
    const launchHash = hashMasterLaunch(request);
    const existing = this.provisional.get(request.connectionAttemptId);
    if (existing) {
      if (
        existing.policyHash !== request.effectiveConnectionPolicyHash ||
        existing.launchHash !== launchHash
      ) {
        throw new SshTransportPoolError(
          "attempt-conflict",
          "connection attempt was reused with another effective policy or launch boundary"
        );
      }
      return await this.requireOpenMaster(existing.masterPromise);
    }

    const masterPromise = this.masterFactory(request).catch(
      (error: unknown) => {
        const current = this.provisional.get(request.connectionAttemptId);
        if (current?.masterPromise === masterPromise) {
          this.provisional.delete(request.connectionAttemptId);
        }
        throw error;
      }
    );
    this.provisional.set(request.connectionAttemptId, {
      policyHash: request.effectiveConnectionPolicyHash,
      launchHash,
      masterPromise
    });
    return await this.requireOpenMaster(masterPromise);
  }

  async promote(options: {
    connectionAttemptId: string;
    targetId: string;
    effectiveConnectionPolicyHash: string;
  }): Promise<AssignedSshMaster> {
    this.assertOpen();
    validatePoolKey(options.connectionAttemptId, "connectionAttemptId");
    validatePoolKey(options.targetId, "targetId");
    validatePolicyHash(options.effectiveConnectionPolicyHash);
    const provisional = this.provisional.get(options.connectionAttemptId);
    if (!provisional) {
      throw new SshTransportPoolError(
        "attempt-missing",
        "connection attempt is not provisional"
      );
    }
    if (provisional.policyHash !== options.effectiveConnectionPolicyHash) {
      throw new SshTransportPoolError(
        "attempt-conflict",
        "promotion policy does not match the provisional master"
      );
    }
    const candidate = await provisional.masterPromise;
    if (this.closing || this.closed) {
      await candidate.stop();
      throw new SshTransportPoolError(
        "master-closed",
        "transport pool closed while the provisional master was starting"
      );
    }
    const assignmentForCandidate = [...this.assigned.values()].find(
      (entry) => entry.generation === candidate.generation
    );
    if (assignmentForCandidate) {
      this.provisional.delete(options.connectionAttemptId);
      if (assignmentForCandidate.targetId !== options.targetId) {
        throw new SshTransportPoolError(
          "attempt-conflict",
          "one provisional master cannot be promoted to more than one target"
        );
      }
      return assignmentForCandidate;
    }
    const existing = this.assigned.get(options.targetId);
    if (!existing) {
      if (!candidate.isRunning()) {
        this.provisional.delete(options.connectionAttemptId);
        throw new SshTransportPoolError(
          "master-closed",
          "provisional master closed before target assignment"
        );
      }
      const assigned = {
        targetId: options.targetId,
        effectiveConnectionPolicyHash: options.effectiveConnectionPolicyHash,
        generation: candidate.generation,
        master: candidate
      } satisfies AssignedSshMaster;
      this.assigned.set(options.targetId, assigned);
      this.watchAssignedMaster(assigned);
      this.provisional.delete(options.connectionAttemptId);
      return assigned;
    }

    this.provisional.delete(options.connectionAttemptId);
    if (
      existing.effectiveConnectionPolicyHash !==
      options.effectiveConnectionPolicyHash
    ) {
      await candidate.stop();
      throw new SshTransportPoolError(
        "target-policy-mismatch",
        "verified target already has a master for another effective policy; explicit re-verification is required"
      );
    }
    if (!existing.master.isRunning()) {
      await candidate.stop();
      throw new SshTransportPoolError(
        "master-closed",
        "assigned target master is closed and must be reconciled before promotion"
      );
    }
    if (candidate.generation !== existing.generation) {
      await candidate.stop();
    }
    return existing;
  }

  async beginAuthorityVerification(options: {
    connectionAttemptId: string;
    verificationId: string;
    effectiveConnectionPolicyHash: string;
  }): Promise<AssignedSshMaster> {
    this.assertOpen();
    validatePoolKey(options.connectionAttemptId, "connectionAttemptId");
    validatePoolKey(options.verificationId, "verificationId");
    validatePolicyHash(options.effectiveConnectionPolicyHash);
    const provisional = this.provisional.get(options.connectionAttemptId);
    if (!provisional) {
      throw new SshTransportPoolError(
        "attempt-missing",
        "connection attempt is not provisional"
      );
    }
    if (provisional.policyHash !== options.effectiveConnectionPolicyHash) {
      throw new SshTransportPoolError(
        "attempt-conflict",
        "authority verification policy does not match the provisional master"
      );
    }
    if (this.verifying.has(options.verificationId)) {
      throw new SshTransportPoolError(
        "attempt-conflict",
        "authority verification ID is already active"
      );
    }
    const candidate = await provisional.masterPromise;
    if (this.closing || this.closed || !candidate.isRunning()) {
      this.provisional.delete(options.connectionAttemptId);
      await candidate.stop().catch(() => undefined);
      throw new SshTransportPoolError(
        "master-closed",
        "provisional master closed before authority verification"
      );
    }
    this.provisional.delete(options.connectionAttemptId);
    const verifying = {
      // `targetId` is a private verification key until promotion. It is never
      // returned by getAssigned or accepted by product operations.
      targetId: options.verificationId,
      effectiveConnectionPolicyHash: options.effectiveConnectionPolicyHash,
      generation: candidate.generation,
      master: candidate
    } satisfies AssignedSshMaster;
    this.verifying.set(options.verificationId, verifying);
    return verifying;
  }

  async promoteAuthorityVerification(options: {
    verificationId: string;
    targetId: string;
    effectiveConnectionPolicyHash: string;
  }): Promise<AssignedSshMaster> {
    this.assertOpen();
    validatePoolKey(options.verificationId, "verificationId");
    validatePoolKey(options.targetId, "targetId");
    validatePolicyHash(options.effectiveConnectionPolicyHash);
    const verifying = this.verifying.get(options.verificationId);
    if (!verifying) {
      throw new SshTransportPoolError(
        "attempt-missing",
        "authority verification is not active"
      );
    }
    if (
      verifying.effectiveConnectionPolicyHash !==
      options.effectiveConnectionPolicyHash
    ) {
      throw new SshTransportPoolError(
        "attempt-conflict",
        "authority verification policy changed before promotion"
      );
    }
    this.verifying.delete(options.verificationId);
    const existing = this.assigned.get(options.targetId);
    if (existing) {
      if (
        existing.effectiveConnectionPolicyHash !==
        options.effectiveConnectionPolicyHash
      ) {
        await verifying.master.stop();
        throw new SshTransportPoolError(
          "target-policy-mismatch",
          "verified target already has a master for another effective policy; explicit re-verification is required"
        );
      }
      if (!existing.master.isRunning()) {
        await verifying.master.stop();
        throw new SshTransportPoolError(
          "master-closed",
          "assigned target master is closed and must be reconciled before promotion"
        );
      }
      if (existing.generation !== verifying.generation) {
        await verifying.master.stop();
      }
      return existing;
    }
    if (!verifying.master.isRunning()) {
      throw new SshTransportPoolError(
        "master-closed",
        "verified provisional master closed before target promotion"
      );
    }
    const assigned = {
      ...verifying,
      targetId: options.targetId
    } satisfies AssignedSshMaster;
    this.assigned.set(options.targetId, assigned);
    this.watchAssignedMaster(assigned);
    return assigned;
  }

  async discardAuthorityVerification(verificationId: string): Promise<void> {
    validatePoolKey(verificationId, "verificationId");
    const verifying = this.verifying.get(verificationId);
    if (!verifying) return;
    this.verifying.delete(verificationId);
    await verifying.master.stop();
  }

  getAssigned(targetId: string): AssignedSshMaster | undefined {
    return this.assigned.get(targetId);
  }

  onTargetLost(listener: (event: SshTargetLostEvent) => void): {
    dispose(): void;
  } {
    this.targetLostListeners.add(listener);
    return {
      dispose: () => this.targetLostListeners.delete(listener)
    };
  }

  async reconcileTargetAfterChannelFailure(targetId: string): Promise<boolean> {
    const assigned = this.assigned.get(targetId);
    if (!assigned) return true;
    try {
      await assigned.master.check();
      return false;
    } catch {
      if (this.assigned.get(targetId)?.generation !== assigned.generation) {
        return true;
      }
      this.assigned.delete(targetId);
      await assigned.master.stop().catch(() => undefined);
      this.emitTargetLost({
        targetId,
        masterGeneration: assigned.generation,
        code: "master-closed",
        message: "assigned OpenSSH master failed its control check"
      });
      return true;
    }
  }

  isCurrentGeneration(targetId: string, generation: string): boolean {
    const assigned =
      this.assigned.get(targetId) ?? this.verifying.get(targetId);
    return (
      assigned?.generation === generation &&
      assigned.master.isRunning() === true
    );
  }

  async disconnectTarget(targetId: string): Promise<void> {
    const assigned = this.assigned.get(targetId);
    if (!assigned) return;
    this.assigned.delete(targetId);
    await assigned.master.stop();
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeAll();
    await this.closePromise;
  }

  private async closeAll(): Promise<void> {
    this.closing = true;
    const assigned = [...this.assigned.values()];
    const verifying = [...this.verifying.values()];
    const provisional = [...this.provisional.values()];
    this.assigned.clear();
    this.verifying.clear();
    this.provisional.clear();
    const masters = await Promise.allSettled(
      provisional.map((entry) => entry.masterPromise)
    );
    const unique = new Map<string, RunningSshMaster>();
    for (const entry of assigned) unique.set(entry.generation, entry.master);
    for (const entry of verifying) unique.set(entry.generation, entry.master);
    for (const result of masters) {
      if (result.status === "fulfilled") {
        unique.set(result.value.generation, result.value);
      }
    }
    await Promise.allSettled(
      [...unique.values()].map((master) => master.stop())
    );
    this.closed = true;
    this.closing = false;
  }

  private watchAssignedMaster(assigned: AssignedSshMaster): void {
    void assigned.master.closed.then(() => {
      if (
        this.closing ||
        this.closed ||
        this.assigned.get(assigned.targetId)?.generation !== assigned.generation
      ) {
        return;
      }
      this.assigned.delete(assigned.targetId);
      this.emitTargetLost({
        targetId: assigned.targetId,
        masterGeneration: assigned.generation,
        code: "master-closed",
        message: "assigned OpenSSH master exited"
      });
    });
  }

  private emitTargetLost(event: SshTargetLostEvent): void {
    for (const listener of this.targetLostListeners) {
      try {
        listener(event);
      } catch {
        // One observer cannot prevent cleanup or other observers.
      }
    }
  }

  private assertOpen(): void {
    if (this.closing || this.closed) {
      throw new SshTransportPoolError(
        "master-closed",
        "transport pool is closing or closed"
      );
    }
  }

  private async requireOpenMaster(
    masterPromise: Promise<RunningSshMaster>
  ): Promise<RunningSshMaster> {
    const master = await masterPromise;
    if (this.closing || this.closed) {
      await master.stop();
      throw new SshTransportPoolError(
        "master-closed",
        "transport pool closed while the provisional master was starting"
      );
    }
    return master;
  }
}

function hashMasterLaunch(request: SshMasterLaunchRequest): string {
  const environment = Object.entries(request.env ?? process.env).sort(
    ([left], [right]) => left.localeCompare(right)
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        sshPath: request.sshPath,
        configPath: request.configPath,
        host: request.host,
        controlRoot: request.controlRoot ?? null,
        askpassPath: request.askpassPath ?? null,
        environment
      })
    )
    .digest("hex");
}

export async function startParentDeathGuard(options: {
  watchedPid: number;
  readySocketPath: string;
  cleanupExecutable: string;
  cleanupArgs: readonly string[];
  env?: NodeJS.ProcessEnv;
}): Promise<ParentDeathGuard> {
  const cleanupArgumentBytes = options.cleanupArgs.reduce(
    (total, argument) => total + Buffer.byteLength(argument),
    0
  );
  if (
    !Number.isSafeInteger(options.watchedPid) ||
    options.watchedPid <= 0 ||
    !isAbsolute(options.readySocketPath) ||
    Buffer.byteLength(options.readySocketPath, "utf8") > 4_096 ||
    /[\0\r\n]/u.test(options.readySocketPath) ||
    !isAbsolute(options.cleanupExecutable) ||
    options.cleanupArgs.length > 4_096 ||
    cleanupArgumentBytes > 1024 * 1024 ||
    options.cleanupArgs.some((argument) => /\0/u.test(argument))
  ) {
    throw new SshTransportPoolError(
      "invalid-request",
      "OpenSSH parent-death guard launch is invalid"
    );
  }
  const guardian = spawn(
    "/bin/sh",
    [
      "-c",
      PARENT_DEATH_GUARD_SCRIPT,
      "kmux-open-ssh-parent-death-guard",
      String(options.watchedPid),
      options.readySocketPath,
      options.cleanupExecutable,
      ...options.cleanupArgs
    ],
    {
      env: options.env ?? process.env,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true
    }
  );
  guardian.on("error", () => undefined);
  try {
    await waitForChildSpawn(guardian, "OpenSSH parent-death guard");
  } catch (error) {
    guardian.kill("SIGKILL");
    throw new SshTransportPoolError(
      "master-start-failed",
      "OpenSSH parent-death guard failed to start",
      { cause: error }
    );
  }
  guardian.stdin?.on("error", () => undefined);
  const closed = new Promise<void>((resolveClosed) => {
    guardian.once("close", () => resolveClosed());
  });
  let action: "active" | "cancelled" | "cleanup" = "active";
  let actionPromise: Promise<void> | undefined;

  const finish = (next: "cancelled" | "cleanup"): Promise<void> => {
    actionPromise ??= (async () => {
      action = next;
      if (guardian.exitCode !== null || guardian.signalCode !== null) {
        await closed;
        return;
      }
      if (next === "cancelled") guardian.stdin?.end("cancel\n");
      else guardian.stdin?.end();
      const didClose = await Promise.race([
        closed.then(() => true),
        delay(
          next === "cancelled"
            ? PARENT_DEATH_GUARD_CANCEL_TIMEOUT_MS
            : MASTER_START_TIMEOUT_MS + MASTER_STOP_TIMEOUT_MS
        ).then(() => false)
      ]);
      if (didClose) return;
      guardian.kill("SIGTERM");
      const terminated = await Promise.race([
        closed.then(() => true),
        delay(PARENT_DEATH_GUARD_CANCEL_TIMEOUT_MS).then(() => false)
      ]);
      if (!terminated) {
        guardian.kill("SIGKILL");
        await Promise.race([closed, delay(PARENT_DEATH_GUARD_FINAL_WAIT_MS)]);
      }
    })();
    return actionPromise;
  };

  return {
    closed,
    wasCancelled: () => action === "cancelled",
    cancel: () => finish("cancelled"),
    cleanupNow: () => finish("cleanup")
  };
}

export async function startOpenSshControlMaster(
  request: SshMasterLaunchRequest
): Promise<RunningSshMaster> {
  validatePoolKey(request.connectionAttemptId, "connectionAttemptId");
  validatePolicyHash(request.effectiveConnectionPolicyHash);
  validateHostAlias(request.host);
  for (const [label, value] of [
    ["sshPath", request.sshPath],
    ["configPath", request.configPath]
  ] as const) {
    if (!isAbsolute(value)) {
      throw new SshTransportPoolError(
        "invalid-request",
        `${label} must be absolute`
      );
    }
  }

  const controlRoot = request.controlRoot ?? shortTemporaryRoot();
  if (!isAbsolute(controlRoot)) {
    throw new SshTransportPoolError(
      "invalid-request",
      "controlRoot must be absolute"
    );
  }
  if (request.controlRoot !== undefined) {
    await ensurePrivateControlRoot(controlRoot);
  }
  const env = createOpenSshEnvironment({
    baseEnv: request.env,
    askpassPath: request.askpassPath
  });
  const controlDirectory = await mkdtemp(join(controlRoot, "km-"));
  await chmod(controlDirectory, 0o700).catch(async (error: unknown) => {
    await rm(controlDirectory, { recursive: true, force: true });
    throw error;
  });
  const controlPath = join(controlDirectory, "m.sock");
  if (Buffer.byteLength(controlPath) > CONSERVATIVE_UNIX_SOCKET_PATH_BYTES) {
    await rm(controlDirectory, { recursive: true, force: true });
    throw new SshTransportPoolError(
      "invalid-request",
      "generated ControlPath exceeds the conservative Unix socket path limit"
    );
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(
      request.sshPath,
      [
        "-F",
        request.configPath,
        "-M",
        "-N",
        "-S",
        controlPath,
        "-o",
        "ControlMaster=yes",
        "-o",
        "ControlPersist=no",
        "-o",
        "ExitOnForwardFailure=yes",
        "--",
        request.host
      ],
      {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );
  } catch (error) {
    await rm(controlDirectory, { recursive: true, force: true });
    throw new SshTransportPoolError(
      "master-start-failed",
      "OpenSSH master process failed to start",
      { cause: error }
    );
  }
  child.stdin.on("error", () => undefined);
  child.stdin.end();
  const diagnostics = collectBoundedDiagnostics(child);
  let running = true;
  let stopping = false;
  let processError: Error | undefined;
  child.once("error", (error) => {
    processError = error;
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => {
      running = false;
      resolve();
    });
  });

  let parentDeathGuard: ParentDeathGuard | undefined;
  try {
    if (child.pid === undefined) {
      await waitForChildSpawn(child, "OpenSSH master");
    }
    if (child.pid === undefined) {
      throw new Error("OpenSSH master did not publish a process ID");
    }
    parentDeathGuard = await startParentDeathGuard({
      watchedPid: child.pid,
      readySocketPath: controlPath,
      cleanupExecutable: request.sshPath,
      cleanupArgs: [
        "-F",
        // A profile-owned config can be edited or removed while its master is
        // alive. Parent-death cleanup must depend only on the already-open,
        // private control socket or a remote-host crash could leave an
        // authenticated master orphaned.
        "/dev/null",
        "-S",
        controlPath,
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPersist=no",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=1",
        "-o",
        "ConnectionAttempts=1",
        "-o",
        "NumberOfPasswordPrompts=0",
        "-o",
        "PasswordAuthentication=no",
        "-o",
        "KbdInteractiveAuthentication=no",
        "-o",
        "ProxyCommand=exec /usr/bin/false",
        "-O",
        "exit",
        "--",
        // The destination is syntactically required for a multiplex control
        // command. A loopback literal prevents any accidental external route
        // if a future OpenSSH version rejects the control command early.
        "127.0.0.1"
      ],
      env: createOpenSshEnvironment({ baseEnv: env })
    });
    const guard = parentDeathGuard;
    void guard.closed.then(() => {
      if (!guard.wasCancelled() && running && !stopping) {
        child.kill("SIGTERM");
      }
    });
    void closed.then(() => guard.cancel().catch(() => undefined));
    await waitForMaster({
      child,
      closed,
      sshPath: request.sshPath,
      configPath: request.configPath,
      controlPath,
      host: request.host,
      env,
      diagnostics,
      processError: () => processError
    });
  } catch (error) {
    running = false;
    await terminateMasterProcess(child, closed);
    await parentDeathGuard?.cancel().catch(() => undefined);
    await rm(controlDirectory, { recursive: true, force: true });
    throw error;
  }

  const generation = randomUUID();
  let stopPromise: Promise<void> | undefined;
  const stopMaster = async (): Promise<void> => {
    stopping = true;
    if (running) {
      await runOpenSshCommand(
        request.sshPath,
        [
          "-F",
          request.configPath,
          "-S",
          controlPath,
          "-O",
          "exit",
          "--",
          request.host
        ],
        { env, timeoutMs: MASTER_STOP_TIMEOUT_MS, maxOutputBytes: 64 * 1024 }
      ).catch(() => undefined);
      await terminateMasterProcess(child, closed);
    }
    running = false;
    await parentDeathGuard?.cancel().catch(() => undefined);
    await rm(controlDirectory, { recursive: true, force: true });
  };
  return {
    connectionAttemptId: request.connectionAttemptId,
    effectiveConnectionPolicyHash: request.effectiveConnectionPolicyHash,
    generation,
    controlPath,
    sshPath: request.sshPath,
    configPath: request.configPath,
    host: request.host,
    closed,
    isRunning: () => running && !stopping,
    async check(): Promise<void> {
      if (!running || stopping) {
        throw new SshTransportPoolError(
          "master-closed",
          "OpenSSH master is not running"
        );
      }
      await checkOpenSshMaster({
        sshPath: request.sshPath,
        configPath: request.configPath,
        controlPath,
        host: request.host,
        env
      });
    },
    async stop(): Promise<void> {
      stopPromise ??= stopMaster();
      await stopPromise;
    }
  };
}

function shortTemporaryRoot(): string {
  return existsSync("/tmp") ? "/tmp" : tmpdir();
}

export async function ensurePrivateControlRoot(
  controlRoot: string
): Promise<void> {
  try {
    await mkdir(controlRoot, { recursive: true, mode: 0o700 });
    const metadata = await lstat(controlRoot);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (metadata.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" &&
        metadata.uid !== process.getuid())
    ) {
      throw new Error(
        "explicit ControlPath root must be a private user-owned directory"
      );
    }
  } catch (error) {
    throw new SshTransportPoolError(
      "invalid-request",
      "explicit ControlPath root is unavailable or unsafe",
      { cause: error }
    );
  }
}

async function waitForMaster(options: {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  sshPath: string;
  configPath: string;
  controlPath: string;
  host: string;
  env: NodeJS.ProcessEnv;
  diagnostics: () => string;
  processError: () => Error | undefined;
}): Promise<void> {
  const deadline = Date.now() + MASTER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const processError = options.processError();
    if (processError) {
      throw new SshTransportPoolError(
        "master-start-failed",
        "OpenSSH master process failed to start",
        { cause: processError }
      );
    }
    if (options.child.exitCode !== null || options.child.signalCode !== null) {
      await options.closed;
      throw new SshTransportPoolError(
        "master-start-failed",
        `OpenSSH master exited before readiness: ${options.diagnostics()}`
      );
    }
    try {
      await checkOpenSshMaster(options);
      return;
    } catch (error) {
      if (
        !(error instanceof OpenSshProcessError) ||
        error.code !== "non-zero-exit"
      ) {
        throw error;
      }
    }
    await delay(25);
  }
  throw new SshTransportPoolError(
    "master-start-failed",
    `OpenSSH master did not become ready: ${options.diagnostics()}`
  );
}

async function terminateMasterProcess(
  child: ChildProcessWithoutNullStreams,
  closed: Promise<void>
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await closed;
    return;
  }
  child.kill("SIGTERM");
  const closedGracefully = await Promise.race([
    closed.then(() => true),
    delay(MASTER_STOP_TIMEOUT_MS).then(() => false)
  ]);
  if (
    !closedGracefully &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    child.kill("SIGKILL");
    await closed;
  }
}

async function checkOpenSshMaster(options: {
  sshPath: string;
  configPath: string;
  controlPath: string;
  host: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  await runOpenSshCommand(
    options.sshPath,
    [
      "-F",
      options.configPath,
      "-S",
      options.controlPath,
      "-O",
      "check",
      "--",
      options.host
    ],
    { env: options.env, timeoutMs: 2_000, maxOutputBytes: 64 * 1024 }
  );
}

async function waitForChildSpawn(
  child: ChildProcess,
  label: string
): Promise<void> {
  if (child.pid !== undefined) return;
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolveSpawn();
    };
    const onError = (error: Error): void => {
      child.off("spawn", onSpawn);
      rejectSpawn(new Error(`${label} failed to spawn`, { cause: error }));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function collectBoundedDiagnostics(
  child: ChildProcessWithoutNullStreams
): () => string {
  const chunks: Buffer[] = [];
  let size = 0;
  const collect = (chunk: Buffer): void => {
    if (size >= MASTER_DIAGNOSTIC_LIMIT_BYTES) return;
    const remaining = MASTER_DIAGNOSTIC_LIMIT_BYTES - size;
    const retained = Buffer.from(chunk.subarray(0, remaining));
    size += retained.byteLength;
    chunks.push(retained);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return () => Buffer.concat(chunks).toString("utf8").trim();
}

function validatePoolKey(value: string, label: string): void {
  if (value.length === 0 || value.length > 512 || /[\0\r\n]/u.test(value)) {
    throw new SshTransportPoolError(
      "invalid-request",
      `${label} must be a bounded, non-empty value`
    );
  }
}

function validatePolicyHash(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new SshTransportPoolError(
      "invalid-request",
      "effectiveConnectionPolicyHash must be a lowercase SHA-256 value"
    );
  }
}

async function delay(durationMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, durationMs);
    timer.unref();
  });
}

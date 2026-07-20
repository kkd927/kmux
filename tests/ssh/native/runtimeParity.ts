import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  canonicalizeRemoteOperationPayload,
  type RemoteOperationPayloadDto,
  type RemoteResourceKey
} from "@kmux/core";
import {
  REMOTE_PROTOCOL_VERSION,
  RemoteFrameDecoder,
  decodeRemoteBridgeResponseEnvelope,
  encodeRemoteControlJson,
  encodeRemoteFrame,
  makeId,
  uint64,
  type Id,
  type RemoteBridgeRequestBody,
  type RemoteBridgeResponseBody,
  type RemoteKeeperAttachRequest,
  type RemoteRuntimeRootsDto,
  type Uint64
} from "@kmux/proto";

import { RemoteTerminalAttachment } from "../../../apps/desktop/src/remote-host/linuxX64RemoteRuntime";

const execFileAsync = promisify(execFile);
const target = requireEnvironment("KMUX_NATIVE_ARTIFACT_TARGET");
const currentRuntime = requireEnvironment("KMUX_NATIVE_CURRENT_RUNTIME");
const compatibleRuntime = requireEnvironment("KMUX_NATIVE_COMPATIBLE_RUNTIME");
const incompatibleRuntime = requireEnvironment(
  "KMUX_NATIVE_INCOMPATIBLE_RUNTIME"
);
const incompatibleRuntimeB = requireEnvironment(
  "KMUX_NATIVE_INCOMPATIBLE_RUNTIME_B"
);
const expectedTarget = nativeTarget();
if (target !== expectedTarget) {
  throw new Error(
    `native parity target mismatch: artifact=${target}, host=${expectedTarget}`
  );
}
for (const path of [
  currentRuntime,
  compatibleRuntime,
  incompatibleRuntime,
  incompatibleRuntimeB
]) {
  await chmod(path, 0o700);
}

const sandbox = await mkdtemp("/tmp/kmux-native-");
const roots: RemoteRuntimeRootsDto = {
  installRoot: join(sandbox, "install"),
  authorityRoot: join(sandbox, "authority"),
  stateRoot: join(sandbox, "state"),
  runtimeRoot: join(sandbox, "run")
};
for (const root of Object.values(roots)) {
  await mkdir(root, { recursive: true, mode: 0o700 });
}
const token = randomBytes(48).toString("hex");
const suffix = randomBytes(6).toString("hex");
const desktopInstallationId = `desktop_native_${suffix}` as Id;
const targetId = `target_native_${suffix}` as Id;
const workspaceId = `workspace_native_${suffix}` as Id;
const compatibleKey = resourceKey(`session_compatible_${suffix}`);
const defaultShellKey = resourceKey(`session_default_shell_${suffix}`);
const cohortKeyA = resourceKey(`session_cohort_a_${suffix}`);
const cohortKeyB = resourceKey(`session_cohort_b_${suffix}`);
const clients = new Set<BridgeClient>();
const attachments = new Set<RemoteTerminalAttachment>();
let currentBridge: BridgeClient | undefined;
let compatibleBridge: BridgeClient | undefined;
let incompatibleBridge: BridgeClient | undefined;
let cohortSocketPath: string | undefined;

async function runNativeParity(): Promise<void> {
  try {
    stage("compatible-create");
    compatibleBridge = startBridge(compatibleRuntime);
    await compatibleBridge.hello();
    const compatibleCreate = await createSession(
      compatibleBridge,
      compatibleKey,
      `create_compatible_${suffix}`
    );
    await compatibleBridge.close();
    clients.delete(compatibleBridge);
    compatibleBridge = undefined;

    stage("incompatible-create-a");
    incompatibleBridge = startBridge(incompatibleRuntime);
    await incompatibleBridge.hello();
    const cohortCreateA = await createSession(
      incompatibleBridge,
      cohortKeyA,
      `create_cohort_a_${suffix}`
    );
    await incompatibleBridge.close();
    clients.delete(incompatibleBridge);
    incompatibleBridge = undefined;

    stage("incompatible-create-b");
    incompatibleBridge = startBridge(incompatibleRuntimeB);
    await incompatibleBridge.hello();
    const cohortCreateB = await createSession(
      incompatibleBridge,
      cohortKeyB,
      `create_cohort_b_${suffix}`
    );
    await incompatibleBridge.close();
    clients.delete(incompatibleBridge);
    incompatibleBridge = undefined;

    stage("current-bridge-update");
    currentBridge = startBridge(currentRuntime);
    const currentHello = await currentBridge.hello();
    assertNativeHello(currentHello);

    stage("default-account-shell");
    const defaultShellCreate = await createSession(
      currentBridge,
      defaultShellKey,
      `create_default_shell_${suffix}`,
      true
    );
    const defaultShellAuthorization = await authorize(
      currentBridge,
      defaultShellKey,
      defaultShellCreate.keeperGeneration,
      "write"
    );
    const defaultShellAttachment = await openAttachment(
      defaultShellAuthorization,
      defaultShellKey,
      "write"
    );
    attachments.add(defaultShellAttachment);
    await defaultShellAttachment.sendInput(
      uint64(1n),
      new TextEncoder().encode(
        "printf 'native-default-%s-ok:%s\\n' shell \"$SHELL\"\n"
      )
    );
    await readUntil(defaultShellAttachment, "native-default-shell-ok:");
    await defaultShellAttachment.detach();
    attachments.delete(defaultShellAttachment);

    const compatibleAuthorization = await authorize(
      currentBridge,
      compatibleKey,
      compatibleCreate.keeperGeneration,
      "write"
    );
    assert(
      compatibleAuthorization.terminalProxy.kind === "direct",
      "compatible keeper did not use the direct proxy"
    );
    stage("compatible-direct-attach");
    const compatibleAttachment = await openAttachment(
      compatibleAuthorization,
      compatibleKey,
      "write"
    );
    attachments.add(compatibleAttachment);
    stage("compatible-direct-input");
    await compatibleAttachment.sendInput(
      uint64(1n),
      new TextEncoder().encode("printf 'compatible-direct-ok\\n'\n")
    );
    await readUntil(compatibleAttachment, "compatible-direct-ok");
    await compatibleAttachment.detach();
    attachments.delete(compatibleAttachment);

    stage("cohort-authorize");
    const authorizationA = await authorize(
      currentBridge,
      cohortKeyA,
      cohortCreateA.keeperGeneration,
      "write"
    );
    const authorizationB = await authorize(
      currentBridge,
      cohortKeyB,
      cohortCreateB.keeperGeneration,
      "write"
    );
    assert(
      authorizationA.terminalProxy.kind === "cohort" &&
        authorizationB.terminalProxy.kind === "cohort",
      "incompatible keepers did not use a cohort proxy"
    );
    if (
      authorizationA.terminalProxy.kind !== "cohort" ||
      authorizationB.terminalProxy.kind !== "cohort"
    ) {
      throw new Error("cohort narrowing failed");
    }
    cohortSocketPath = authorizationA.terminalProxy.socketPath;
    assert(
      authorizationB.terminalProxy.socketPath === cohortSocketPath,
      "one target/protocol cohort created more than one endpoint"
    );
    await assertOneCohortProcess(cohortSocketPath);

    stage("cohort-attach");
    const attachmentA = await openAttachment(
      authorizationA,
      cohortKeyA,
      "write"
    );
    attachments.add(attachmentA);
    const attachmentB = await openAttachment(
      authorizationB,
      cohortKeyB,
      "write"
    );
    attachments.add(attachmentB);
    await attachmentA.sendInput(
      uint64(1n),
      new TextEncoder().encode("printf 'cohort-a-ok\\n'\n")
    );
    await readUntil(attachmentA, "cohort-a-ok");
    await attachmentB.sendInput(
      uint64(1n),
      new TextEncoder().encode("printf 'cohort-b-ok\\n'\n")
    );
    await readUntil(attachmentB, "cohort-b-ok");

    stage("cohort-detach-replay");
    const replayCursor = (await attachmentA.ready).liveStartsAfterSequence;
    await attachmentA.sendInput(
      uint64(2n),
      new TextEncoder().encode("sleep 0.2; printf 'detached-replay-ok\\n'\n")
    );
    await attachmentA.detach();
    attachments.delete(attachmentA);
    await delay(400);
    const reconnectAuthorization = await authorize(
      currentBridge,
      cohortKeyA,
      cohortCreateA.keeperGeneration,
      "write"
    );
    const reconnectedA = await openAttachment(
      reconnectAuthorization,
      cohortKeyA,
      "write",
      replayCursor
    );
    attachments.add(reconnectedA);
    await readUntil(reconnectedA, "detached-replay-ok");
    await reconnectedA.detach();
    attachments.delete(reconnectedA);

    stage("keeper-isolation");
    const cohortProcessesA = await readSessionProcesses(cohortKeyA);
    process.kill(cohortProcessesA.keeperPid, "SIGABRT");
    await assertProcessExited(
      cohortProcessesA.keeperPid,
      "aborted cohort A keeper"
    );
    await assertProcessExited(
      cohortProcessesA.childPid,
      "aborted cohort A PTY child"
    );
    const postAbortObservation = await currentBridge.request({
      type: "observe",
      desktopInstallationId,
      targetId
    });
    assert(
      postAbortObservation.type === "observed",
      "post-abort inventory returned the wrong response"
    );
    if (postAbortObservation.type !== "observed") {
      throw new Error("post-abort observation narrowing failed");
    }
    assert(
      postAbortObservation.keepers.some(
        (keeper) =>
          keeper.keeperGeneration === cohortCreateA.keeperGeneration &&
          keeper.processState === "exited"
      ),
      "aborted keeper was not authoritatively observed as exited"
    );
    assert(
      postAbortObservation.keepers.some(
        (keeper) =>
          keeper.keeperGeneration === cohortCreateB.keeperGeneration &&
          keeper.processState === "running"
      ),
      "surviving keeper was not observed as running"
    );
    await attachmentB.sendInput(
      uint64(2n),
      new TextEncoder().encode("printf 'keeper-b-survived\\n'\n")
    );
    await readUntil(attachmentB, "keeper-b-survived");
    await attachmentB.detach();
    attachments.delete(attachmentB);

    stage("bridge-restart");
    await currentBridge.close();
    clients.delete(currentBridge);
    currentBridge = startBridge(currentRuntime);
    await currentBridge.hello();
    const afterBridgeRestart = await authorize(
      currentBridge,
      cohortKeyB,
      cohortCreateB.keeperGeneration,
      "read"
    );
    assert(
      afterBridgeRestart.terminalProxy.kind === "cohort" &&
        afterBridgeRestart.terminalProxy.socketPath === cohortSocketPath,
      "bridge restart did not reuse the pinned cohort"
    );
    await assertOneCohortProcess(cohortSocketPath);
    const readOnlyAfterRestart = await openAttachment(
      afterBridgeRestart,
      cohortKeyB,
      "read"
    );
    attachments.add(readOnlyAfterRestart);
    await readOnlyAfterRestart.detach();
    attachments.delete(readOnlyAfterRestart);

    stage("cleanup-terminate");
    const cohortKeeperPidB = await readKeeperPid(cohortKeyB);
    const compatibleKeeperPid = await readKeeperPid(compatibleKey);
    const defaultShellKeeperPid = await readKeeperPid(defaultShellKey);
    await terminateSession(
      currentBridge,
      cohortKeyB,
      `terminate_cohort_b_${suffix}`,
      1n
    );
    await terminateSession(
      currentBridge,
      compatibleKey,
      `terminate_compatible_${suffix}`,
      1n
    );
    await terminateSession(
      currentBridge,
      defaultShellKey,
      `terminate_default_shell_${suffix}`,
      1n
    );
    await assertSandboxProcessExited(cohortKeeperPidB, "cohort B keeper");
    await assertCohortProcessExited(cohortSocketPath);
    await assertSandboxProcessExited(compatibleKeeperPid, "compatible keeper");
    await assertSandboxProcessExited(
      defaultShellKeeperPid,
      "default shell keeper"
    );

    process.stdout.write(
      `${JSON.stringify({
        target,
        directCompatible: true,
        pinnedCohort: true,
        reconnectReplay: true,
        keeperIsolation: true,
        bridgeRestart: true,
        shellParity: true,
        persistenceReporting: true,
        cohortStopsWhenIdle: true
      })}\n`
    );
  } catch (error) {
    await dumpSessionDescriptors();
    throw error;
  } finally {
    await Promise.allSettled(
      [...attachments].map((attachment) => attachment.detach())
    );
    await Promise.allSettled([...clients].map((client) => client.close()));
    await stopSandboxProcesses(sandbox);
    await rm(sandbox, { recursive: true, force: true });
  }
}

function startBridge(executable: string): BridgeClient {
  const client = new BridgeClient(executable, roots, token);
  clients.add(client);
  return client;
}

function resourceKey(sessionId: string): RemoteResourceKey & { sessionId: Id } {
  return {
    desktopInstallationId,
    targetId,
    workspaceId,
    sessionId: sessionId as Id
  };
}

async function createSession(
  bridge: BridgeClient,
  key: RemoteResourceKey & { sessionId: Id },
  operationId: Id,
  useDefaultShell = false
): Promise<{ keeperGeneration: Id }> {
  const payload: RemoteOperationPayloadDto = {
    kind: "session.create",
    sessionId: key.sessionId,
    surfaceId: `surface_${operationId}` as Id,
    paneId: `pane_${operationId}` as Id,
    launch: useDefaultShell
      ? { cwd: "/tmp" }
      : {
          cwd: "/tmp",
          shell: "/bin/sh",
          args: ["-c", "stty -echo; exec /bin/sh"]
        }
  };
  const body = await bridge.request({
    type: "operation.execute",
    intent: operationIntent(operationId, key, payload, 0n),
    payload
  });
  if (
    body.type !== "operation.result" ||
    body.outcome !== "succeeded" ||
    !body.keeperGeneration
  ) {
    throw new Error(`session create failed: ${JSON.stringify(body)}`);
  }
  return { keeperGeneration: body.keeperGeneration };
}

async function terminateSession(
  bridge: BridgeClient,
  key: RemoteResourceKey & { sessionId: Id },
  operationId: Id,
  expectedRevision: bigint
): Promise<void> {
  const payload: RemoteOperationPayloadDto = {
    kind: "session.terminate",
    sessionId: key.sessionId
  };
  const body = await bridge.request({
    type: "operation.execute",
    intent: operationIntent(operationId, key, payload, expectedRevision),
    payload
  });
  if (body.type !== "operation.result" || body.outcome !== "succeeded") {
    throw new Error(`session terminate failed: ${JSON.stringify(body)}`);
  }
}

function operationIntent(
  operationId: Id,
  key: RemoteResourceKey & { sessionId: Id },
  payload: RemoteOperationPayloadDto,
  expectedRevision: bigint
) {
  return {
    operationId,
    kind: payload.kind,
    resourceKey: key,
    expectedWorkspaceRevision: "a".repeat(64),
    expectedRemoteResourceRevision: expectedRevision.toString(10),
    nextRemoteResourceRevision: (expectedRevision + 1n).toString(10),
    ...(payload.kind === "session.create"
      ? { createOperationId: operationId }
      : {}),
    canonicalPayloadHash: createHash("sha256")
      .update(canonicalizeRemoteOperationPayload(payload))
      .digest("hex"),
    createdAt: new Date().toISOString()
  };
}

type AttachAuthorization = Extract<
  RemoteBridgeResponseBody,
  { type: "attach.authorized" }
>;

async function authorize(
  bridge: BridgeClient,
  key: RemoteResourceKey & { sessionId: Id },
  keeperGeneration: Id,
  access: "read" | "write"
): Promise<AttachAuthorization> {
  const body = await bridge.request({
    type: "attach.authorize",
    resourceKey: key,
    expectedKeeperGeneration: keeperGeneration,
    access
  });
  if (body.type !== "attach.authorized") {
    throw new Error(`attach authorization failed: ${JSON.stringify(body)}`);
  }
  return body;
}

async function openAttachment(
  authorization: AttachAuthorization,
  key: RemoteResourceKey & { sessionId: Id },
  access: "read" | "write",
  lastReceivedSequence?: Uint64
): Promise<RemoteTerminalAttachment> {
  const proxy = authorization.terminalProxy;
  const executable =
    proxy.kind === "direct" ? currentRuntime : proxy.executablePath;
  const args =
    proxy.kind === "direct"
      ? ["keeper", "proxy"]
      : ["bridge", "cohort-proxy", "attach", "--socket-path", proxy.socketPath];
  const child = spawn(executable, args, {
    stdio: ["pipe", "pipe", "pipe"]
  });
  let proxyStderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    proxyStderr = `${proxyStderr}${chunk.toString("utf8")}`.slice(-64 * 1024);
  });
  child.once("close", (code, signal) => {
    if (code !== 0) {
      process.stderr.write(
        `[native-runtime-parity] proxy closed (${String(code ?? signal)}): ${proxyStderr.trim() || "no stderr"}\n`
      );
    }
  });
  const request: RemoteKeeperAttachRequest = {
    type: "keeper.attach",
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    roots,
    resourceKey: key,
    keeperGeneration: authorization.keeperGeneration,
    attachCapability: authorization.attachCapability,
    attachmentId: makeId("native-attachment"),
    access,
    ...(lastReceivedSequence === undefined
      ? {}
      : { lastReceivedSequence: lastReceivedSequence.toString(10) })
  };
  const attachment = new RemoteTerminalAttachment(child, request);
  try {
    await attachment.ready;
    await attachment.checkpoint;
    await delay(10);
    if (!attachment.isOpen()) {
      await attachment.nextMutation();
      throw new Error("native proxy closed immediately after attach");
    }
  } catch (error) {
    await delay(100);
    throw new Error(
      `native proxy attach failed (${proxyStderr.trim() || "no stderr"}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
  return attachment;
}

async function readUntil(
  attachment: RemoteTerminalAttachment,
  marker: string
): Promise<Uint64> {
  const decoder = new TextDecoder();
  let output = "";
  let highest = uint64(0n);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const mutation = await withDeadline(
      attachment.nextMutation(),
      Math.max(1, deadline - Date.now()),
      `terminal output marker ${marker}`
    );
    if (mutation === null) {
      throw new Error(
        `terminal attachment ended before output contained ${marker}: ${output}`
      );
    }
    highest = mutation.sequence;
    if (mutation.kind === "output" && mutation.data) {
      output += decoder.decode(mutation.data, { stream: true });
      if (output.includes(marker)) return highest;
    }
  }
  throw new Error(`terminal output did not contain ${marker}: ${output}`);
}

async function assertOneCohortProcess(socketPath: string): Promise<void> {
  const matches = await cohortProcessLines(socketPath);
  assert(
    matches.length === 1,
    `expected one cohort process, found ${matches.length}`
  );
}

async function assertCohortProcessExited(socketPath: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await cohortProcessLines(socketPath)).length === 0) return;
    await delay(20);
  }
  throw new Error("cohort process remained alive after its final old keeper");
}

async function cohortProcessLines(socketPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="]);
  return stdout
    .split("\n")
    .filter(
      (line) =>
        line.includes("bridge cohort-proxy serve") && line.includes(socketPath)
    );
}

class BridgeClient {
  private readonly child: ChildProcess;
  private readonly decoder = new RemoteFrameDecoder();
  private readonly responses = new Map<
    Id,
    Deferred<RemoteBridgeResponseBody>
  >();
  private stderr = "";
  private closed = false;

  constructor(
    executable: string,
    private readonly roots: RemoteRuntimeRootsDto,
    private readonly token: string
  ) {
    this.child = spawn(executable, ["bridge", "serve"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-64 * 1024);
    });
    this.child.stdin?.on("error", (error) => {
      this.closed = true;
      for (const deferred of this.responses.values()) deferred.reject(error);
      this.responses.clear();
      this.child.kill("SIGTERM");
    });
    this.child.once("close", () => {
      this.closed = true;
      const error = new Error(`bridge closed: ${this.stderr.trim()}`);
      for (const deferred of this.responses.values()) deferred.reject(error);
      this.responses.clear();
    });
  }

  hello(): Promise<Extract<RemoteBridgeResponseBody, { type: "hello" }>> {
    return this.request({ type: "hello" }).then((body) => {
      if (body.type !== "hello") throw new Error("bridge hello type mismatch");
      return body;
    });
  }

  async request(
    request: RemoteBridgeRequestBody
  ): Promise<RemoteBridgeResponseBody> {
    if (this.closed || !this.child.stdin) throw new Error("bridge is closed");
    const requestId = makeId("native-bridge-request");
    const deferred = createDeferred<RemoteBridgeResponseBody>();
    this.responses.set(requestId, deferred);
    const bytes = encodeRemoteFrame(
      1,
      encodeRemoteControlJson({
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        requestId,
        token: this.token,
        roots: this.roots,
        request
      })
    );
    try {
      await new Promise<void>((resolve, reject) => {
        this.child.stdin?.write(bytes, (error) =>
          error ? reject(error) : resolve()
        );
      });
      return await withDeadline(deferred.promise, 30_000, "bridge request");
    } finally {
      this.responses.delete(requestId);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const closed = new Promise<void>((resolve) =>
      this.child.once("close", () => resolve())
    );
    this.child.stdin?.end();
    const closedGracefully = await Promise.race([
      closed.then(() => true),
      delay(2_000).then(() => false)
    ]);
    if (!closedGracefully) {
      this.child.kill("SIGTERM");
      const closedAfterTerm = await Promise.race([
        closed.then(() => true),
        delay(2_000).then(() => false)
      ]);
      if (!closedAfterTerm) {
        this.child.kill("SIGKILL");
        await Promise.race([closed, delay(2_000)]);
      }
    }
    this.closed = true;
  }

  private receive(chunk: Buffer): void {
    try {
      for (const frame of this.decoder.push(chunk)) {
        if (frame.kind !== 1)
          throw new Error("bridge emitted non-control frame");
        const response = decodeRemoteBridgeResponseEnvelope(frame.payload);
        const deferred = this.responses.get(response.requestId);
        if (!deferred) throw new Error("bridge response identity is unknown");
        this.responses.delete(response.requestId);
        if (response.status === "error") {
          deferred.reject(
            new Error(`${response.error.code}: ${response.error.message}`)
          );
        } else {
          deferred.resolve(response.body);
        }
      }
    } catch (error) {
      this.child.kill("SIGTERM");
      for (const deferred of this.responses.values()) deferred.reject(error);
      this.responses.clear();
    }
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function stopSandboxProcesses(root: string): Promise<void> {
  const pids = new Set<number>();
  try {
    const entries = await readdir(join(root, "state", "sessions"));
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const descriptor = JSON.parse(
        await readFile(join(root, "state", "sessions", entry), "utf8")
      );
      for (const candidate of [descriptor.keeperPid, descriptor.childPid]) {
        if (Number.isSafeInteger(candidate) && candidate > 1)
          pids.add(candidate);
      }
    }
  } catch {
    // A failure before the first descriptor is expected to leave no keeper.
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="]);
    for (const line of stdout.split("\n")) {
      if (!line.includes(root)) continue;
      const pid = Number.parseInt(line.trim().split(/\s+/u)[0] ?? "", 10);
      if (Number.isSafeInteger(pid) && pid > 1) pids.add(pid);
    }
  } catch {
    // Best-effort cleanup follows exact sandbox-owned process identities only.
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already exited.
    }
  }
  if (pids.size > 0) {
    await waitForProcessesToExit(pids, 1_000);
    for (const pid of pids) {
      if (!(await sandboxProcessIsRunning(pid, root))) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    }
    await waitForProcessesToExit(pids, 1_000);
  }
}

async function readKeeperPid(
  key: RemoteResourceKey & { sessionId: Id }
): Promise<number> {
  return (await readSessionProcesses(key)).keeperPid;
}

async function readSessionProcesses(
  key: RemoteResourceKey & { sessionId: Id }
): Promise<{ keeperPid: number; childPid: number }> {
  const directory = join(sandbox, "state", "sessions");
  for (const entry of await readdir(directory)) {
    if (!entry.endsWith(".json")) continue;
    const descriptor = JSON.parse(
      await readFile(join(directory, entry), "utf8")
    );
    if (
      descriptor.resourceKey?.desktopInstallationId ===
        key.desktopInstallationId &&
      descriptor.resourceKey?.targetId === key.targetId &&
      descriptor.resourceKey?.workspaceId === key.workspaceId &&
      descriptor.resourceKey?.sessionId === key.sessionId &&
      Number.isSafeInteger(descriptor.keeperPid) &&
      descriptor.keeperPid > 1 &&
      Number.isSafeInteger(descriptor.childPid) &&
      descriptor.childPid > 1
    ) {
      return {
        keeperPid: descriptor.keeperPid,
        childPid: descriptor.childPid
      };
    }
  }
  throw new Error(
    `session process descriptor was not found for ${key.sessionId}`
  );
}

async function assertSandboxProcessExited(
  pid: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!(await sandboxProcessIsRunning(pid, sandbox))) return;
    await delay(20);
  }
  throw new Error(`${label} process ${pid} remained alive after termination`);
}

async function assertProcessExited(pid: number, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!(await processIsRunning(pid))) return;
    await delay(20);
  }
  throw new Error(`${label} process ${pid} remained alive after termination`);
}

async function processIsRunning(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", [
      "-p",
      String(pid),
      "-o",
      "state="
    ]);
    return !stdout.trim().startsWith("Z");
  } catch {
    return false;
  }
}

async function waitForProcessesToExit(
  pids: ReadonlySet<number>,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = await Promise.all(
      [...pids].map((pid) => sandboxProcessIsRunning(pid, sandbox))
    );
    if (running.every((value) => !value)) return;
    await delay(20);
  }
}

async function sandboxProcessIsRunning(
  pid: number,
  root: string
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", [
      "-p",
      String(pid),
      "-o",
      "command="
    ]);
    return stdout.includes(root);
  } catch {
    return false;
  }
}

async function dumpSessionDescriptors(): Promise<void> {
  try {
    const directory = join(sandbox, "state", "sessions");
    for (const entry of await readdir(directory)) {
      if (!entry.endsWith(".json")) continue;
      const contents = await readFile(join(directory, entry), "utf8");
      process.stderr.write(
        `[native-runtime-parity] descriptor ${entry}: ${contents.trim()}\n`
      );
    }
  } catch (error) {
    process.stderr.write(
      `[native-runtime-parity] descriptor dump failed: ${String(error)}\n`
    );
  }
}

function nativeTarget(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "darwin") return `darwin-${arch}`;
  if (process.platform === "linux") return `linux-${arch}-musl`;
  throw new Error(
    `unsupported native parity host ${process.platform}/${process.arch}`
  );
}

function assertNativeHello(
  hello: Extract<RemoteBridgeResponseBody, { type: "hello" }>
): void {
  const expectedPlatform = process.platform === "darwin" ? "macos" : "linux";
  const expectedArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const expectedAbi = process.platform === "darwin" ? "native" : "musl";
  assert(
    hello.platform === expectedPlatform,
    `native platform mismatch: ${hello.platform} != ${expectedPlatform}`
  );
  assert(
    hello.arch === expectedArch,
    `native architecture mismatch: ${hello.arch} != ${expectedArch}`
  );
  assert(
    hello.abi === expectedAbi,
    `native ABI mismatch: ${hello.abi} != ${expectedAbi}`
  );
  assert(
    hello.persistenceLevel === "ssh-disconnect",
    `unverified persistence advertised: ${hello.persistenceLevel}`
  );
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function stage(name: string): void {
  process.stderr.write(`[native-runtime-parity] ${name}\n`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

await runNativeParity();

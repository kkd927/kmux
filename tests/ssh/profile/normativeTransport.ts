import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ChildProcess } from "node:child_process";

import {
  canonicalizeRemoteOperationPayload,
  type RemoteOperationPayloadDto,
  type RemoteResourceKey
} from "@kmux/core";
import {
  makeId,
  uint64,
  type Id,
  type RemoteRuntimeRootsDto
} from "@kmux/proto";

import {
  LinuxX64RemoteRuntime,
  type RemoteTerminalAttachment,
  type RemoteTerminalMutation
} from "../../../apps/desktop/src/remote-host/linuxX64RemoteRuntime";
import {
  buildMuxOnlyLaunch,
  spawnMuxOnlyChannel,
  type MuxOnlyChannelRequest
} from "../../../apps/desktop/src/remote-host/muxOnlyOpenSshChannel";
import { runOpenSshCommand } from "../../../apps/desktop/src/remote-host/openSshProcess";
import {
  SshTransportPool,
  type AssignedSshMaster
} from "../../../apps/desktop/src/remote-host/sshTransportPool";
import {
  SshConnectionAudit,
  type SshConnectionAuditSnapshot
} from "../harness/connectionAudit";
import type { StartedSshTarget } from "../harness/sshTarget";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const manifestPath = join(
  repositoryRoot,
  "tests/e2e/fixtures/remote-performance-gates.v1.json"
);
const PROFILE_RESULT_ROOT = join(repositoryRoot, ".kmux", "ssh-profile");
const PROFILE_CONFIGURATION_ENV = "KMUX_SSH_PROFILE_CONFIG";
const FUNCTIONAL_CONTAINER_ENV = "KMUX_SSH_PROFILE_FUNCTIONAL_CONTAINER";
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const NORMATIVE_ECHO_LIVENESS_TIMEOUT_MS = 2_000;
const FUNCTIONAL_ECHO_LIVENESS_TIMEOUT_MS = 30_000;

interface PerformanceManifest {
  schemaVersion: 1;
  referenceTargetMinimum: {
    physicalCpuCores: number;
    memoryBytes: number;
    stateStorage: "ssd-backed";
  };
  network: {
    roundTripLatencyMs: number;
    maximumInjectedJitterMs: number;
  };
  workload: {
    minimumDurationMs: number;
    keepers: {
      total: number;
      attached: number;
      detached: number;
      attachedOutputBytesPerSecondEach: number;
      detachedOutputBytesPerSecondEach: number;
    };
    keyEcho: { probesPerSecond: number };
    sftp: { bytes: number; sha256: string };
    git: {
      repositoryPath: string;
      repositoryCommit: string;
      repetitionsPerSecond: number;
    };
    terminalOutputGenerator: { seed: string };
    checkpoint: { minimumCompletedPerKeeper: number };
  };
  gates: {
    addedKeyEchoLatencyMs: { p95Max: number; p99Max: number };
    remoteHostEventLoopDelayMs: { p99Max: number; singleStallMax: number };
    terminalMutationContinuity: {
      missing: number;
      duplicate: number;
      reordered: number;
    };
    keeperRssBytes: { p95Max: number };
    remoteHostProcessTreeRssBytes: { max: number };
    journalGroupSyncMs: {
      p99Max: number;
      storageDegradedAtOrAbove: number;
    };
    sshFeatureTransport: {
      targetAuthenticatedMasterRoutes: number;
      physicalTcpLegs: "resolved-route-baseline";
      featureAuthenticationAttempts: number;
    };
    loadedSftpThroughput: { minimumDirectBaselineRatio: number };
  };
}

interface AuditSnapshot extends SshConnectionAuditSnapshot {
  physicalTcpLegs: number;
}

interface NativeProfileConfiguration {
  schemaVersion: 1;
  environmentKind: "controlled-native";
  artifactTarget:
    | "darwin-arm64"
    | "darwin-x64"
    | "linux-arm64-musl"
    | "linux-x64-musl";
  sshPath: string;
  sftpPath: string;
  configPath: string;
  host: string;
  controlRoot?: string;
  runtimePath: string;
  roots: RemoteRuntimeRootsDto;
  targetId: Id;
  hardware: {
    physicalCpuCores: number;
    memoryBytes: number;
    stateStorage: "ssd-backed" | "other";
    evidence: string;
  };
  network: {
    roundTripLatencyMs: number;
    maximumInjectedJitterMs: number;
    evidence: string;
  };
  resolvedRoutePhysicalTcpLegs: number;
  auditSnapshot: { executable: string; args: string[] };
  sharedHost: boolean;
}

interface ProfileContext {
  kind: "controlled-native" | "docker-functional";
  normative: boolean;
  limitations: string[];
  artifactTarget: NativeProfileConfiguration["artifactTarget"];
  sshPath: string;
  sftpPath: string;
  configPath: string;
  host: string;
  controlRoot?: string;
  runtimePath: string;
  roots: RemoteRuntimeRootsDto;
  targetId: Id;
  hardware: NativeProfileConfiguration["hardware"];
  network: NativeProfileConfiguration["network"];
  resolvedRoutePhysicalTcpLegs: number;
  auditSnapshot(): Promise<AuditSnapshot>;
  stop(): Promise<void>;
}

interface SessionProfile {
  resourceKey: RemoteResourceKey & { sessionId: Id };
  keeperGeneration: Id;
  attached: boolean;
  outputBytesPerSecond: number;
  attachment?: RemoteTerminalAttachment;
  reader?: MutationReader;
}

class MutationReader {
  readonly completed: Promise<void>;
  outputBytes = 0;
  mutations = 0;
  missing = 0;
  duplicate = 0;
  reordered = 0;
  private tail = Buffer.alloc(0);
  private readonly waiters = new Map<
    string,
    {
      resolve(): void;
      reject(error: Error): void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private started = false;
  private resolveCompleted!: () => void;
  private rejectCompleted!: (error: Error) => void;

  constructor(private readonly attachment: RemoteTerminalAttachment) {
    this.completed = new Promise<void>((resolveCompleted, rejectCompleted) => {
      this.resolveCompleted = resolveCompleted;
      this.rejectCompleted = rejectCompleted;
    });
    void this.completed.catch(() => undefined);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.consume();
  }

  waitFor(token: string, timeoutMs: number): Promise<void> {
    if (this.tail.includes(Buffer.from(token, "utf8")))
      return Promise.resolve();
    if (this.waiters.has(token)) {
      return Promise.reject(
        new Error(`duplicate mutation token waiter ${token}`)
      );
    }
    return new Promise<void>((resolveToken, rejectToken) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(token);
        rejectToken(new Error(`remote profile did not echo ${token}`));
      }, timeoutMs);
      this.waiters.set(token, {
        resolve: () => {
          clearTimeout(timeout);
          resolveToken();
        },
        reject: (error) => {
          clearTimeout(timeout);
          rejectToken(error);
        },
        timeout
      });
    });
  }

  private async consume(): Promise<void> {
    try {
      for (;;) {
        const mutation = await this.attachment.nextMutation();
        if (mutation === null) break;
        this.observe(mutation);
      }
      for (const waiter of this.waiters.values()) {
        waiter.reject(
          new Error("remote profile attachment closed before echo")
        );
      }
      this.waiters.clear();
      this.resolveCompleted();
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      for (const waiter of this.waiters.values()) waiter.reject(normalized);
      this.waiters.clear();
      this.rejectCompleted(normalized);
    }
  }

  private observe(mutation: RemoteTerminalMutation): void {
    this.mutations += 1;
    if (mutation.kind !== "output" || !mutation.data) return;
    this.outputBytes += mutation.data.byteLength;
    const observed = Buffer.concat([this.tail, Buffer.from(mutation.data)]);
    for (const [token, waiter] of this.waiters) {
      if (!observed.includes(Buffer.from(token, "utf8"))) continue;
      this.waiters.delete(token);
      waiter.resolve();
    }
    this.tail = observed.subarray(-16 * 1024);
  }
}

const manifest = decodePerformanceManifest(
  JSON.parse(await readFile(manifestPath, "utf8")) as unknown
);
const scratch = await mkdtemp(join(tmpdir(), "kmux-normative-profile-"));
const pool = new SshTransportPool();
let context: ProfileContext | undefined;
let runtime: LinuxX64RemoteRuntime | undefined;
const sessions: SessionProfile[] = [];
let remoteFixturePath: string | undefined;

try {
  context = await createProfileContext(manifest);
  const auditBeforeMaster = await context.auditSnapshot();
  const assigned = await connectAssignedMaster(context, pool);
  const auditAfterMaster = await context.auditSnapshot();
  const routeBaseline = auditDelta(auditBeforeMaster, auditAfterMaster);
  assertRouteBaseline(context, manifest, routeBaseline);

  runtime = new LinuxX64RemoteRuntime({
    pool,
    assigned,
    runtimePath: context.runtimePath,
    roots: structuredClone(context.roots),
    token: randomBytes(48).toString("hex"),
    transferRoot: join(scratch, "transfers"),
    sftpPath: context.sftpPath
  });
  const hello = await runtime.connect();
  assertRuntimeTarget(context.artifactTarget, hello);

  const repositoryCommit = (
    await runChannel(
      context,
      pool,
      assigned,
      {
        kind: "control",
        remoteCommand: `git -C ${quotePosixWord(manifest.workload.git.repositoryPath)} rev-parse HEAD`
      },
      undefined,
      30_000
    )
  ).stdout.trim();
  if (repositoryCommit !== manifest.workload.git.repositoryCommit) {
    throw new Error(
      `profile Git fixture is ${repositoryCommit || "missing"}; expected ${manifest.workload.git.repositoryCommit}`
    );
  }

  remoteFixturePath = `${context.roots.stateRoot}/profile/sftp-${randomBytes(8).toString("hex")}.bin`;
  await prepareRemoteSftpFixture(
    context,
    pool,
    assigned,
    remoteFixturePath,
    manifest.workload.sftp.bytes
  );
  const directEcho = await measureDirectEcho(context, pool, assigned, 200, 100);
  const directSftp = await measureDirectSftp(
    context,
    pool,
    assigned,
    remoteFixturePath,
    join(scratch, "direct-sftp.bin"),
    manifest
  );

  sessions.push(
    ...(await createProfileSessions(context, runtime, assigned, manifest))
  );
  let checkpointCount = 0;
  for (const session of sessions.filter((candidate) => candidate.attached)) {
    session.attachment = await runtime.attach({
      resourceKey: session.resourceKey,
      expectedKeeperGeneration: session.keeperGeneration,
      access: "write"
    });
    await session.attachment.ready;
    if ((await session.attachment.checkpoint) !== null) checkpointCount += 1;
    session.reader = new MutationReader(session.attachment);
    session.reader.start();
  }

  const loopDelay = monitorEventLoopDelay({ resolution: 1 });
  loopDelay.enable();
  const profileStartedAt = performance.now();
  const profileEndsAt = profileStartedAt + manifest.workload.minimumDurationMs;
  const remoteHostRssSamples: number[] = [];
  const keeperRssSamples = new Map<number, number[]>();
  const journalSyncSamples: number[] = [];
  let gitRepetitions = 0;
  let loadedSftp: Awaited<ReturnType<typeof runtime.downloadFile>> | undefined;
  let loadedSftpSeconds = 0;

  const loadedSftpPromise = (async () => {
    const started = performance.now();
    const result = await runtime.downloadFile({
      transferId: `normative_sftp_${randomBytes(8).toString("hex")}`,
      remotePath: remoteFixturePath!,
      maxBytes: manifest.workload.sftp.bytes
    });
    loadedSftpSeconds = (performance.now() - started) / 1000;
    loadedSftp = result;
    if (
      result.byteLength !== manifest.workload.sftp.bytes ||
      result.sha256 !== manifest.workload.sftp.sha256
    ) {
      throw new Error(
        "loaded SFTP fixture failed its size or SHA-256 contract"
      );
    }
  })();

  const loadedEchoPromise = measureLoadedEcho(
    sessions,
    manifest.workload.keyEcho.probesPerSecond,
    profileEndsAt,
    context.normative
      ? NORMATIVE_ECHO_LIVENESS_TIMEOUT_MS
      : FUNCTIONAL_ECHO_LIVENESS_TIMEOUT_MS
  );
  const gitPromise = runGitLoad(
    runtime,
    assigned.targetId as Id,
    sessions[0]!.resourceKey.desktopInstallationId,
    manifest,
    profileEndsAt,
    (count) => {
      gitRepetitions = count;
    }
  );
  const resourcePromise = sampleResources(
    context,
    pool,
    assigned,
    runtime,
    sessions[0]!.resourceKey.desktopInstallationId,
    profileEndsAt,
    remoteHostRssSamples,
    keeperRssSamples,
    journalSyncSamples
  );

  await Promise.all([
    loadedSftpPromise,
    loadedEchoPromise,
    gitPromise,
    resourcePromise,
    delayUntil(profileEndsAt)
  ]);
  loopDelay.disable();
  const durationMs = performance.now() - profileStartedAt;
  if (!loadedSftp) throw new Error("loaded SFTP did not produce a result");
  await runtime.releaseFile(loadedSftp.localPath);

  for (const session of sessions.filter((candidate) => !candidate.attached)) {
    const attachment = await runtime.attach({
      resourceKey: session.resourceKey,
      expectedKeeperGeneration: session.keeperGeneration,
      access: "read"
    });
    try {
      await attachment.ready;
      if ((await attachment.checkpoint) !== null) checkpointCount += 1;
    } finally {
      await attachment.detach();
    }
  }

  for (const session of sessions.filter((candidate) => candidate.attached)) {
    await session.attachment!.detach();
    await session.reader!.completed;
  }

  const loadedEcho = await loadedEchoPromise;
  const auditAfterFeatures = await context.auditSnapshot();
  const featureDelta = auditDelta(auditAfterMaster, auditAfterFeatures);
  const keeperRss = summarizeKeeperRss(keeperRssSamples);
  const continuity = summarizeContinuity(sessions);
  const directEchoSummary = summarize(directEcho);
  const loadedEchoSummary = summarize(loadedEcho);
  const loadedSftpMiBPerSecond =
    manifest.workload.sftp.bytes / (1024 * 1024) / loadedSftpSeconds;
  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    sourceRevision: (
      await runLocal("git", ["rev-parse", "HEAD"])
    ).stdout.trim(),
    workingTreeDirty:
      (await runLocal("git", ["status", "--porcelain"])).stdout.trim().length >
      0,
    environmentKind: context.kind,
    normative: context.normative,
    limitations: context.limitations,
    artifactTarget: context.artifactTarget,
    hardware: context.hardware,
    network: context.network,
    runtime: {
      platform: hello.platform,
      arch: hello.arch,
      abi: hello.abi,
      version: hello.runtimeVersion,
      persistenceLevel: hello.persistenceLevel
    },
    workload: {
      durationMs: round(durationMs),
      keepers: sessions.length,
      attachedKeepers: sessions.filter((session) => session.attached).length,
      detachedKeepers: sessions.filter((session) => !session.attached).length,
      checkpointCount,
      gitRepetitions,
      echoSamples: loadedEcho.length,
      directEchoSamples: directEcho.length,
      sftpBytes: manifest.workload.sftp.bytes
    },
    metrics: {
      directEchoLatencyMs: directEchoSummary,
      loadedEchoLatencyMs: loadedEchoSummary,
      addedEchoLatencyMs: {
        p95: round(loadedEchoSummary.p95 - directEchoSummary.p95),
        p99: round(loadedEchoSummary.p99 - directEchoSummary.p99)
      },
      remoteHostEventLoopDelayMs: {
        p50: round(loopDelay.percentile(50) / 1_000_000),
        p95: round(loopDelay.percentile(95) / 1_000_000),
        p99: round(loopDelay.percentile(99) / 1_000_000),
        max: round(loopDelay.max / 1_000_000)
      },
      terminalMutationContinuity: continuity,
      keeperRssBytes: keeperRss,
      remoteHostProcessTreeRssBytes: {
        max: Math.max(0, ...remoteHostRssSamples),
        samples: remoteHostRssSamples.length
      },
      journalGroupSyncMs: summarize(journalSyncSamples),
      sftp: {
        directMiBPerSecond: round(directSftp.mebibytesPerSecond),
        loadedMiBPerSecond: round(loadedSftpMiBPerSecond),
        loadedToDirectRatio: round(
          loadedSftpMiBPerSecond / directSftp.mebibytesPerSecond
        )
      },
      routeBaseline,
      featureDelta
    }
  };
  const failures = evaluateReport(report, manifest, context);
  const completed = {
    ...report,
    status: failures.length === 0 ? "passed" : "failed",
    failures
  };
  const outputPath = await writeProfileResult(completed);
  process.stdout.write(
    `${JSON.stringify({ ...completed, outputPath }, null, 2)}\n`
  );
  if (failures.length !== 0) {
    throw new Error(`SSH profile failed: ${failures.join("; ")}`);
  }
} finally {
  if (runtime) {
    for (const session of sessions) {
      await terminateProfileSession(runtime, session).catch(() => undefined);
      await session.attachment?.detach().catch(() => undefined);
    }
    if (remoteFixturePath && context) {
      const assigned = pool.getAssigned(context.targetId);
      if (assigned) {
        await runChannel(context, pool, assigned, {
          kind: "control",
          remoteCommand: `rm -f ${quotePosixWord(remoteFixturePath)}`
        }).catch(() => undefined);
      }
    }
    await runtime.close().catch(() => undefined);
  }
  await pool.close().catch(() => undefined);
  await context?.stop().catch(() => undefined);
  await rm(scratch, { recursive: true, force: true });
}

async function createProfileContext(
  selectedManifest: PerformanceManifest
): Promise<ProfileContext> {
  if (process.env[FUNCTIONAL_CONTAINER_ENV] === "1") {
    return await createContainerContext(selectedManifest);
  }
  const configuredPath = process.env[PROFILE_CONFIGURATION_ENV];
  if (!configuredPath || !isAbsolute(configuredPath)) {
    throw new Error(
      `normative SSH profiling requires an absolute ${PROFILE_CONFIGURATION_ENV} file; use npm run profile:ssh:functional only for explicit non-normative Docker evidence`
    );
  }
  const configuration = decodeNativeProfileConfiguration(
    JSON.parse(await readFile(configuredPath, "utf8")) as unknown
  );
  let stopped = false;
  return {
    kind: "controlled-native",
    normative: !configuration.sharedHost && process.env.CI !== "true",
    limitations: [
      ...(configuration.sharedHost
        ? [
            "The target is marked as shared and cannot provide normative evidence."
          ]
        : []),
      ...(process.env.CI === "true"
        ? ["Shared CI execution cannot provide normative performance evidence."]
        : [])
    ],
    artifactTarget: configuration.artifactTarget,
    sshPath: configuration.sshPath,
    sftpPath: configuration.sftpPath,
    configPath: configuration.configPath,
    host: configuration.host,
    ...(configuration.controlRoot === undefined
      ? {}
      : { controlRoot: configuration.controlRoot }),
    runtimePath: configuration.runtimePath,
    roots: structuredClone(configuration.roots),
    targetId: configuration.targetId,
    hardware: structuredClone(configuration.hardware),
    network: structuredClone(configuration.network),
    resolvedRoutePhysicalTcpLegs: configuration.resolvedRoutePhysicalTcpLegs,
    auditSnapshot: async () =>
      await runAuditSnapshot(configuration.auditSnapshot),
    async stop() {
      if (stopped) return;
      stopped = true;
    }
  };
}

async function createContainerContext(
  selectedManifest: PerformanceManifest
): Promise<ProfileContext> {
  // Testcontainers is loaded only for the explicitly non-normative lane. The
  // controlled-native process therefore measures the remote-host runtime and
  // its OpenSSH children without carrying the container orchestrator's RSS.
  const { startSshTarget } = await import("../harness/sshTarget");
  const target = await startSshTarget();
  const toxics = [
    await target.faults.addLatency({
      latencyMs: selectedManifest.network.roundTripLatencyMs / 2,
      jitterMs: 0,
      direction: "upstream"
    }),
    await target.faults.addLatency({
      latencyMs: selectedManifest.network.roundTripLatencyMs / 2,
      jitterMs: 0,
      direction: "downstream"
    })
  ];
  const facts = await readContainerFacts(target);
  const suffix = randomBytes(8).toString("hex");
  let stopped = false;
  return {
    kind: "docker-functional",
    normative: false,
    limitations: [
      "Docker Desktop or a shared container runtime is functional evidence only.",
      `The fixture exposed ${facts.physicalCpuCores} logical CPU(s), ${facts.memoryBytes} bytes of RAM, and ${facts.stateStorage}.`
    ],
    artifactTarget: "linux-x64-musl",
    sshPath: target.sshPath,
    sftpPath: target.sftpPath,
    configPath: target.sshConfigPath,
    host: target.hostAlias,
    controlRoot: target.controlDirectoryPath,
    runtimePath: target.remoteRuntimePath,
    roots: profileRoots(`/home/kmux/.kmux-profile-${suffix}`),
    targetId: `target_profile_${suffix}` as Id,
    hardware: {
      ...facts,
      evidence: "Testcontainers target inspection"
    },
    network: {
      roundTripLatencyMs: selectedManifest.network.roundTripLatencyMs,
      maximumInjectedJitterMs: 0,
      evidence: "Toxiproxy upstream/downstream latency toxics"
    },
    resolvedRoutePhysicalTcpLegs: 1,
    auditSnapshot: async () => {
      const snapshot = await target.audit.snapshot();
      return {
        ...snapshot,
        physicalTcpLegs: snapshot.acceptedTcpConnections
      };
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await Promise.allSettled(toxics.map((toxic) => toxic.remove()));
      await target.stop();
    }
  };
}

async function connectAssignedMaster(
  context: ProfileContext,
  selectedPool: SshTransportPool
): Promise<AssignedSshMaster> {
  const attemptId = `profile_attempt_${randomBytes(8).toString("hex")}`;
  const effectiveConnectionPolicyHash = createHash("sha256")
    .update(
      JSON.stringify({
        sshPath: context.sshPath,
        configPath: context.configPath,
        host: context.host
      })
    )
    .digest("hex");
  await selectedPool.connectProvisional({
    connectionAttemptId: attemptId,
    effectiveConnectionPolicyHash,
    sshPath: context.sshPath,
    configPath: context.configPath,
    host: context.host,
    ...(context.controlRoot === undefined
      ? {}
      : { controlRoot: context.controlRoot })
  });
  return await selectedPool.promote({
    connectionAttemptId: attemptId,
    targetId: context.targetId,
    effectiveConnectionPolicyHash
  });
}

async function createProfileSessions(
  context: ProfileContext,
  selectedRuntime: LinuxX64RemoteRuntime,
  assigned: AssignedSshMaster,
  selectedManifest: PerformanceManifest
): Promise<SessionProfile[]> {
  const suffix = randomBytes(8).toString("hex");
  const desktopInstallationId = `desktop_profile_${suffix}` as Id;
  const workspaceId = `workspace_profile_${suffix}` as Id;
  const baseSeed = BigInt(
    selectedManifest.workload.terminalOutputGenerator.seed
  );
  const created: SessionProfile[] = [];
  for (
    let index = 0;
    index < selectedManifest.workload.keepers.total;
    index += 1
  ) {
    const attached = index < selectedManifest.workload.keepers.attached;
    const outputBytesPerSecond = attached
      ? selectedManifest.workload.keepers.attachedOutputBytesPerSecondEach
      : selectedManifest.workload.keepers.detachedOutputBytesPerSecondEach;
    const sessionId = `session_profile_${index}_${suffix}` as Id;
    const resourceKey = {
      desktopInstallationId,
      targetId: assigned.targetId as Id,
      workspaceId,
      sessionId
    };
    const payload: RemoteOperationPayloadDto = {
      kind: "session.create",
      sessionId,
      surfaceId: `surface_profile_${index}_${suffix}` as Id,
      paneId: `pane_profile_${index}_${suffix}` as Id,
      launch: {
        cwd: selectedManifest.workload.git.repositoryPath,
        shell: context.runtimePath,
        args: [
          "profile",
          "terminal-load",
          "--bytes-per-second",
          String(outputBytesPerSecond),
          "--seed",
          `0x${(baseSeed + BigInt(index + 1)).toString(16)}`
        ]
      }
    };
    const outcome = await selectedRuntime.executeOperation(
      operationIntent(
        `create_profile_${index}_${suffix}` as Id,
        resourceKey,
        payload,
        0n
      ),
      payload
    );
    if (outcome.status !== "succeeded" || !outcome.keeperGeneration) {
      throw new Error(`profile keeper ${index} failed to start`);
    }
    created.push({
      resourceKey,
      keeperGeneration: outcome.keeperGeneration,
      attached,
      outputBytesPerSecond
    });
  }
  return created;
}

async function terminateProfileSession(
  selectedRuntime: LinuxX64RemoteRuntime,
  session: SessionProfile
): Promise<void> {
  const payload: RemoteOperationPayloadDto = {
    kind: "session.terminate",
    sessionId: session.resourceKey.sessionId
  };
  await selectedRuntime.executeOperation(
    operationIntent(
      makeId("terminate-profile"),
      session.resourceKey,
      payload,
      1n
    ),
    payload
  );
}

function operationIntent(
  operationId: Id,
  resourceKey: RemoteResourceKey,
  payload: RemoteOperationPayloadDto,
  expectedRevision: bigint
) {
  return {
    operationId,
    kind: payload.kind,
    resourceKey: structuredClone(resourceKey),
    expectedWorkspaceRevision: "a".repeat(64),
    expectedRemoteResourceRevision: uint64(expectedRevision),
    nextRemoteResourceRevision: uint64(expectedRevision + 1n),
    ...(payload.kind === "session.create"
      ? { createOperationId: operationId }
      : {}),
    canonicalPayloadHash: createHash("sha256")
      .update(canonicalizeRemoteOperationPayload(payload))
      .digest("hex"),
    createdAt: new Date().toISOString()
  };
}

async function measureLoadedEcho(
  sessions: SessionProfile[],
  probesPerSecond: number,
  endsAt: number,
  livenessTimeoutMs: number
): Promise<number[]> {
  const attached = sessions.filter((session) => session.attached);
  const samples: number[] = [];
  const intervalMs = 1000 / probesPerSecond;
  let nextProbeAt = performance.now();
  let index = 0;
  while (performance.now() < endsAt) {
    const waitMs = nextProbeAt - performance.now();
    if (waitMs > 0) await delay(waitMs);
    if (performance.now() >= endsAt) break;
    const session = attached[index % attached.length]!;
    const token = `kmux-profile-${index.toString().padStart(8, "0")}-${randomBytes(8).toString("hex")}`;
    const observed = session.reader!.waitFor(token, livenessTimeoutMs).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error : new Error(String(error))
      })
    );
    const started = performance.now();
    await session.attachment!.sendInput(
      uint64(BigInt(index + 1)),
      new TextEncoder().encode(`${token}\n`)
    );
    const inputAcknowledgementMs = performance.now() - started;
    const observation = await observed;
    if (!observation.ok) {
      throw new Error(
        `${observation.error.message}; input acknowledgement took ${round(inputAcknowledgementMs)} ms on ${session.resourceKey.sessionId}`,
        { cause: observation.error }
      );
    }
    samples.push(performance.now() - started);
    index += 1;
    nextProbeAt = Math.max(nextProbeAt + intervalMs, performance.now());
  }
  return samples;
}

async function runGitLoad(
  selectedRuntime: LinuxX64RemoteRuntime,
  targetId: Id,
  desktopInstallationId: Id,
  selectedManifest: PerformanceManifest,
  endsAt: number,
  onCount: (count: number) => void
): Promise<void> {
  let count = 0;
  let nextAt = performance.now();
  const intervalMs = 1000 / selectedManifest.workload.git.repetitionsPerSecond;
  while (performance.now() < endsAt) {
    const waitMs = nextAt - performance.now();
    if (waitMs > 0) await delay(waitMs);
    if (performance.now() >= endsAt) break;
    await selectedRuntime.inspectGit({
      desktopInstallationId,
      targetId,
      cwd: selectedManifest.workload.git.repositoryPath,
      dirtyLimit: 64
    });
    count += 1;
    onCount(count);
    nextAt = Math.max(nextAt + intervalMs, performance.now());
  }
}

async function sampleResources(
  context: ProfileContext,
  selectedPool: SshTransportPool,
  assigned: AssignedSshMaster,
  selectedRuntime: LinuxX64RemoteRuntime,
  desktopInstallationId: Id,
  endsAt: number,
  remoteHostRssSamples: number[],
  keeperRssSamples: Map<number, number[]>,
  journalSyncSamples: number[]
): Promise<void> {
  let nextAt = performance.now();
  while (performance.now() < endsAt) {
    const waitMs = nextAt - performance.now();
    if (waitMs > 0) await delay(waitMs);
    if (performance.now() >= endsAt) break;
    const [localRss, remoteProcesses, observation] = await Promise.all([
      processTreeRssBytes(process.pid),
      readKeeperProcesses(context, selectedPool, assigned),
      selectedRuntime.observe({
        desktopInstallationId,
        targetId: assigned.targetId as Id
      })
    ]);
    remoteHostRssSamples.push(localRss);
    for (const process of remoteProcesses) {
      const samples = keeperRssSamples.get(process.pid) ?? [];
      samples.push(process.rssBytes);
      keeperRssSamples.set(process.pid, samples);
    }
    for (const keeper of observation.keepers) {
      if (keeper.storageStatus?.lastSyncDurationMs !== undefined) {
        journalSyncSamples.push(keeper.storageStatus.lastSyncDurationMs);
      }
    }
    nextAt = Math.max(nextAt + 1_000, performance.now());
  }
}

async function readKeeperProcesses(
  context: ProfileContext,
  selectedPool: SshTransportPool,
  assigned: AssignedSshMaster
): Promise<Array<{ pid: number; rssBytes: number }>> {
  const result = await runChannel(context, selectedPool, assigned, {
    kind: "metadata",
    remoteCommand: "ps -axo pid=,rss=,command="
  });
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line))
    .filter((match): match is RegExpExecArray =>
      Boolean(
        match &&
        match[3]!.includes("keeper serve") &&
        match[3]!.includes(context.roots.stateRoot)
      )
    )
    .map((match) => ({
      pid: Number(match[1]),
      rssBytes: Number(match[2]) * 1024
    }));
}

async function processTreeRssBytes(rootPid: number): Promise<number> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss="], {
    timeout: 10_000,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES
  });
  const processes = stdout
    .split(/\r?\n/u)
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024
    }));
  const included = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (!included.has(process.pid) && included.has(process.parentPid)) {
        included.add(process.pid);
        changed = true;
      }
    }
  }
  return processes.reduce(
    (total, process) =>
      total + (included.has(process.pid) ? process.rssBytes : 0),
    0
  );
}

async function prepareRemoteSftpFixture(
  context: ProfileContext,
  selectedPool: SshTransportPool,
  assigned: AssignedSshMaster,
  remotePath: string,
  bytes: number
): Promise<void> {
  if (bytes % (1024 * 1024) !== 0) {
    throw new Error("profile SFTP fixture must be an exact MiB multiple");
  }
  await runChannel(
    context,
    selectedPool,
    assigned,
    {
      kind: "control",
      remoteCommand: [
        `install -d -m 700 ${quotePosixWord(dirname(remotePath))}`,
        `dd if=/dev/zero of=${quotePosixWord(remotePath)} bs=1048576 count=${bytes / (1024 * 1024)} 2>/dev/null`,
        `chmod 600 ${quotePosixWord(remotePath)}`
      ].join(" && ")
    },
    undefined,
    10 * 60_000
  );
}

async function measureDirectSftp(
  context: ProfileContext,
  selectedPool: SshTransportPool,
  assigned: AssignedSshMaster,
  remotePath: string,
  localPath: string,
  selectedManifest: PerformanceManifest
): Promise<{ seconds: number; mebibytesPerSecond: number }> {
  const started = performance.now();
  await runChannel(
    context,
    selectedPool,
    assigned,
    { kind: "sftp" },
    `get ${quoteSftpPath(remotePath)} ${quoteSftpPath(localPath)}\nquit\n`,
    15 * 60_000
  );
  const seconds = (performance.now() - started) / 1000;
  const metadata = await stat(localPath);
  const sha256 = await sha256File(localPath);
  if (
    metadata.size !== selectedManifest.workload.sftp.bytes ||
    sha256 !== selectedManifest.workload.sftp.sha256
  ) {
    throw new Error("direct SFTP fixture failed its size or SHA-256 contract");
  }
  await rm(localPath, { force: true });
  return {
    seconds,
    mebibytesPerSecond:
      selectedManifest.workload.sftp.bytes / (1024 * 1024) / seconds
  };
}

async function measureDirectEcho(
  context: ProfileContext,
  selectedPool: SshTransportPool,
  assigned: AssignedSshMaster,
  sampleCount: number,
  intervalMs: number
): Promise<number[]> {
  const child = await spawnMuxOnlyChannel(
    channelRequest(context, assigned, {
      kind: "terminal",
      remoteCommand:
        "stty -echo -icanon min 1 time 0; printf 'KMUX_DIRECT_READY\\n'; cat"
    }),
    {
      isCurrentGeneration: (generation) =>
        selectedPool.isCurrentGeneration(assigned.targetId, generation)
    }
  );
  const stream = createChildTokenStream(child);
  try {
    await stream.waitFor("KMUX_DIRECT_READY", 10_000);
    const samples: number[] = [];
    let nextAt = performance.now();
    for (let index = 0; index < sampleCount; index += 1) {
      const waitMs = nextAt - performance.now();
      if (waitMs > 0) await delay(waitMs);
      const token = `kmux-direct-${index.toString().padStart(6, "0")}-${randomBytes(8).toString("hex")}`;
      const observed = stream.waitFor(token, 2_000);
      const started = performance.now();
      if (!child.stdin?.write(`${token}\n`)) {
        await new Promise<void>((resolveDrain) =>
          child.stdin?.once("drain", resolveDrain)
        );
      }
      await observed;
      samples.push(performance.now() - started);
      nextAt = Math.max(nextAt + intervalMs, performance.now());
    }
    return samples;
  } finally {
    child.stdin?.end();
    await closeChild(child);
  }
}

function summarizeContinuity(sessions: SessionProfile[]) {
  return sessions.reduce(
    (result, session) => ({
      missing: result.missing + (session.reader?.missing ?? 0),
      duplicate: result.duplicate + (session.reader?.duplicate ?? 0),
      reordered: result.reordered + (session.reader?.reordered ?? 0),
      mutationCount: result.mutationCount + (session.reader?.mutations ?? 0),
      outputBytes: result.outputBytes + (session.reader?.outputBytes ?? 0)
    }),
    { missing: 0, duplicate: 0, reordered: 0, mutationCount: 0, outputBytes: 0 }
  );
}

function summarizeKeeperRss(samples: Map<number, number[]>) {
  const keepers = [...samples.entries()].map(([pid, values]) => ({
    pid,
    samples: values.length,
    p95: percentile(values, 95),
    max: Math.max(0, ...values)
  }));
  return {
    keepers,
    maximumPerKeeperP95: Math.max(0, ...keepers.map((keeper) => keeper.p95))
  };
}

function evaluateReport(
  report: Record<string, any>,
  selectedManifest: PerformanceManifest,
  context: ProfileContext
): string[] {
  const failures: string[] = [];
  const workload = report.workload;
  const metrics = report.metrics;
  requireGate(
    workload.durationMs >= selectedManifest.workload.minimumDurationMs,
    "workload duration was shorter than the immutable manifest",
    failures
  );
  requireGate(
    workload.keepers === selectedManifest.workload.keepers.total &&
      workload.attachedKeepers === selectedManifest.workload.keepers.attached &&
      workload.detachedKeepers === selectedManifest.workload.keepers.detached,
    "keeper topology changed",
    failures
  );
  requireGate(
    workload.checkpointCount >=
      selectedManifest.workload.checkpoint.minimumCompletedPerKeeper *
        selectedManifest.workload.keepers.total,
    "not every keeper completed a checkpoint",
    failures
  );
  requireGate(
    metrics.terminalMutationContinuity.missing === 0 &&
      metrics.terminalMutationContinuity.duplicate === 0 &&
      metrics.terminalMutationContinuity.reordered === 0 &&
      metrics.terminalMutationContinuity.mutationCount > 0,
    "terminal mutation continuity failed",
    failures
  );
  requireGate(
    metrics.routeBaseline.acceptedAuthentications ===
      selectedManifest.gates.sshFeatureTransport
        .targetAuthenticatedMasterRoutes &&
      metrics.routeBaseline.physicalTcpLegs ===
        context.resolvedRoutePhysicalTcpLegs,
    "master route baseline changed",
    failures
  );
  requireGate(
    metrics.featureDelta.authenticationAttempts ===
      selectedManifest.gates.sshFeatureTransport
        .featureAuthenticationAttempts &&
      metrics.featureDelta.acceptedTcpConnections === 0 &&
      metrics.featureDelta.physicalTcpLegs === 0,
    "feature traffic opened a direct route or authentication",
    failures
  );
  if (!context.normative) return failures;

  requireGate(
    context.hardware.physicalCpuCores >=
      selectedManifest.referenceTargetMinimum.physicalCpuCores &&
      context.hardware.memoryBytes >=
        selectedManifest.referenceTargetMinimum.memoryBytes &&
      context.hardware.stateStorage ===
        selectedManifest.referenceTargetMinimum.stateStorage,
    "reference target hardware minimum is not satisfied",
    failures
  );
  requireGate(
    context.network.roundTripLatencyMs ===
      selectedManifest.network.roundTripLatencyMs &&
      context.network.maximumInjectedJitterMs <=
        selectedManifest.network.maximumInjectedJitterMs,
    "controlled network contract is not satisfied",
    failures
  );
  requireGate(
    metrics.addedEchoLatencyMs.p95 <=
      selectedManifest.gates.addedKeyEchoLatencyMs.p95Max &&
      metrics.addedEchoLatencyMs.p99 <=
        selectedManifest.gates.addedKeyEchoLatencyMs.p99Max,
    "added key-echo latency exceeded its gate",
    failures
  );
  requireGate(
    metrics.remoteHostEventLoopDelayMs.p99 <=
      selectedManifest.gates.remoteHostEventLoopDelayMs.p99Max &&
      metrics.remoteHostEventLoopDelayMs.max <=
        selectedManifest.gates.remoteHostEventLoopDelayMs.singleStallMax,
    "remote-host event-loop delay exceeded its gate",
    failures
  );
  requireGate(
    metrics.keeperRssBytes.keepers.length ===
      selectedManifest.workload.keepers.total &&
      metrics.keeperRssBytes.maximumPerKeeperP95 <=
        selectedManifest.gates.keeperRssBytes.p95Max,
    "keeper RSS exceeded its gate or a keeper was not sampled",
    failures
  );
  requireGate(
    metrics.remoteHostProcessTreeRssBytes.max <=
      selectedManifest.gates.remoteHostProcessTreeRssBytes.max,
    "remote-host process-tree RSS exceeded its gate",
    failures
  );
  requireGate(
    metrics.journalGroupSyncMs.count > 0 &&
      metrics.journalGroupSyncMs.p99 <=
        selectedManifest.gates.journalGroupSyncMs.p99Max,
    "journal group-sync p99 exceeded its gate or emitted no samples",
    failures
  );
  requireGate(
    metrics.sftp.loadedToDirectRatio >=
      selectedManifest.gates.loadedSftpThroughput.minimumDirectBaselineRatio,
    "loaded SFTP throughput fell below its direct baseline ratio",
    failures
  );
  return failures;
}

function requireGate(
  condition: boolean,
  message: string,
  failures: string[]
): void {
  if (!condition) failures.push(message);
}

async function writeProfileResult(report: unknown): Promise<string> {
  const configured = process.env.KMUX_SSH_PROFILE_OUTPUT;
  const outputPath = configured
    ? resolve(configured)
    : join(
        PROFILE_RESULT_ROOT,
        `remote-performance-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`
      );
  if (!isAbsolute(outputPath)) {
    throw new Error("SSH profile output path must be absolute");
  }
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600
  });
  return outputPath;
}

function channelRequest(
  context: ProfileContext,
  assigned: AssignedSshMaster,
  request:
    | { kind: "control" | "metadata"; remoteCommand: string }
    | { kind: "terminal"; remoteCommand?: string }
    | { kind: "sftp" }
): MuxOnlyChannelRequest {
  return {
    ...request,
    sshPath: context.sshPath,
    sftpPath: context.sftpPath,
    configPath: context.configPath,
    controlPath: assigned.master.controlPath,
    host: context.host,
    masterGeneration: assigned.generation
  } as MuxOnlyChannelRequest;
}

async function runChannel(
  context: ProfileContext,
  selectedPool: SshTransportPool,
  assigned: AssignedSshMaster,
  request:
    | { kind: "control" | "metadata"; remoteCommand: string }
    | { kind: "terminal"; remoteCommand?: string }
    | { kind: "sftp" },
  input?: string,
  timeoutMs = 30_000
) {
  const launch = await buildMuxOnlyLaunch(
    channelRequest(context, assigned, request)
  );
  if (
    !selectedPool.isCurrentGeneration(assigned.targetId, assigned.generation)
  ) {
    throw new Error("assigned master changed during SSH profiling");
  }
  return await runOpenSshCommand(launch.executable, launch.args, {
    env: launch.env,
    input,
    timeoutMs,
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES
  });
}

function createChildTokenStream(child: ChildProcess) {
  let buffered = Buffer.alloc(0);
  const waiters = new Map<
    string,
    {
      resolve(): void;
      reject(error: Error): void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  const onData = (chunk: Buffer): void => {
    buffered = Buffer.concat([buffered, chunk]).subarray(-64 * 1024);
    for (const [token, waiter] of waiters) {
      if (!buffered.includes(Buffer.from(token, "utf8"))) continue;
      waiters.delete(token);
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
  };
  const onClose = (): void => {
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("direct echo channel closed"));
    }
    waiters.clear();
  };
  child.stdout?.on("data", onData);
  child.once("close", onClose);
  return {
    waitFor(token: string, timeoutMs: number): Promise<void> {
      if (buffered.includes(Buffer.from(token, "utf8")))
        return Promise.resolve();
      return new Promise<void>((resolveToken, rejectToken) => {
        const timeout = setTimeout(() => {
          waiters.delete(token);
          rejectToken(new Error(`direct channel did not echo ${token}`));
        }, timeoutMs);
        waiters.set(token, {
          resolve: resolveToken,
          reject: rejectToken,
          timeout
        });
      });
    }
  };
}

async function closeChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolveClosed) =>
    child.once("close", () => resolveClosed())
  );
  const graceful = await Promise.race([
    closed.then(() => true),
    delay(2_000).then(() => false)
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([closed, delay(2_000)]);
  }
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
  await Promise.race([closed, delay(2_000)]);
}

function auditDelta(
  before: AuditSnapshot,
  after: AuditSnapshot
): AuditSnapshot {
  return {
    ...SshConnectionAudit.delta(before, after),
    physicalTcpLegs: after.physicalTcpLegs - before.physicalTcpLegs
  };
}

function assertRouteBaseline(
  context: ProfileContext,
  selectedManifest: PerformanceManifest,
  baseline: AuditSnapshot
): void {
  if (
    baseline.acceptedAuthentications !==
      selectedManifest.gates.sshFeatureTransport
        .targetAuthenticatedMasterRoutes ||
    baseline.authenticationAttempts !== 1 ||
    baseline.physicalTcpLegs !== context.resolvedRoutePhysicalTcpLegs
  ) {
    throw new Error(
      `SSH route baseline is not one authenticated master: ${JSON.stringify(baseline)}`
    );
  }
}

async function runAuditSnapshot(options: {
  executable: string;
  args: string[];
}): Promise<AuditSnapshot> {
  const result = await execFileAsync(options.executable, options.args, {
    timeout: 30_000,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES
  });
  const value = JSON.parse(result.stdout) as Record<string, unknown>;
  const keys = [
    "acceptedAuthentications",
    "acceptedTcpConnections",
    "authenticationAttempts",
    "closedConnections",
    "liveTcpConnections",
    "physicalTcpLegs"
  ];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)) {
    throw new Error("profile audit snapshot has unknown or missing fields");
  }
  return Object.fromEntries(
    keys.map((key) => [key, requireNonNegativeInteger(value[key], key)])
  ) as unknown as AuditSnapshot;
}

async function readContainerFacts(target: StartedSshTarget) {
  const [cpu, memory, filesystem] = await Promise.all([
    target.target.exec(["nproc"]),
    target.target.exec([
      "sh",
      "-c",
      "awk '/MemTotal/ {print $2 * 1024}' /proc/meminfo"
    ]),
    target.target.exec(["stat", "-f", "-c", "%T", "/home/kmux"])
  ]);
  if (
    cpu.exitCode !== 0 ||
    memory.exitCode !== 0 ||
    filesystem.exitCode !== 0
  ) {
    throw new Error("could not inspect functional profile target facts");
  }
  return {
    physicalCpuCores: Number(cpu.stdout.trim()),
    memoryBytes: Number(memory.stdout.trim()),
    stateStorage: filesystem.stdout.trim() === "ext2/ext3" ? "other" : "other"
  } as const;
}

function profileRoots(root: string): RemoteRuntimeRootsDto {
  return {
    installRoot: `${root}/install`,
    authorityRoot: `${root}/authority`,
    stateRoot: `${root}/state`,
    runtimeRoot: `${root}/run`
  };
}

function assertRuntimeTarget(
  target: NativeProfileConfiguration["artifactTarget"],
  hello: { platform: string; arch: string; abi: string }
): void {
  const actual = `${normalizePlatform(hello.platform)}/${normalizeArch(hello.arch)}/${hello.abi}`;
  const expected = {
    "darwin-arm64": "darwin/arm64/native",
    "darwin-x64": "darwin/x64/native",
    "linux-arm64-musl": "linux/arm64/musl",
    "linux-x64-musl": "linux/x64/musl"
  }[target];
  if (actual !== expected) {
    throw new Error(`runtime target ${actual} does not match ${target}`);
  }
}

function normalizePlatform(value: string): string {
  return value === "macos" ? "darwin" : value;
}

function normalizeArch(value: string): string {
  if (value === "aarch64") return "arm64";
  if (value === "x86_64") return "x64";
  return value;
}

function decodePerformanceManifest(value: unknown): PerformanceManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("remote performance manifest must be an object");
  }
  const manifest = value as PerformanceManifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.workload.keepers.total !== 16 ||
    manifest.workload.keepers.attached !== 4 ||
    manifest.workload.keepers.detached !== 12 ||
    manifest.workload.minimumDurationMs !== 120_000 ||
    manifest.workload.sftp.bytes !== 512 * 1024 * 1024
  ) {
    throw new TypeError("remote performance manifest topology was weakened");
  }
  return structuredClone(manifest);
}

function decodeNativeProfileConfiguration(
  value: unknown
): NativeProfileConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("SSH profile configuration must be an object");
  }
  const config = value as NativeProfileConfiguration;
  const expectedKeys = [
    "artifactTarget",
    "auditSnapshot",
    "configPath",
    "controlRoot",
    "environmentKind",
    "hardware",
    "host",
    "network",
    "resolvedRoutePhysicalTcpLegs",
    "roots",
    "runtimePath",
    "schemaVersion",
    "sftpPath",
    "sharedHost",
    "sshPath",
    "targetId"
  ];
  const actualKeys = Object.keys(config).sort();
  const acceptedKeys = expectedKeys.filter(
    (key) => key !== "controlRoot" || config.controlRoot !== undefined
  );
  if (
    config.schemaVersion !== 1 ||
    config.environmentKind !== "controlled-native" ||
    JSON.stringify(actualKeys) !== JSON.stringify(acceptedKeys)
  ) {
    throw new TypeError(
      "SSH profile configuration has unknown or missing fields"
    );
  }
  for (const path of [config.sshPath, config.sftpPath, config.configPath]) {
    if (!isAbsolute(path))
      throw new TypeError("profile local paths must be absolute");
  }
  for (const path of Object.values(config.roots)) {
    if (!path.startsWith("/"))
      throw new TypeError("profile remote roots must be absolute");
  }
  if (
    !Number.isSafeInteger(config.resolvedRoutePhysicalTcpLegs) ||
    config.resolvedRoutePhysicalTcpLegs < 1
  ) {
    throw new TypeError("resolved route physical leg count is invalid");
  }
  return structuredClone(config);
}

function summarize(values: number[]) {
  if (values.length === 0) {
    return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  return {
    count: values.length,
    min: round(Math.min(...values)),
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    p99: round(percentile(values, 99)),
    max: round(Math.max(...values))
  };
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))]!;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function runLocal(executable: string, args: string[]) {
  return await execFileAsync(executable, args, {
    cwd: repositoryRoot,
    timeout: 30_000,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES
  });
}

function quotePosixWord(value: string): string {
  if (
    value.length === 0 ||
    value.length > 32 * 1024 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(
      "remote profile path is empty, oversized, or multiline"
    );
  }
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function quoteSftpPath(value: string): string {
  if (
    value.length === 0 ||
    value.length > 32 * 1024 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError("SFTP profile path is empty, oversized, or multiline");
  }
  return `"${value.replace(/([\\" ])/gu, "\\$1")}"`;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

async function delayUntil(deadline: number): Promise<void> {
  while (performance.now() < deadline) {
    await delay(Math.min(1_000, deadline - performance.now()));
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

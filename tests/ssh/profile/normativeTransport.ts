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
import {
  decodeNativeProfileConfiguration,
  isSharedCiEnvironment,
  NATIVE_PROFILE_MAX_RUNTIME_ARTIFACT_BYTES,
  verifyNativeProfileRuntimeArtifact,
  type NativeProfileConfiguration
} from "./nativeProfileConfiguration";

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
    terminalOutputGenerator: {
      seed: string;
      statusRequestPrefix: string;
      steadyChunkBytes: number;
      burst: {
        triggerPrefix: string;
        attachedKeepers: number;
        totalBytes: number;
        chunkBytes: number;
        chunkIntervalMs: number;
        echoProbes: number;
        completionTimeoutMs: number;
      };
    };
    checkpoint: { minimumCompletedPerKeeper: number };
  };
  gates: {
    addedKeyEchoLatencyMs: { p95Max: number; p99Max: number };
    remoteHostEventLoopDelayMs: { p99Max: number; singleStallMax: number };
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
  expectedRuntimeSha256?: string;
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
  nextInputSequence: bigint;
  attachment?: RemoteTerminalAttachment;
  reader?: MutationReader;
}

class MutationReader {
  readonly completed: Promise<void>;
  outputBytes = 0;
  mutations = 0;
  private tail = Buffer.alloc(0);
  private readonly waiters = new Map<
    string,
    {
      resolve(outputOffset: number): void;
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

  waitFor(token: string, timeoutMs: number): Promise<number> {
    const encodedToken = Buffer.from(token, "utf8");
    const existingIndex = this.tail.indexOf(encodedToken);
    if (existingIndex >= 0) {
      return Promise.resolve(
        this.outputBytes - this.tail.byteLength + existingIndex
      );
    }
    if (this.waiters.has(token)) {
      return Promise.reject(
        new Error(`duplicate mutation token waiter ${token}`)
      );
    }
    return new Promise<number>((resolveToken, rejectToken) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(token);
        rejectToken(new Error(`remote profile did not echo ${token}`));
      }, timeoutMs);
      this.waiters.set(token, {
        resolve: (outputOffset) => {
          clearTimeout(timeout);
          resolveToken(outputOffset);
        },
        reject: (error) => {
          clearTimeout(timeout);
          rejectToken(error);
        },
        timeout
      });
    });
  }

  tailText(): string {
    return this.tail.toString("utf8");
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
    const observedStartOffset = this.outputBytes - this.tail.byteLength;
    this.outputBytes += mutation.data.byteLength;
    const observed = Buffer.concat([this.tail, Buffer.from(mutation.data)]);
    for (const [token, waiter] of this.waiters) {
      const tokenIndex = observed.indexOf(Buffer.from(token, "utf8"));
      if (tokenIndex < 0) continue;
      this.waiters.delete(token);
      waiter.resolve(observedStartOffset + tokenIndex);
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
  const sourceRevision = (
    await runLocal("git", ["rev-parse", "HEAD"])
  ).stdout.trim();
  const workingTreeDirty =
    (await runLocal("git", ["status", "--porcelain"])).stdout.trim().length > 0;
  if (context.normative && workingTreeDirty) {
    throw new Error("normative SSH profiling requires a clean local worktree");
  }
  const auditBeforeMaster = await context.auditSnapshot();
  const assigned = await connectAssignedMaster(context, pool);
  const auditAfterMaster = await context.auditSnapshot();
  const routeBaseline = auditDelta(auditBeforeMaster, auditAfterMaster);
  assertRouteBaseline(context, manifest, routeBaseline);
  const openSsh = await inspectOpenSshVersions(context, pool, assigned);
  const runtimeSha256 = await readRemoteRuntimeSha256(
    context,
    pool,
    assigned,
    join(scratch, "remote-runtime-artifact")
  );
  if (
    context.expectedRuntimeSha256 !== undefined &&
    runtimeSha256 !== context.expectedRuntimeSha256
  ) {
    throw new Error(
      `remote runtime SHA-256 ${runtimeSha256} does not match configured artifact ${context.expectedRuntimeSha256}`
    );
  }

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
  const journalAdmittedBySession = new Map<Id, bigint>();
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
    journalSyncSamples,
    journalAdmittedBySession
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
  const terminalBurst = await runTerminalBurst(sessions, manifest);
  if (!loadedSftp) throw new Error("loaded SFTP did not produce a result");
  await runtime.releaseFile(loadedSftp.localPath);

  const generatorStatuses = new Map<
    Id,
    { steadyOutputBytes: bigint; burstOutputBytes: bigint }
  >();
  await Promise.all(
    sessions
      .filter((session) => session.attached)
      .map(async (session) => {
        generatorStatuses.set(
          session.resourceKey.sessionId,
          await queryTerminalGeneratorStatus(session, manifest)
        );
      })
  );

  for (const session of sessions.filter((candidate) => !candidate.attached)) {
    session.attachment = await runtime.attach({
      resourceKey: session.resourceKey,
      expectedKeeperGeneration: session.keeperGeneration,
      access: "write"
    });
    try {
      await session.attachment.ready;
      if ((await session.attachment.checkpoint) !== null) checkpointCount += 1;
      session.reader = new MutationReader(session.attachment);
      session.reader.start();
      generatorStatuses.set(
        session.resourceKey.sessionId,
        await queryTerminalGeneratorStatus(session, manifest)
      );
    } finally {
      await session.attachment.detach();
      await session.reader?.completed;
    }
  }

  await recordJournalAdmitted(
    runtime,
    assigned.targetId as Id,
    sessions[0]!.resourceKey.desktopInstallationId,
    journalAdmittedBySession
  );

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
    sourceRevision,
    workingTreeDirty,
    environmentKind: context.kind,
    normative: context.normative,
    limitations: context.limitations,
    artifactTarget: context.artifactTarget,
    hardware: context.hardware,
    network: context.network,
    openSsh,
    runtime: {
      platform: hello.platform,
      arch: hello.arch,
      abi: hello.abi,
      version: hello.runtimeVersion,
      sha256: runtimeSha256,
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
      sftpBytes: manifest.workload.sftp.bytes,
      minimumEchoSamples: minimumScheduledRepetitions(
        manifest.workload.minimumDurationMs,
        manifest.workload.keyEcho.probesPerSecond,
        manifest.gates.remoteHostEventLoopDelayMs.singleStallMax
      ),
      minimumGitRepetitions: minimumScheduledRepetitions(
        manifest.workload.minimumDurationMs,
        manifest.workload.git.repetitionsPerSecond
      ),
      minimumAttachedOutputBytes:
        (manifest.workload.minimumDurationMs / 1_000) *
        manifest.workload.keepers.attached *
        manifest.workload.keepers.attachedOutputBytesPerSecondEach,
      terminalLoad: sessions.map((session) => ({
        sessionId: session.resourceKey.sessionId,
        attached: session.attached,
        outputBytesPerSecond: session.outputBytesPerSecond,
        minimumGeneratedBytes: BigInt(
          (manifest.workload.minimumDurationMs / 1_000) *
            session.outputBytesPerSecond
        ).toString(),
        generatedSteadyBytes: (
          generatorStatuses.get(session.resourceKey.sessionId)
            ?.steadyOutputBytes ?? -1n
        ).toString(),
        generatedBurstBytes: (
          generatorStatuses.get(session.resourceKey.sessionId)
            ?.burstOutputBytes ?? -1n
        ).toString(),
        journalAdmitted: (
          journalAdmittedBySession.get(session.resourceKey.sessionId) ?? -1n
        ).toString()
      }))
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
      terminalBurst,
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
  await verifyNativeProfileRuntimeArtifact(configuration);
  const sharedCi = isSharedCiEnvironment(process.env.CI);
  let stopped = false;
  return {
    kind: "controlled-native",
    normative: !configuration.sharedHost && !sharedCi,
    limitations: [
      ...(configuration.sharedHost
        ? [
            "The target is marked as shared and cannot provide normative evidence."
          ]
        : []),
      ...(sharedCi
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
    expectedRuntimeSha256: configuration.runtimeSha256,
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

async function inspectOpenSshVersions(
  context: ProfileContext,
  selectedPool: SshTransportPool,
  assigned: AssignedSshMaster
): Promise<{ hostClient: string; targetServer: string }> {
  const host = await execFileAsync(context.sshPath, ["-V"], {
    timeout: 10_000,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES
  });
  const target = await runChannel(context, selectedPool, assigned, {
    kind: "control",
    remoteCommand:
      "if command -v sshd >/dev/null 2>&1; then sshd_path=$(command -v sshd); " +
      "elif [ -x /usr/sbin/sshd ]; then sshd_path=/usr/sbin/sshd; " +
      "else exit 127; fi; " +
      'output=$("$sshd_path" -V 2>&1 || true); ' +
      'case "$output" in *OpenSSH_*) ;; *) output=$("$sshd_path" -? 2>&1 || true);; esac; ' +
      'printf "%s\\n" "$output"'
  });
  return {
    hostClient: requireOpenSshVersion(
      `${host.stderr}\n${host.stdout}`.trim(),
      "host"
    ),
    targetServer: requireOpenSshVersion(target.stdout.trim(), "target server")
  };
}

async function readRemoteRuntimeSha256(
  context: ProfileContext,
  selectedPool: SshTransportPool,
  assigned: AssignedSshMaster,
  localPath: string
): Promise<string> {
  try {
    await runChannel(
      context,
      selectedPool,
      assigned,
      { kind: "sftp" },
      `get ${quoteSftpPath(context.runtimePath)} ${quoteSftpPath(localPath)}\nquit\n`,
      5 * 60_000
    );
    const metadata = await stat(localPath);
    if (
      metadata.size === 0 ||
      metadata.size > NATIVE_PROFILE_MAX_RUNTIME_ARTIFACT_BYTES
    ) {
      throw new Error("remote runtime artifact size is outside its hard bound");
    }
    return await sha256File(localPath);
  } finally {
    await rm(localPath, { force: true });
  }
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
          "--steady-chunk-bytes",
          String(
            selectedManifest.workload.terminalOutputGenerator.steadyChunkBytes
          ),
          "--burst-bytes",
          String(
            selectedManifest.workload.terminalOutputGenerator.burst.totalBytes
          ),
          "--burst-chunk-bytes",
          String(
            selectedManifest.workload.terminalOutputGenerator.burst.chunkBytes
          ),
          "--burst-chunk-interval-ms",
          String(
            selectedManifest.workload.terminalOutputGenerator.burst
              .chunkIntervalMs
          ),
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
      outputBytesPerSecond,
      nextInputSequence: 0n
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
    await sendProfileInput(session, `${token}\n`);
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
    nextProbeAt += intervalMs;
  }
  return samples;
}

async function runTerminalBurst(
  sessions: SessionProfile[],
  selectedManifest: PerformanceManifest
) {
  const burst = selectedManifest.workload.terminalOutputGenerator.burst;
  const targets = sessions
    .filter((session) => session.attached)
    .slice(0, burst.attachedKeepers);
  if (targets.length !== burst.attachedKeepers) {
    throw new Error("profile burst topology has too few attached keepers");
  }
  const keepers = await Promise.all(
    targets.map(async (session, keeperIndex) => {
      if (!session.attachment || !session.reader) {
        throw new Error("profile burst keeper is not attached");
      }
      const token = `${keeperIndex}_${randomBytes(12).toString("hex")}`;
      const beginMarker = `KMUX_PROFILE_BURST_BEGIN:${token}`;
      const endMarker = `KMUX_PROFILE_BURST_END:${token}`;
      const beginObserved = session.reader.waitFor(
        beginMarker,
        burst.completionTimeoutMs
      );
      void beginObserved.catch(() => undefined);
      const endObserved = session.reader
        .waitFor(endMarker, burst.completionTimeoutMs)
        .then(
          (outputOffset) => ({ ok: true as const, outputOffset }),
          (error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error : new Error(String(error))
          })
        );
      const outputBytesBefore = session.reader.outputBytes;
      const mutationsBefore = session.reader.mutations;
      const started = performance.now();
      await sendProfileInput(session, `${burst.triggerPrefix}${token}\n`);
      const beginOutputOffset = await beginObserved;

      const echoLatencies: number[] = [];
      const echoOutputOffsets: number[] = [];
      for (let index = 0; index < burst.echoProbes; index += 1) {
        const echoToken = `kmux-burst-echo-${token}-${index.toString().padStart(2, "0")}`;
        const observed = session.reader.waitFor(
          echoToken,
          burst.completionTimeoutMs
        );
        void observed.catch(() => undefined);
        const echoStarted = performance.now();
        await sendProfileInput(session, `${echoToken}\n`);
        echoOutputOffsets.push(await observed);
        echoLatencies.push(performance.now() - echoStarted);
      }

      const endObservation = await endObserved;
      if (!endObservation.ok) throw endObservation.error;
      if (
        echoOutputOffsets.some(
          (offset) =>
            offset <= beginOutputOffset || offset >= endObservation.outputOffset
        )
      ) {
        throw new Error(
          "profile burst echo did not pass through the active burst attachment"
        );
      }
      return {
        sessionId: session.resourceKey.sessionId,
        completionMs: round(performance.now() - started),
        outputBytes: session.reader.outputBytes - outputBytesBefore,
        mutationCount: session.reader.mutations - mutationsBefore,
        echoLatencyMs: summarize(echoLatencies),
        attachmentOpen: session.attachment.isOpen()
      };
    })
  );
  return {
    attachedKeepers: keepers.length,
    totalBytesEach: burst.totalBytes,
    chunkBytes: burst.chunkBytes,
    chunkIntervalMs: burst.chunkIntervalMs,
    echoProbesEach: burst.echoProbes,
    keepers
  };
}

async function sendProfileInput(
  session: SessionProfile,
  input: string
): Promise<void> {
  if (!session.attachment) {
    throw new Error("profile input requires an attached keeper");
  }
  session.nextInputSequence += 1n;
  await session.attachment.sendInput(
    uint64(session.nextInputSequence),
    new TextEncoder().encode(input)
  );
}

async function queryTerminalGeneratorStatus(
  session: SessionProfile,
  selectedManifest: PerformanceManifest
): Promise<{ steadyOutputBytes: bigint; burstOutputBytes: bigint }> {
  if (!session.reader) {
    throw new Error("profile generator status requires a mutation reader");
  }
  const token = randomBytes(12).toString("hex");
  const endMarker = `KMUX_PROFILE_STATUS_END:${token}`;
  const observed = session.reader.waitFor(
    endMarker,
    selectedManifest.workload.terminalOutputGenerator.burst.completionTimeoutMs
  );
  void observed.catch(() => undefined);
  await sendProfileInput(
    session,
    `${selectedManifest.workload.terminalOutputGenerator.statusRequestPrefix}${token}\n`
  );
  await observed;
  const match = new RegExp(
    `KMUX_PROFILE_STATUS:${token}:([0-9]+):([0-9]+)`,
    "u"
  ).exec(session.reader.tailText());
  if (!match) {
    throw new Error("profile generator emitted an invalid status response");
  }
  return {
    steadyOutputBytes: BigInt(match[1]!),
    burstOutputBytes: BigInt(match[2]!)
  };
}

async function recordJournalAdmitted(
  selectedRuntime: LinuxX64RemoteRuntime,
  targetId: Id,
  desktopInstallationId: Id,
  journalAdmittedBySession: Map<Id, bigint>
): Promise<void> {
  const observation = await selectedRuntime.observe({
    desktopInstallationId,
    targetId
  });
  for (const keeper of observation.keepers) {
    journalAdmittedBySession.set(
      keeper.resourceKey.sessionId,
      BigInt(keeper.storageStatus.journalAdmitted)
    );
  }
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
    nextAt += intervalMs;
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
  journalSyncSamples: number[],
  journalAdmittedBySession: Map<Id, bigint>
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
      journalAdmittedBySession.set(
        keeper.resourceKey.sessionId,
        BigInt(keeper.storageStatus.journalAdmitted)
      );
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
      mutationCount: result.mutationCount + (session.reader?.mutations ?? 0),
      outputBytes: result.outputBytes + (session.reader?.outputBytes ?? 0)
    }),
    { mutationCount: 0, outputBytes: 0 }
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
    metrics.terminalMutationContinuity.mutationCount > 0,
    "terminal profile emitted no mutations",
    failures
  );
  const burst = selectedManifest.workload.terminalOutputGenerator.burst;
  requireGate(
    metrics.terminalBurst.attachedKeepers === burst.attachedKeepers &&
      Array.isArray(metrics.terminalBurst.keepers) &&
      metrics.terminalBurst.keepers.length === burst.attachedKeepers &&
      metrics.terminalBurst.keepers.every(
        (keeper: Record<string, unknown>) =>
          keeper.attachmentOpen === true &&
          Number.isSafeInteger(keeper.outputBytes) &&
          Number(keeper.outputBytes) >= burst.totalBytes &&
          Number.isSafeInteger(keeper.mutationCount) &&
          Number(keeper.mutationCount) > 0 &&
          (keeper.echoLatencyMs as { count?: unknown } | undefined)?.count ===
            burst.echoProbes
      ),
    "terminal burst did not remain contiguous on the existing attachment",
    failures
  );
  requireGate(
    terminalLoadGeneratorEvidencePassed(
      workload.terminalLoad,
      selectedManifest.workload.keepers.total,
      selectedManifest.workload.terminalOutputGenerator.burst
    ),
    "one or more terminal generators did not sustain the versioned byte load",
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
    workload.echoSamples >= workload.minimumEchoSamples,
    "normative workload did not sustain its 10 Hz echo schedule",
    failures
  );
  requireGate(
    workload.gitRepetitions >= workload.minimumGitRepetitions,
    "normative workload did not sustain its Git inspection schedule",
    failures
  );
  requireGate(
    metrics.terminalMutationContinuity.outputBytes >=
      workload.minimumAttachedOutputBytes,
    "attached terminal generators did not sustain the versioned byte rate",
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
    metrics.terminalBurst.keepers.every((keeper: Record<string, unknown>) => {
      const latency = keeper.echoLatencyMs as
        | { p95?: unknown; p99?: unknown }
        | undefined;
      return (
        typeof latency?.p95 === "number" &&
        typeof latency.p99 === "number" &&
        latency.p95 - metrics.directEchoLatencyMs.p95 <=
          selectedManifest.gates.addedKeyEchoLatencyMs.p95Max &&
        latency.p99 - metrics.directEchoLatencyMs.p99 <=
          selectedManifest.gates.addedKeyEchoLatencyMs.p99Max
      );
    }),
    "burst key-echo latency exceeded its added-latency gate",
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
    metrics.remoteHostProcessTreeRssBytes.samples > 0 &&
      metrics.remoteHostProcessTreeRssBytes.max > 0 &&
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

function minimumScheduledRepetitions(
  durationMs: number,
  repetitionsPerSecond: number,
  allowedFinalStallMs = 0
): number {
  return Math.max(
    1,
    Math.floor((durationMs / 1_000) * repetitionsPerSecond) -
      Math.ceil((allowedFinalStallMs / 1_000) * repetitionsPerSecond)
  );
}

function terminalLoadGeneratorEvidencePassed(
  entries: unknown,
  expectedSessions: number,
  burst: PerformanceManifest["workload"]["terminalOutputGenerator"]["burst"]
): boolean {
  if (!Array.isArray(entries) || entries.length !== expectedSessions) {
    return false;
  }
  let burstKeepers = 0;
  const evidence = entries as Array<{
    attached: boolean;
    minimumGeneratedBytes: string;
    generatedSteadyBytes: string;
    generatedBurstBytes: string;
    journalAdmitted: string;
  }>;
  const everyEntryPassed = evidence.every((record) => {
    const generatedBurstBytes = BigInt(record.generatedBurstBytes);
    if (generatedBurstBytes > 0n) {
      if (
        record.attached !== true ||
        generatedBurstBytes !== BigInt(burst.totalBytes)
      ) {
        return false;
      }
      burstKeepers += 1;
    }
    return (
      BigInt(record.generatedSteadyBytes) >=
        BigInt(record.minimumGeneratedBytes) &&
      BigInt(record.journalAdmitted) > 0n
    );
  });
  return everyEntryPassed && burstKeepers === burst.attachedKeepers;
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
  if ((value as { schemaVersion?: unknown }).schemaVersion !== 1) {
    throw new TypeError("remote performance manifest schemaVersion must be 1");
  }
  // The checked-in manifest is the numeric source of truth. Its schema and
  // cross-field invariants are enforced by remotePerformanceManifest.test.ts;
  // duplicating every literal here would create a second contract.
  return structuredClone(value) as PerformanceManifest;
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

function requireOpenSshVersion(value: string, owner: string): string {
  const version = /(?:^|\n)(OpenSSH_[^\r\n]*)/u.exec(value)?.[1]?.trim();
  if (
    !version ||
    Buffer.byteLength(version, "utf8") > 1024 ||
    /[\0\r\n]/u.test(version)
  ) {
    throw new Error(`profile ${owner} OpenSSH version is missing or invalid`);
  }
  return version;
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

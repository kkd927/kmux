import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ChildProcess } from "node:child_process";

import {
  buildMuxOnlyLaunch,
  spawnMuxOnlyChannel,
  type MuxOnlyChannelRequest
} from "../../../apps/desktop/src/remote-host/muxOnlyOpenSshChannel";
import {
  resolveEffectiveSshConfig,
  runOpenSshCommand
} from "../../../apps/desktop/src/remote-host/openSshProcess";
import {
  SshTransportPool,
  type AssignedSshMaster
} from "../../../apps/desktop/src/remote-host/sshTransportPool";
import { SshConnectionAudit } from "../harness/connectionAudit";
import { startSshTarget, type StartedSshTarget } from "../harness/sshTarget";

const execFileAsync = promisify(execFile);
const ECHO_SAMPLES = 200;
const ECHO_INTERVAL_MS = 100;
const SFTP_BYTES = 512 * 1024 * 1024;
const runtimeArtifactPath = fileURLToPath(
  new URL("../../../remote/kmuxd/dist/linux-x64-musl/kmuxd", import.meta.url)
);

interface BoundChannelFields {
  sshPath: string;
  sftpPath?: string;
  configPath: string;
  controlPath: string;
  host: string;
  masterGeneration: string;
  env?: NodeJS.ProcessEnv;
}

type WithoutBoundChannel<T> = T extends MuxOnlyChannelRequest
  ? Omit<T, keyof BoundChannelFields>
  : never;
type UnboundChannelRequest = WithoutBoundChannel<MuxOnlyChannelRequest>;

const target = await startSshTarget();
const pool = new SshTransportPool();
let scratch: string | undefined;
const toxics: Array<{ remove(): Promise<void> }> = [];

try {
  scratch = await mkdtemp(join(tmpdir(), "kmux-ssh-baseline-"));
  toxics.push(
    await target.faults.addLatency({
      latencyMs: 10,
      jitterMs: 0,
      direction: "upstream"
    })
  );
  toxics.push(
    await target.faults.addLatency({
      latencyMs: 10,
      jitterMs: 0,
      direction: "downstream"
    })
  );
  const assigned = await connectAssignedMaster(target, pool);
  const afterMaster = await target.audit.snapshot();
  const routeBaseline = SshConnectionAudit.delta(
    target.auditBaseline,
    afterMaster
  );
  const echo = await measureEcho(target, pool, assigned);
  const sftp = await measureSftp(target, pool, assigned, scratch);
  const afterFeatures = await target.audit.snapshot();
  const featureDelta = SshConnectionAudit.delta(afterMaster, afterFeatures);
  const targetFacts = await readTargetFacts(target);
  const hostFacts = await readHostFacts();
  const revision = await runHost("git", ["rev-parse", "HEAD"]);
  const workingTree = await runHost("git", ["status", "--porcelain"]);
  const runtimeArtifactSha256 = createHash("sha256")
    .update(await readFile(runtimeArtifactPath))
    .digest("hex");

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        measuredAt: new Date().toISOString(),
        sourceRevision: revision.stdout.trim(),
        workingTreeDirty: workingTree.stdout.trim().length > 0,
        runtimeArtifactSha256,
        environmentKind: "docker-desktop-functional-baseline",
        normative: false,
        limitations: [
          "Docker Desktop virtualization is functional evidence only.",
          `The fixture target exposed ${targetFacts.logicalCpus} logical CPUs, ${targetFacts.memoryKiB} KiB RAM, and ${targetFacts.stateFilesystem}, so it does not meet the native 8 GiB/SSD reference-target requirement.`
        ],
        network: {
          upstreamLatencyMs: 10,
          downstreamLatencyMs: 10,
          injectedRoundTripLatencyMs: 20,
          jitterMs: 0
        },
        host: hostFacts,
        target: targetFacts,
        directMuxedOpenSsh: {
          echoSamples: ECHO_SAMPLES,
          echoIntervalMs: ECHO_INTERVAL_MS,
          echoLatencyMs: summarize(echo),
          sftpBytes: SFTP_BYTES,
          sftpSeconds: round(sftp.seconds),
          sftpMiBPerSecond: round(sftp.mebibytesPerSecond),
          sftpSha256: sftp.sha256,
          routeBaseline,
          featureDelta
        }
      },
      null,
      2
    )}\n`
  );
} finally {
  await pool.close();
  await Promise.allSettled(toxics.map((toxic) => toxic.remove()));
  await target.stop();
  if (scratch) await rm(scratch, { recursive: true, force: true });
}

async function connectAssignedMaster(
  selectedTarget: StartedSshTarget,
  selectedPool: SshTransportPool
): Promise<AssignedSshMaster> {
  const effective = await resolveEffectiveSshConfig({
    sshPath: selectedTarget.sshPath,
    configPath: selectedTarget.sshConfigPath,
    host: selectedTarget.hostAlias
  });
  const connectionAttemptId = "phase1-performance-baseline";
  await selectedPool.connectProvisional({
    connectionAttemptId,
    effectiveConnectionPolicyHash: effective.policyHash,
    sshPath: selectedTarget.sshPath,
    configPath: selectedTarget.sshConfigPath,
    host: selectedTarget.hostAlias,
    controlRoot: selectedTarget.controlDirectoryPath
  });
  return await selectedPool.promote({
    connectionAttemptId,
    targetId: "phase1-performance-target",
    effectiveConnectionPolicyHash: effective.policyHash
  });
}

function channelRequest(
  selectedTarget: StartedSshTarget,
  assigned: AssignedSshMaster,
  request: UnboundChannelRequest
): MuxOnlyChannelRequest {
  return {
    ...request,
    sshPath: selectedTarget.sshPath,
    sftpPath: selectedTarget.sftpPath,
    configPath: selectedTarget.sshConfigPath,
    controlPath: assigned.master.controlPath,
    host: selectedTarget.hostAlias,
    masterGeneration: assigned.generation
  } as MuxOnlyChannelRequest;
}

async function runChannel(
  selectedTarget: StartedSshTarget,
  selectedPool: SshTransportPool,
  assigned: AssignedSshMaster,
  request: UnboundChannelRequest,
  input?: string,
  timeoutMs = 30_000
) {
  const launch = await buildMuxOnlyLaunch(
    channelRequest(selectedTarget, assigned, request)
  );
  if (
    !selectedPool.isCurrentGeneration(assigned.targetId, assigned.generation)
  ) {
    throw new Error("assigned master changed during the performance baseline");
  }
  return await runOpenSshCommand(launch.executable, launch.args, {
    env: launch.env,
    input,
    timeoutMs
  });
}

async function measureEcho(
  selectedTarget: StartedSshTarget,
  selectedPool: SshTransportPool,
  assigned: AssignedSshMaster
): Promise<number[]> {
  const child = await spawnMuxOnlyChannel(
    channelRequest(selectedTarget, assigned, {
      kind: "terminal",
      remoteCommand:
        "stty -echo -icanon min 1 time 0; printf 'KMUX_ECHO_READY\\n'; cat"
    }),
    {
      isCurrentGeneration: (generation) =>
        selectedPool.isCurrentGeneration(assigned.targetId, generation)
    }
  );
  const stream = createTokenStream(child);
  try {
    await stream.waitFor("KMUX_ECHO_READY", 10_000);
    const samples: number[] = [];
    let nextProbeAt = performance.now();
    for (let index = 0; index < ECHO_SAMPLES; index += 1) {
      const waitMs = nextProbeAt - performance.now();
      if (waitMs > 0) await delay(waitMs);
      const token = `kmux-echo-${index.toString().padStart(4, "0")}-0123456789abcdef`;
      const echoed = stream.waitFor(token, 2_000);
      const started = performance.now();
      if (!child.stdin?.write(`${token}\n`)) {
        await new Promise<void>((resolve) =>
          child.stdin?.once("drain", resolve)
        );
      }
      await echoed;
      samples.push(performance.now() - started);
      nextProbeAt = Math.max(nextProbeAt + ECHO_INTERVAL_MS, performance.now());
    }
    return samples;
  } finally {
    child.stdin?.end();
    await closeChild(child);
  }
}

async function measureSftp(
  selectedTarget: StartedSshTarget,
  selectedPool: SshTransportPool,
  assigned: AssignedSshMaster,
  scratchPath: string
): Promise<{ seconds: number; mebibytesPerSecond: number; sha256: string }> {
  const remotePath = "/home/kmux/.kmux-phase1/perf-512m.bin";
  const localPath = join(scratchPath, "perf-512m.bin");
  await runChannel(
    selectedTarget,
    selectedPool,
    assigned,
    {
      kind: "control",
      remoteCommand: `install -d -m 700 /home/kmux/.kmux-phase1 && dd if=/dev/zero of=${remotePath} bs=1M count=512 status=none`
    },
    undefined,
    120_000
  );
  try {
    const started = performance.now();
    await runChannel(
      selectedTarget,
      selectedPool,
      assigned,
      { kind: "sftp" },
      `get ${remotePath} ${localPath}\nquit\n`,
      5 * 60_000
    );
    const seconds = (performance.now() - started) / 1000;
    const file = await stat(localPath);
    if (file.size !== SFTP_BYTES) {
      throw new Error(
        `SFTP baseline received ${file.size}/${SFTP_BYTES} bytes`
      );
    }
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(localPath)) digest.update(chunk);
    return {
      seconds,
      mebibytesPerSecond: SFTP_BYTES / (1024 * 1024) / seconds,
      sha256: digest.digest("hex")
    };
  } finally {
    await runChannel(selectedTarget, selectedPool, assigned, {
      kind: "control",
      remoteCommand: `rm -f ${remotePath}`
    }).catch(() => undefined);
  }
}

function createTokenStream(child: ChildProcess): {
  waitFor(token: string, timeoutMs: number): Promise<void>;
} {
  let buffered = "";
  return {
    async waitFor(token, timeoutMs): Promise<void> {
      const existing = buffered.indexOf(token);
      if (existing >= 0) {
        buffered = buffered.slice(existing + token.length);
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`terminal baseline did not echo ${token}`));
        }, timeoutMs);
        const onData = (chunk: Buffer): void => {
          buffered = `${buffered}${chunk.toString("utf8")}`.slice(-64 * 1024);
          const index = buffered.indexOf(token);
          if (index < 0) return;
          buffered = buffered.slice(index + token.length);
          cleanup();
          resolve();
        };
        const onClose = (): void => {
          cleanup();
          reject(new Error("terminal baseline channel closed before echo"));
        };
        const cleanup = (): void => {
          clearTimeout(timeout);
          child.stdout?.off("data", onData);
          child.off("close", onClose);
        };
        child.stdout?.on("data", onData);
        child.once("close", onClose);
      });
    }
  };
}

async function closeChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve())
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

async function readTargetFacts(selectedTarget: StartedSshTarget) {
  const [logicalCpus, memoryKiB, stateFilesystem, repositoryCommit, openSsh] =
    await Promise.all([
      selectedTarget.target.exec(["nproc"]),
      selectedTarget.target.exec([
        "sh",
        "-c",
        "awk '/MemTotal/ {print $2}' /proc/meminfo"
      ]),
      selectedTarget.target.exec([
        "stat",
        "-f",
        "-c",
        "%T",
        "/var/lib/kmux-local"
      ]),
      selectedTarget.target.exec([
        "git",
        "-c",
        "safe.directory=/opt/kmux-fixtures/repository",
        "-C",
        "/opt/kmux-fixtures/repository",
        "rev-parse",
        "HEAD"
      ]),
      selectedTarget.target.exec(["/usr/sbin/sshd", "-V"])
    ]);
  for (const fact of [
    logicalCpus,
    memoryKiB,
    stateFilesystem,
    repositoryCommit,
    openSsh
  ]) {
    if (fact.exitCode !== 0) throw new Error(`${fact.stdout}${fact.stderr}`);
  }
  return {
    platform: "linux",
    arch: "x86_64",
    logicalCpus: Number(logicalCpus.stdout.trim()),
    memoryKiB: Number(memoryKiB.stdout.trim()),
    stateFilesystem: stateFilesystem.stdout.trim(),
    repositoryCommit: repositoryCommit.stdout.trim(),
    openSsh: `${openSsh.stdout}${openSsh.stderr}`.trim()
  };
}

async function readHostFacts() {
  const [productVersion, physicalCpus, memoryBytes, openSsh, docker] =
    await Promise.all([
      runHost("sw_vers", ["-productVersion"]),
      runHost("sysctl", ["-n", "hw.physicalcpu"]),
      runHost("sysctl", ["-n", "hw.memsize"]),
      runHost("/usr/bin/ssh", ["-V"]),
      runHost("docker", [
        "version",
        "--format",
        "{{.Client.Version}}/{{.Server.Version}}"
      ])
    ]);
  return {
    platform: process.platform,
    arch: process.arch,
    productVersion: productVersion.stdout.trim(),
    physicalCpuCores: Number(physicalCpus.stdout.trim()),
    memoryBytes: Number(memoryBytes.stdout.trim()),
    solidStateStorage: true,
    openSsh: `${openSsh.stdout}${openSsh.stderr}`.trim(),
    dockerClientServer: docker.stdout.trim()
  };
}

async function runHost(executable: string, args: string[]) {
  return await execFileAsync(executable, args, {
    maxBuffer: 1024 * 1024,
    timeout: 30_000
  });
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    min: round(sorted[0] ?? 0),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted.at(-1) ?? 0)
  };
}

function percentile(sorted: number[], quantile: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function delay(durationMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}

import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";

import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteRuntimeRootsDto
} from "@kmux/proto";

import {
  buildBootstrapHelperCommand,
  buildBootstrapScriptCommand,
  resolveBootstrapShellPolicy,
  type BootstrapShellPolicy
} from "./bootstrapShellAdapter";
import {
  buildMuxOnlyLaunch,
  type MuxOnlyChannelRequest
} from "./muxOnlyOpenSshChannel";
import {
  OpenSshProcessError,
  runOpenSshCommand,
  type OpenSshCommandResult
} from "./openSshProcess";
import {
  type AssignedSshMaster,
  type SshTransportPool
} from "./sshTransportPool";

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const BOOTSTRAP_COMMAND_TIMEOUT_MS = 30_000;
const BOOTSTRAP_SFTP_TIMEOUT_MS = 2 * 60_000;

export type RemoteRuntimeBootstrapErrorCode =
  | "invalid-request"
  | "unsupported-target"
  | "unknown-bootstrap-shell"
  | "sftp-required"
  | "artifact-invalid"
  | "compatibility-repair-required"
  | "bootstrap-failed";

export class RemoteRuntimeBootstrapError extends Error {
  constructor(
    readonly code: RemoteRuntimeBootstrapErrorCode,
    message: string,
    options: { cause?: unknown } = {}
  ) {
    super(message, options);
    this.name = "RemoteRuntimeBootstrapError";
  }
}

export interface PrepareRemoteRuntimeOptions {
  pool: SshTransportPool;
  assigned: AssignedSshMaster;
  artifactRoot: string;
  transferRoot: string;
  sftpPath?: string;
  roots?: RemoteRuntimeRootsDto;
  rootOverrides?: Partial<RemoteRuntimeRootsDto>;
  bootstrapShellOverride?: string;
}

type ResolvedPrepareRemoteRuntimeOptions = PrepareRemoteRuntimeOptions & {
  roots: RemoteRuntimeRootsDto;
};

export interface PreparedRemoteRuntime {
  runtimePath: string;
  generation: string;
  remoteHome: string;
  roots: RemoteRuntimeRootsDto;
  shellPolicy: BootstrapShellPolicy;
  doctor: RemoteDoctorReport;
  rotateBridgeToken(options: {
    desktopInstallationId: string;
    targetId: string;
    token: string;
  }): Promise<void>;
  runGenerationGc(): Promise<RemoteGenerationGcReport>;
  resetCurrentGeneration(): Promise<RemoteGenerationResetReport>;
}

export interface RemoteDoctorReport {
  remoteInstallationId: string;
  executionNodeId: string;
  authenticatedPrincipal: {
    uid: number;
    accountName: string;
  };
  platform: string;
  arch: string;
  abi: string;
  installRoot: string;
  authorityRoot: string;
  stateRoot: string;
  runtimeRoot: string;
}

export interface RemoteGenerationGcReport {
  inspected: number;
  removed: string[];
  live: string[];
  incompleteOrCorrupt: string[];
}

export interface RemoteGenerationResetReport {
  generation: string;
  status: "reset" | "already-absent";
}

interface RuntimeArtifactManifest {
  schemaVersion: number;
  target: string;
  platform: string;
  arch: string;
  abi: string;
  runtimeVersion: string;
  remoteProtocolMin: number;
  remoteProtocolMax: number;
  keeperLocalProtocolMajor: number;
  terminalWireVersion: number;
  executable: "kmuxd";
  sha256: string;
  bytes: number;
  signed: boolean;
}

interface SelectedRuntimeArtifact {
  target: string;
  executablePath: string;
  manifestPath: string;
  executableBytes: Buffer;
  manifestBytes: Buffer;
  manifest: RuntimeArtifactManifest;
  manifestSha256: string;
}

export async function prepareRemoteRuntime(
  options: PrepareRemoteRuntimeOptions
): Promise<PreparedRemoteRuntime> {
  validateOptions(options);
  const environment = await runMuxCommand(options, "metadata", "/usr/bin/env", {
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024
  });
  const remoteHome = parseRemoteHome(environment.stdout);
  let shellPolicy: BootstrapShellPolicy;
  try {
    shellPolicy = resolveBootstrapShellPolicy({
      environmentOutput: environment.stdout,
      ...(options.bootstrapShellOverride === undefined
        ? {}
        : { bootstrapShellOverride: options.bootstrapShellOverride })
    });
  } catch (error) {
    throw new RemoteRuntimeBootstrapError(
      "unknown-bootstrap-shell",
      error instanceof Error ? error.message : String(error),
      { cause: error }
    );
  }
  const observation = await probeRemotePlatform(options, shellPolicy);
  const uid = parseRemoteUid(
    (await runBootstrapScript(options, shellPolicy, "/usr/bin/id -u")).stdout
  );
  const roots =
    options.roots ??
    resolveRemoteRuntimeRoots(
      remoteHome,
      environment.stdout,
      uid,
      options.rootOverrides ?? {}
    );
  validateRuntimeRoots(roots);
  const runtimeOptions: ResolvedPrepareRemoteRuntimeOptions = {
    ...options,
    roots
  };
  const artifact = await loadRuntimeArtifact(options.artifactRoot, observation);
  const generation = `${REMOTE_PROTOCOL_VERSION}+${artifact.manifest.sha256}`;
  const generationDirectory = remoteJoin(roots.installRoot, "bin", generation);
  const runtimePath = remoteJoin(generationDirectory, "kmuxd");
  const inspectArguments = generationInspectArguments(
    runtimePath,
    artifact.manifest.sha256,
    artifact.manifestSha256
  );

  let installed = false;
  let doctor: RemoteDoctorReport;
  try {
    await runHelperCommand(
      runtimeOptions,
      shellPolicy,
      runtimePath,
      inspectArguments
    );
    installed = true;
  } catch (inspectionError) {
    const sentinelPath = remoteJoin(generationDirectory, "install-complete");
    const sentinel = await runBootstrapScript(
      runtimeOptions,
      shellPolicy,
      `if [ -f ${quotePosixWord(sentinelPath)} ]; then printf '%s\\n' KMUX_PRESENT; else printf '%s\\n' KMUX_ABSENT; fi`
    );
    if (sentinel.stdout.trim() === "KMUX_PRESENT") {
      throw new RemoteRuntimeBootstrapError(
        "compatibility-repair-required",
        `installed runtime generation ${generation} failed verification; explicit compatibility repair is required`,
        { cause: inspectionError }
      );
    }
  }

  if (!installed) {
    doctor = await uploadAndVerifyBootstrapRoots(
      runtimeOptions,
      shellPolicy,
      artifact,
      uid,
      remoteHome,
      observation
    );
    await uploadAndInstallGeneration(
      runtimeOptions,
      shellPolicy,
      artifact,
      generation,
      remoteHome
    );
    await runHelperCommand(
      runtimeOptions,
      shellPolicy,
      runtimePath,
      inspectArguments
    );
  } else {
    doctor = await runRemoteDoctor(
      runtimeOptions,
      shellPolicy,
      runtimePath,
      observation
    );
  }

  return {
    runtimePath,
    generation,
    remoteHome,
    roots: structuredClone(roots),
    shellPolicy,
    doctor,
    async rotateBridgeToken(options): Promise<void> {
      if (
        options.desktopInstallationId.length === 0 ||
        options.desktopInstallationId.length > 256 ||
        containsAsciiControl(options.desktopInstallationId) ||
        options.targetId.length === 0 ||
        options.targetId.length > 256 ||
        containsAsciiControl(options.targetId) ||
        !/^[a-f0-9]{64,128}$/u.test(options.token)
      ) {
        throw new RemoteRuntimeBootstrapError(
          "invalid-request",
          "remote bridge token rotation scope is invalid"
        );
      }
      const request = JSON.stringify({
        version: 1,
        roots,
        desktopInstallationId: options.desktopInstallationId,
        targetId: options.targetId,
        token: options.token
      });
      const result = await runHelperCommand(
        runtimeOptions,
        shellPolicy,
        runtimePath,
        ["bridge", "token", "rotate"],
        {
          input: request,
          maxInputBytes: 64 * 1024,
          maxOutputBytes: 64 * 1024
        }
      );
      const response = parseJsonObject(
        result.stdout,
        "remote bridge token rotation"
      );
      assertExactKeys(response, ["status", "version"]);
      if (response.version !== 1 || response.status !== "rotated") {
        throw new RemoteRuntimeBootstrapError(
          "bootstrap-failed",
          "remote bridge token rotation returned an invalid acknowledgement"
        );
      }
    },
    async runGenerationGc(): Promise<RemoteGenerationGcReport> {
      const result = await runHelperCommand(
        runtimeOptions,
        shellPolicy,
        runtimePath,
        [
          "bootstrap",
          "gc",
          "--install-root",
          roots.installRoot,
          "--state-root",
          roots.stateRoot,
          "--current-generation",
          generation
        ]
      );
      return decodeGcReport(
        parseJsonObject(result.stdout, "runtime generation GC")
      );
    },
    async resetCurrentGeneration(): Promise<RemoteGenerationResetReport> {
      const result = await runHelperCommand(
        runtimeOptions,
        shellPolicy,
        runtimePath,
        [
          "bootstrap",
          "reset",
          "--install-root",
          roots.installRoot,
          "--state-root",
          roots.stateRoot,
          "--current-generation",
          generation
        ]
      );
      return decodeResetReport(
        parseJsonObject(result.stdout, "runtime generation reset"),
        generation
      );
    }
  };
}

async function uploadAndVerifyBootstrapRoots(
  options: ResolvedPrepareRemoteRuntimeOptions,
  shellPolicy: BootstrapShellPolicy,
  artifact: SelectedRuntimeArtifact,
  uid: number,
  remoteHome: string,
  observation: { platform: "darwin" | "linux"; arch: "arm64" | "x64" }
): Promise<RemoteDoctorReport> {
  // The persistent roots are not trusted until this helper runs doctor. Use a
  // random, read-back-verified directory in the authenticated home solely as
  // an ephemeral executable stage; `/tmp` is commonly mounted noexec.
  const stageDirectory = remoteJoin(
    remoteHome,
    `.kmux-bootstrap-${uid}-${randomBytes(12).toString("hex")}`
  );
  const stageExecutable = remoteJoin(stageDirectory, "kmuxd");
  const localRoot = await prepareLocalTransferRoot(options.transferRoot);
  const readbackRoot = await mkdtemp(join(localRoot, "bootstrap-preflight-"));
  await chmod(readbackRoot, 0o700);
  const executableReadback = join(readbackRoot, "kmuxd.readback");
  let stageMayExist = false;
  try {
    try {
      await runMuxSftp(options, "pwd\nquit\n");
    } catch (error) {
      throw new RemoteRuntimeBootstrapError(
        "sftp-required",
        "first bootstrap and runtime generation installation require the target SFTP subsystem",
        { cause: error }
      );
    }
    stageMayExist = true;
    await runMuxSftp(
      options,
      [
        `mkdir ${quoteSftpPath(stageDirectory)}`,
        `chmod 700 ${quoteSftpPath(stageDirectory)}`,
        `put ${quoteSftpPath(artifact.executablePath)} ${quoteSftpPath(stageExecutable)}`,
        `chmod 700 ${quoteSftpPath(stageExecutable)}`,
        `get ${quoteSftpPath(stageExecutable)} ${quoteSftpPath(executableReadback)}`,
        "quit",
        ""
      ].join("\n"),
      [
        {
          path: executableReadback,
          maxBytes: artifact.executableBytes.length
        }
      ]
    ).catch((error: unknown) => {
      if (error instanceof RemoteRuntimeBootstrapError) throw error;
      throw new RemoteRuntimeBootstrapError(
        "bootstrap-failed",
        "SFTP bootstrap preflight staging failed before root verification",
        { cause: error }
      );
    });
    const { bytes: executableBytes } = await readBoundedStableFile(
      executableReadback,
      artifact.executableBytes.length
    );
    if (
      executableBytes.length !== artifact.executableBytes.length ||
      sha256(executableBytes) !== artifact.manifest.sha256
    ) {
      throw new RemoteRuntimeBootstrapError(
        "artifact-invalid",
        "remote bootstrap preflight read-back did not preserve the bundled runtime bytes"
      );
    }
    return await runRemoteDoctor(
      options,
      shellPolicy,
      stageExecutable,
      observation
    );
  } finally {
    await rm(readbackRoot, { recursive: true, force: true });
    if (stageMayExist) {
      await cleanupRemoteBootstrapStage(options, stageDirectory).catch(
        () => undefined
      );
    }
  }
}

async function runRemoteDoctor(
  options: ResolvedPrepareRemoteRuntimeOptions,
  shellPolicy: BootstrapShellPolicy,
  runtimePath: string,
  observation: { platform: "darwin" | "linux"; arch: "arm64" | "x64" }
): Promise<RemoteDoctorReport> {
  const roots = options.roots;
  return decodeDoctorReport(
    parseJsonObject(
      (
        await runHelperCommand(options, shellPolicy, runtimePath, [
          "doctor",
          "--install-root",
          roots.installRoot,
          "--authority-root",
          roots.authorityRoot,
          "--state-root",
          roots.stateRoot,
          "--runtime-root",
          roots.runtimeRoot
        ])
      ).stdout,
      "remote doctor"
    ),
    roots,
    observation
  );
}

async function uploadAndInstallGeneration(
  options: ResolvedPrepareRemoteRuntimeOptions,
  shellPolicy: BootstrapShellPolicy,
  artifact: SelectedRuntimeArtifact,
  generation: string,
  remoteHome: string
): Promise<void> {
  const stagingRoot = remoteJoin(options.roots.installRoot, ".install-staging");
  const stageDirectory = remoteJoin(
    stagingRoot,
    `${generation}.${randomBytes(12).toString("hex")}`
  );
  const stageExecutable = remoteJoin(stageDirectory, "kmuxd");
  const stageManifest = remoteJoin(stageDirectory, "manifest.json");
  const localRoot = await prepareLocalTransferRoot(options.transferRoot);
  const readbackRoot = await mkdtemp(join(localRoot, "bootstrap-"));
  await chmod(readbackRoot, 0o700);
  const executableReadback = join(readbackRoot, "kmuxd.readback");
  const manifestReadback = join(readbackRoot, "manifest.readback.json");
  let stageCreated = false;
  try {
    try {
      await runMuxSftp(options, "pwd\nquit\n");
    } catch (error) {
      throw new RemoteRuntimeBootstrapError(
        "sftp-required",
        "first bootstrap and runtime generation installation require the target SFTP subsystem",
        { cause: error }
      );
    }
    const batch = [
      ...sftpParentCreationCommands(options.roots.installRoot, remoteHome),
      `-mkdir ${quoteSftpPath(options.roots.installRoot)}`,
      `chmod 700 ${quoteSftpPath(options.roots.installRoot)}`,
      `-mkdir ${quoteSftpPath(remoteJoin(options.roots.installRoot, "bin"))}`,
      `chmod 700 ${quoteSftpPath(remoteJoin(options.roots.installRoot, "bin"))}`,
      `-mkdir ${quoteSftpPath(stagingRoot)}`,
      `chmod 700 ${quoteSftpPath(stagingRoot)}`,
      `-mkdir ${quoteSftpPath(remoteJoin(options.roots.installRoot, ".install-locks"))}`,
      `chmod 700 ${quoteSftpPath(remoteJoin(options.roots.installRoot, ".install-locks"))}`,
      `mkdir ${quoteSftpPath(stageDirectory)}`,
      `chmod 700 ${quoteSftpPath(stageDirectory)}`,
      `put ${quoteSftpPath(artifact.executablePath)} ${quoteSftpPath(stageExecutable)}`,
      `chmod 700 ${quoteSftpPath(stageExecutable)}`,
      `get ${quoteSftpPath(stageExecutable)} ${quoteSftpPath(executableReadback)}`,
      `put ${quoteSftpPath(artifact.manifestPath)} ${quoteSftpPath(stageManifest)}`,
      `chmod 600 ${quoteSftpPath(stageManifest)}`,
      `get ${quoteSftpPath(stageManifest)} ${quoteSftpPath(manifestReadback)}`,
      "quit",
      ""
    ].join("\n");
    stageCreated = true;
    await runMuxSftp(options, batch, [
      {
        path: executableReadback,
        maxBytes: artifact.executableBytes.length
      },
      { path: manifestReadback, maxBytes: artifact.manifestBytes.length }
    ]).catch((error: unknown) => {
      if (error instanceof RemoteRuntimeBootstrapError) throw error;
      throw new RemoteRuntimeBootstrapError(
        "bootstrap-failed",
        "SFTP runtime staging failed before verified installation",
        { cause: error }
      );
    });
    const [executableReadbackFile, manifestReadbackFile] = await Promise.all([
      readBoundedStableFile(
        executableReadback,
        artifact.executableBytes.length
      ),
      readBoundedStableFile(manifestReadback, artifact.manifestBytes.length)
    ]);
    const executableBytes = executableReadbackFile.bytes;
    const manifestBytes = manifestReadbackFile.bytes;
    if (
      executableBytes.length !== artifact.executableBytes.length ||
      sha256(executableBytes) !== artifact.manifest.sha256 ||
      !manifestBytes.equals(artifact.manifestBytes) ||
      sha256(manifestBytes) !== artifact.manifestSha256
    ) {
      throw new RemoteRuntimeBootstrapError(
        "artifact-invalid",
        "remote SFTP read-back did not preserve the bundled runtime bytes"
      );
    }
    const install = await runHelperCommand(
      options,
      shellPolicy,
      stageExecutable,
      [
        "bootstrap",
        "install",
        "--stage-directory",
        stageDirectory,
        "--install-root",
        options.roots.installRoot,
        "--protocol-version",
        String(REMOTE_PROTOCOL_VERSION),
        "--expected-executable-sha256",
        artifact.manifest.sha256,
        "--expected-manifest-sha256",
        artifact.manifestSha256
      ],
      { timeoutMs: BOOTSTRAP_COMMAND_TIMEOUT_MS }
    );
    const report = parseJsonObject(install.stdout, "runtime install");
    assertExactKeys(report, ["generation", "runtimePath", "status"]);
    const expectedRuntimePath = remoteJoin(
      options.roots.installRoot,
      "bin",
      generation,
      "kmuxd"
    );
    if (
      report.generation !== generation ||
      report.runtimePath !== expectedRuntimePath ||
      (report.status !== "installed" && report.status !== "reused")
    ) {
      throw new RemoteRuntimeBootstrapError(
        "bootstrap-failed",
        "runtime installer returned a mismatched generation result"
      );
    }
    stageCreated = false;
  } finally {
    await rm(readbackRoot, { recursive: true, force: true });
    if (stageCreated) {
      await cleanupRemoteStage(options, stageDirectory).catch(() => undefined);
    }
  }
}

async function cleanupRemoteStage(
  options: ResolvedPrepareRemoteRuntimeOptions,
  stageDirectory: string
): Promise<void> {
  await runMuxSftp(
    options,
    [
      `-rm ${quoteSftpPath(remoteJoin(stageDirectory, "kmuxd"))}`,
      `-rm ${quoteSftpPath(remoteJoin(stageDirectory, "manifest.json"))}`,
      `-rm ${quoteSftpPath(remoteJoin(stageDirectory, "install-complete"))}`,
      `-rmdir ${quoteSftpPath(stageDirectory)}`,
      "quit",
      ""
    ].join("\n")
  );
}

async function cleanupRemoteBootstrapStage(
  options: ResolvedPrepareRemoteRuntimeOptions,
  stageDirectory: string
): Promise<void> {
  await runMuxSftp(
    options,
    [
      `-rm ${quoteSftpPath(remoteJoin(stageDirectory, "kmuxd"))}`,
      `-rmdir ${quoteSftpPath(stageDirectory)}`,
      "quit",
      ""
    ].join("\n")
  );
}

async function probeRemotePlatform(
  options: PrepareRemoteRuntimeOptions,
  policy: BootstrapShellPolicy
): Promise<{ platform: "darwin" | "linux"; arch: "arm64" | "x64" }> {
  const result = await runBootstrapScript(
    options,
    policy,
    "printf 'KMUX_OS='; /usr/bin/uname -s; printf 'KMUX_ARCH='; /usr/bin/uname -m"
  );
  const fields = new Map(
    result.stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)] as const;
      })
  );
  const os = fields.get("KMUX_OS");
  const rawArch = fields.get("KMUX_ARCH");
  const platform =
    os === "Darwin" ? "darwin" : os === "Linux" ? "linux" : undefined;
  const arch =
    rawArch === "arm64" || rawArch === "aarch64"
      ? "arm64"
      : rawArch === "x86_64"
        ? "x64"
        : undefined;
  if (!platform || !arch) {
    throw new RemoteRuntimeBootstrapError(
      "unsupported-target",
      `unsupported remote runtime platform ${String(os)}/${String(rawArch)}; supported targets are macOS/Linux arm64/x64`
    );
  }
  return { platform, arch };
}

async function loadRuntimeArtifact(
  artifactRoot: string,
  observation: { platform: "darwin" | "linux"; arch: "arm64" | "x64" }
): Promise<SelectedRuntimeArtifact> {
  const target =
    observation.platform === "darwin"
      ? `darwin-${observation.arch}`
      : `linux-${observation.arch}-musl`;
  const directory = join(artifactRoot, target);
  const executablePath = join(directory, "kmuxd");
  const manifestPath = join(directory, "manifest.json");
  try {
    const [directoryMetadata, executableFile, manifestFile] = await Promise.all(
      [
        lstat(directory),
        readBoundedStableFile(executablePath, MAX_ARTIFACT_BYTES),
        readBoundedStableFile(manifestPath, MAX_MANIFEST_BYTES)
      ]
    );
    const executableMetadata = executableFile.metadata;
    const manifestMetadata = manifestFile.metadata;
    if (
      !directoryMetadata.isDirectory() ||
      directoryMetadata.isSymbolicLink() ||
      (directoryMetadata.mode & 0o022) !== 0 ||
      !executableMetadata.isFile() ||
      executableMetadata.isSymbolicLink() ||
      executableMetadata.size < 1 ||
      executableMetadata.size > MAX_ARTIFACT_BYTES ||
      (executableMetadata.mode & 0o111) === 0 ||
      (executableMetadata.mode & 0o022) !== 0 ||
      !manifestMetadata.isFile() ||
      manifestMetadata.isSymbolicLink() ||
      manifestMetadata.size < 1 ||
      manifestMetadata.size > MAX_MANIFEST_BYTES ||
      (manifestMetadata.mode & 0o022) !== 0
    ) {
      throw new Error("artifact files or permissions are unsafe");
    }
    const executableBytes = executableFile.bytes;
    const manifestBytes = manifestFile.bytes;
    const manifest = decodeRuntimeManifest(
      parseJsonObject(manifestBytes.toString("utf8"), "runtime manifest"),
      target
    );
    if (
      executableBytes.length !== manifest.bytes ||
      sha256(executableBytes) !== manifest.sha256
    ) {
      throw new Error("runtime executable does not match its manifest");
    }
    return {
      target,
      executablePath,
      manifestPath,
      executableBytes,
      manifestBytes,
      manifest,
      manifestSha256: sha256(manifestBytes)
    };
  } catch (error) {
    throw new RemoteRuntimeBootstrapError(
      "artifact-invalid",
      `bundled remote runtime artifact ${target} is missing or invalid`,
      { cause: error }
    );
  }
}

async function readBoundedStableFile(
  path: string,
  maxBytes: number
): Promise<{ bytes: Buffer; metadata: Stats }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("bounded runtime file limit is invalid");
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maxBytes) {
      throw new RangeError("runtime file is not a bounded regular file");
    }
    const chunks: Buffer[] = [];
    let byteLength = 0;
    while (true) {
      const maximumRead = Math.min(64 * 1024, maxBytes - byteLength + 1);
      if (maximumRead <= 0) {
        throw new RangeError("runtime file exceeds its byte limit");
      }
      const chunk = Buffer.allocUnsafe(maximumRead);
      const { bytesRead } = await handle.read(chunk, 0, maximumRead, null);
      if (bytesRead === 0) break;
      byteLength += bytesRead;
      if (byteLength > maxBytes) {
        throw new RangeError("runtime file exceeds its byte limit");
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const finalMetadata = await handle.stat();
    if (
      byteLength !== metadata.size ||
      finalMetadata.size !== metadata.size ||
      finalMetadata.dev !== metadata.dev ||
      finalMetadata.ino !== metadata.ino ||
      finalMetadata.mtimeMs !== metadata.mtimeMs ||
      finalMetadata.ctimeMs !== metadata.ctimeMs
    ) {
      throw new Error("runtime file changed while it was being verified");
    }
    return {
      bytes: Buffer.concat(chunks, byteLength),
      metadata: finalMetadata
    };
  } finally {
    await handle.close();
  }
}

function decodeRuntimeManifest(
  record: Record<string, unknown>,
  expectedTarget: string
): RuntimeArtifactManifest {
  assertExactKeys(record, [
    "abi",
    "arch",
    "bytes",
    "executable",
    "keeperLocalProtocolMajor",
    "platform",
    "remoteProtocolMax",
    "remoteProtocolMin",
    "runtimeVersion",
    "schemaVersion",
    "sha256",
    "signed",
    "target",
    "terminalWireVersion"
  ]);
  const tuples: Record<
    string,
    { platform: string; arch: string; abi: string; signed: boolean }
  > = {
    "darwin-arm64": {
      platform: "darwin",
      arch: "arm64",
      abi: "native",
      signed: true
    },
    "darwin-x64": {
      platform: "darwin",
      arch: "x64",
      abi: "native",
      signed: true
    },
    "linux-arm64-musl": {
      platform: "linux",
      arch: "arm64",
      abi: "musl",
      signed: false
    },
    "linux-x64-musl": {
      platform: "linux",
      arch: "x64",
      abi: "musl",
      signed: false
    }
  };
  const tuple = tuples[expectedTarget];
  if (
    !tuple ||
    record.schemaVersion !== 1 ||
    record.target !== expectedTarget ||
    record.platform !== tuple.platform ||
    record.arch !== tuple.arch ||
    record.abi !== tuple.abi ||
    record.signed !== tuple.signed ||
    record.executable !== "kmuxd" ||
    typeof record.runtimeVersion !== "string" ||
    record.runtimeVersion.length < 1 ||
    record.runtimeVersion.length > 256 ||
    !Number.isSafeInteger(record.remoteProtocolMin) ||
    !Number.isSafeInteger(record.remoteProtocolMax) ||
    (record.remoteProtocolMin as number) < 1 ||
    (record.remoteProtocolMin as number) > REMOTE_PROTOCOL_VERSION ||
    (record.remoteProtocolMax as number) < REMOTE_PROTOCOL_VERSION ||
    !Number.isSafeInteger(record.keeperLocalProtocolMajor) ||
    (record.keeperLocalProtocolMajor as number) < 1 ||
    !Number.isSafeInteger(record.terminalWireVersion) ||
    (record.terminalWireVersion as number) < 1 ||
    !Number.isSafeInteger(record.bytes) ||
    (record.bytes as number) < 1 ||
    (record.bytes as number) > MAX_ARTIFACT_BYTES ||
    typeof record.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.sha256)
  ) {
    throw new TypeError("runtime manifest violates its artifact contract");
  }
  return record as unknown as RuntimeArtifactManifest;
}

async function runBootstrapScript(
  options: PrepareRemoteRuntimeOptions,
  policy: BootstrapShellPolicy,
  script: string
): Promise<OpenSshCommandResult> {
  return await runMuxCommand(
    options,
    "metadata",
    buildBootstrapScriptCommand(policy, script)
  );
}

async function runHelperCommand(
  options: PrepareRemoteRuntimeOptions,
  policy: BootstrapShellPolicy,
  runtimePath: string,
  args: readonly string[],
  limits: {
    timeoutMs?: number;
    input?: string | Uint8Array;
    maxInputBytes?: number;
    maxOutputBytes?: number;
  } = {}
): Promise<OpenSshCommandResult> {
  return await runMuxCommand(
    options,
    "metadata",
    buildBootstrapHelperCommand(policy, runtimePath, args),
    limits
  );
}

async function runMuxCommand(
  options: PrepareRemoteRuntimeOptions,
  kind: "control" | "metadata",
  remoteCommand: string,
  limits: {
    timeoutMs?: number;
    maxOutputBytes?: number;
    input?: string | Uint8Array;
    maxInputBytes?: number;
  } = {}
): Promise<OpenSshCommandResult> {
  const launch = await buildMuxOnlyLaunch(
    muxRequest(options, { kind, remoteCommand })
  );
  assertCurrentMaster(options);
  const result = await runOpenSshCommand(launch.executable, launch.args, {
    env: launch.env,
    ...(limits.input === undefined ? {} : { input: limits.input }),
    timeoutMs: limits.timeoutMs ?? BOOTSTRAP_COMMAND_TIMEOUT_MS,
    maxOutputBytes: limits.maxOutputBytes ?? 1024 * 1024,
    maxInputBytes: limits.maxInputBytes ?? 1024 * 1024
  });
  assertCurrentMaster(options);
  return result;
}

async function runMuxSftp(
  options: PrepareRemoteRuntimeOptions,
  batch: string,
  monitoredFiles: readonly { path: string; maxBytes: number }[] = []
): Promise<OpenSshCommandResult> {
  if (Buffer.byteLength(batch, "utf8") > 1024 * 1024 || batch.includes("\0")) {
    throw new RemoteRuntimeBootstrapError(
      "invalid-request",
      "runtime bootstrap SFTP batch is invalid or oversized"
    );
  }
  const launch = await buildMuxOnlyLaunch(
    muxRequest(options, { kind: "sftp", batchMode: true })
  );
  for (const monitored of monitoredFiles) {
    if (
      !isAbsolute(monitored.path) ||
      !Number.isSafeInteger(monitored.maxBytes) ||
      monitored.maxBytes < 1 ||
      monitored.maxBytes > MAX_ARTIFACT_BYTES
    ) {
      throw new RemoteRuntimeBootstrapError(
        "invalid-request",
        "runtime bootstrap read-back monitor is invalid"
      );
    }
  }
  assertCurrentMaster(options);
  const abortController = new AbortController();
  let monitorFailure: RemoteRuntimeBootstrapError | undefined;
  let activeCheck: Promise<void> | undefined;
  const checkFiles = async (): Promise<void> => {
    if (monitorFailure) return;
    for (const monitored of monitoredFiles) {
      let metadata;
      try {
        metadata = await lstat(monitored.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        metadata.size > monitored.maxBytes
      ) {
        monitorFailure = new RemoteRuntimeBootstrapError(
          "artifact-invalid",
          "remote SFTP read-back exceeded its bounded local file contract"
        );
        abortController.abort();
        return;
      }
    }
  };
  const pollFiles = (): Promise<void> => {
    activeCheck ??= checkFiles()
      .catch((error: unknown) => {
        monitorFailure =
          error instanceof RemoteRuntimeBootstrapError
            ? error
            : new RemoteRuntimeBootstrapError(
                "artifact-invalid",
                "remote SFTP read-back monitor failed closed",
                { cause: error }
              );
        abortController.abort();
      })
      .finally(() => {
        activeCheck = undefined;
      });
    return activeCheck;
  };
  const monitorTimer =
    monitoredFiles.length === 0
      ? undefined
      : setInterval(() => void pollFiles(), 10);
  monitorTimer?.unref();
  try {
    const result = await runOpenSshCommand(launch.executable, launch.args, {
      env: launch.env,
      input: batch,
      timeoutMs: BOOTSTRAP_SFTP_TIMEOUT_MS,
      maxInputBytes: 1024 * 1024,
      maxOutputBytes: 2 * 1024 * 1024,
      signal: abortController.signal
    });
    await pollFiles();
    if (monitorFailure) throw monitorFailure;
    assertCurrentMaster(options);
    return result;
  } catch (error) {
    await activeCheck?.catch(() => undefined);
    if (monitorFailure) throw monitorFailure;
    throw error;
  } finally {
    if (monitorTimer) clearInterval(monitorTimer);
  }
}

function muxRequest(
  options: PrepareRemoteRuntimeOptions,
  request:
    | { kind: "control" | "metadata"; remoteCommand: string }
    | { kind: "sftp"; batchMode: boolean }
): MuxOnlyChannelRequest {
  const master = options.assigned.master;
  return {
    ...request,
    sshPath: master.sshPath,
    ...(request.kind === "sftp" && options.sftpPath !== undefined
      ? { sftpPath: options.sftpPath }
      : {}),
    configPath: master.configPath,
    controlPath: master.controlPath,
    host: master.host,
    masterGeneration: master.generation
  } as MuxOnlyChannelRequest;
}

function assertCurrentMaster(options: PrepareRemoteRuntimeOptions): void {
  if (
    !options.pool.isCurrentGeneration(
      options.assigned.targetId,
      options.assigned.generation
    )
  ) {
    throw new OpenSshProcessError(
      "invalid-launch",
      "assigned SSH master generation changed during runtime bootstrap"
    );
  }
}

function generationInspectArguments(
  runtimePath: string,
  executableSha256: string,
  manifestSha256: string
): string[] {
  return [
    "bootstrap",
    "inspect",
    "--runtime-path",
    runtimePath,
    "--protocol-version",
    String(REMOTE_PROTOCOL_VERSION),
    "--expected-executable-sha256",
    executableSha256,
    "--expected-manifest-sha256",
    manifestSha256
  ];
}

async function prepareLocalTransferRoot(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new RemoteRuntimeBootstrapError(
      "invalid-request",
      "runtime bootstrap transfer root is not a private real directory"
    );
  }
  await chmod(path, 0o700);
  return path;
}

function decodeDoctorReport(
  record: Record<string, unknown>,
  roots: RemoteRuntimeRootsDto,
  observation: { platform: "darwin" | "linux"; arch: "arm64" | "x64" }
): RemoteDoctorReport {
  assertExactKeys(record, [
    "abi",
    "arch",
    "authenticatedPrincipal",
    "authorityRoot",
    "executionNodeId",
    "installRoot",
    "platform",
    "remoteInstallationId",
    "runtimeRoot",
    "stateRoot"
  ]);
  const principal = requireRecord(
    record.authenticatedPrincipal,
    "authenticated principal"
  );
  assertExactKeys(principal, ["accountName", "uid"]);
  const expectedArch = observation.arch === "arm64" ? "aarch64" : "x86_64";
  if (
    !isUuid(record.remoteInstallationId) ||
    !isUuid(record.executionNodeId) ||
    !Number.isSafeInteger(principal.uid) ||
    (principal.uid as number) < 0 ||
    typeof principal.accountName !== "string" ||
    principal.accountName.length < 1 ||
    principal.accountName.length > 256 ||
    record.platform !==
      (observation.platform === "darwin" ? "macos" : "linux") ||
    record.arch !== expectedArch ||
    (record.abi !== "musl" && record.abi !== "native") ||
    record.installRoot !== roots.installRoot ||
    record.authorityRoot !== roots.authorityRoot ||
    record.stateRoot !== roots.stateRoot ||
    record.runtimeRoot !== roots.runtimeRoot
  ) {
    throw new RemoteRuntimeBootstrapError(
      "bootstrap-failed",
      "remote doctor report does not match the verified bootstrap target"
    );
  }
  return record as unknown as RemoteDoctorReport;
}

function decodeGcReport(
  record: Record<string, unknown>
): RemoteGenerationGcReport {
  assertExactKeys(record, [
    "incompleteOrCorrupt",
    "inspected",
    "live",
    "removed"
  ]);
  if (
    !Number.isSafeInteger(record.inspected) ||
    (record.inspected as number) < 0 ||
    (record.inspected as number) > 256 ||
    !isGenerationArray(record.removed) ||
    !isGenerationArray(record.live) ||
    !isGenerationArray(record.incompleteOrCorrupt)
  ) {
    throw new RemoteRuntimeBootstrapError(
      "bootstrap-failed",
      "runtime generation GC returned an invalid bounded report"
    );
  }
  return record as unknown as RemoteGenerationGcReport;
}

function decodeResetReport(
  record: Record<string, unknown>,
  expectedGeneration: string
): RemoteGenerationResetReport {
  assertExactKeys(record, ["generation", "status"]);
  if (
    record.generation !== expectedGeneration ||
    (record.status !== "reset" && record.status !== "already-absent")
  ) {
    throw new RemoteRuntimeBootstrapError(
      "bootstrap-failed",
      "runtime generation reset returned an invalid acknowledgement"
    );
  }
  return record as unknown as RemoteGenerationResetReport;
}

function isGenerationArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 256 &&
    value.every(
      (entry) => typeof entry === "string" && /^\d+\+[a-f0-9]{64}$/u.test(entry)
    )
  );
}

function validateOptions(options: PrepareRemoteRuntimeOptions): void {
  for (const [name, value] of [
    ["runtime artifact root", options.artifactRoot],
    ["runtime transfer root", options.transferRoot]
  ] as const) {
    if (
      !isAbsolute(value) ||
      Buffer.byteLength(value, "utf8") > 32 * 1024 ||
      /[\0\r\n]/u.test(value)
    ) {
      throw new RemoteRuntimeBootstrapError(
        "invalid-request",
        `${name} must be a bounded absolute local path`
      );
    }
  }
  if (options.roots !== undefined && options.rootOverrides !== undefined) {
    throw new RemoteRuntimeBootstrapError(
      "invalid-request",
      "remote runtime roots and root overrides are mutually exclusive"
    );
  }
  for (const value of Object.values(
    options.roots ?? options.rootOverrides ?? {}
  )) {
    requireRemotePath(value);
  }
  if (
    options.bootstrapShellOverride !== undefined &&
    (!options.bootstrapShellOverride.startsWith("/") ||
      /[\0\r\n]/u.test(options.bootstrapShellOverride) ||
      Buffer.byteLength(options.bootstrapShellOverride, "utf8") > 32 * 1024)
  ) {
    throw new RemoteRuntimeBootstrapError(
      "invalid-request",
      "bootstrapShellOverride must be a bounded absolute remote shell path"
    );
  }
}

function validateRuntimeRoots(roots: RemoteRuntimeRootsDto): void {
  for (const value of Object.values(roots)) {
    requireRemotePath(value);
  }
}

function remoteJoin(root: string, ...parts: string[]): string {
  const path = posix.join(root, ...parts);
  requireRemotePath(path);
  return path;
}

function requireRemotePath(value: string): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    Buffer.byteLength(value, "utf8") > 32 * 1024 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new RemoteRuntimeBootstrapError(
      "invalid-request",
      "remote bootstrap paths must be bounded absolute paths"
    );
  }
  return value;
}

function quoteSftpPath(value: string): string {
  if (/[\0\r\n]/u.test(value)) {
    throw new RemoteRuntimeBootstrapError(
      "invalid-request",
      "SFTP bootstrap path contains a command separator"
    );
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function parseRemoteHome(environmentOutput: string): string {
  const homes = environmentOutput
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("HOME="))
    .map((line) => line.slice("HOME=".length));
  const unique = [...new Set(homes)];
  if (unique.length !== 1) {
    throw new RemoteRuntimeBootstrapError(
      "bootstrap-failed",
      "remote HOME could not be determined unambiguously before bootstrap"
    );
  }
  return requireRemotePath(unique[0]);
}

function parseRemoteUid(output: string): number {
  const value = output.trim();
  if (!/^\d+$/u.test(value)) {
    throw new RemoteRuntimeBootstrapError(
      "bootstrap-failed",
      "remote numeric UID could not be determined before bootstrap"
    );
  }
  const uid = Number(value);
  if (!Number.isSafeInteger(uid) || uid < 0 || uid > 0xffff_ffff) {
    throw new RemoteRuntimeBootstrapError(
      "bootstrap-failed",
      "remote numeric UID is outside the supported POSIX range"
    );
  }
  return uid;
}

function resolveRemoteRuntimeRoots(
  remoteHome: string,
  environmentOutput: string,
  uid: number,
  overrides: Partial<RemoteRuntimeRootsDto>
): RemoteRuntimeRootsDto {
  const installRoot = overrides.installRoot ?? remoteJoin(remoteHome, ".kmux");
  const stateRoot =
    overrides.stateRoot ?? remoteJoin(remoteHome, ".kmux", "state");
  const authorityRoot =
    overrides.authorityRoot ?? remoteJoin(stateRoot, "authority");
  const runtimeBase =
    parseRemoteEnvironmentPath(environmentOutput, "XDG_RUNTIME_DIR") ??
    parseRemoteEnvironmentPath(environmentOutput, "TMPDIR");
  const runtimeRoot =
    overrides.runtimeRoot ??
    (runtimeBase
      ? remoteJoin(runtimeBase, "kmux")
      : requireRemotePath(`/tmp/kmux-${uid}`));
  return { installRoot, authorityRoot, stateRoot, runtimeRoot };
}

function parseRemoteEnvironmentPath(
  environmentOutput: string,
  name: string
): string | undefined {
  const prefix = `${name}=`;
  const values = [
    ...new Set(
      environmentOutput
        .split(/\r?\n/u)
        .filter((line) => line.startsWith(prefix))
        .map((line) => line.slice(prefix.length))
        .filter(Boolean)
    )
  ];
  if (values.length === 0) return undefined;
  if (values.length !== 1) {
    throw new RemoteRuntimeBootstrapError(
      "bootstrap-failed",
      `remote ${name} could not be determined unambiguously before bootstrap`
    );
  }
  return requireRemotePath(values[0]);
}

function sftpParentCreationCommands(
  installRoot: string,
  remoteHome: string
): string[] {
  if (installRoot !== remoteHome && !installRoot.startsWith(`${remoteHome}/`)) {
    // An explicit root outside HOME is valid, but its owner-managed parent
    // must already exist. Bootstrap never creates or chmods an arbitrary
    // system hierarchy while guessing its ownership boundary.
    return [];
  }
  const relative = posix.relative(remoteHome, posix.dirname(installRoot));
  if (relative === "" || relative === ".") return [];
  const commands: string[] = [];
  let current = remoteHome;
  for (const component of relative.split("/")) {
    if (!component || component === "." || component === "..") {
      throw new RemoteRuntimeBootstrapError(
        "invalid-request",
        "remote install root escapes the authenticated HOME"
      );
    }
    current = remoteJoin(current, component);
    commands.push(`-mkdir ${quoteSftpPath(current)}`);
  }
  return commands;
}

function quotePosixWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJsonObject(value: string, name: string): Record<string, unknown> {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > 1024 * 1024
  ) {
    throw new RemoteRuntimeBootstrapError(
      "bootstrap-failed",
      `${name} output is oversized`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim()) as unknown;
  } catch (error) {
    throw new RemoteRuntimeBootstrapError(
      "bootstrap-failed",
      `${name} did not return one JSON object`,
      { cause: error }
    );
  }
  return requireRecord(parsed, name);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[]
): void {
  if (
    JSON.stringify(Object.keys(record).sort()) !==
    JSON.stringify([...expected].sort())
  ) {
    throw new TypeError(
      "remote bootstrap object has unknown or missing fields"
    );
  }
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value
    )
  );
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

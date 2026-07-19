import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const REMOTE_RUNTIME_ARTIFACT_SCHEMA_VERSION = 1;
export const REMOTE_RUNTIME_INDEX_SCHEMA_VERSION = 1;
const REMOTE_RUNTIME_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
const REMOTE_RUNTIME_METADATA_MAX_BYTES = 64 * 1024;
export const REMOTE_RUNTIME_PROTOCOL = Object.freeze({
  remoteProtocolMin: 1,
  remoteProtocolMax: 1,
  keeperLocalProtocolMajor: 1,
  terminalWireVersion: 1
});

export const REMOTE_RUNTIME_TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    platform: "darwin",
    arch: "arm64",
    abi: "native",
    rustTarget: "aarch64-apple-darwin",
    dockerPlatform: undefined,
    signed: true
  }),
  "darwin-x64": Object.freeze({
    platform: "darwin",
    arch: "x64",
    abi: "native",
    rustTarget: "x86_64-apple-darwin",
    dockerPlatform: undefined,
    signed: true
  }),
  "linux-arm64-musl": Object.freeze({
    platform: "linux",
    arch: "arm64",
    abi: "musl",
    rustTarget: "aarch64-unknown-linux-musl",
    dockerPlatform: "linux/arm64",
    signed: false
  }),
  "linux-x64-musl": Object.freeze({
    platform: "linux",
    arch: "x64",
    abi: "musl",
    rustTarget: "x86_64-unknown-linux-musl",
    dockerPlatform: "linux/amd64",
    signed: false
  })
});

export const REMOTE_RUNTIME_TARGET_NAMES = Object.freeze(
  Object.keys(REMOTE_RUNTIME_TARGETS)
);

export function requireRemoteRuntimeTarget(target) {
  const contract = REMOTE_RUNTIME_TARGETS[target];
  if (!contract) {
    throw new Error(
      `unsupported remote-runtime target ${JSON.stringify(target)}; expected one of ${REMOTE_RUNTIME_TARGET_NAMES.join(
        ", "
      )}`
    );
  }
  return contract;
}

export function nativeRemoteRuntimeTarget(
  platform = process.platform,
  arch = process.arch
) {
  const normalizedArch = arch === "aarch64" ? "arm64" : arch;
  if (platform === "darwin" && normalizedArch === "arm64") {
    return "darwin-arm64";
  }
  if (platform === "darwin" && normalizedArch === "x64") {
    return "darwin-x64";
  }
  if (platform === "linux" && normalizedArch === "arm64") {
    return "linux-arm64-musl";
  }
  if (platform === "linux" && normalizedArch === "x64") {
    return "linux-x64-musl";
  }
  return undefined;
}

export function selectRemoteRuntimeTarget(observation) {
  if (!observation || typeof observation !== "object") {
    throw new TypeError("remote runtime observation must be an object");
  }
  const platform =
    observation.platform === "macos" ? "darwin" : observation.platform;
  const arch =
    observation.arch === "aarch64"
      ? "arm64"
      : observation.arch === "x86_64"
        ? "x64"
        : observation.arch;
  const abi = platform === "darwin" ? "native" : observation.abi;
  const selected = REMOTE_RUNTIME_TARGET_NAMES.find((target) => {
    const contract = REMOTE_RUNTIME_TARGETS[target];
    return (
      contract.platform === platform &&
      contract.arch === arch &&
      contract.abi === abi
    );
  });
  if (!selected) {
    throw new Error(
      `unsupported remote runtime ${String(observation.platform)}/${String(
        observation.arch
      )}/${String(observation.abi)}`
    );
  }
  return selected;
}

export function createRemoteRuntimeArtifactManifest({
  target,
  runtimeVersion,
  sha256,
  bytes
}) {
  const contract = requireRemoteRuntimeTarget(target);
  requireRuntimeVersion(runtimeVersion);
  requireSha256(sha256);
  requirePositiveSafeInteger(bytes, "artifact byte length");
  return {
    schemaVersion: REMOTE_RUNTIME_ARTIFACT_SCHEMA_VERSION,
    target,
    platform: contract.platform,
    arch: contract.arch,
    abi: contract.abi,
    runtimeVersion,
    ...REMOTE_RUNTIME_PROTOCOL,
    executable: "kmuxd",
    sha256,
    bytes,
    signed: contract.signed
  };
}

export function parseRemoteRuntimeArtifactManifest(value, expectedTarget) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("remote runtime artifact manifest must be an object");
  }
  const expectedKeys = [
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
  ];
  const actualKeys = Object.keys(value).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new TypeError(
      "remote runtime artifact manifest has unknown or missing fields"
    );
  }
  const target = requireString(value.target, "target");
  const contract = requireRemoteRuntimeTarget(target);
  if (expectedTarget !== undefined && target !== expectedTarget) {
    throw new TypeError(
      `remote runtime artifact target ${target} does not match ${expectedTarget}`
    );
  }
  const manifest = createRemoteRuntimeArtifactManifest({
    target,
    runtimeVersion: requireString(value.runtimeVersion, "runtimeVersion"),
    sha256: requireString(value.sha256, "sha256"),
    bytes: value.bytes
  });
  if (
    value.schemaVersion !== REMOTE_RUNTIME_ARTIFACT_SCHEMA_VERSION ||
    value.platform !== contract.platform ||
    value.arch !== contract.arch ||
    value.abi !== contract.abi ||
    value.executable !== "kmuxd" ||
    value.signed !== contract.signed ||
    value.remoteProtocolMin !== REMOTE_RUNTIME_PROTOCOL.remoteProtocolMin ||
    value.remoteProtocolMax !== REMOTE_RUNTIME_PROTOCOL.remoteProtocolMax ||
    value.keeperLocalProtocolMajor !==
      REMOTE_RUNTIME_PROTOCOL.keeperLocalProtocolMajor ||
    value.terminalWireVersion !== REMOTE_RUNTIME_PROTOCOL.terminalWireVersion
  ) {
    throw new TypeError(
      "remote runtime artifact manifest violates its target contract"
    );
  }
  return manifest;
}

export async function verifyRemoteRuntimeArtifact(
  distributionRoot,
  target,
  {
    verifyNativeCapabilities = false,
    allowCrossHostDarwinSignatureAttestation = false,
    allowPackagedApplicationPermissions = false
  } = {}
) {
  const contract = requireRemoteRuntimeTarget(target);
  const directory = join(distributionRoot, target);
  const executablePath = join(directory, "kmuxd");
  const manifestPath = join(directory, "manifest.json");
  const [directoryMetadata, executableMetadata, manifestMetadata] =
    await Promise.all([
      lstat(directory),
      lstat(executablePath),
      lstat(manifestPath)
    ]);
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink() ||
    !isCurrentUserOwned(directoryMetadata) ||
    !hasSafeArtifactPermissions(
      directoryMetadata,
      "directory",
      allowPackagedApplicationPermissions
    )
  ) {
    throw new Error(`${target} artifact directory is not private`);
  }
  if (
    !manifestMetadata.isFile() ||
    manifestMetadata.isSymbolicLink() ||
    !isCurrentUserOwned(manifestMetadata) ||
    !hasSafeArtifactPermissions(
      manifestMetadata,
      "manifest",
      allowPackagedApplicationPermissions
    ) ||
    manifestMetadata.size === 0 ||
    manifestMetadata.size > REMOTE_RUNTIME_METADATA_MAX_BYTES
  ) {
    throw new Error(`${target} manifest is not a private bounded file`);
  }
  const manifest = parseRemoteRuntimeArtifactManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
    target
  );
  if (
    !executableMetadata.isFile() ||
    executableMetadata.isSymbolicLink() ||
    !isCurrentUserOwned(executableMetadata) ||
    executableMetadata.size === 0 ||
    executableMetadata.size > REMOTE_RUNTIME_ARTIFACT_MAX_BYTES ||
    !hasSafeArtifactPermissions(
      executableMetadata,
      "executable",
      allowPackagedApplicationPermissions
    )
  ) {
    throw new Error(`${target} kmuxd is not an executable regular file`);
  }
  const bytes = await readFile(executablePath);
  if (bytes.byteLength !== manifest.bytes) {
    throw new Error(`${target} kmuxd byte length does not match its manifest`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== manifest.sha256) {
    throw new Error(`${target} kmuxd SHA-256 does not match its manifest`);
  }
  const { stdout: fileOutput } = await execFileAsync("file", [executablePath]);
  assertRemoteRuntimeExecutableFormat(target, fileOutput);
  if (contract.signed) {
    if (process.platform === "darwin") {
      await execFileAsync("codesign", ["--verify", "--strict", executablePath]);
    } else if (!allowCrossHostDarwinSignatureAttestation) {
      throw new Error(
        `${target} signature verification requires a Darwin producer or explicit cross-host attestation`
      );
    } else {
      await verifyNativeArtifactAttestation(
        directory,
        target,
        contract,
        manifest
      );
    }
  }
  if (verifyNativeCapabilities) {
    if (nativeRemoteRuntimeTarget() !== target) {
      throw new Error(
        `${target} capability verification requires its actual matching target`
      );
    }
    const { stdout } = await execFileAsync(executablePath, [
      "bridge",
      "--capabilities"
    ]);
    const capabilities = JSON.parse(stdout);
    const protocol = capabilities?.protocol;
    if (
      capabilities?.processRole !== "bridge" ||
      capabilities?.available !== true ||
      protocol?.remoteProtocolMin !== manifest.remoteProtocolMin ||
      protocol?.remoteProtocolMax !== manifest.remoteProtocolMax ||
      protocol?.keeperLocalProtocolMajor !==
        manifest.keeperLocalProtocolMajor ||
      protocol?.terminalWireVersion !== manifest.terminalWireVersion
    ) {
      throw new Error(
        `${target} runtime capabilities do not match its manifest`
      );
    }
  }
  return { manifest, executablePath, manifestPath };
}

export async function refreshSignedRemoteRuntimeArtifactManifest(
  distributionRoot,
  target,
  { allowPackagedApplicationPermissions = false } = {}
) {
  const contract = requireRemoteRuntimeTarget(target);
  if (!contract.signed) {
    throw new Error(`${target} is not a signed remote-runtime artifact`);
  }

  const directory = join(distributionRoot, target);
  const executablePath = join(directory, "kmuxd");
  const manifestPath = join(directory, "manifest.json");
  const [directoryMetadata, executableMetadata, manifestMetadata] =
    await Promise.all([
      lstat(directory),
      lstat(executablePath),
      lstat(manifestPath)
    ]);
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink() ||
    !isCurrentUserOwned(directoryMetadata) ||
    !hasSafeArtifactPermissions(
      directoryMetadata,
      "directory",
      allowPackagedApplicationPermissions
    )
  ) {
    throw new Error(`${target} artifact directory is not private`);
  }
  if (
    !manifestMetadata.isFile() ||
    manifestMetadata.isSymbolicLink() ||
    !isCurrentUserOwned(manifestMetadata) ||
    !hasSafeArtifactPermissions(
      manifestMetadata,
      "manifest",
      allowPackagedApplicationPermissions
    ) ||
    manifestMetadata.size === 0 ||
    manifestMetadata.size > REMOTE_RUNTIME_METADATA_MAX_BYTES
  ) {
    throw new Error(`${target} manifest is not a private bounded file`);
  }
  if (
    !executableMetadata.isFile() ||
    executableMetadata.isSymbolicLink() ||
    !isCurrentUserOwned(executableMetadata) ||
    executableMetadata.size === 0 ||
    executableMetadata.size > REMOTE_RUNTIME_ARTIFACT_MAX_BYTES ||
    !hasSafeArtifactPermissions(
      executableMetadata,
      "executable",
      allowPackagedApplicationPermissions
    )
  ) {
    throw new Error(`${target} kmuxd is not a private executable regular file`);
  }

  const previousManifest = parseRemoteRuntimeArtifactManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
    target
  );
  const executable = await readFile(executablePath);
  const manifest = createRemoteRuntimeArtifactManifest({
    target,
    runtimeVersion: previousManifest.runtimeVersion,
    sha256: createHash("sha256").update(executable).digest("hex"),
    bytes: executable.byteLength
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: allowPackagedApplicationPermissions ? 0o644 : 0o600
  });
  await chmod(
    manifestPath,
    allowPackagedApplicationPermissions ? 0o644 : 0o600
  );
  return { manifest, executablePath, manifestPath };
}

async function verifyNativeArtifactAttestation(
  directory,
  target,
  contract,
  manifest
) {
  const attestationPath = join(directory, "native-attestation.json");
  const metadata = await lstat(attestationPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !isCurrentUserOwned(metadata) ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size === 0 ||
    metadata.size > REMOTE_RUNTIME_METADATA_MAX_BYTES
  ) {
    throw new Error(`${target} native producer attestation is unsafe`);
  }
  const value = JSON.parse(await readFile(attestationPath, "utf8"));
  parseNativeArtifactAttestation(value, {
    target,
    platform: contract.platform,
    arch: contract.arch,
    sha256: manifest.sha256
  });
}

export function parseNativeArtifactAttestation(value, expected) {
  const expectedKeys = [
    "arch",
    "nativeCapabilitiesVerified",
    "nativeParityPassed",
    "platform",
    "schemaVersion",
    "sha256",
    "signatureVerified",
    "target"
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(expectedKeys) ||
    value.schemaVersion !== 1 ||
    value.target !== expected.target ||
    value.platform !== expected.platform ||
    value.arch !== expected.arch ||
    value.sha256 !== expected.sha256 ||
    value.signatureVerified !== true ||
    value.nativeCapabilitiesVerified !== true ||
    value.nativeParityPassed !== true
  ) {
    throw new Error(
      `${expected.target} native producer attestation is invalid`
    );
  }
  return value;
}

export async function writeRemoteRuntimeIndex(
  distributionRoot,
  {
    allowCrossHostDarwinSignatureAttestation = false,
    allowPackagedApplicationPermissions = false
  } = {}
) {
  const artifacts = {};
  let runtimeVersion;
  for (const target of REMOTE_RUNTIME_TARGET_NAMES) {
    const { manifest } = await verifyRemoteRuntimeArtifact(
      distributionRoot,
      target,
      {
        allowCrossHostDarwinSignatureAttestation,
        allowPackagedApplicationPermissions
      }
    );
    runtimeVersion ??= manifest.runtimeVersion;
    if (runtimeVersion !== manifest.runtimeVersion) {
      throw new Error(
        "remote runtime artifacts do not share one runtime version"
      );
    }
    artifacts[target] = {
      path: `${target}/kmuxd`,
      manifestPath: `${target}/manifest.json`,
      sha256: manifest.sha256,
      bytes: manifest.bytes
    };
  }
  const index = {
    schemaVersion: REMOTE_RUNTIME_INDEX_SCHEMA_VERSION,
    runtimeVersion,
    ...REMOTE_RUNTIME_PROTOCOL,
    artifacts
  };
  const indexPath = join(distributionRoot, "index.json");
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, {
    mode: allowPackagedApplicationPermissions ? 0o644 : 0o600
  });
  await chmod(indexPath, allowPackagedApplicationPermissions ? 0o644 : 0o600);
  return index;
}

export async function makeExecutablePrivate(executablePath) {
  await access(executablePath);
  await chmod(executablePath, 0o700);
}

function isCurrentUserOwned(metadata) {
  const uid = process.getuid?.();
  return uid === undefined || metadata.uid === uid;
}

function hasSafeArtifactPermissions(metadata, kind, allowPackagedPermissions) {
  const mode = metadata.mode & 0o777;
  if (allowPackagedPermissions) {
    if ((mode & 0o022) !== 0) {
      return false;
    }
    return kind === "manifest"
      ? (mode & 0o400) !== 0
      : (mode & 0o500) === 0o500;
  }
  if ((mode & 0o077) !== 0) {
    return false;
  }
  return kind === "manifest" ? (mode & 0o400) !== 0 : (mode & 0o500) === 0o500;
}

export function assertRemoteRuntimeExecutableFormat(target, output) {
  const contract = requireRemoteRuntimeTarget(target);
  const isDarwin = contract.platform === "darwin";
  const architecturePattern =
    contract.arch === "arm64"
      ? /(?:arm64|aarch64)/iu
      : /(?:x86[_-]64|x86-64)/iu;
  if (
    (isDarwin
      ? !/Mach-O 64-bit/iu.test(output)
      : !/ELF 64-bit/iu.test(output)) ||
    !architecturePattern.test(output) ||
    (!isDarwin && !/(?:static-pie linked|statically linked)/iu.test(output))
  ) {
    throw new Error(`${target} executable format is invalid: ${output.trim()}`);
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new TypeError(`${name} must be a bounded non-empty string`);
  }
  return value;
}

function requireRuntimeVersion(value) {
  const version = requireString(value, "runtimeVersion");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new TypeError("runtimeVersion is invalid");
  }
  return version;
}

function requireSha256(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("sha256 must be a lowercase SHA-256 digest");
  }
  return value;
}

function requirePositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

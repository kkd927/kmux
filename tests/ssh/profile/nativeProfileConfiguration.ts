import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, normalize, posix } from "node:path";

import type { Id, RemoteRuntimeRootsDto } from "@kmux/proto";

export const NATIVE_PROFILE_ARTIFACT_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64-musl",
  "linux-x64-musl"
] as const;

export type NativeProfileArtifactTarget =
  (typeof NATIVE_PROFILE_ARTIFACT_TARGETS)[number];

export function isSharedCiEnvironment(value = process.env.CI): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

export interface NativeProfileConfiguration {
  schemaVersion: 1;
  environmentKind: "controlled-native";
  artifactTarget: NativeProfileArtifactTarget;
  runtimeArtifactPath: string;
  runtimeSha256: string;
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

const CONFIGURATION_KEYS = [
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
  "runtimeArtifactPath",
  "runtimePath",
  "runtimeSha256",
  "schemaVersion",
  "sftpPath",
  "sharedHost",
  "sshPath",
  "targetId"
] as const;

const ROOT_KEYS = [
  "authorityRoot",
  "installRoot",
  "runtimeRoot",
  "stateRoot"
] as const;
const HARDWARE_KEYS = [
  "evidence",
  "memoryBytes",
  "physicalCpuCores",
  "stateStorage"
] as const;
const NETWORK_KEYS = [
  "evidence",
  "maximumInjectedJitterMs",
  "roundTripLatencyMs"
] as const;
const AUDIT_KEYS = ["args", "executable"] as const;
const MAX_PATH_BYTES = 32 * 1024;
const MAX_EVIDENCE_BYTES = 8 * 1024;
const MAX_AUDIT_ARGUMENTS = 128;
const MAX_RUNTIME_ARTIFACT_BYTES = 64 * 1024 * 1024;

export function decodeNativeProfileConfiguration(
  value: unknown
): NativeProfileConfiguration {
  const config = requireRecord(value, "SSH profile configuration");
  assertExactKeys(
    config,
    config.controlRoot === undefined
      ? CONFIGURATION_KEYS.filter((key) => key !== "controlRoot")
      : CONFIGURATION_KEYS,
    "SSH profile configuration"
  );
  if (config.schemaVersion !== 1) {
    throw new TypeError("SSH profile schemaVersion must be 1");
  }
  if (config.environmentKind !== "controlled-native") {
    throw new TypeError(
      "SSH profile environmentKind must be controlled-native"
    );
  }
  if (!isNativeProfileArtifactTarget(config.artifactTarget)) {
    throw new TypeError("SSH profile artifactTarget is unsupported");
  }
  const runtimeSha256 = requireString(
    config.runtimeSha256,
    "runtimeSha256",
    64
  );
  if (!/^[a-f0-9]{64}$/u.test(runtimeSha256)) {
    throw new TypeError("SSH profile runtimeSha256 must be lowercase SHA-256");
  }

  const runtimeArtifactPath = requireLocalPath(
    config.runtimeArtifactPath,
    "runtimeArtifactPath"
  );
  const sshPath = requireLocalPath(config.sshPath, "sshPath");
  const sftpPath = requireLocalPath(config.sftpPath, "sftpPath");
  const configPath = requireLocalPath(config.configPath, "configPath");
  const controlRoot =
    config.controlRoot === undefined
      ? undefined
      : requireLocalPath(config.controlRoot, "controlRoot");
  const runtimePath = requireRemotePath(config.runtimePath, "runtimePath");
  const host = requireString(config.host, "host", 512);
  if (host.startsWith("-") || /[\0\r\n]/u.test(host)) {
    throw new TypeError(
      "SSH profile host is option-like or contains a control character"
    );
  }
  const targetId = requireString(config.targetId, "targetId", 256) as Id;
  if (/\p{Cc}/u.test(targetId)) {
    throw new TypeError("targetId contains a control character");
  }

  const rootsRecord = requireRecord(config.roots, "roots");
  assertExactKeys(rootsRecord, ROOT_KEYS, "roots");
  const roots: RemoteRuntimeRootsDto = {
    installRoot: requireRemotePath(
      rootsRecord.installRoot,
      "roots.installRoot"
    ),
    authorityRoot: requireRemotePath(
      rootsRecord.authorityRoot,
      "roots.authorityRoot"
    ),
    stateRoot: requireRemotePath(rootsRecord.stateRoot, "roots.stateRoot"),
    runtimeRoot: requireRemotePath(rootsRecord.runtimeRoot, "roots.runtimeRoot")
  };
  if (new Set(Object.values(roots)).size !== ROOT_KEYS.length) {
    throw new TypeError("SSH profile roots must be distinct");
  }

  const hardwareRecord = requireRecord(config.hardware, "hardware");
  assertExactKeys(hardwareRecord, HARDWARE_KEYS, "hardware");
  const physicalCpuCores = requirePositiveSafeInteger(
    hardwareRecord.physicalCpuCores,
    "hardware.physicalCpuCores"
  );
  const memoryBytes = requirePositiveSafeInteger(
    hardwareRecord.memoryBytes,
    "hardware.memoryBytes"
  );
  if (
    hardwareRecord.stateStorage !== "ssd-backed" &&
    hardwareRecord.stateStorage !== "other"
  ) {
    throw new TypeError("hardware.stateStorage is invalid");
  }
  const hardwareEvidence = requireString(
    hardwareRecord.evidence,
    "hardware.evidence",
    MAX_EVIDENCE_BYTES
  );

  const networkRecord = requireRecord(config.network, "network");
  assertExactKeys(networkRecord, NETWORK_KEYS, "network");
  const roundTripLatencyMs = requireNonNegativeFiniteNumber(
    networkRecord.roundTripLatencyMs,
    "network.roundTripLatencyMs"
  );
  const maximumInjectedJitterMs = requireNonNegativeFiniteNumber(
    networkRecord.maximumInjectedJitterMs,
    "network.maximumInjectedJitterMs"
  );
  const networkEvidence = requireString(
    networkRecord.evidence,
    "network.evidence",
    MAX_EVIDENCE_BYTES
  );

  const resolvedRoutePhysicalTcpLegs = requirePositiveSafeInteger(
    config.resolvedRoutePhysicalTcpLegs,
    "resolvedRoutePhysicalTcpLegs"
  );
  if (resolvedRoutePhysicalTcpLegs > 64) {
    throw new TypeError("resolvedRoutePhysicalTcpLegs exceeds its hard bound");
  }

  const auditRecord = requireRecord(config.auditSnapshot, "auditSnapshot");
  assertExactKeys(auditRecord, AUDIT_KEYS, "auditSnapshot");
  const auditExecutable = requireLocalPath(
    auditRecord.executable,
    "auditSnapshot.executable"
  );
  if (
    !Array.isArray(auditRecord.args) ||
    auditRecord.args.length > MAX_AUDIT_ARGUMENTS
  ) {
    throw new TypeError("auditSnapshot.args must be a bounded array");
  }
  const auditArgs = auditRecord.args.map((argument, index) =>
    requireArgument(argument, `auditSnapshot.args[${index}]`)
  );
  if (typeof config.sharedHost !== "boolean") {
    throw new TypeError("sharedHost must be boolean");
  }

  return {
    schemaVersion: 1,
    environmentKind: "controlled-native",
    artifactTarget: config.artifactTarget,
    runtimeArtifactPath,
    runtimeSha256,
    sshPath,
    sftpPath,
    configPath,
    host,
    ...(controlRoot === undefined ? {} : { controlRoot }),
    runtimePath,
    roots,
    targetId,
    hardware: {
      physicalCpuCores,
      memoryBytes,
      stateStorage: hardwareRecord.stateStorage,
      evidence: hardwareEvidence
    },
    network: {
      roundTripLatencyMs,
      maximumInjectedJitterMs,
      evidence: networkEvidence
    },
    resolvedRoutePhysicalTcpLegs,
    auditSnapshot: { executable: auditExecutable, args: auditArgs },
    sharedHost: config.sharedHost
  };
}

export async function verifyNativeProfileRuntimeArtifact(
  configuration: NativeProfileConfiguration
): Promise<string> {
  const artifact = await open(
    configuration.runtimeArtifactPath,
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    const metadata = await artifact.stat();
    if (
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > MAX_RUNTIME_ARTIFACT_BYTES ||
      (metadata.mode & 0o111) === 0
    ) {
      throw new Error(
        "native SSH profile runtime artifact must be a bounded executable regular file"
      );
    }
    const hash = createHash("sha256");
    for await (const chunk of artifact.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
    const digest = hash.digest("hex");
    if (digest !== configuration.runtimeSha256) {
      throw new Error(
        `native SSH profile runtime artifact SHA-256 ${digest} does not match configuration ${configuration.runtimeSha256}`
      );
    }
    return digest;
  } finally {
    await artifact.close();
  }
}

function isNativeProfileArtifactTarget(
  value: unknown
): value is NativeProfileArtifactTarget {
  return (
    typeof value === "string" &&
    (NATIVE_PROFILE_ARTIFACT_TARGETS as readonly string[]).includes(value)
  );
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new TypeError(`${name} has unknown or missing fields`);
  }
}

function requireString(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum
  ) {
    throw new TypeError(`${name} must be a non-empty bounded string`);
  }
  return value;
}

function requireLocalPath(value: unknown, name: string): string {
  const path = requireString(value, name, MAX_PATH_BYTES);
  if (!isAbsolute(path) || normalize(path) !== path || /[\0\r\n]/u.test(path)) {
    throw new TypeError(`${name} must be a bounded absolute local path`);
  }
  return path;
}

function requireRemotePath(value: unknown, name: string): string {
  const path = requireString(value, name, MAX_PATH_BYTES);
  if (
    !posix.isAbsolute(path) ||
    path === "/" ||
    posix.normalize(path) !== path ||
    /[\0\r\n]/u.test(path)
  ) {
    throw new TypeError(`${name} must be a bounded absolute remote path`);
  }
  return path;
}

function requireArgument(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${name} must be a bounded single-line string`);
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value as number;
}

function requireNonNegativeFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

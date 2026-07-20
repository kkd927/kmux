import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  REMOTE_RUNTIME_TARGETS,
  nativeRemoteRuntimeTarget
} from "./remote-runtime-artifact-contract.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(repositoryRoot, "remote", "kmuxd");
const target = nativeRemoteRuntimeTarget();
if (!target) {
  throw new Error("native SSH parity requires a supported actual target");
}
const contract = REMOTE_RUNTIME_TARGETS[target];
const nativeExecution = await verifyNativeExecutionEnvironment(target);
process.stderr.write(
  `[native-runtime-parity] execution ${JSON.stringify(nativeExecution)}\n`
);
const artifactPath = join(sourceRoot, "dist", target, "kmuxd");
const parityRoot = join(sourceRoot, "target", "native-parity");
const parityTargetRoot = join(parityRoot, "compatible");
const secondIncompatibleTargetRoot = join(parityRoot, "incompatible-b");
const binaryRoot = join(parityRoot, "bin");
await mkdir(parityRoot, { recursive: true });
await mkdir(binaryRoot, { recursive: true });

await run(
  process.execPath,
  [join(repositoryRoot, "scripts", "build-remote-runtime.mjs"), target],
  {
    ...process.env,
    KMUX_VERIFY_NATIVE_REMOTE_RUNTIME: "1"
  }
);
const shippedManifest = JSON.parse(
  await readFile(join(sourceRoot, "dist", target, "manifest.json"), "utf8")
);

const cargoArguments = [
  "build",
  "--manifest-path",
  join(sourceRoot, "Cargo.toml"),
  "--locked",
  "--target",
  contract.rustTarget
];
await run(process.env.KMUX_CARGO_PATH ?? "cargo", cargoArguments, {
  ...process.env,
  CARGO_TARGET_DIR: parityTargetRoot
});
const binaryName = process.platform === "win32" ? "kmuxd.exe" : "kmuxd";
const builtPath = join(
  parityTargetRoot,
  contract.rustTarget,
  "debug",
  binaryName
);
const compatiblePath = await installFixtureArtifact(
  builtPath,
  binaryName,
  shippedManifest.keeperLocalProtocolMajor
);
await run(
  process.env.KMUX_CARGO_PATH ?? "cargo",
  [...cargoArguments, "--features", "fixture-keeper-local-protocol-2"],
  {
    ...process.env,
    CARGO_TARGET_DIR: parityTargetRoot
  }
);
const incompatiblePath = await installFixtureArtifact(builtPath, binaryName, 2);
await run(
  process.env.KMUX_CARGO_PATH ?? "cargo",
  [...cargoArguments, "--features", "fixture-keeper-local-protocol-2"],
  {
    ...process.env,
    CARGO_TARGET_DIR: secondIncompatibleTargetRoot,
    RUSTFLAGS:
      `${process.env.RUSTFLAGS ?? ""} -C metadata=kmux_cohort_generation_b`.trim()
  }
);
const secondIncompatibleBuiltPath = join(
  secondIncompatibleTargetRoot,
  contract.rustTarget,
  "debug",
  binaryName
);
const secondIncompatiblePath = await installFixtureArtifact(
  secondIncompatibleBuiltPath,
  binaryName,
  2
);
if (
  (await sha256File(incompatiblePath)) ===
  (await sha256File(secondIncompatiblePath))
) {
  throw new Error("incompatible parity generations must have distinct hashes");
}
const localBin = join(repositoryRoot, "node_modules", ".bin");
await run(
  join(localBin, process.platform === "win32" ? "tsx.cmd" : "tsx"),
  [join(repositoryRoot, "tests", "ssh", "native", "runtimeParity.ts")],
  {
    ...process.env,
    PATH: `${localBin}${delimiter}${process.env.PATH ?? ""}`,
    KMUX_NATIVE_ARTIFACT_TARGET: target,
    KMUX_NATIVE_CURRENT_RUNTIME: artifactPath,
    KMUX_NATIVE_COMPATIBLE_RUNTIME: compatiblePath,
    KMUX_NATIVE_INCOMPATIBLE_RUNTIME: incompatiblePath,
    KMUX_NATIVE_INCOMPATIBLE_RUNTIME_B: secondIncompatiblePath
  }
);

const nativeAttestationPath = join(
  sourceRoot,
  "dist",
  target,
  "native-attestation.json"
);
await writeFile(
  nativeAttestationPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      target,
      platform: contract.platform,
      arch: contract.arch,
      sha256: shippedManifest.sha256,
      signatureVerified: contract.signed,
      nativeCapabilitiesVerified: true,
      nativeParityPassed: true
    },
    null,
    2
  )}\n`,
  { mode: 0o600 }
);
await chmod(nativeAttestationPath, 0o600);

process.stdout.write(
  `${JSON.stringify({ target, status: "passed", nativeExecution })}\n`
);

async function run(executable, args, env) {
  try {
    const result = await execFileAsync(executable, args, {
      cwd: repositoryRoot,
      env,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 20 * 60 * 1000
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } catch (error) {
    if (error?.stdout) process.stdout.write(error.stdout);
    if (error?.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}

async function copyPrivateExecutable(source, destination) {
  await copyFile(source, destination);
  await chmod(destination, 0o700);
}

async function installFixtureArtifact(source, binaryName, localProtocolMajor) {
  const bytes = await readFile(source);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = join(binaryRoot, sha256);
  const destination = join(directory, binaryName);
  const manifestPath = join(directory, "manifest.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await copyPrivateExecutable(source, destination);
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        ...shippedManifest,
        keeperLocalProtocolMajor: localProtocolMajor,
        sha256,
        bytes: bytes.byteLength
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  await chmod(manifestPath, 0o600);
  return destination;
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function verifyNativeExecutionEnvironment(expectedTarget) {
  const { stdout } = await execFileAsync("uname", ["-m"], {
    timeout: 10_000,
    maxBuffer: 64 * 1024
  });
  const kernelMachine = stdout.trim().toLowerCase();
  const expectedArchitecture = expectedTarget.includes("arm64")
    ? "arm64"
    : "x64";
  const kernelArchitecture = /^(?:aarch64|arm64)$/u.test(kernelMachine)
    ? "arm64"
    : /^(?:x86_64|amd64)$/u.test(kernelMachine)
      ? "x64"
      : undefined;
  if (kernelArchitecture !== expectedArchitecture) {
    throw new Error(
      `native parity rejects translated architecture: process target ${expectedTarget}, kernel ${kernelMachine}`
    );
  }

  let translated = false;
  if (process.platform === "darwin") {
    const result = await execFileAsync(
      "/usr/sbin/sysctl",
      ["-in", "sysctl.proc_translated"],
      { timeout: 10_000, maxBuffer: 64 * 1024 }
    ).catch(() => undefined);
    translated = result?.stdout.trim() === "1";
    if (translated) {
      throw new Error("native parity rejects a Rosetta-translated process");
    }
  }

  return {
    processPlatform: process.platform,
    processArch: process.arch,
    kernelMachine,
    translated,
    sharedCi: process.env.CI === "true"
  };
}

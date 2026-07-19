import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createRemoteRuntimeArtifactManifest,
  makeExecutablePrivate,
  nativeRemoteRuntimeTarget,
  requireRemoteRuntimeTarget,
  verifyRemoteRuntimeArtifact
} from "./remote-runtime-artifact-contract.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const target =
  process.argv[2] === "--native"
    ? nativeRemoteRuntimeTarget()
    : process.argv[2];
if (!target) {
  throw new Error("this host is not a supported native remote-runtime target");
}
const contract = requireRemoteRuntimeTarget(target);
const sourceDirectory = join(repositoryRoot, "remote", "kmuxd");
const outputDirectory = join(sourceDirectory, "dist", target);
const outputPath = join(outputDirectory, "kmuxd");
const manifestPath = join(outputDirectory, "manifest.json");
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "kmux-remote-runtime-build-")
);

try {
  const builtPath = contract.dockerPlatform
    ? await buildLinuxArtifact(temporaryDirectory)
    : await buildDarwinArtifact();
  const bytes = await readFile(builtPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const runtimeVersion = await readRuntimeVersion();
  const manifest = createRemoteRuntimeArtifactManifest({
    target,
    runtimeVersion,
    sha256,
    bytes: bytes.length
  });
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const stagedPath = join(outputDirectory, `.kmuxd-${process.pid}.tmp`);
  await copyFile(builtPath, stagedPath);
  await chmod(stagedPath, 0o700);
  await rename(stagedPath, outputPath);
  await makeExecutablePrivate(outputPath);
  const stagedManifest = join(
    outputDirectory,
    `.manifest-${process.pid}.json.tmp`
  );
  await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600
  });
  await rename(stagedManifest, manifestPath);
  await verifyRemoteRuntimeArtifact(join(sourceDirectory, "dist"), target, {
    verifyNativeCapabilities:
      process.env.KMUX_VERIFY_NATIVE_REMOTE_RUNTIME === "1"
  });
  process.stdout.write(
    `${JSON.stringify({ target, outputPath, manifestPath, sha256, bytes: bytes.length })}\n`
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(`failed to build ${target}: ${detail}`, { cause: error });
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function buildLinuxArtifact(temporaryRoot) {
  await execFileAsync(
    process.env.KMUX_DOCKER_PATH ?? "docker",
    [
      "buildx",
      "build",
      "--platform",
      contract.dockerPlatform,
      "--file",
      join(sourceDirectory, "Dockerfile.linux-musl"),
      "--build-arg",
      `RUST_TARGET=${contract.rustTarget}`,
      "--target",
      "artifact",
      "--output",
      `type=local,dest=${temporaryRoot}`,
      sourceDirectory
    ],
    {
      cwd: repositoryRoot,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15 * 60 * 1000
    }
  );
  return join(temporaryRoot, "kmuxd");
}

async function buildDarwinArtifact() {
  if (process.platform !== "darwin") {
    throw new Error("Darwin artifacts require a macOS build host");
  }
  await execFileAsync(
    process.env.KMUX_CARGO_PATH ?? "cargo",
    [
      "build",
      "--manifest-path",
      join(sourceDirectory, "Cargo.toml"),
      "--locked",
      "--release",
      "--target",
      contract.rustTarget
    ],
    {
      cwd: repositoryRoot,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15 * 60 * 1000
    }
  );
  const builtPath = join(
    sourceDirectory,
    "target",
    contract.rustTarget,
    "release",
    "kmuxd"
  );
  const identity = process.env.KMUX_REMOTE_CODESIGN_IDENTITY ?? "-";
  const codesignArguments = ["--force", "--sign", identity];
  if (identity === "-") codesignArguments.push("--timestamp=none");
  codesignArguments.push(builtPath);
  await execFileAsync("codesign", codesignArguments, {
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000
  });
  return builtPath;
}

async function readRuntimeVersion() {
  const cargoToml = await readFile(join(sourceDirectory, "Cargo.toml"), "utf8");
  const match = cargoToml.match(
    /\[workspace\.package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/u
  );
  if (!match?.[1]) {
    throw new Error("workspace package version is unavailable");
  }
  return match[1];
}

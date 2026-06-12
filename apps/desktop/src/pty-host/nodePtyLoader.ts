import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import type * as PtyModule from "node-pty";

import { KMUX_NATIVE_CACHE_ROOT_ENV } from "../shared/platform/env";

declare const require: NodeJS.Require | undefined;

interface NodePtyPackageJson {
  version?: string;
}

function debugPty(message: string): void {
  if (process.env.KMUX_DEBUG_PTY === "1") {
    process.stderr.write(`[pty-host-debug] ${message}\n`);
  }
}

function resolveModuleRequire(): NodeJS.Require {
  if (typeof require === "function") {
    return require;
  }

  return createRequire(resolve(process.cwd(), "package.json"));
}

function resolveNodePtySourceRoot(moduleRequire: NodeJS.Require): string {
  return dirname(moduleRequire.resolve("node-pty/package.json"));
}

export function shouldExternalizeNodePty(
  nodePtyRoot: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return (
    platform === "darwin" &&
    nodePtyRoot.includes(`.app${sep}`) &&
    nodePtyRoot.includes(`${sep}app.asar.unpacked${sep}`)
  );
}

function readNodePtyVersion(nodePtyRoot: string): string {
  const packageJson = JSON.parse(
    readFileSync(join(nodePtyRoot, "package.json"), "utf8")
  ) as NodePtyPackageJson;
  return packageJson.version ?? "unknown";
}

function nonBlankEnvPath(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function nonBlankAbsoluteEnvPath(value: string | undefined): string | undefined {
  const pathValue = nonBlankEnvPath(value);
  return pathValue && isAbsolute(pathValue) ? pathValue : undefined;
}

function resolveLinuxNativeCacheRoot(env: NodeJS.ProcessEnv): string {
  const configuredNativeRoot = nonBlankAbsoluteEnvPath(
    env[KMUX_NATIVE_CACHE_ROOT_ENV]
  );
  if (configuredNativeRoot) {
    return configuredNativeRoot;
  }
  const xdgCacheHome = nonBlankAbsoluteEnvPath(env.XDG_CACHE_HOME);
  if (xdgCacheHome) {
    return join(xdgCacheHome, "kmux", "native");
  }
  return join(homedir(), ".cache", "kmux", "native");
}

export function resolveExternalNodePtyRoot(
  nodePtyRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  abi = process.versions.modules
): string {
  const nativeRoot =
    platform === "linux"
      ? resolveLinuxNativeCacheRoot(env)
      : join(
          nonBlankEnvPath(env.KMUX_RUNTIME_DIR) ?? join(homedir(), ".kmux"),
          "native"
        );
  const version = readNodePtyVersion(nodePtyRoot);
  return join(
    nativeRoot,
    `node-pty-${version}-${platform}-${arch}-abi${abi}`
  );
}

function ensureExecutable(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }
  chmodSync(filePath, 0o755);
}

export function ensureExternalNodePtyRoot(
  nodePtyRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  abi = process.versions.modules
): string {
  const externalRoot = resolveExternalNodePtyRoot(
    nodePtyRoot,
    env,
    platform,
    arch,
    abi
  );
  const packageJsonPath = join(externalRoot, "package.json");

  if (existsSync(packageJsonPath)) {
    debugPty(`reusing external node-pty at ${externalRoot}`);
    ensureExecutable(join(externalRoot, "build", "Release", "spawn-helper"));
    ensureExecutable(
      join(externalRoot, "prebuilds", `${platform}-${arch}`, "spawn-helper")
    );
    return externalRoot;
  }

  mkdirSync(dirname(externalRoot), { recursive: true });
  const stagingRoot = `${externalRoot}-staging-${process.pid}`;
  rmSync(stagingRoot, { force: true, recursive: true });
  debugPty(`copying node-pty from ${nodePtyRoot} to ${externalRoot}`);
  cpSync(nodePtyRoot, stagingRoot, {
    force: true,
    preserveTimestamps: true,
    recursive: true
  });
  ensureExecutable(join(stagingRoot, "build", "Release", "spawn-helper"));
  ensureExecutable(
    join(stagingRoot, "prebuilds", `${platform}-${arch}`, "spawn-helper")
  );

  try {
    renameSync(stagingRoot, externalRoot);
  } catch (error) {
    rmSync(stagingRoot, { force: true, recursive: true });
    if (!existsSync(packageJsonPath)) {
      throw error;
    }
  }

  return externalRoot;
}

export function loadNodePty(): typeof PtyModule {
  const moduleRequire = resolveModuleRequire();
  const nodePtyRoot = resolveNodePtySourceRoot(moduleRequire);
  debugPty(`resolved bundled node-pty root ${nodePtyRoot}`);

  if (!shouldExternalizeNodePty(nodePtyRoot)) {
    debugPty("using bundled node-pty directly");
    return moduleRequire("node-pty") as typeof PtyModule;
  }

  const externalRoot = ensureExternalNodePtyRoot(nodePtyRoot);
  debugPty(`loading external node-pty from ${externalRoot}`);
  const externalRequire = createRequire(join(externalRoot, "lib", "index.js"));
  return externalRequire("./index.js") as typeof PtyModule;
}

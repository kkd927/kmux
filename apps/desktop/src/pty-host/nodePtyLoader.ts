import {execFileSync} from "node:child_process";
import {chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync} from "node:fs";
import {createRequire} from "node:module";
import {homedir} from "node:os";
import {dirname, join, resolve, sep} from "node:path";

import type * as PtyModule from "node-pty";

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

export function shouldExternalizeNodePty(nodePtyRoot: string): boolean {
  return (
    process.platform === "darwin" &&
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

export function resolveExternalNodePtyRoot(nodePtyRoot: string): string {
  const runtimeRoot = process.env.KMUX_RUNTIME_DIR ?? join(homedir(), ".kmux");
  const version = readNodePtyVersion(nodePtyRoot);
  return join(
    runtimeRoot,
    "native",
    `node-pty-${version}-${process.platform}-${process.arch}-abi${process.versions.modules}`
  );
}

function ensureExecutable(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }
  chmodSync(filePath, 0o755);
}

function ensureExternalNodePtyRoot(nodePtyRoot: string): string {
  const externalRoot = resolveExternalNodePtyRoot(nodePtyRoot);
  const packageJsonPath = join(externalRoot, "package.json");

  if (existsSync(packageJsonPath)) {
    debugPty(`reusing external node-pty at ${externalRoot}`);
    ensureExecutable(join(externalRoot, "build", "Release", "spawn-helper"));
    ensureExecutable(
      join(
        externalRoot,
        "prebuilds",
        `${process.platform}-${process.arch}`,
        "spawn-helper"
      )
    );
    return externalRoot;
  }

  mkdirSync(dirname(externalRoot), { recursive: true });
  const stagingRoot = `${externalRoot}-staging-${process.pid}`;
  rmSync(stagingRoot, { force: true, recursive: true });
  debugPty(`copying node-pty from ${nodePtyRoot} to ${externalRoot}`);
  execFileSync("ditto", [nodePtyRoot, stagingRoot]);
  ensureExecutable(join(stagingRoot, "build", "Release", "spawn-helper"));
  ensureExecutable(
    join(
      stagingRoot,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper"
    )
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

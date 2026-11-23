import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

export interface CliRuntimePaths {
  cliPath?: string;
  cliTsxLoaderPath?: string;
  cliWorkingDirectory?: string;
  nodePath: string;
  warning?: string;
}

interface ResolveCliRuntimePathsOptions {
  currentDir: string;
  isPackaged?: boolean;
  resourcesPath?: string;
  processExecPath?: string;
  pathExists?: (path: string) => boolean;
  resolveTsxLoaderPath?: () => string | undefined;
}

const requireForResolve = createRequire(import.meta.url);

function defaultResolveTsxLoaderPath(): string | undefined {
  try {
    return requireForResolve.resolve("tsx");
  } catch {
    return undefined;
  }
}

export function resolveCliRuntimePaths(
  options: ResolveCliRuntimePathsOptions
): CliRuntimePaths {
  const pathExists = options.pathExists ?? existsSync;
  const nodePath = options.processExecPath ?? process.execPath;

  if (options.isPackaged && options.resourcesPath) {
    const packagedCliPath = join(options.resourcesPath, "cli", "bin.cjs");
    if (pathExists(packagedCliPath)) {
      return {
        cliPath: packagedCliPath,
        cliWorkingDirectory: options.resourcesPath,
        nodePath
      };
    }

    return {
      nodePath,
      warning: `[orchestration] Bundled kmux CLI not found at ${packagedCliPath}; the kmux terminal command is unavailable.`
    };
  }

  const repoRoot = resolve(options.currentDir, "../../../..");
  const builtCliPath = resolve(repoRoot, "packages/cli/dist/bin.cjs");
  if (pathExists(builtCliPath)) {
    return {
      cliPath: builtCliPath,
      cliWorkingDirectory: repoRoot,
      nodePath
    };
  }

  const sourceCliPath = resolve(repoRoot, "packages/cli/src/bin.ts");
  const cliTsxLoaderPath =
    options.resolveTsxLoaderPath?.() ?? defaultResolveTsxLoaderPath();
  if (
    pathExists(sourceCliPath) &&
    cliTsxLoaderPath &&
    pathExists(cliTsxLoaderPath)
  ) {
    return {
      cliPath: sourceCliPath,
      cliWorkingDirectory: repoRoot,
      cliTsxLoaderPath,
      nodePath
    };
  }

  const loaderSuffix = cliTsxLoaderPath
    ? `tsx loader not found at ${cliTsxLoaderPath}`
    : "tsx loader is unavailable";

  return {
    nodePath,
    warning: `[orchestration] kmux CLI entry not found; the kmux terminal command is unavailable. Checked ${builtCliPath} and ${sourceCliPath} (${loaderSuffix}).`
  };
}

export function synchronizeKmuxCliLauncher(
  binDir: string,
  runtime: CliRuntimePaths
): string | undefined {
  const launcherPath = join(binDir, "kmux");
  if (!runtime.cliPath) {
    rmSync(launcherPath, { force: true });
    return undefined;
  }

  mkdirSync(binDir, { recursive: true });
  const temporaryPath = join(binDir, `.kmux.tmp-${randomUUID()}`);
  const argv = [
    runtime.nodePath,
    ...(runtime.cliTsxLoaderPath ? ["--import", runtime.cliTsxLoaderPath] : []),
    runtime.cliPath
  ];
  try {
    writeFileSync(
      temporaryPath,
      [
        "#!/bin/sh",
        `exec env ELECTRON_RUN_AS_NODE=1 ${argv.map(quotePosixWord).join(" ")} "$@"`,
        ""
      ].join("\n"),
      { encoding: "utf8", flag: "wx", mode: 0o700 }
    );
    chmodSync(temporaryPath, 0o700);
    renameSync(temporaryPath, launcherPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return launcherPath;
}

function quotePosixWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

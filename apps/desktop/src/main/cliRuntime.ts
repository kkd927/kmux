import { existsSync } from "node:fs";
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
      warning: `[agent-hooks] Bundled kmux CLI not found at ${packagedCliPath}; agent hook forwarding is disabled.`
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
  if (pathExists(sourceCliPath) && cliTsxLoaderPath && pathExists(cliTsxLoaderPath)) {
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
    warning: `[agent-hooks] kmux CLI entry not found; agent hook forwarding is disabled. Checked ${builtCliPath} and ${sourceCliPath} (${loaderSuffix}).`
  };
}

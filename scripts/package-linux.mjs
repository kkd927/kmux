#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DESKTOP_ROOT = path.join(REPOSITORY_ROOT, "apps", "desktop");
export const KMUX_LINUX_PACKAGE_ARCH = "KMUX_LINUX_PACKAGE_ARCH";

export function normalizeLinuxPackageArch(argv = [], hostArch = process.arch) {
  const tokens = argv.filter((token) => token !== "--");
  const unknown = tokens.filter(
    (token) => token !== "--x64" && token !== "--arm64"
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unsupported Linux package argument(s): ${unknown.join(", ")}. Expected --x64 or --arm64.`
    );
  }
  if (tokens.length > 1) {
    throw new Error("Choose exactly one Linux package architecture.");
  }
  if (tokens[0] === "--x64") {
    return "x64";
  }
  if (tokens[0] === "--arm64") {
    return "arm64";
  }
  if (hostArch === "x64" || hostArch === "arm64") {
    return hostArch;
  }
  throw new Error(
    `Unsupported Linux package host architecture ${hostArch}; pass --x64 or --arm64.`
  );
}

export function electronBuilderLinuxArgs(arch) {
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported normalized Linux architecture: ${arch}`);
  }
  return [
    "--config",
    "electron-builder.yml",
    "--linux",
    "AppImage",
    "--publish",
    "never",
    `--${arch}`
  ];
}

export function electronBuilderLinuxEnv(arch, baseEnv = process.env) {
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported normalized Linux architecture: ${arch}`);
  }
  return {
    ...baseEnv,
    [KMUX_LINUX_PACKAGE_ARCH]: arch
  };
}

export function main(argv = process.argv.slice(2)) {
  const arch = normalizeLinuxPackageArch(argv);
  const cliPath = path.join(
    REPOSITORY_ROOT,
    "node_modules",
    "electron-builder",
    "out",
    "cli",
    "cli.js"
  );
  const result = spawnSync(
    process.execPath,
    [cliPath, ...electronBuilderLinuxArgs(arch)],
    {
      cwd: DESKTOP_ROOT,
      env: electronBuilderLinuxEnv(arch),
      stdio: "inherit"
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `electron-builder Linux ${arch} packaging exited with code ${result.status ?? "unknown"}`
    );
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

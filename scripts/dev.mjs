import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

function commandForNpm() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function exitCodeForSignal(signal) {
  switch (signal) {
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    default:
      return 1;
  }
}

export function resolveDevProfileDirs({
  repoRoot = process.cwd(),
  env = process.env
} = {}) {
  const defaultProfileRoot = path.join(repoRoot, ".kmux", "dev");
  return {
    configDir:
      nonBlankEnvPath(env.KMUX_CONFIG_DIR) ??
      path.join(defaultProfileRoot, "config"),
    runtimeDir:
      nonBlankEnvPath(env.KMUX_RUNTIME_DIR) ??
      path.join(defaultProfileRoot, "runtime")
  };
}

function nonBlankEnvPath(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function main() {
  const repoRoot = process.cwd();
  const { configDir, runtimeDir } = resolveDevProfileDirs({
    repoRoot,
    env: process.env
  });

  mkdirSync(configDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });

  const child = spawn(
    commandForNpm(),
    ["run", "dev", "--workspace", "@kmux/desktop"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        KMUX_CONFIG_DIR: configDir,
        KMUX_RUNTIME_DIR: runtimeDir
      },
      stdio: "inherit"
    }
  );

  const signalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      child.kill(signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  child.on("exit", (code, signal) => {
    for (const [registeredSignal, handler] of signalHandlers) {
      process.removeListener(registeredSignal, handler);
    }
    if (signal) {
      process.exit(exitCodeForSignal(signal));
      return;
    }
    process.exit(code ?? 0);
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}

import { spawn } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const CHROME_SANDBOX_RELATIVE_PATH = path.join(
  "node_modules",
  "electron",
  "dist",
  "chrome-sandbox"
);

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

export function isConfiguredChromeSandbox(stats) {
  return (
    stats?.isFile?.() === true &&
    stats.uid === 0 &&
    stats.gid === 0 &&
    (stats.mode & 0o4777) === 0o4755
  );
}

export function resolveDevElectronSandboxEnv({
  repoRoot = process.cwd(),
  env = process.env,
  platform = process.platform,
  statFile = statSync
} = {}) {
  if (platform !== "linux" || nonBlankEnvPath(env.NO_SANDBOX)) {
    return { env: { ...env }, fallback: null };
  }

  const chromeSandboxPath = path.join(repoRoot, CHROME_SANDBOX_RELATIVE_PATH);
  try {
    if (isConfiguredChromeSandbox(statFile(chromeSandboxPath))) {
      return { env: { ...env }, fallback: null };
    }
  } catch {
    return { env: { ...env }, fallback: null };
  }

  return {
    env: {
      ...env,
      NO_SANDBOX: "1"
    },
    fallback: {
      chromeSandboxPath,
      reason: "linux-dev-chrome-sandbox-helper-not-configured"
    }
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

  const sandboxEnv = resolveDevElectronSandboxEnv({
    repoRoot,
    env: process.env
  });
  if (sandboxEnv.fallback) {
    process.stderr.write(
      [
        "Linux dev Electron sandbox helper is not configured; running `npm run dev` with NO_SANDBOX=1.",
        `Helper: ${sandboxEnv.fallback.chromeSandboxPath}`,
        "This fallback is limited to the local dev launcher; packaged AppImage validation remains unaffected."
      ].join("\n") + "\n"
    );
  }

  const child = spawn(
    commandForNpm(),
    ["run", "dev", "--workspace", "@kmux/desktop"],
    {
      cwd: repoRoot,
      env: {
        ...sandboxEnv.env,
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

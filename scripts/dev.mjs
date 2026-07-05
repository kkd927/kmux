import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const CHROME_SANDBOX_RELATIVE_PATH = path.join(
  "node_modules",
  "electron",
  "dist",
  "chrome-sandbox"
);
const ELECTRON_PATH_TXT_RELATIVE_PATH = path.join(
  "node_modules",
  "electron",
  "path.txt"
);
const SNAPSHOT_STORE_VERSION = 1;
const KMUX_INHERITED_RUNTIME_ENV_KEYS = [
  "KMUX_SOCKET_PATH",
  "KMUX_SOCKET_MODE",
  "KMUX_AUTH_TOKEN",
  "KMUX_RAW_OUTPUT_ROOT",
  "KMUX_NATIVE_CACHE_ROOT",
  "KMUX_ELECTRON_USER_DATA_DIR",
  "KMUX_AGENT_BIN_DIR",
  "KMUX_AGENT_WRAPPER_BIN_DIR",
  "KMUX_NODE_PATH",
  "KMUX_WORKSPACE_ID",
  "KMUX_PANE_ID",
  "KMUX_SURFACE_ID",
  "KMUX_SESSION_ID",
  "KMUX_HOOK_AGENT",
  "KMUX_HOOK_EVENT",
  "KMUX_AGENT_HOOK_OUTPUT_MODE",
  "KMUX_SHELL_INTEGRATION",
  "KMUX_ZSH_WRAPPER_DIR",
  "KMUX_ZSH_INTEGRATION_SCRIPT",
  "KMUX_BASH_INTEGRATION_SCRIPT",
  "KMUX_FISH_INTEGRATION_SCRIPT",
  "KMUX_ORIGINAL_HOME",
  "KMUX_ORIGINAL_ZDOTDIR",
  "KMUX_ORIGINAL_HISTFILE",
  "KMUX_ORIGINAL_XDG_CONFIG_HOME",
  "KMUX_CLI_PATH",
  "KMUX_AGENT_HELPER_PATH",
  "KMUX_NODE_RUNTIME",
  "__KMUX_OSC7_INSTALLED"
];

function commandForNpm() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function resolveInstallElectronCommand({
  repoRoot = process.cwd(),
  platform = process.platform
} = {}) {
  return path.join(
    repoRoot,
    "node_modules",
    ".bin",
    platform === "win32" ? "install-electron.cmd" : "install-electron"
  );
}

function fallbackElectronOverrideExecutableRelativePath() {
  return "electron";
}

export function resolveElectronOverrideExecutablePath({
  repoRoot = process.cwd(),
  env = process.env,
  readFile = readFileSync
} = {}) {
  const overrideDistPath = nonBlankEnvPath(env.ELECTRON_OVERRIDE_DIST_PATH);
  if (!overrideDistPath) {
    return null;
  }

  let executableRelativePath = fallbackElectronOverrideExecutableRelativePath();
  try {
    const pathTxt = readFile(
      path.join(repoRoot, ELECTRON_PATH_TXT_RELATIVE_PATH),
      "utf8"
    ).trim();
    if (pathTxt.length > 0) {
      executableRelativePath = pathTxt;
    }
  } catch {
    // Electron's package resolver joins ELECTRON_OVERRIDE_DIST_PATH with
    // "electron" when path.txt is unavailable.
  }

  return path.join(overrideDistPath, executableRelativePath);
}

export function ensureElectronBinaryDownloaded({
  repoRoot = process.cwd(),
  env = process.env,
  platform = process.platform,
  accessFile = accessSync,
  readFile = readFileSync,
  spawnSyncFn = spawnSync
} = {}) {
  const overrideExecutablePath = resolveElectronOverrideExecutablePath({
    repoRoot,
    env,
    platform,
    readFile
  });
  if (overrideExecutablePath) {
    try {
      accessFile(
        overrideExecutablePath,
        platform === "win32" ? constants.F_OK : constants.X_OK
      );
    } catch {
      throw new Error(
        [
          "ELECTRON_OVERRIDE_DIST_PATH is set but the Electron executable is not usable.",
          `Expected executable: ${overrideExecutablePath}`
        ].join(" ")
      );
    }
    return {
      ran: false,
      command: null,
      reason: "electron-override-dist-path",
      electronPath: overrideExecutablePath
    };
  }

  const command = resolveInstallElectronCommand({ repoRoot, platform });
  const result = spawnSyncFn(command, ["--no"], {
    cwd: repoRoot,
    env,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`install-electron exited with signal ${result.signal}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`install-electron exited with status ${result.status}`);
  }
  return { ran: true, command };
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
  const configDir =
    nonBlankEnvPath(env.KMUX_CONFIG_DIR) ??
    path.join(defaultProfileRoot, "config");
  const runtimeDir =
    nonBlankEnvPath(env.KMUX_RUNTIME_DIR) ??
    path.join(defaultProfileRoot, "runtime");
  const stateDir = nonBlankEnvPath(env.KMUX_STATE_DIR) ?? configDir;
  const dataDir = nonBlankEnvPath(env.KMUX_DATA_DIR) ?? configDir;
  const cacheDir = nonBlankEnvPath(env.KMUX_CACHE_DIR) ?? runtimeDir;
  const electronUserDataDir = path.join(cacheDir, "electron-user-data");
  return {
    configDir,
    runtimeDir,
    stateDir,
    dataDir,
    cacheDir,
    socketPath: path.join(runtimeDir, "control.sock"),
    rawOutputRoot: path.join(stateDir, "pty-raw"),
    nativeCacheRoot: path.join(cacheDir, "native"),
    agentHookBinDir: path.join(dataDir, "bin"),
    agentWrapperBinDir: path.join(dataDir, "wrappers"),
    electronUserDataDir
  };
}

export function resolveDevAppEnv({
  repoRoot = process.cwd(),
  env = process.env
} = {}) {
  const dirs = resolveDevProfileDirs({ repoRoot, env });
  const nextEnv = { ...env };

  for (const key of KMUX_INHERITED_RUNTIME_ENV_KEYS) {
    delete nextEnv[key];
  }

  return {
    ...nextEnv,
    KMUX_CONFIG_DIR: dirs.configDir,
    KMUX_RUNTIME_DIR: dirs.runtimeDir,
    KMUX_STATE_DIR: dirs.stateDir,
    KMUX_DATA_DIR: dirs.dataDir,
    KMUX_CACHE_DIR: dirs.cacheDir,
    KMUX_SOCKET_PATH: dirs.socketPath,
    KMUX_RAW_OUTPUT_ROOT: dirs.rawOutputRoot,
    KMUX_NATIVE_CACHE_ROOT: dirs.nativeCacheRoot,
    KMUX_AGENT_BIN_DIR: dirs.agentHookBinDir,
    KMUX_AGENT_WRAPPER_BIN_DIR: dirs.agentWrapperBinDir,
    KMUX_ELECTRON_USER_DATA_DIR: dirs.electronUserDataDir
  };
}

export function readDevStateRestoreMetadata({
  statePath,
  readFile = readFileSync
} = {}) {
  if (!statePath) {
    return {
      found: false,
      shouldRestore: false
    };
  }
  let content;
  try {
    content = readFile(statePath, "utf8");
  } catch {
    return {
      found: false,
      shouldRestore: false
    };
  }

  let envelope;
  try {
    envelope = JSON.parse(content);
  } catch {
    return {
      found: false,
      shouldRestore: false
    };
  }

  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.version !== SNAPSHOT_STORE_VERSION ||
    !envelope.snapshot
  ) {
    return {
      found: false,
      shouldRestore: false
    };
  }

  const cleanShutdown = envelope.cleanShutdown === true;
  const restoreOnLaunch = envelope.restoreOnLaunch === true;
  return {
    found: true,
    cleanShutdown,
    restoreOnLaunch,
    shouldRestore: cleanShutdown !== true || restoreOnLaunch
  };
}

export function shouldResetDevState({
  env = process.env,
  statePath,
  readFile = readFileSync
} = {}) {
  const explicitRestore = nonBlankEnvPath(env.KMUX_DEV_RESTORE_STATE);
  if (explicitRestore === "1") {
    return false;
  }
  if (explicitRestore) {
    return true;
  }
  return !readDevStateRestoreMetadata({ statePath, readFile }).shouldRestore;
}

export function resetDevState({
  stateDir,
  env = process.env,
  readFile = readFileSync,
  rmFile = rmSync
} = {}) {
  const statePath = stateDir ? path.join(stateDir, "state.json") : null;
  if (
    !stateDir ||
    !shouldResetDevState({
      env,
      statePath,
      readFile
    })
  ) {
    return { reset: false, statePath: null };
  }
  // Dev launches reset only snapshots that the app would not restore anyway.
  rmFile(statePath, { force: true });
  return { reset: true, statePath };
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
  const profileDirs = resolveDevProfileDirs({
    repoRoot,
    env: process.env
  });

  for (const dir of [
    profileDirs.configDir,
    profileDirs.runtimeDir,
    profileDirs.stateDir,
    profileDirs.dataDir,
    profileDirs.cacheDir,
    profileDirs.electronUserDataDir
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  resetDevState({
    stateDir: profileDirs.stateDir,
    env: process.env
  });
  ensureElectronBinaryDownloaded({
    repoRoot,
    env: process.env
  });

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
        ...resolveDevAppEnv({
          repoRoot,
          env: sandboxEnv.env
        })
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

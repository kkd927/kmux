import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

const DEFAULT_SMOKE_TIMEOUT_MS = 180_000;
const SUCCESS_SETTLE_MS = 1_500;
const MAX_LOG_CHARS = 20_000;
const PROCESS_EXIT_GRACE_MS = 5_000;

const FAILURE_PATTERNS = [
  /Unable to find Electron app at/i,
  /Cannot find module .*process\.stdout\.write/i
];

function commandForNpm() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function createSandbox() {
  const profileRoot = mkdtempSync(path.join(tmpdir(), "kmux-dev-smoke-"));
  const configDir = path.join(profileRoot, "config");
  const runtimeDir = path.join(profileRoot, "runtime");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  return {
    profileRoot,
    configDir,
    runtimeDir
  };
}

function cleanupSandbox(sandbox) {
  try {
    rmSync(sandbox.profileRoot, { force: true, recursive: true });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOTEMPTY" ||
        error.code === "EBUSY" ||
        error.code === "EPERM")
    ) {
      return;
    }
    throw error;
  }
}

function trimLog(log) {
  return log.length > MAX_LOG_CHARS ? log.slice(-MAX_LOG_CHARS) : log;
}

export function hasDevSmokeReadySignal(log) {
  const mainStarted = log.includes("start electron app...");
  const rendererConnected =
    log.includes("[main:window] did-finish-load") ||
    log.includes("[renderer:debug]") ||
    log.includes("[renderer:info]") ||
    log.includes("[renderer:warning]");
  const ptyReady =
    log.includes('"kind":"osc.shell-ready"') ||
    log.includes("pty-host.osc.shell-ready");

  return mainStarted && (rendererConnected || ptyReady);
}

export function resolveDevSmokeTimeoutMs(env = process.env) {
  const configuredTimeout = Number(env.KMUX_DEV_SMOKE_TIMEOUT_MS);
  if (Number.isFinite(configuredTimeout) && configuredTimeout > 0) {
    return configuredTimeout;
  }
  return DEFAULT_SMOKE_TIMEOUT_MS;
}

export function parsePosixProcessTable(output) {
  return output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u);
    if (!match) {
      return [];
    }
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        command: match[4]
      }
    ];
  });
}

export function resolveOwnedPosixProcessIds(
  rows,
  { rootPid, ownerMarkers, selfPid = process.pid }
) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const owned = new Set(rootPid ? [rootPid] : []);

  for (const row of rows) {
    if (ownerMarkers.some((marker) => row.command.includes(marker))) {
      let current = row;
      while (current && current.pid > 1 && current.pid !== selfPid) {
        owned.add(current.pid);
        current = byPid.get(current.ppid);
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!owned.has(row.ppid) || owned.has(row.pid)) {
        continue;
      }
      owned.add(row.pid);
      changed = true;
    }
  }

  owned.delete(selfPid);
  return Array.from(owned);
}

function readPosixProcessTable() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], {
    encoding: "utf8"
  });
  return result.status === 0 ? parsePosixProcessTable(result.stdout ?? "") : [];
}

function signalProcess(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Ignore processes that exited between discovery and signaling.
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateSmokeProcesses(child, sandbox) {
  if (!child.pid) {
    return;
  }

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", `${child.pid}`, "/t", "/f"], {
      stdio: "ignore"
    });
    await new Promise((resolve) => killer.once("exit", resolve));
    return;
  }

  const rows = readPosixProcessTable();
  const ownedPids = resolveOwnedPosixProcessIds(rows, {
    rootPid: child.pid,
    ownerMarkers: [sandbox.profileRoot]
  });

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore cleanup races
    }
  }

  for (const pid of ownedPids) {
    signalProcess(pid, "SIGTERM");
  }

  const deadline = Date.now() + PROCESS_EXIT_GRACE_MS;
  let remaining = ownedPids.filter(isProcessAlive);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    remaining = remaining.filter(isProcessAlive);
  }
  for (const pid of remaining) {
    signalProcess(pid, "SIGKILL");
  }
}

async function main() {
  const sandbox = createSandbox();
  const command = commandForNpm();
  const output = [];
  const smokeTimeoutMs = resolveDevSmokeTimeoutMs();

  const child = spawn(command, ["run", "dev"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CI: "1",
      KMUX_E2E_DISABLE_QUIT_CONFIRM:
        process.env.KMUX_E2E_DISABLE_QUIT_CONFIRM ?? "1",
      KMUX_DEV_SMOKE: "1",
      KMUX_DISABLE_SHELL_ENV_PROBE:
        process.env.KMUX_DISABLE_SHELL_ENV_PROBE ?? "1",
      KMUX_CONFIG_DIR: sandbox.configDir,
      KMUX_RUNTIME_DIR: sandbox.runtimeDir
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });

  const cleanup = async () => {
    await terminateSmokeProcesses(child, sandbox);
    cleanupSandbox(sandbox);
  };

  const append = (chunk) => {
    const text = chunk.toString();
    output.push(text);
    const combined = output.join("");

    if (FAILURE_PATTERNS.some((pattern) => pattern.test(combined))) {
      throw new Error(
        `dev smoke matched a failure pattern\n\n${trimLog(combined)}`
      );
    }

    if (hasDevSmokeReadySignal(combined)) {
      return true;
    }

    return false;
  };

  let resolved = false;

  await new Promise((resolve, reject) => {
    let finished = false;
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `timed out after ${smokeTimeoutMs}ms waiting for npm run dev smoke to launch the app\n\n${trimLog(output.join(""))}`
        )
      );
    }, smokeTimeoutMs);

    const finish = (error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", finish);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const onExit = (code, signal) => {
      if (!resolved) {
        finish(
          new Error(
            `npm run dev exited before the app became ready (code=${code ?? "null"}, signal=${signal ?? "null"})\n\n${trimLog(output.join(""))}`
          )
        );
      }
    };

    const onData = async (chunk) => {
      if (resolved) {
        return;
      }
      try {
        if (append(chunk)) {
          resolved = true;
          setTimeout(() => finish(), SUCCESS_SETTLE_MS);
        }
      } catch (error) {
        finish(error);
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
    child.on("error", finish);
  }).finally(cleanup);

  process.stdout.write(
    "dev smoke passed: npm run dev launched the Electron app\n"
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}

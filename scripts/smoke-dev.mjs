import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

const SMOKE_TIMEOUT_MS = 30_000;
const SUCCESS_SETTLE_MS = 1_500;
const MAX_LOG_CHARS = 20_000;

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

function killProcessTree(child) {
  if (!child.pid) {
    return;
  }

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", `${child.pid}`, "/t", "/f"], {
      stdio: "ignore"
    });
    killer.unref();
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore cleanup races
    }
  }
}

async function main() {
  const sandbox = createSandbox();
  const command = commandForNpm();
  const output = [];

  const child = spawn(command, ["run", "dev"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CI: "1",
      KMUX_CONFIG_DIR: sandbox.configDir,
      KMUX_RUNTIME_DIR: sandbox.runtimeDir
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });

  const cleanup = () => {
    killProcessTree(child);
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

    const mainStarted = combined.includes("start electron app...");
    const rendererConnected =
      combined.includes("[renderer:debug]") ||
      combined.includes("[renderer:info]") ||
      combined.includes("[renderer:warning]");

    if (mainStarted && rendererConnected) {
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
          `timed out waiting for npm run dev smoke to launch the app\n\n${trimLog(output.join(""))}`
        )
      );
    }, SMOKE_TIMEOUT_MS);

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

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});

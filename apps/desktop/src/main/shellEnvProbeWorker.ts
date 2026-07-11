import type * as PtyModule from "node-pty";
import { isAbsolute } from "node:path";

import { loadNodePty } from "../pty-host/nodePtyLoader";
import {
  SHELL_ENV_PROBE_MAX_OUTPUT_BYTES,
  ShellEnvProbeOutputBuffer
} from "./shellEnvProbeOutput";

interface ShellEnvProbeWorkerRequest {
  type: "probe";
  shellPath: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

interface ShellEnvProbeWorkerResult {
  type: "result";
  stdout: string;
}

interface ShellEnvProbeWorkerStarted {
  type: "started";
  ptyPid: number;
}

interface ShellEnvProbeWorkerError {
  type: "error";
  message: string;
}

type ShellEnvProbeWorkerMessage =
  | ShellEnvProbeWorkerStarted
  | ShellEnvProbeWorkerResult
  | ShellEnvProbeWorkerError;

let activePty: PtyModule.IPty | null = null;

function cleanupActivePty(signal: NodeJS.Signals = "SIGTERM"): void {
  const pty = activePty;
  activePty = null;
  if (!pty) {
    return;
  }
  try {
    process.kill(-pty.pid, signal);
  } catch {
    try {
      process.kill(pty.pid, signal);
    } catch {
      // ignore
    }
  }
  try {
    pty.kill(signal);
  } catch {
    // ignore
  }
}

function sendAndExit(
  message: ShellEnvProbeWorkerMessage,
  exitCode: number
): void {
  cleanupActivePty();
  if (!process.send) {
    process.exit(exitCode);
  }

  process.send(message, (error) => {
    if (error) {
      process.stderr.write(`[shell-env-probe] ${error.message}\n`);
      process.exit(1);
      return;
    }
    process.exit(exitCode);
  });
}

async function runProbe(request: ShellEnvProbeWorkerRequest): Promise<string> {
  const pty = loadNodePty();
  const output = new ShellEnvProbeOutputBuffer();

  return await new Promise((resolve, reject) => {
    let settled = false;
    let spawnedPty: PtyModule.IPty;
    try {
      spawnedPty = pty.spawn(request.shellPath, request.args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: resolveProbeCwd(request),
        env: request.env
      });
      activePty = spawnedPty;
      sendWorkerMessage({ type: "started", ptyPid: spawnedPty.pid });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    spawnedPty.onData((chunk) => {
      if (settled || output.append(chunk)) {
        return;
      }
      settled = true;
      cleanupActivePty("SIGKILL");
      reject(
        new Error(
          `shell env PTY probe exceeded ${SHELL_ENV_PROBE_MAX_OUTPUT_BYTES} output bytes`
        )
      );
    });

    spawnedPty.onExit(({ exitCode, signal }) => {
      if (settled) {
        return;
      }
      settled = true;
      if (activePty === spawnedPty) {
        activePty = null;
      }
      if (exitCode === 0) {
        resolve(output.toString());
        return;
      }
      reject(
        new Error(
          `shell env PTY probe exited with code ${exitCode} and signal ${signal}`
        )
      );
    });
  });
}

function sendWorkerMessage(message: ShellEnvProbeWorkerMessage): void {
  if (!process.send || !process.connected) {
    return;
  }
  try {
    process.send(message, () => {
      // Parent-side timeout and disconnect handling own cleanup.
    });
  } catch {
    // The parent may have exited between the connected check and send.
  }
}

function resolveProbeCwd(request: ShellEnvProbeWorkerRequest): string {
  const requestedCwd = request.cwd?.trim();
  if (requestedCwd && isAbsolute(requestedCwd)) {
    return requestedCwd;
  }
  const homeDir = request.env.HOME?.trim();
  if (homeDir && isAbsolute(homeDir)) {
    return homeDir;
  }
  return process.cwd();
}

process.once("message", async (message: ShellEnvProbeWorkerRequest) => {
  if (!message || typeof message !== "object" || message.type !== "probe") {
    sendAndExit(
      {
        type: "error",
        message: "shell env PTY probe worker received an invalid request"
      },
      1
    );
    return;
  }

  try {
    const stdout = await runProbe(message);
    sendAndExit({ type: "result", stdout }, 0);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    sendAndExit({ type: "error", message: messageText }, 1);
  }
});

process.on("SIGTERM", () => {
  cleanupActivePty("SIGKILL");
  process.exit(1);
});

process.on("disconnect", () => {
  cleanupActivePty("SIGKILL");
  process.exit(1);
});

process.on("exit", () => {
  cleanupActivePty();
});

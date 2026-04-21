import type * as PtyModule from "node-pty";

import {loadNodePty} from "../pty-host/nodePtyLoader";

interface ShellEnvProbeWorkerRequest {
  type: "probe";
  shellPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

interface ShellEnvProbeWorkerResult {
  type: "result";
  stdout: string;
}

interface ShellEnvProbeWorkerError {
  type: "error";
  message: string;
}

type ShellEnvProbeWorkerMessage =
  | ShellEnvProbeWorkerResult
  | ShellEnvProbeWorkerError;

let activePty: PtyModule.IPty | null = null;

function cleanupActivePty(): void {
  if (!activePty) {
    return;
  }
  try {
    activePty.kill();
  } catch {
    // ignore
  }
  activePty = null;
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

async function runProbe(
  request: ShellEnvProbeWorkerRequest
): Promise<string> {
  const pty = loadNodePty();
  let output = "";

  return await new Promise((resolve, reject) => {
    try {
      activePty = pty.spawn(request.shellPath, request.args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: request.env.HOME ?? process.cwd(),
        env: request.env
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    activePty.onData((chunk) => {
      output += chunk;
    });

    activePty.onExit(({exitCode, signal}) => {
      const finishedOutput = output;
      activePty = null;
      if (exitCode === 0) {
        resolve(finishedOutput);
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
    sendAndExit({type: "result", stdout}, 0);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    sendAndExit({type: "error", message: messageText}, 1);
  }
});

process.on("SIGTERM", () => {
  cleanupActivePty();
  process.exit(1);
});

process.on("exit", () => {
  cleanupActivePty();
});

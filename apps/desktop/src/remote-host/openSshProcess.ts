import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio
} from "node:child_process";

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;
const TERMINATE_GRACE_MS = 2_000;
const HARD_MAX_COMMAND_TIMEOUT_MS = 15 * 60_000;
const HARD_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const HARD_MAX_INPUT_BYTES = 16 * 1024 * 1024;
const TERMINATE_FINAL_WAIT_MS = 2_000;

export type OpenSshProcessErrorCode =
  | "invalid-launch"
  | "spawn-failed"
  | "timed-out"
  | "output-limit"
  | "non-zero-exit";

export class OpenSshProcessError extends Error {
  readonly code: OpenSshProcessErrorCode;
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
  readonly stderr: string;

  constructor(
    code: OpenSshProcessErrorCode,
    message: string,
    options: {
      exitCode?: number;
      signal?: NodeJS.Signals;
      stderr?: string;
      cause?: unknown;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "OpenSshProcessError";
    this.code = code;
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    this.stderr = options.stderr ?? "";
  }
}

export interface OpenSshCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Uint8Array;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxInputBytes?: number;
  signal?: AbortSignal;
}

export interface OpenSshCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface EffectiveSshConfig {
  hostName: string;
  user: string;
  port: number;
  identityFiles: string[];
  proxyJump?: string;
  proxyCommand?: string;
  canonicalLines: string[];
  policyHash: string;
}

export async function assertSystemOpenSshExecutable(
  sshPath: string
): Promise<void> {
  if (!isAbsolute(sshPath)) {
    throw new OpenSshProcessError(
      "invalid-launch",
      "system OpenSSH path must be absolute"
    );
  }
  try {
    await access(sshPath, constants.X_OK);
    const stats = await stat(sshPath);
    if (!stats.isFile()) {
      throw new Error("resolved path is not a file");
    }
  } catch (error) {
    throw new OpenSshProcessError(
      "invalid-launch",
      `system OpenSSH executable is unavailable at ${sshPath}`,
      { cause: error }
    );
  }
}

export async function runOpenSshCommand(
  executable: string,
  args: readonly string[],
  options: OpenSshCommandOptions = {}
): Promise<OpenSshCommandResult> {
  const aggregateArgumentBytes = args.reduce(
    (bytes, argument) => bytes + Buffer.byteLength(argument),
    0
  );
  if (
    !isAbsolute(executable) ||
    args.length > 4_096 ||
    aggregateArgumentBytes > 1024 * 1024 ||
    args.some((arg) => arg.includes("\0"))
  ) {
    throw new OpenSshProcessError(
      "invalid-launch",
      "OpenSSH commands require an absolute executable and NUL-free arguments"
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > HARD_MAX_COMMAND_TIMEOUT_MS
  ) {
    throw new OpenSshProcessError(
      "invalid-launch",
      `OpenSSH command timeout must be within 1..${HARD_MAX_COMMAND_TIMEOUT_MS} ms`
    );
  }
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes <= 0 ||
    maxOutputBytes > HARD_MAX_OUTPUT_BYTES
  ) {
    throw new OpenSshProcessError(
      "invalid-launch",
      `OpenSSH command output limit must be within 1..${HARD_MAX_OUTPUT_BYTES} bytes`
    );
  }
  if (
    !Number.isSafeInteger(maxInputBytes) ||
    maxInputBytes <= 0 ||
    maxInputBytes > HARD_MAX_INPUT_BYTES
  ) {
    throw new OpenSshProcessError(
      "invalid-launch",
      `OpenSSH command input limit must be within 1..${HARD_MAX_INPUT_BYTES} bytes`
    );
  }
  const inputBytes =
    typeof options.input === "string"
      ? Buffer.byteLength(options.input)
      : (options.input?.byteLength ?? 0);
  if (inputBytes > maxInputBytes) {
    throw new OpenSshProcessError(
      "invalid-launch",
      `OpenSSH command input exceeds ${maxInputBytes} bytes`
    );
  }

  return await new Promise<OpenSshCommandResult>((resolve, reject) => {
    const spawnOptions: SpawnOptionsWithoutStdio = {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, [...args], spawnOptions);
    } catch (error) {
      reject(
        new OpenSshProcessError(
          "spawn-failed",
          "failed to start the system OpenSSH process",
          { cause: error }
        )
      );
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    let finalKillTimeout: NodeJS.Timeout | undefined;
    let terminationFailure: OpenSshProcessError | undefined;

    const finish = (
      error: OpenSshProcessError | null,
      result?: OpenSshCommandResult
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      if (finalKillTimeout) clearTimeout(finalKillTimeout);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result as OpenSshCommandResult);
    };

    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      forceKillTimeout ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        finalKillTimeout ??= setTimeout(() => {
          if (!terminationFailure) return;
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          finish(terminationFailure);
        }, TERMINATE_FINAL_WAIT_MS);
        finalKillTimeout.unref();
      }, TERMINATE_GRACE_MS);
      forceKillTimeout.unref();
    };

    const failAfterTermination = (error: OpenSshProcessError): void => {
      if (settled || terminationFailure) return;
      terminationFailure = error;
      terminate();
    };

    const timeout = setTimeout(() => {
      failAfterTermination(
        new OpenSshProcessError(
          "timed-out",
          `OpenSSH command exceeded ${timeoutMs} ms`,
          { stderr: Buffer.concat(stderr).toString("utf8") }
        )
      );
    }, timeoutMs);
    timeout.unref();

    const abort = (): void => {
      failAfterTermination(
        new OpenSshProcessError("timed-out", "OpenSSH command was aborted", {
          stderr: Buffer.concat(stderr).toString("utf8")
        })
      );
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (settled || terminationFailure) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        failAfterTermination(
          new OpenSshProcessError(
            "output-limit",
            `OpenSSH command exceeded ${maxOutputBytes} output bytes`,
            { stderr: Buffer.concat(stderr).toString("utf8") }
          )
        );
        return;
      }
      target.push(Buffer.from(chunk));
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    // A command can exit before consuming its bounded stdin. The child close
    // event remains the authoritative result; absorb the resulting EPIPE so it
    // cannot become an uncaught stream error in remote-host.
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => {
      const failure = new OpenSshProcessError(
        "spawn-failed",
        "failed to start the system OpenSSH process",
        { cause: error }
      );
      if (child.pid === undefined) finish(terminationFailure ?? failure);
      else failAfterTermination(terminationFailure ?? failure);
    });
    child.once("exit", () => {
      // `close` waits for stdio to close as well. A ProxyCommand or another
      // descendant can inherit those descriptors after the direct child has
      // been killed, so a failed bounded command must settle on process exit
      // instead of waiting indefinitely for unrelated descendants.
      if (terminationFailure) finish(terminationFailure);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      if (terminationFailure) {
        finish(terminationFailure);
        return;
      }
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (exitCode !== 0) {
        finish(
          new OpenSshProcessError(
            "non-zero-exit",
            `OpenSSH command exited with ${exitCode ?? signal ?? "unknown"}`,
            {
              exitCode: exitCode ?? undefined,
              signal: signal ?? undefined,
              stderr: stderrText
            }
          )
        );
        return;
      }
      finish(null, { stdout: stdoutText, stderr: stderrText, exitCode: 0 });
    });

    if (options.input === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(options.input);
    }
  });
}

export async function resolveEffectiveSshConfig(options: {
  sshPath: string;
  configPath: string;
  host: string;
  env?: NodeJS.ProcessEnv;
}): Promise<EffectiveSshConfig> {
  validateHostAlias(options.host);
  const result = await runOpenSshCommand(
    options.sshPath,
    ["-G", "-F", options.configPath, "--", options.host],
    { env: options.env, timeoutMs: 10_000, maxOutputBytes: 512 * 1024 }
  );
  const canonicalLines = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const values = new Map<string, string[]>();
  for (const line of canonicalLines) {
    const separator = line.indexOf(" ");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    const existing = values.get(key) ?? [];
    existing.push(value);
    values.set(key, existing);
  }

  const hostName = requiredConfigValue(values, "hostname");
  const user = requiredConfigValue(values, "user");
  const portText = requiredConfigValue(values, "port");
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new OpenSshProcessError(
      "non-zero-exit",
      `OpenSSH returned an invalid effective port: ${portText}`
    );
  }

  return {
    hostName,
    user,
    port,
    identityFiles: values.get("identityfile") ?? [],
    proxyJump: optionalConfiguredValue(values, "proxyjump"),
    proxyCommand: optionalConfiguredValue(values, "proxycommand"),
    canonicalLines,
    policyHash: createHash("sha256")
      .update(canonicalLines.join("\n"))
      .update("\n")
      .digest("hex")
  };
}

export function createOpenSshEnvironment(options: {
  baseEnv?: NodeJS.ProcessEnv;
  askpassPath?: string;
}): NodeJS.ProcessEnv {
  const env = { ...(options.baseEnv ?? process.env) };
  delete env.SSH_ASKPASS;
  env.SSH_ASKPASS_REQUIRE = "never";
  if (options.askpassPath) {
    if (
      !isAbsolute(options.askpassPath) ||
      options.askpassPath.length > 4_096 ||
      /[\0\r\n]/u.test(options.askpassPath)
    ) {
      throw new OpenSshProcessError(
        "invalid-launch",
        "SSH_ASKPASS helper path must be absolute and bounded"
      );
    }
    env.SSH_ASKPASS = options.askpassPath;
    env.SSH_ASKPASS_REQUIRE = "force";
    env.DISPLAY = env.DISPLAY || "kmux-askpass:0";
  }
  return env;
}

function requiredConfigValue(
  values: ReadonlyMap<string, readonly string[]>,
  key: string
): string {
  const value = values.get(key)?.[0];
  if (!value) {
    throw new OpenSshProcessError(
      "non-zero-exit",
      `OpenSSH effective configuration omitted ${key}`
    );
  }
  return value;
}

function optionalConfiguredValue(
  values: ReadonlyMap<string, readonly string[]>,
  key: string
): string | undefined {
  const value = values.get(key)?.[0];
  return value && value !== "none" ? value : undefined;
}

export function validateHostAlias(host: string): void {
  if (
    host.length === 0 ||
    host.length > 512 ||
    host.startsWith("-") ||
    /[\0\r\n]/u.test(host)
  ) {
    throw new OpenSshProcessError(
      "invalid-launch",
      "OpenSSH host alias is empty, option-like, or contains a control character"
    );
  }
}

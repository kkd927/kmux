import { lstat } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import {
  createOpenSshEnvironment,
  OpenSshProcessError,
  validateHostAlias
} from "./openSshProcess";

const MUX_ONLY_OPTIONS = [
  "ControlMaster=no",
  "ControlPersist=no",
  "BatchMode=yes",
  "NumberOfPasswordPrompts=0",
  "PasswordAuthentication=no",
  "KbdInteractiveAuthentication=no"
] as const;

export type MuxOnlyChannelKind =
  | "control"
  | "terminal"
  | "metadata"
  | "sftp"
  | "local-forward"
  | "dynamic-forward";

export interface MuxOnlyChannelBase {
  kind: MuxOnlyChannelKind;
  sshPath: string;
  sftpPath?: string;
  configPath: string;
  controlPath: string;
  fallbackGuardPath?: string;
  host: string;
  masterGeneration: string;
  env?: NodeJS.ProcessEnv;
}

export type MuxOnlyChannelRequest =
  | (MuxOnlyChannelBase & {
      kind: "control" | "metadata";
      remoteCommand: string;
    })
  | (MuxOnlyChannelBase & {
      kind: "terminal";
      remoteCommand?: string;
    })
  | (MuxOnlyChannelBase & {
      kind: "sftp";
      batchMode?: boolean;
    })
  | (MuxOnlyChannelBase & {
      kind: "local-forward";
      localBindHost: string;
      localPort: number;
      remoteHost: string;
      remotePort: number;
    })
  | (MuxOnlyChannelBase & {
      kind: "dynamic-forward";
      localBindHost: string;
      localPort: number;
    });

export interface MuxOnlyLaunch {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  kind: MuxOnlyChannelKind;
  masterGeneration: string;
}

export interface SpawnMuxOnlyChannelOptions {
  stdio?: SpawnOptions["stdio"];
  isCurrentGeneration: (generation: string) => boolean;
}

export async function buildMuxOnlyLaunch(
  request: MuxOnlyChannelRequest
): Promise<MuxOnlyLaunch> {
  validateBaseRequest(request);
  await assertPrivateControlSocket(request.controlPath);

  const fallbackGuardPath = request.fallbackGuardPath ?? "/usr/bin/false";
  if (
    !isAbsolute(fallbackGuardPath) ||
    fallbackGuardPath.length > 4_096 ||
    /[\0\r\n]/u.test(fallbackGuardPath)
  ) {
    throw new OpenSshProcessError(
      "invalid-launch",
      "mux fallback guard path must be absolute and bounded"
    );
  }
  const commonArgs = [
    "-F",
    request.configPath,
    "-S",
    request.controlPath,
    ...MUX_ONLY_OPTIONS.flatMap((option) => ["-o", option]),
    "-o",
    `ProxyCommand=exec ${quoteOpenSshCommandWord(fallbackGuardPath)}`
  ];

  const env = createOpenSshEnvironment({ baseEnv: request.env });
  switch (request.kind) {
    case "control":
    case "metadata":
      validateRemoteCommand(request.remoteCommand);
      return {
        executable: request.sshPath,
        args: [...commonArgs, "--", request.host, request.remoteCommand],
        env,
        kind: request.kind,
        masterGeneration: request.masterGeneration
      };
    case "terminal":
      if (request.remoteCommand) validateRemoteCommand(request.remoteCommand);
      return {
        executable: request.sshPath,
        args: [
          ...commonArgs,
          // The remote keeper owns the real PTY. This channel is a binary
          // proxy and must never let OpenSSH allocate or transform a TTY.
          "-T",
          "--",
          request.host,
          ...(request.remoteCommand === undefined
            ? []
            : [request.remoteCommand])
        ],
        env,
        kind: request.kind,
        masterGeneration: request.masterGeneration
      };
    case "sftp": {
      const sftpPath = request.sftpPath ?? "/usr/bin/sftp";
      if (!isAbsolute(sftpPath)) {
        throw new OpenSshProcessError(
          "invalid-launch",
          "system SFTP path must be absolute"
        );
      }
      return {
        executable: sftpPath,
        args: [
          "-F",
          request.configPath,
          "-S",
          request.sshPath,
          ...MUX_ONLY_OPTIONS.flatMap((option) => ["-o", option]),
          "-o",
          `ControlPath=${request.controlPath}`,
          "-o",
          `ProxyCommand=exec ${quoteOpenSshCommandWord(fallbackGuardPath)}`,
          ...(request.batchMode === false ? [] : ["-b", "-"]),
          "--",
          request.host
        ],
        env,
        kind: request.kind,
        masterGeneration: request.masterGeneration
      };
    }
    case "local-forward":
      validateForwardPort(request.localPort);
      validateForwardPort(request.remotePort);
      return {
        executable: request.sshPath,
        args: [
          ...commonArgs,
          "-N",
          "-o",
          "ExitOnForwardFailure=yes",
          "-L",
          `${formatLoopbackBindHost(request.localBindHost)}:${request.localPort}:${formatForwardHost(request.remoteHost)}:${request.remotePort}`,
          "--",
          request.host
        ],
        env,
        kind: request.kind,
        masterGeneration: request.masterGeneration
      };
    case "dynamic-forward":
      validateForwardPort(request.localPort);
      return {
        executable: request.sshPath,
        args: [
          ...commonArgs,
          "-N",
          "-o",
          "ExitOnForwardFailure=yes",
          "-D",
          `${formatLoopbackBindHost(request.localBindHost)}:${request.localPort}`,
          "--",
          request.host
        ],
        env,
        kind: request.kind,
        masterGeneration: request.masterGeneration
      };
  }
}

export async function spawnMuxOnlyChannel(
  request: MuxOnlyChannelRequest,
  options: SpawnMuxOnlyChannelOptions
): Promise<ChildProcess> {
  const launch = await buildMuxOnlyLaunch(request);
  if (!options.isCurrentGeneration(launch.masterGeneration)) {
    throw new OpenSshProcessError(
      "invalid-launch",
      "assigned SSH master generation changed before channel launch"
    );
  }

  let child: ChildProcess;
  try {
    child = spawn(launch.executable, launch.args, {
      env: launch.env,
      stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
  } catch (error) {
    throw new OpenSshProcessError(
      "spawn-failed",
      `failed to start mux-only ${launch.kind} channel`,
      { cause: error }
    );
  }
  await new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      reject(
        new OpenSshProcessError(
          "spawn-failed",
          `failed to start mux-only ${launch.kind} channel`,
          { cause: error }
        )
      );
    });
    child.once("spawn", () => resolve());
  });
  if (!options.isCurrentGeneration(launch.masterGeneration)) {
    await terminateSpawnedChannel(child);
    throw new OpenSshProcessError(
      "invalid-launch",
      "assigned SSH master generation changed during channel launch"
    );
  }
  return child;
}

export async function assertPrivateControlSocket(
  controlPath: string
): Promise<void> {
  if (!isAbsolute(controlPath)) {
    throw new OpenSshProcessError(
      "invalid-launch",
      "ControlPath must be absolute"
    );
  }
  const directoryPath = dirname(controlPath);
  const [directory, socket] = await Promise.all([
    lstat(directoryPath),
    lstat(controlPath)
  ]).catch((error: unknown) => {
    throw new OpenSshProcessError(
      "invalid-launch",
      "assigned ControlPath is unavailable",
      { cause: error }
    );
  });
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o077) !== 0
  ) {
    throw new OpenSshProcessError(
      "invalid-launch",
      "ControlPath directory is not a private, real directory"
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && directory.uid !== uid) {
    throw new OpenSshProcessError(
      "invalid-launch",
      "ControlPath directory has the wrong owner"
    );
  }
  if (!socket.isSocket() || socket.isSymbolicLink()) {
    throw new OpenSshProcessError(
      "invalid-launch",
      "ControlPath is not a Unix-domain socket"
    );
  }
  if ((socket.mode & 0o077) !== 0) {
    throw new OpenSshProcessError(
      "invalid-launch",
      "ControlPath socket is not private"
    );
  }
  if (uid !== undefined && socket.uid !== uid) {
    throw new OpenSshProcessError(
      "invalid-launch",
      "ControlPath socket has the wrong owner"
    );
  }
}

function validateBaseRequest(request: MuxOnlyChannelRequest): void {
  validateHostAlias(request.host);
  for (const [label, value] of [
    ["sshPath", request.sshPath],
    ["configPath", request.configPath],
    ["controlPath", request.controlPath]
  ] as const) {
    if (!isAbsolute(value)) {
      throw new OpenSshProcessError(
        "invalid-launch",
        `${label} must be absolute`
      );
    }
  }
  if (
    request.masterGeneration.length === 0 ||
    request.masterGeneration.length > 512 ||
    /[\0\r\n]/u.test(request.masterGeneration)
  ) {
    throw new OpenSshProcessError(
      "invalid-launch",
      "master generation is invalid"
    );
  }
}

function validateRemoteCommand(command: string): void {
  if (
    command.length === 0 ||
    command.length > 64 * 1024 ||
    /[\0\r\n]/u.test(command)
  ) {
    throw new OpenSshProcessError(
      "invalid-launch",
      "remote command must be a bounded, fixed NUL/newline-free command"
    );
  }
}

function formatForwardHost(host: string): string {
  if (
    host.length === 0 ||
    host.length > 255 ||
    /[\0\r\n,\s]/u.test(host) ||
    host.includes("[") ||
    host.includes("]")
  ) {
    throw new OpenSshProcessError(
      "invalid-launch",
      "forward host/port is invalid"
    );
  }
  if (host.includes(":")) {
    if (isIP(host) !== 6) {
      throw new OpenSshProcessError(
        "invalid-launch",
        "forward host/port is invalid"
      );
    }
    return `[${host}]`;
  }
  return host;
}

function formatLoopbackBindHost(host: string): string {
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new OpenSshProcessError(
      "invalid-launch",
      "forward bind address must be an explicit loopback address"
    );
  }
  return formatForwardHost(host);
}

function validateForwardPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new OpenSshProcessError(
      "invalid-launch",
      "forward host/port is invalid"
    );
  }
}

async function terminateSpawnedChannel(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    closed.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000))
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      closed,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000))
    ]);
  }
}

function quoteOpenSshCommandWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

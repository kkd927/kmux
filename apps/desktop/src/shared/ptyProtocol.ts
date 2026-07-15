import type {
  Id,
  SessionLaunchConfig,
  SurfaceExitPayload,
  SurfaceMetadataPayload,
  SurfaceSnapshotPayload,
  TerminalSessionRef,
  TerminalKeyInput,
  TerminalNotificationProtocol
} from "@kmux/proto";
import type { DiagnosticsRecord } from "./diagnostics";

export type ShellIntegrationMode = "none" | "posix-wrapper";
export type ShellPolicyPlatform =
  | "aix"
  | "android"
  | "darwin"
  | "freebsd"
  | "haiku"
  | "linux"
  | "openbsd"
  | "sunos"
  | "win32"
  | "cygwin"
  | "netbsd";

export interface ShellLaunchPolicy {
  defaultShellPath: string;
  defaultShellArgs: string[];
  stripManagedEnv: boolean;
  integration: {
    enabled: boolean;
    mode: ShellIntegrationMode;
  };
  agentPath: {
    helperBinDir: string;
    wrapperBinDir: string;
    prependWrapperToPath: boolean;
  };
  hookEnv: ShellLaunchHookEnv;
}

export interface ShellLaunchHookEnv extends Record<string, string> {
  KMUX_SOCKET_PATH: string;
  KMUX_AGENT_BIN_DIR: string;
  KMUX_NODE_PATH: string;
}

export interface DesktopPtySpawnRequest {
  type: "spawn";
  spec: PtySessionSpec;
  shellLaunchPolicy: ShellLaunchPolicy;
}

export interface PtySessionSpec {
  sessionId: Id;
  surfaceId: Id;
  runtimeEpoch: Id;
  workspaceId: Id;
  launch: SessionLaunchConfig;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export type PtyRequest =
  | DesktopPtySpawnRequest
  | { type: "shutdown"; requestId: Id }
  | { type: "diagnostics.configure"; requestId: Id; logPath?: string }
  | { type: "diagnostics.flush"; requestId: Id }
  | {
      type: "stream.bind";
      attachId: Id;
      session: TerminalSessionRef;
    }
  | { type: "close"; sessionId: Id }
  | { type: "input:text"; sessionId: Id; text: string }
  | { type: "input:key"; sessionId: Id; input: TerminalKeyInput }
  | {
      type: "snapshot";
      sessionId: Id;
      surfaceId: Id;
      requestId: Id;
      settleForMs?: number;
      includeRawOutputTail?: boolean;
    };

export type PtyEvent =
  | { type: "ready" }
  | { type: "shutdown:ack"; requestId: Id }
  | { type: "diagnostics.batch"; records: DiagnosticsRecord[] }
  | {
      type: "diagnostics.configured";
      requestId: Id;
      enabled: boolean;
    }
  | { type: "diagnostics.flushed"; requestId: Id }
  | {
      type: "spawned";
      sessionId: Id;
      pid: number;
      shellInputReady: boolean;
    }
  | {
      type: "shell.ready";
      sessionId: Id;
      surfaceId: Id;
    }
  | {
      type: "snapshot";
      requestId: Id;
      payload: SurfaceSnapshotPayload | null;
    }
  | {
      type: "input.observed";
      session: TerminalSessionRef;
      input:
        | { type: "text"; text: string }
        | { type: "binary"; data: string }
        | { type: "key"; input: TerminalKeyInput };
    }
  | { type: "runtime.lost"; sessions: TerminalSessionRef[] }
  | { type: "metadata"; payload: SurfaceMetadataPayload }
  | { type: "bell"; surfaceId: Id; sessionId: Id; title: string; cwd?: string }
  | {
      type: "terminal.notification";
      surfaceId: Id;
      sessionId: Id;
      protocol: TerminalNotificationProtocol;
      title?: string;
      message?: string;
    }
  | { type: "exit"; payload: SurfaceExitPayload }
  | { type: "error"; sessionId?: Id; message: string };

export function resolveDefaultShellArgs(
  shellPath: string | undefined,
  platform: ShellPolicyPlatform
): string[] {
  if (platform !== "darwin" || !shellPath) {
    return [];
  }

  switch (shellBasename(shellPath).toLowerCase()) {
    case "zsh":
    case "sh":
    case "fish":
      return ["-l"];
    case "bash":
      return ["--login"];
    case "pwsh":
    case "pwsh.exe":
      return ["-Login"];
    default:
      return [];
  }
}

export function shouldStripShellManagedEnv(
  shellPath: string | undefined,
  launchArgs: string[] | undefined,
  platform: ShellPolicyPlatform
): boolean {
  return (
    platform === "darwin" &&
    launchArgs === undefined &&
    resolveDefaultShellArgs(shellPath, platform).length > 0
  );
}

export function shouldApplyShellIntegration(
  shellPath: string | undefined,
  launchArgs: string[] | undefined,
  platform: ShellPolicyPlatform
): boolean {
  if (platform !== "darwin" || launchArgs !== undefined || !shellPath) {
    return false;
  }
  if (!isSupportedIntegrationShell(shellPath)) {
    return false;
  }
  return resolveDefaultShellArgs(shellPath, platform).length > 0;
}

export function resolvePolicyShellPath(
  policy: ShellLaunchPolicy,
  launch: SessionLaunchConfig
): string {
  return launch.shell?.trim() || policy.defaultShellPath;
}

export function resolvePolicyShellArgs(
  policy: ShellLaunchPolicy,
  launch: SessionLaunchConfig
): string[] {
  return launch.args ?? policy.defaultShellArgs;
}

function isSupportedIntegrationShell(shellPath: string): boolean {
  switch (shellBasename(shellPath).toLowerCase()) {
    case "zsh":
    case "bash":
    case "fish":
      return true;
    default:
      return false;
  }
}

function shellBasename(shellPath: string): string {
  const parts = shellPath
    .trim()
    .split(/[\\/]+/)
    .filter(Boolean);
  return parts.at(-1) ?? "";
}

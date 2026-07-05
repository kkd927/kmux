import type {
  Id,
  SessionLaunchConfig,
  SurfaceChunkPayload,
  SurfaceExitPayload,
  SurfaceMetadataPayload,
  SurfaceResizePayload,
  SurfaceSnapshotPayload,
  TerminalKeyInput,
  TerminalNotificationProtocol
} from "@kmux/proto";

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
  workspaceId: Id;
  launch: SessionLaunchConfig;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export type PtyRequest =
  | DesktopPtySpawnRequest
  | { type: "close"; sessionId: Id }
  | {
      type: "resize";
      sessionId: Id;
      cols: number;
      rows: number;
      attachId?: Id;
      requestId?: Id;
      // True while the renderer knows a resize gesture (divider/sidebar
      // drag) is still active: the PTY commit is held until the gesture
      // ends so mid-drag pauses can't leak SIGWINCHes to the app.
      gestureActive?: boolean;
    }
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
  | { type: "snapshot"; requestId: Id; payload: SurfaceSnapshotPayload }
  | { type: "chunk"; payload: SurfaceChunkPayload }
  | { type: "resize"; payload: SurfaceResizePayload }
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
  | {
      type: "resize:ack";
      sessionId: Id;
      requestId: Id;
      cols: number;
      rows: number;
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
  const parts = shellPath.trim().split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? "";
}

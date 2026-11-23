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

/**
 * Desktop platform shell behavior before the user has supplied launch args.
 * Keep this data-only so the common policy builder, rather than platform
 * conditionals, owns the per-session shell decision.
 */
export interface ShellLaunchProfile {
  defaultArgs: "none" | "login";
  stripManagedEnv: boolean;
  integrationMode: ShellIntegrationMode;
}

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
    cliBinDir?: string;
    prependWrapperToPath: boolean;
  };
  hookEnv: ShellLaunchHookEnv;
}

export interface ShellLaunchHookEnv extends Record<string, string> {
  KMUX_AGENT_HOOK_TRANSPORT: "local";
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
  historyOnly?: { exitCode?: number };
  /** Prior display contents only; never sent to the new PTY child. */
  restoredOutput?: { vt: string; cols: number; rows: number };
}

export interface PtyGenerationRef {
  sessionId: Id;
  surfaceId: Id;
  runtimeEpoch: Id;
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
  | {
      type: "close";
      sessionId: Id;
      surfaceId?: Id;
      expectedRuntimeEpoch?: Id;
      preserveIfDirectInputAfter?: string;
      requestId?: Id;
    }
  | { type: "input:text"; sessionId: Id; text: string }
  | { type: "input:key"; sessionId: Id; input: TerminalKeyInput }
  | {
      type: "agent.readiness.register";
      requestId: Id;
      session: PtyGenerationRef;
      authorityRef: Id;
      receiptId: Id;
      agentId: Id;
      agentInstanceId: Id;
      readyEpoch: Id;
    }
  | {
      type: "input:orchestrated";
      requestId: Id;
      session: PtyGenerationRef;
      authorityRef: Id;
      readinessReceiptId: Id;
      readyEpoch: Id;
      operationId: Id;
      payloadHash: string;
      text: string;
      verificationText: string;
      encoding?: "orchestration-result-json";
    }
  | {
      type: "input:delivery.query";
      requestId: Id;
      session: PtyGenerationRef;
      operationId: Id;
      payloadHash: string;
    }
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
  | { type: "history.ready"; sessionId: Id }
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
  | {
      type: "agent.readiness.ack";
      requestId: Id;
      session: PtyGenerationRef;
      outcome: "registered" | "fenced" | "generation-mismatch";
      receiptId: Id;
    }
  | {
      type: "input.delivery.ack";
      requestId: Id;
      session: PtyGenerationRef;
      operationId: Id;
      payloadHash: string;
      outcome:
        | "written"
        | "conflict"
        | "fenced"
        | "generation-mismatch"
        | "unknown";
      replay: boolean;
    }
  | {
      type: "input.delivery.status";
      requestId: Id;
      session: PtyGenerationRef;
      operationId: Id;
      payloadHash: string;
      outcome:
        | "not-seen"
        | "written"
        | "conflict"
        | "unknown"
        | "generation-mismatch";
    }
  | { type: "runtime.lost"; sessions: TerminalSessionRef[] }
  | {
      type: "orchestration.command.exit";
      operationId: Id;
      session: PtyGenerationRef;
      exitCode: number;
      output: string;
      outputBytes: number;
      truncated: boolean;
    }
  | {
      type: "close.ack";
      requestId: Id;
      sessionId: Id;
      surfaceId?: Id;
      runtimeEpoch?: Id;
      outcome:
        | "terminated"
        | "already-exited"
        | "generation-mismatch"
        | "input-observed";
    }
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
  profile: ShellLaunchProfile
): string[] {
  if (profile.defaultArgs !== "login" || !shellPath) {
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
  profile: ShellLaunchProfile
): boolean {
  return (
    profile.stripManagedEnv &&
    launchArgs === undefined &&
    resolveDefaultShellArgs(shellPath, profile).length > 0
  );
}

export function shouldApplyShellIntegration(
  shellPath: string | undefined,
  launchArgs: string[] | undefined,
  profile: ShellLaunchProfile
): boolean {
  if (
    profile.integrationMode !== "posix-wrapper" ||
    launchArgs !== undefined ||
    !shellPath
  ) {
    return false;
  }
  if (!isSupportedIntegrationShell(shellPath)) {
    return false;
  }
  return true;
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

import type {
  AgentSessionRef,
  AppAction,
  AppState,
  StoredSessionLaunchConfig,
  WorkspaceTarget
} from "@kmux/core";
import type {
  ExternalAgentSessionRef,
  ExternalAgentSessionResumeRequest,
  ExternalAgentSessionResumeResult,
  SessionLaunchConfig
} from "@kmux/proto";

import { logDiagnostics } from "../shared/diagnostics";
import type { ExternalSessionResumeSpec } from "./externalSessions";
import type { SshReconnectCoordinator } from "./remote/sshReconnectCoordinator";
import type { SshWorkspaceCreationRuntime } from "./remote/sshWorkspaceCreationRuntime";

export interface ExternalSessionResumeRuntime {
  resume(
    request: ExternalAgentSessionResumeRequest
  ): Promise<ExternalAgentSessionResumeResult>;
}

export class ExternalSessionConnectionError extends Error {
  constructor(cause: Error) {
    super(
      `Could not connect to the SSH target. No workspace was created: ${cause.message}`
    );
    this.name = "ExternalSessionConnectionError";
    this.cause = cause;
  }
}

export class ExternalSessionLaunchError extends Error {
  readonly result: ExternalAgentSessionResumeResult;

  constructor(result: ExternalAgentSessionResumeResult, message: string) {
    super(
      `The SSH workspace was created, but the session resume command did not complete: ${message}`
    );
    this.name = "ExternalSessionLaunchError";
    this.result = result;
  }
}

export function createExternalSessionResumeRuntime(options: {
  resolveExternalAgentSession: (
    key: string
  ) => ExternalSessionResumeSpec | null;
  getState: () => AppState;
  dispatchAppAction: (action: AppAction) => void;
  defaultShellPath: string;
  sshReconnect: SshReconnectCoordinator;
  sshCreator: SshWorkspaceCreationRuntime;
}): ExternalSessionResumeRuntime {
  const inFlight = new Map<string, Promise<ExternalAgentSessionResumeResult>>();

  const resumeNow = async (
    request: ExternalAgentSessionResumeRequest
  ): Promise<ExternalAgentSessionResumeResult> => {
    const { key, destinationWindowId } =
      decodeExternalAgentSessionResumeRequest(request);
    const spec = options.resolveExternalAgentSession(key);
    if (!spec) throw new Error("External session not found");
    const targetLabel =
      spec.target.kind === "local" ? "local" : spec.target.targetId;
    const logStage = (stage: string): void => {
      logDiagnostics("main.external-session.resume", {
        sessionKey: spec.key,
        vendor: spec.vendor,
        target: targetLabel,
        stage
      });
    };
    logStage("resolved");

    const existing = findOpenExternalAgentSession(
      options.getState(),
      spec,
      options.defaultShellPath
    );
    if (existing) {
      if (spec.target.kind === "ssh") {
        logStage("existing-reconnect");
        try {
          await options.sshReconnect.ensureTargetConnected(
            spec.target.targetId,
            "session-resume"
          );
        } catch (error) {
          throw new ExternalSessionConnectionError(toError(error));
        }
      }
      options.dispatchAppAction({
        type: "surface.focus",
        surfaceId: existing.surfaceId
      });
      logStage("existing-focused");
      return existing;
    }

    if (spec.target.kind === "local") {
      options.dispatchAppAction({
        type: "workspace.create",
        name: spec.title,
        cwd: spec.cwd,
        target: spec.target,
        launch: spec.launch,
        agentSessionRef: spec.agentSessionRef
      });
      const result = activeSurfaceResult(options.getState());
      logStage("local-created");
      return result;
    }

    if (!options.getState().windows[destinationWindowId]) {
      throw new Error("External session destination window no longer exists");
    }
    let activeTarget;
    try {
      logStage("connecting");
      activeTarget = await options.sshReconnect.ensureTargetConnected(
        spec.target.targetId,
        "session-resume"
      );
    } catch (error) {
      logStage("connection-failed");
      throw new ExternalSessionConnectionError(toError(error));
    }

    logStage("creating");
    let created;
    try {
      created = await options.sshCreator.create({
        kind: "create-new",
        destinationWindowId,
        target: activeTarget,
        workspaceName: spec.title,
        launch: spec.launch,
        agentSessionRef: spec.agentSessionRef,
        ...(spec.launch.initialInput === undefined
          ? {}
          : { initialInput: spec.launch.initialInput })
      });
    } catch (error) {
      const preserved = findOpenExternalAgentSession(
        options.getState(),
        spec,
        options.defaultShellPath
      );
      if (preserved) {
        options.dispatchAppAction({
          type: "surface.focus",
          surfaceId: preserved.surfaceId
        });
        logStage("resume-admission-failed");
        throw new ExternalSessionLaunchError(preserved, toError(error).message);
      }
      logStage("creation-failed");
      throw error;
    }
    const result = {
      workspaceId: created.workspaceId,
      surfaceId: created.surfaceId
    };
    options.dispatchAppAction({
      type: "surface.focus",
      surfaceId: created.surfaceId
    });
    const outcome = created.resumeInputResult?.outcome;
    if (outcome?.status === "failed") {
      logStage("resume-failed");
      throw new ExternalSessionLaunchError(result, outcome.message);
    }
    if (outcome?.status === "pending") {
      logStage("resume-pending");
      throw new ExternalSessionLaunchError(
        result,
        "it is pending and will retry after SSH reconnects"
      );
    }
    logStage("created");
    return result;
  };

  return Object.freeze({
    resume(
      request: ExternalAgentSessionResumeRequest
    ): Promise<ExternalAgentSessionResumeResult> {
      const { key } = decodeExternalAgentSessionResumeRequest(request);
      const current = inFlight.get(key);
      if (current) return current;
      const attempt = resumeNow(request);
      inFlight.set(key, attempt);
      void attempt
        .finally(() => {
          if (inFlight.get(key) === attempt) inFlight.delete(key);
        })
        .catch(() => undefined);
      return attempt;
    }
  });
}

export function decodeExternalAgentSessionResumeRequest(
  value: unknown
): ExternalAgentSessionResumeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("external session resume request must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = new Set(["key", "destinationWindowId"]);
  const unexpected = Object.keys(record).find((key) => !expected.has(key));
  if (
    unexpected ||
    typeof record.key !== "string" ||
    record.key.length === 0 ||
    record.key.length > 4 * 1024 ||
    typeof record.destinationWindowId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(
      record.destinationWindowId
    )
  ) {
    throw new TypeError("external session resume request is invalid");
  }
  return {
    key: record.key,
    destinationWindowId: record.destinationWindowId
  };
}

function findOpenExternalAgentSession(
  state: AppState,
  spec: ExternalSessionResumeSpec,
  defaultShellPath: string
): ExternalAgentSessionResumeResult | null {
  for (const session of Object.values(state.sessions)) {
    if (session.runtimeStatus.processState === "exited") continue;
    const refMatches = externalAgentSessionRefsMatch(
      session.agentSessionRef,
      spec.agentSessionRef
    );
    if (
      !refMatches &&
      (session.agentSessionRef !== undefined ||
        !launchCommandsMatch(
          session.launch,
          spec.launch,
          state.settings.shell || defaultShellPath
        ))
    ) {
      continue;
    }
    const surface = state.surfaces[session.surfaceId];
    const pane = surface ? state.panes[surface.paneId] : undefined;
    const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
    if (
      !surface ||
      !pane ||
      !workspace ||
      !sameWorkspaceTarget(workspace.location.target, spec.target)
    ) {
      continue;
    }
    return { workspaceId: pane.workspaceId, surfaceId: surface.id };
  }
  return null;
}

function activeSurfaceResult(
  state: AppState
): ExternalAgentSessionResumeResult {
  const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
  const workspace = state.workspaces[workspaceId];
  const surfaceId = state.panes[workspace.activePaneId].activeSurfaceId;
  return { workspaceId, surfaceId };
}

function externalAgentSessionRefsMatch(
  left: AgentSessionRef | undefined,
  right: ExternalAgentSessionRef
): boolean {
  return Boolean(
    left &&
    left.vendor === right.vendor &&
    left.externalKey === right.externalKey &&
    left.id === right.sessionId
  );
}

function sameWorkspaceTarget(
  left: WorkspaceTarget,
  right: WorkspaceTarget
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "local" ||
      (right.kind === "ssh" && left.targetId === right.targetId))
  );
}

function launchCommandsMatch(
  left: StoredSessionLaunchConfig,
  right: SessionLaunchConfig,
  defaultShell: string
): boolean {
  return (
    (left.shell ?? defaultShell) === (right.shell ?? defaultShell) &&
    arrayShallowEqual(left.args, right.args) &&
    (left.initialInput ?? "") === (right.initialInput ?? "")
  );
}

function arrayShallowEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  const leftItems = left ?? [];
  const rightItems = right ?? [];
  return (
    leftItems.length === rightItems.length &&
    leftItems.every((item, index) => item === rightItems[index])
  );
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

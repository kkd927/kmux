import type { AppState, RemoteOperationCommandResult } from "@kmux/core";
import type {
  ExternalAgentSessionRef,
  Id,
  SessionLaunchConfig
} from "@kmux/proto";

import type { ActiveSshTarget } from "./sshConnectionRuntime";
import type { RemoteLifecycleRuntime } from "./remoteLifecycleRuntime";

interface SshWorkspaceCreationCommonRequest {
  target: ActiveSshTarget;
  workspaceName?: string;
  launch?: SessionLaunchConfig;
  agentSessionRef?: ExternalAgentSessionRef;
  initialInput?: string;
}

export type SshWorkspaceCreationRequest =
  | (SshWorkspaceCreationCommonRequest & {
      kind: "convert-existing";
      sourceWorkspaceId: Id;
    })
  | (SshWorkspaceCreationCommonRequest & {
      kind: "create-new";
      destinationWindowId: Id;
    });

export interface SshWorkspaceCreationResult {
  workspaceId: Id;
  surfaceId: Id;
  sessionId: Id;
  targetId: Id;
  continuation: "convert" | "create";
  resumeInputResult?: RemoteOperationCommandResult;
}

export interface SshWorkspaceCreationRuntime {
  create(
    request: SshWorkspaceCreationRequest
  ): Promise<SshWorkspaceCreationResult>;
}

export function createSshWorkspaceCreationRuntime(options: {
  lifecycle: RemoteLifecycleRuntime;
  getState: () => AppState;
}): SshWorkspaceCreationRuntime {
  return Object.freeze({
    async create(
      request: SshWorkspaceCreationRequest
    ): Promise<SshWorkspaceCreationResult> {
      const profile = request.target.profile;
      const binding = request.target.binding;
      const cwd =
        request.launch?.cwd ??
        profile.defaultRemoteCwd ??
        request.target.remoteHome;
      const shell = request.launch?.shell ?? profile.shellOverride;
      const env = {
        ...(profile.env ?? {}),
        ...(request.launch?.env ?? {})
      };
      const initialInput = request.initialInput ?? request.launch?.initialInput;
      const initialWorkspaceName =
        request.workspaceName ??
        `${binding.authority.authenticatedPrincipal.accountName}@${profile.name}`;
      const intent =
        request.kind === "convert-existing"
          ? {
              kind: request.kind,
              sourceWorkspaceId: request.sourceWorkspaceId
            }
          : {
              kind: request.kind,
              destinationWindowId: request.destinationWindowId
            };
      const record = await options.lifecycle.startSshWorkspaceTransaction({
        ...intent,
        targetId: binding.id,
        effectiveConnectionPolicyHash:
          binding.locator.effectiveConnectionPolicyHash,
        initialWorkspaceName,
        defaultCwd: cwd,
        launch: {
          cwd,
          ...(shell === undefined ? {} : { shell }),
          ...(request.launch?.args === undefined
            ? {}
            : { args: [...request.launch.args] }),
          ...(Object.keys(env).length === 0 ? {} : { env }),
          ...(request.launch?.title === undefined
            ? {}
            : { title: request.launch.title })
        },
        ...(request.agentSessionRef === undefined
          ? {}
          : { agentSessionRef: structuredClone(request.agentSessionRef) }),
        ...(initialInput === undefined ? {} : { initialInput })
      });
      if (record.state !== "cleanup-complete") {
        throw new Error("SSH workspace transaction did not finish cleanup");
      }
      const state = options.getState();
      const session = state.sessions[record.sessionResourceKey.sessionId];
      if (!session) {
        throw new Error(
          "SSH workspace transaction did not install its session"
        );
      }
      const resumeInputResult =
        options.lifecycle.takeSshWorkspaceLaunchInputResult(
          record.transactionId
        );
      return {
        workspaceId: record.workspaceResourceKey.workspaceId,
        surfaceId: session.surfaceId,
        sessionId: session.id,
        targetId: record.workspaceResourceKey.targetId,
        continuation:
          request.kind === "convert-existing" ? "convert" : "create",
        ...(resumeInputResult === null ? {} : { resumeInputResult })
      };
    }
  });
}

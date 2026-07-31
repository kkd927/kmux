import type { AppAction, AppState } from "@kmux/core";
import type { Id, SshWorkspaceReconnectResult } from "@kmux/proto";

import {
  SshAuthenticationCancelledError,
  type ActiveSshTarget,
  type ConnectedSshProfile,
  type SshConnectionRuntime,
  type SshTargetRestoreRequest
} from "./sshConnectionRuntime";

const SSH_CONNECTION_STATUS_KEY = "ssh:connection";
const SSH_RECONNECTING_TEXT = "Reconnecting SSH…";

export interface SshReconnectCoordinator {
  reconnectTarget(
    targetId: Id,
    request: SshTargetRestoreRequest
  ): Promise<ConnectedSshProfile>;
  reconnectWorkspace(workspaceId: Id): Promise<SshWorkspaceReconnectResult>;
  ensureTargetConnected(
    targetId: Id,
    purpose: "session-resume" | "retained-termination"
  ): Promise<ActiveSshTarget>;
  isTargetReconnecting(targetId: Id): boolean;
  targetConnected(targetId: Id): void;
}

export function createSshReconnectCoordinator(options: {
  getState: () => AppState;
  dispatchAppAction: (action: AppAction) => void;
  restoreTarget: SshConnectionRuntime["restoreTarget"];
  getActiveTarget?: SshConnectionRuntime["getActiveTarget"];
  isTargetConnected?: (targetId: Id) => boolean;
  onConnected?: (targetId: Id) => void | Promise<void>;
  reportError?: (error: Error) => void;
}): SshReconnectCoordinator {
  const attempts = new Map<Id, Promise<ConnectedSshProfile>>();
  const ensureAttempts = new Map<Id, Promise<ActiveSshTarget>>();
  const successfulConnectionVersions = new Map<Id, number>();

  const updateTargetStatus = (
    targetId: Id,
    text: string | null,
    variant: "info" | "error" = "info"
  ): void => {
    const workspaceIds = Object.values(options.getState().workspaces)
      .filter(
        (workspace) =>
          workspace.location.target.kind === "ssh" &&
          workspace.location.target.targetId === targetId
      )
      .map((workspace) => workspace.id);
    for (const workspaceId of workspaceIds) {
      options.dispatchAppAction(
        text === null
          ? {
              type: "sidebar.clearStatus",
              workspaceId,
              key: SSH_CONNECTION_STATUS_KEY
            }
          : {
              type: "sidebar.setStatus",
              workspaceId,
              key: SSH_CONNECTION_STATUS_KEY,
              label: "SSH",
              text,
              variant
            }
      );
    }
  };

  const coordinator: SshReconnectCoordinator = {
    reconnectTarget(
      targetId: Id,
      request: SshTargetRestoreRequest
    ): Promise<ConnectedSshProfile> {
      const current = attempts.get(targetId);
      if (current) return current;

      const successVersionAtStart =
        successfulConnectionVersions.get(targetId) ?? 0;
      updateTargetStatus(targetId, SSH_RECONNECTING_TEXT);
      const attempt = (async () => {
        let connected: ConnectedSshProfile;
        try {
          connected = await options.restoreTarget(targetId, request);
        } catch (error) {
          const failure =
            error instanceof Error ? error : new Error(String(error));
          if (
            (successfulConnectionVersions.get(targetId) ?? 0) ===
            successVersionAtStart
          ) {
            updateTargetStatus(
              targetId,
              failure instanceof SshAuthenticationCancelledError
                ? "SSH authentication cancelled"
                : failure.message,
              "error"
            );
          }
          throw failure;
        }
        try {
          await options.onConnected?.(targetId);
        } catch (error) {
          options.reportError?.(
            error instanceof Error ? error : new Error(String(error))
          );
        }
        return connected;
      })();
      attempts.set(targetId, attempt);
      void attempt
        .finally(() => {
          if (attempts.get(targetId) === attempt) attempts.delete(targetId);
        })
        .catch(() => undefined);
      return attempt;
    },

    async reconnectWorkspace(
      workspaceId: Id
    ): Promise<SshWorkspaceReconnectResult> {
      const workspace = options.getState().workspaces[workspaceId];
      if (!workspace) throw new Error("SSH workspace does not exist");
      if (workspace.location.target.kind !== "ssh") {
        throw new Error("workspace is not an SSH workspace");
      }
      try {
        await coordinator.reconnectTarget(workspace.location.target.targetId, {
          authentication: "interactive",
          purpose: "manual-reconnect"
        });
        return { status: "connected" };
      } catch (error) {
        return {
          status:
            error instanceof SshAuthenticationCancelledError
              ? "cancelled"
              : "failed"
        };
      }
    },

    async ensureTargetConnected(
      targetId: Id,
      purpose: "session-resume" | "retained-termination"
    ): Promise<ActiveSshTarget> {
      const current = ensureAttempts.get(targetId);
      if (current) return await current;
      const ensure = (async (): Promise<ActiveSshTarget> => {
        if (!options.getActiveTarget || !options.isTargetConnected) {
          throw new Error("SSH target connection validation is not configured");
        }
        const active = options.getActiveTarget(targetId);
        if (active && options.isTargetConnected(targetId)) {
          return active;
        }
        const existingAttempt = attempts.get(targetId);
        if (existingAttempt) {
          try {
            await existingAttempt;
          } catch {
            if (attempts.get(targetId) === existingAttempt) {
              attempts.delete(targetId);
            }
            await coordinator.reconnectTarget(targetId, {
              authentication: "interactive",
              purpose
            });
          }
        } else {
          await coordinator.reconnectTarget(targetId, {
            authentication: "interactive",
            purpose
          });
        }
        const restored = options.getActiveTarget(targetId);
        if (restored) return restored;
        throw new Error(
          "restored SSH target no longer matches its saved binding"
        );
      })();
      ensureAttempts.set(targetId, ensure);
      void ensure
        .finally(() => {
          if (ensureAttempts.get(targetId) === ensure) {
            ensureAttempts.delete(targetId);
          }
        })
        .catch(() => undefined);
      return await ensure;
    },

    isTargetReconnecting(targetId: Id): boolean {
      return attempts.has(targetId);
    },

    targetConnected(targetId: Id): void {
      successfulConnectionVersions.set(
        targetId,
        (successfulConnectionVersions.get(targetId) ?? 0) + 1
      );
      // The lifecycle success is authoritative even though the promise that
      // initiated it may still be unwinding askpass and post-connect work. A
      // later target-lost event must be able to start a fresh attempt instead
      // of joining that already-satisfied promise.
      attempts.delete(targetId);
      updateTargetStatus(targetId, null);
    }
  };

  return Object.freeze(coordinator);
}

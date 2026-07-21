import { makeId, type SurfaceVmContentMap } from "@kmux/proto";

import {
  buildSessionSpawnEffect,
  defaultNewSurfaceCwd,
  encodeWorkspaceGitRepository,
  pendingSessionRuntimeStatus,
  sanitizeAgentSessionRef,
  sanitizeStoredSessionLaunchConfig,
  terminalSessionForSurface
} from "../index";
import { encodeLocatedPathDto, locatedPathForTarget } from "../domain";
import type { SurfaceCoreModule } from "./registry";

export const terminalSurfaceCoreModule: SurfaceCoreModule<"terminal"> = {
  kind: "terminal",

  create(context, init) {
    const { state, workspaceId, paneId, surfaceId } = context;
    const workspace = state.workspaces[workspaceId];
    const pane = state.panes[paneId];
    if (!workspace || !pane || pane.workspaceId !== workspaceId) {
      throw new Error("Terminal Surface create context is invalid");
    }
    const sessionId = context.createResourceId();
    const launchCwd = defaultNewSurfaceCwd(state, paneId, init.cwd);
    const defaultShell =
      workspace.location.target.kind === "local"
        ? state.settings.shell || process.env.SHELL
        : undefined;
    const launch = sanitizeStoredSessionLaunchConfig(
      {
        ...(defaultShell === undefined ? {} : { shell: defaultShell }),
        title: init.title,
        ...init.launch,
        cwd:
          init.launch?.cwd === undefined
            ? launchCwd
            : locatedPathForTarget(workspace.location.target, init.launch.cwd)
      },
      defaultShell
    );
    const isOnlyWorkspacePane =
      pane.surfaceIds.length === 0 &&
      Object.values(workspace.nodeMap).filter((node) => node.kind === "leaf")
        .length === 1;
    const title =
      launch.title?.trim() ||
      init.title?.trim() ||
      (pane.surfaceIds.length > 0
        ? `tab ${pane.surfaceIds.length + 1}`
        : isOnlyWorkspacePane
          ? workspace.name
          : "new terminal");
    const surface = {
      id: surfaceId,
      paneId,
      title,
      titleLocked: Boolean(launch.title?.trim()),
      unreadCount: 0,
      attention: false,
      content: { kind: "terminal" as const, sessionId }
    };
    const agentSessionRef = sanitizeAgentSessionRef(
      init.agentSessionRef,
      workspace.location.target,
      launch.cwd
    );
    state.sessions[sessionId] = {
      id: sessionId,
      surfaceId,
      launch,
      ...(agentSessionRef ? { agentSessionRef } : {}),
      authToken: makeId("auth"),
      runtimeStatus: pendingSessionRuntimeStatus(),
      shellInputReady: false,
      runtimeMetadata: { cwd: launch.cwd, ports: [] }
    };
    return {
      surface,
      effects: [
        buildSessionSpawnEffect(state, workspaceId, surfaceId, sessionId)
      ]
    };
  },

  close(state, surface) {
    const session = terminalSessionForSurface(state, surface.id);
    if (!session) return [];
    delete state.sessions[session.id];
    return [{ type: "session.close", sessionId: session.id }];
  },

  restore() {
    return [];
  },

  encodeContent(content) {
    return { kind: "terminal", sessionId: content.sessionId };
  },

  decodeContent(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Terminal content must be an object");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
      keys.length !== 2 ||
      keys[0] !== "kind" ||
      keys[1] !== "sessionId" ||
      record.kind !== "terminal" ||
      typeof record.sessionId !== "string" ||
      !record.sessionId ||
      record.sessionId.length > 512
    ) {
      throw new TypeError("Terminal content schema is invalid");
    }
    return { kind: "terminal", sessionId: record.sessionId };
  },

  buildVmContent(state, surface) {
    const session = terminalSessionForSurface(state, surface.id);
    if (!session) {
      throw new Error(`Terminal Surface ${surface.id} has no Session`);
    }
    const storageStatus = session.remoteRuntime?.storageStatus;
    return {
      kind: "terminal",
      sessionId: session.id,
      runtimeStatus: session.runtimeStatus.processState,
      shellInputReady: session.shellInputReady,
      exitCode: session.exitCode,
      runtimeMetadata: {
        cwd: encodeLocatedPathDto(session.runtimeMetadata.cwd).path,
        branch: session.runtimeMetadata.branch,
        gitRepository: session.runtimeMetadata.gitRepository
          ? encodeWorkspaceGitRepository(session.runtimeMetadata.gitRepository)
          : undefined,
        ports: [...session.runtimeMetadata.ports]
      },
      ...(storageStatus
        ? {
            storageStatus: {
              state: storageStatus.state,
              journalAdmitted: storageStatus.journalAdmitted.toString(10),
              journalSynced: storageStatus.journalSynced.toString(10),
              emergencyBytes: storageStatus.emergencyBytes,
              ...(storageStatus.lastSyncDurationMs === undefined
                ? {}
                : { lastSyncDurationMs: storageStatus.lastSyncDurationMs })
            }
          }
        : {})
    } satisfies SurfaceVmContentMap["terminal"];
  }
};

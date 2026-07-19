import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInitialState } from "@kmux/core";
import { createSshWorkspaceReplacementPatch } from "@kmux/core/main";
import { uint64 } from "@kmux/proto";

import {
  ConversionWalConflictError,
  conversionPatchHash,
  createConversionWalStore,
  type ConversionPreparingRecord
} from "./conversionWal";

describe("conversion WAL", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "kmux-conversion-wal-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("durably advances the exact five-state transaction and compacts only after cleanup", () => {
    const root = join(sandbox, "wal");
    const store = createConversionWalStore(root);
    const patch = replacementPatch();
    const preparing = store.begin(preparingRecord(patch));
    expect(preparing.state).toBe("preparing");

    const remoteCreated = store.recordRemoteCreated("conversion_1", {
      remoteSnapshotHash: "b".repeat(64),
      workspaceDescriptorHash: "c".repeat(64),
      sessionDescriptorHash: "d".repeat(64),
      keeperGeneration: "keeper_1",
      remoteResourceRevision: "1",
      remoteCreatedAt: "2026-07-18T00:00:01.000Z"
    });
    expect(remoteCreated.state).toBe("remote-created");
    expect(() => store.compact("conversion_1")).toThrow(
      ConversionWalConflictError
    );

    const decided = store.decideCommit("conversion_1", {
      replacementPatch: patch,
      replacementPatchHash: conversionPatchHash(patch),
      decidedAt: "2026-07-18T00:00:02.000Z"
    });
    expect(decided.state).toBe("commit-decided");

    const committed = store.recordCommitted("conversion_1", {
      desktopSnapshotHash: "e".repeat(64),
      remotePromotionHash: "f".repeat(64),
      committedAt: "2026-07-18T00:00:03.000Z"
    });
    expect(committed.state).toBe("committed");

    const complete = store.recordCleanupComplete(
      "conversion_1",
      [
        {
          sessionId: "session_local",
          surfaceId: "surface_local",
          runtimeEpoch: "epoch_local",
          outcome: "terminated"
        }
      ],
      "2026-07-18T00:00:04.000Z"
    );
    expect(complete.state).toBe("cleanup-complete");
    expect(createConversionWalStore(root).loadAll()).toEqual([complete]);

    store.compact("conversion_1");
    expect(store.loadAll()).toEqual([]);
  });

  it("rejects skipped, conflicting, incomplete, and tampered transitions", () => {
    const root = join(sandbox, "wal");
    const store = createConversionWalStore(root);
    store.begin(preparingRecord(replacementPatch()));
    expect(() =>
      store.recordCommitted("conversion_1", {
        desktopSnapshotHash: "e".repeat(64),
        remotePromotionHash: "f".repeat(64),
        committedAt: "2026-07-18T00:00:03.000Z"
      })
    ).toThrow();
    store.recordRemoteCreated("conversion_1", {
      remoteSnapshotHash: "b".repeat(64),
      workspaceDescriptorHash: "c".repeat(64),
      sessionDescriptorHash: "d".repeat(64),
      keeperGeneration: "keeper_1",
      remoteResourceRevision: "1",
      remoteCreatedAt: "2026-07-18T00:00:01.000Z"
    });
    expect(() =>
      store.recordRemoteCreated("conversion_1", {
        remoteSnapshotHash: "9".repeat(64),
        workspaceDescriptorHash: "c".repeat(64),
        sessionDescriptorHash: "d".repeat(64),
        keeperGeneration: "keeper_1",
        remoteResourceRevision: "1",
        remoteCreatedAt: "2026-07-18T00:00:01.000Z"
      })
    ).toThrow(ConversionWalConflictError);

    const path = join(root, readSingleRecordName(root));
    const envelope = JSON.parse(readFileSync(path, "utf8")) as {
      recordDigest: string;
    };
    envelope.recordDigest = "0".repeat(64);
    writeFileSync(path, JSON.stringify(envelope), { mode: 0o600 });
    expect(() => createConversionWalStore(root).loadAll()).toThrow(
      /digest mismatch/u
    );
  });
});

function preparingRecord(
  patch: ReturnType<typeof replacementPatch>
): Omit<
  ConversionPreparingRecord,
  "version" | "state"
> {
  return {
    continuation: "convert",
    transactionId: "conversion_1",
    workspaceCreateOperationId: "operation_workspace_1",
    sessionCreateOperationId: "operation_session_1",
    workspaceResourceKey: {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: "workspace_1"
    },
    sessionResourceKey: {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: "workspace_1",
      sessionId: "session_remote"
    },
    sourceWorkspaceRevision: patch.expectedSourceWorkspaceRevision,
    effectiveConnectionPolicyHash: "a".repeat(64),
    preservation: {
      workspaceId: "workspace_1",
      windowId: "window_1",
      name: "local project",
      nameLocked: false,
      pinned: true
    },
    cleanupSet: [
      {
        sessionId: "session_local",
        surfaceId: "surface_local",
        runtimeEpoch: "epoch_local"
      }
    ],
    connectionName: "devbox",
    defaultCwd: "/srv/project",
    launch: { cwd: "/srv/project", shell: "/bin/sh" },
    preparedAt: "2026-07-18T00:00:00.000Z"
  };
}

function replacementPatch() {
  const state = createInitialState("/bin/zsh");
  const originalWorkspaceId = Object.keys(state.workspaces)[0]!;
  const originalWorkspace = state.workspaces[originalWorkspaceId];
  const originalPane = state.panes[originalWorkspace.activePaneId];
  const originalSurface = state.surfaces[originalPane.activeSurfaceId];
  const originalSession = state.sessions[originalSurface.sessionId];
  state.workspaces.workspace_1 = {
    ...originalWorkspace,
    id: "workspace_1",
    windowId: "window_1",
    name: "local project",
    pinned: true
  };
  delete state.workspaces[originalWorkspaceId];
  state.windows[state.activeWindowId].id = "window_1";
  state.windows.window_1 = state.windows[state.activeWindowId];
  if (state.activeWindowId !== "window_1") {
    delete state.windows[state.activeWindowId];
    state.activeWindowId = "window_1";
  }
  state.windows.window_1.workspaceOrder = ["workspace_1"];
  state.windows.window_1.activeWorkspaceId = "workspace_1";
  state.panes.pane_local = {
    ...originalPane,
    id: "pane_local",
    workspaceId: "workspace_1",
    surfaceIds: ["surface_local"],
    activeSurfaceId: "surface_local"
  };
  delete state.panes[originalPane.id];
  state.surfaces.surface_local = {
    ...originalSurface,
    id: "surface_local",
    paneId: "pane_local",
    sessionId: "session_local"
  };
  delete state.surfaces[originalSurface.id];
  state.sessions.session_local = {
    ...originalSession,
    id: "session_local",
    surfaceId: "surface_local"
  };
  delete state.sessions[originalSession.id];
  state.workspaces.workspace_1.activePaneId = "pane_local";
  state.workspaces.workspace_1.nodeMap = {
    node_local: { id: "node_local", kind: "leaf", paneId: "pane_local" }
  };
  state.workspaces.workspace_1.rootNodeId = "node_local";
  return createSshWorkspaceReplacementPatch(state, {
    workspaceId: "workspace_1",
    targetId: "target_1",
    connectionName: "devbox",
    defaultCwd: "/srv/project",
    paneId: "pane_remote",
    nodeId: "node_remote",
    surfaceId: "surface_remote",
    sessionId: "session_remote",
    authToken: "auth_remote",
    keeperGeneration: "keeper_1",
    remoteResourceRevision: uint64(1n),
    launch: { cwd: "/srv/project", shell: "/bin/sh" }
  });
}

function readSingleRecordName(root: string): string {
  const names = readdirSync(root);
  const name = names.find((candidate) => candidate.endsWith(".json"));
  if (!name) throw new Error("test WAL record was not written");
  return name;
}

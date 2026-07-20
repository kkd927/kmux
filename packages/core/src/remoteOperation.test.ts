import { uint64 } from "@kmux/proto";

import {
  canonicalizeRemoteOperationPayload,
  decodeRemoteOperationIntentDto,
  decodeRemoteOperationPayload,
  decodeRemoteOperationProjectionDto,
  encodeRemoteOperationIntentDto,
  encodeRemoteOperationProjectionDto,
  type RemoteOperationIntent,
  type RemoteOperationPayloadDto,
  type RemoteOperationProjection
} from "./index";

const digest = "a".repeat(64);

describe("remote operation codecs", () => {
  it("roundtrips every allowlisted mutation payload without an arbitrary object escape", () => {
    const payloads: RemoteOperationPayloadDto[] = [
      {
        kind: "workspace.create",
        workspaceId: "workspace_1",
        name: "remote",
        defaultCwd: "/srv/app"
      },
      {
        kind: "session.create",
        sessionId: "session_1",
        surfaceId: "surface_1",
        paneId: "pane_1",
        direction: "right",
        launch: { cwd: "/srv/app", shell: "/bin/bash" }
      },
      {
        kind: "session.restart",
        sessionId: "session_1",
        surfaceId: "surface_1",
        launch: { cwd: "/srv/app" }
      },
      {
        kind: "session.adopt",
        sessionId: "session_2",
        surfaceId: "surface_2",
        paneId: "pane_1",
        launch: { cwd: "/srv/retained", title: "retained agent" }
      },
      { kind: "session.terminate", sessionId: "session_1" },
      { kind: "workspace.terminate", workspaceId: "workspace_1" },
      {
        kind: "worktree.create",
        workspaceId: "workspace_1",
        cwd: "/srv/app",
        path: "/srv/worktree",
        baseRef: "main",
        branch: "feature/remote"
      },
      {
        kind: "worktree.remove",
        workspaceId: "workspace_1",
        cwd: "/srv/app",
        path: "/srv/worktree",
        force: false,
        expectedBranch: "feature/remote",
        expectedCommonGitDir: "/srv/app/.git"
      },
      {
        kind: "forward.ensure",
        forwardId: "forward_1",
        remoteHost: "127.0.0.1",
        remotePort: 3000,
        localBindHost: "127.0.0.1",
        localPort: 3001
      },
      { kind: "forward.remove", forwardId: "forward_1" },
      { kind: "launch-input", sessionId: "session_1", input: "codex\n" }
    ];

    expect(payloads.map(decodeRemoteOperationPayload)).toEqual(payloads);
  });

  it("validates a bounded kind-discriminated payload and canonicalizes keys", () => {
    const payload = decodeRemoteOperationPayload({
      launch: {
        env: { ZED: "2", ALPHA: "1" },
        args: ["-l"],
        cwd: "/srv/app"
      },
      paneId: "pane_1",
      surfaceId: "surface_2",
      sessionId: "session_2",
      kind: "session.create"
    });

    expect(payload).toEqual({
      kind: "session.create",
      sessionId: "session_2",
      surfaceId: "surface_2",
      paneId: "pane_1",
      launch: {
        cwd: "/srv/app",
        args: ["-l"],
        env: { ALPHA: "1", ZED: "2" }
      }
    });
    expect(canonicalizeRemoteOperationPayload(payload)).toBe(
      '{"kind":"session.create","launch":{"args":["-l"],"cwd":"/srv/app","env":{"ALPHA":"1","ZED":"2"}},"paneId":"pane_1","sessionId":"session_2","surfaceId":"surface_2"}'
    );
  });

  it("rejects unknown fields, unsafe forward binds, and oversized launch input", () => {
    expect(() =>
      decodeRemoteOperationPayload({
        kind: "session.terminate",
        sessionId: "session_1",
        arbitrary: true
      })
    ).toThrow(/unexpected/);
    expect(() =>
      decodeRemoteOperationPayload({
        kind: "forward.ensure",
        forwardId: "forward_1",
        remoteHost: "localhost",
        remotePort: 3000,
        localBindHost: "0.0.0.0"
      })
    ).toThrow(/loopback/);
    expect(() =>
      decodeRemoteOperationPayload({
        kind: "launch-input",
        sessionId: "session_1",
        input: "x".repeat(64 * 1024 + 1)
      })
    ).toThrow(/byte limit/);
    expect(() =>
      decodeRemoteOperationPayload({
        kind: "session.create",
        sessionId: "session_1",
        surfaceId: "surface_1",
        paneId: "pane_1",
        launch: { cwd: "/srv/app", initialInput: "echo duplicated" }
      })
    ).toThrow(/unexpected/);
    expect(() =>
      decodeRemoteOperationPayload({
        kind: "session.create",
        sessionId: "session_1",
        surfaceId: "surface_1",
        paneId: "pane_1",
        launch: { cwd: "/srv/app", env: { "BAD=KEY": "value" } }
      })
    ).toThrow(/environment key/);
    expect(() =>
      decodeRemoteOperationPayload({
        kind: "session.create",
        sessionId: "session_1",
        surfaceId: "surface_1",
        paneId: "pane_1",
        launch: { cwd: "/srv/app", args: ["bad\0argument"] }
      })
    ).toThrow(/NUL/);
  });

  it("roundtrips intent and projection uint64 values as decimal strings", () => {
    const intent: RemoteOperationIntent = {
      operationId: "operation_1",
      kind: "session.terminate",
      resourceKey: {
        desktopInstallationId: "desktop_1",
        targetId: "target_1",
        workspaceId: "workspace_1",
        sessionId: "session_1"
      },
      expectedWorkspaceRevision: "b".repeat(64),
      expectedRemoteResourceRevision: uint64(9n),
      nextRemoteResourceRevision: uint64(10n),
      canonicalPayloadHash: digest,
      createdAt: "2026-07-17T00:00:00.000Z"
    };
    const projection: RemoteOperationProjection = {
      ...intent,
      state: "termination-pending"
    };

    expect(encodeRemoteOperationIntentDto(intent)).toMatchObject({
      expectedRemoteResourceRevision: "9",
      nextRemoteResourceRevision: "10"
    });
    expect(
      decodeRemoteOperationIntentDto(encodeRemoteOperationIntentDto(intent))
    ).toEqual(intent);
    expect(encodeRemoteOperationProjectionDto(projection)).toMatchObject({
      expectedRemoteResourceRevision: "9",
      nextRemoteResourceRevision: "10"
    });
    expect(
      decodeRemoteOperationProjectionDto(
        encodeRemoteOperationProjectionDto(projection)
      )
    ).toEqual(projection);
    expect(() =>
      decodeRemoteOperationIntentDto({
        ...encodeRemoteOperationIntentDto(intent),
        expectedRemoteResourceRevision: 9
      })
    ).toThrow(/canonical decimal/);
  });

  it("roundtrips the durable worktree launch-surface marker", () => {
    const worktree = {
      name: "app-remote",
      path: "/srv/worktrees/app-remote",
      repoRoot: "/srv/app",
      commonGitDir: "/srv/app/.git",
      baseRef: "main",
      branch: "kmux/app-remote",
      createdByKmux: true,
      launchSurfaceCreated: true
    };
    const projection: RemoteOperationProjection = {
      operationId: "operation_worktree_create",
      kind: "worktree.create",
      resourceKey: {
        desktopInstallationId: "desktop_1",
        targetId: "target_1",
        workspaceId: "workspace_1"
      },
      expectedWorkspaceRevision: "b".repeat(64),
      expectedRemoteResourceRevision: uint64(0n),
      nextRemoteResourceRevision: uint64(1n),
      canonicalPayloadHash: digest,
      pendingProduct: {
        kind: "worktree.create",
        workspaceId: "workspace_1",
        cwd: worktree.repoRoot,
        path: worktree.path,
        baseRef: worktree.baseRef,
        branch: worktree.branch,
        product: { kind: "worktree.create", worktree }
      },
      state: "succeeded",
      createdAt: "2026-07-17T00:00:00.000Z",
      completedAt: "2026-07-17T00:00:01.000Z",
      resultDigest: "c".repeat(64)
    };
    const encoded = encodeRemoteOperationProjectionDto(projection);

    expect(decodeRemoteOperationProjectionDto(encoded)).toEqual(projection);
    expect(() =>
      decodeRemoteOperationProjectionDto({
        ...encoded,
        pendingProduct: {
          ...encoded.pendingProduct,
          product: {
            kind: "worktree.create",
            worktree: { ...worktree, launchSurfaceCreated: "yes" }
          }
        }
      })
    ).toThrow(/launchSurfaceCreated must be boolean/);
  });

  it("rejects invalid resource scope, skipped revisions, and inconsistent terminal state", () => {
    const intent: RemoteOperationIntent = {
      operationId: "operation_1",
      kind: "session.terminate",
      resourceKey: {
        desktopInstallationId: "desktop_1",
        targetId: "target_1",
        workspaceId: "workspace_1",
        sessionId: "session_1"
      },
      expectedWorkspaceRevision: "b".repeat(64),
      expectedRemoteResourceRevision: uint64(9n),
      nextRemoteResourceRevision: uint64(10n),
      canonicalPayloadHash: digest,
      createdAt: "2026-07-17T00:00:00.000Z"
    };
    const dto = encodeRemoteOperationIntentDto(intent);

    expect(() =>
      decodeRemoteOperationIntentDto({
        ...dto,
        resourceKey: { ...dto.resourceKey, sessionId: undefined }
      })
    ).toThrow(/wrong scope/);
    expect(() =>
      decodeRemoteOperationIntentDto({
        ...dto,
        nextRemoteResourceRevision: "11"
      })
    ).toThrow(/exactly one/);
    expect(() =>
      decodeRemoteOperationProjectionDto({
        ...encodeRemoteOperationProjectionDto({
          ...intent,
          state: "termination-pending"
        }),
        state: "succeeded"
      })
    ).toThrow(/requires result metadata/);
  });
});

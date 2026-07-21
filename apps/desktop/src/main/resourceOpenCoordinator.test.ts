import {
  applyAction,
  createInitialState,
  encodeLocatedPathDto,
  locatedPathForTarget,
  type AppAction,
  type LocatedPath
} from "@kmux/core";
import { MAX_MARKDOWN_BYTES } from "@kmux/proto";
import { describe, expect, it, vi } from "vitest";

import { ResourceOpenCoordinator } from "./resourceOpenCoordinator";
import type {
  FileMetadata,
  LocatedTargetServiceSet,
  TargetServiceRegistry
} from "./targets/contracts";

describe("ResourceOpenCoordinator", () => {
  it("re-resolves and opens a bounded Markdown target from terminal context", async () => {
    const fixture = createFixture();
    const dispatchAppAction = vi.fn((action: AppAction) =>
      applyAction(fixture.state, action)
    );
    const coordinator = createCoordinator(fixture, { dispatchAppAction });

    await coordinator.activateTerminalFileLink(
      { id: 7 },
      {
        sourceSurfaceId: fixture.sourceSurfaceId,
        rawPath: "docs/README.MARKDOWN:12",
        baseCwd: "/repo/old"
      }
    );

    const resolveRequest = fixture.files.resolveTerminalPath.mock.calls[0]?.[0];
    expect(resolveRequest?.rawPath).toBe("docs/README.MARKDOWN:12");
    expect(encodeLocatedPathDto(resolveRequest?.cwd as LocatedPath).path).toBe(
      "/repo/old"
    );
    expect(fixture.files.stat).toHaveBeenCalledWith(fixture.resolvedPath);
    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "surface.open",
      workspaceId: fixture.workspaceId,
      init: {
        kind: "markdown",
        path: fixture.resolvedPath,
        title: "README.MARKDOWN"
      },
      placement: {
        kind: "right-preview",
        sourceSurfaceId: fixture.sourceSurfaceId
      }
    });
    expect(Object.values(fixture.state.surfaces)).toContainEqual(
      expect.objectContaining({
        title: "README.MARKDOWN",
        content: {
          kind: "markdown",
          source: { kind: "file", path: fixture.resolvedPath }
        }
      })
    );
  });

  it("rejects senders that do not own the terminal Surface window", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture, {
      ownsWindow: () => false
    });

    await expect(
      coordinator.activateTerminalFileLink(
        { id: 99 },
        {
          sourceSurfaceId: fixture.sourceSurfaceId,
          rawPath: "README.md"
        }
      )
    ).rejects.toThrow(/not authorized/u);
    expect(fixture.files.resolveTerminalPath).not.toHaveBeenCalled();
  });

  it("rechecks extension, regular-file type, and size before dispatch", async () => {
    const fixture = createFixture();
    const dispatchAppAction = vi.fn();
    const coordinator = createCoordinator(fixture, { dispatchAppAction });

    fixture.files.basename.mockReturnValueOnce("notes.txt");
    await expect(
      coordinator.activateTerminalFileLink(
        { id: 7 },
        { sourceSurfaceId: fixture.sourceSurfaceId, rawPath: "notes.txt" }
      )
    ).rejects.toThrow(/not a Markdown/u);

    fixture.files.basename.mockReturnValue("README.md");
    fixture.files.stat.mockResolvedValueOnce({ kind: "directory", size: 0 });
    await expect(
      coordinator.activateTerminalFileLink(
        { id: 7 },
        { sourceSurfaceId: fixture.sourceSurfaceId, rawPath: "README.md" }
      )
    ).rejects.toThrow(/bounded regular file/u);

    fixture.files.stat.mockResolvedValueOnce({
      kind: "file",
      size: MAX_MARKDOWN_BYTES + 1
    });
    await expect(
      coordinator.activateTerminalFileLink(
        { id: 7 },
        { sourceSurfaceId: fixture.sourceSurfaceId, rawPath: "README.md" }
      )
    ).rejects.toThrow(/bounded regular file/u);
    expect(dispatchAppAction).not.toHaveBeenCalled();
  });
});

function createFixture(): {
  state: ReturnType<typeof createInitialState>;
  workspaceId: string;
  sourceSurfaceId: string;
  resolvedPath: LocatedPath;
  files: {
    resolveTerminalPath: ReturnType<typeof vi.fn>;
    basename: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
  };
} {
  const state = createInitialState();
  const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
  const paneId = state.workspaces[workspaceId].activePaneId;
  const sourceSurfaceId = state.panes[paneId].activeSurfaceId;
  applyAction(state, {
    type: "surface.metadata",
    surfaceId: sourceSurfaceId,
    cwd: "/repo/live"
  });
  const resolvedPath = locatedPathForTarget(
    { kind: "local" },
    "/repo/old/docs/README.MARKDOWN"
  );
  return {
    state,
    workspaceId,
    sourceSurfaceId,
    resolvedPath,
    files: {
      resolveTerminalPath: vi.fn(async () => ({
        path: resolvedPath,
        displayPath: "/repo/old/docs/README.MARKDOWN"
      })),
      basename: vi.fn(() => "README.MARKDOWN"),
      stat: vi.fn(
        async (): Promise<FileMetadata> => ({ kind: "file", size: 128 })
      )
    }
  };
}

function createCoordinator(
  fixture: ReturnType<typeof createFixture>,
  overrides: {
    ownsWindow?: () => boolean;
    dispatchAppAction?: (action: AppAction) => void;
  }
): ResourceOpenCoordinator {
  const targetServices = {
    resolveLocated: () =>
      ({ files: fixture.files }) as unknown as LocatedTargetServiceSet
  } as unknown as TargetServiceRegistry;
  return new ResourceOpenCoordinator({
    getState: () => fixture.state,
    targetServices,
    ownsWindow: overrides.ownsWindow ?? (() => true),
    dispatchAppAction: overrides.dispatchAppAction ?? vi.fn()
  });
}

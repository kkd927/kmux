import { applyAction, buildViewModel, createInitialState } from "@kmux/core";

import {
  buildWorkspaceContextMenuEntries,
  findWorkspaceContext,
  runWorkspaceContextAction
} from "./workspaceContextMenu";

describe("workspace context menu helpers", () => {
  it("builds shared menu entries from the latest row state", () => {
    const state = createInitialState();
    applyAction(state, { type: "workspace.create", name: "alpha" });

    const view = buildViewModel(state);
    const alphaContext = findWorkspaceContext(view, view.activeWorkspace.id);

    expect(alphaContext).toBeTruthy();

    const entries = buildWorkspaceContextMenuEntries(alphaContext!);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "rename",
          kind: "action",
          shortcut: view.settings.shortcuts["workspace.rename"]
        }),
        expect.objectContaining({
          id: "pin",
          kind: "action",
          checked: false
        }),
        expect.objectContaining({
          id: "move-top",
          kind: "action",
          disabled: true
        }),
        expect.objectContaining({
          id: "close",
          kind: "action",
          shortcut: view.settings.shortcuts["workspace.close"],
          disabled: false
        })
      ])
    );
  });

  it("runs shared actions using the latest resolved workspace context", async () => {
    const state = createInitialState();
    applyAction(state, { type: "workspace.create", name: "alpha" });
    applyAction(state, { type: "workspace.create", name: "beta" });

    const view = buildViewModel(state);
    const firstWorkspaceId = view.workspaceRows[0]?.workspaceId;
    const betaWorkspaceId = view.workspaceRows.find(
      (row) => row.name === "beta"
    )?.workspaceId;

    expect(firstWorkspaceId).toBeTruthy();
    expect(betaWorkspaceId).toBeTruthy();

    const rename = vi.fn();
    const dispatch = vi.fn();

    await runWorkspaceContextAction(
      betaWorkspaceId!,
      "rename",
      () => findWorkspaceContext(view, betaWorkspaceId!),
      {
        rename,
        dispatch
      }
    );

    expect(rename).toHaveBeenCalledWith(betaWorkspaceId);
    expect(dispatch).not.toHaveBeenCalled();

    await runWorkspaceContextAction(
      betaWorkspaceId!,
      "move-up",
      () => findWorkspaceContext(view, betaWorkspaceId!),
      {
        rename,
        dispatch
      }
    );

    expect(dispatch).toHaveBeenCalledWith({
      type: "workspace.move",
      workspaceId: betaWorkspaceId,
      toIndex: 1
    });

    dispatch.mockClear();

    await runWorkspaceContextAction(
      firstWorkspaceId!,
      "move-up",
      () => findWorkspaceContext(view, firstWorkspaceId!),
      {
        rename,
        dispatch
      }
    );

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("treats the visible pinned section as the move boundary", () => {
    const state = createInitialState();
    applyAction(state, { type: "workspace.create", name: "alpha" });
    applyAction(state, { type: "workspace.create", name: "beta" });
    applyAction(state, { type: "workspace.create", name: "gamma" });

    const betaId = buildViewModel(state).workspaceRows.find(
      (row) => row.name === "beta"
    )?.workspaceId;
    const alphaId = buildViewModel(state).workspaceRows.find(
      (row) => row.name === "alpha"
    )?.workspaceId;

    expect(betaId).toBeTruthy();
    expect(alphaId).toBeTruthy();

    applyAction(state, { type: "workspace.pin.toggle", workspaceId: betaId! });

    const view = buildViewModel(state);
    const alphaContext = findWorkspaceContext(view, alphaId!);

    expect(alphaContext).toMatchObject({
      index: 2,
      groupStartIndex: 2,
      groupIndex: 0,
      groupSize: 2
    });

    const entries = buildWorkspaceContextMenuEntries(alphaContext!);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "move-top",
          disabled: true
        }),
        expect.objectContaining({
          id: "move-up",
          disabled: true
        }),
        expect.objectContaining({
          id: "move-down",
          disabled: false
        })
      ])
    );
  });

  it("runs move-top inside the current pinned or unpinned section", async () => {
    const state = createInitialState();
    applyAction(state, { type: "workspace.create", name: "alpha" });
    applyAction(state, { type: "workspace.create", name: "beta" });
    applyAction(state, { type: "workspace.create", name: "gamma" });

    const betaId = buildViewModel(state).workspaceRows.find(
      (row) => row.name === "beta"
    )?.workspaceId;
    const gammaId = buildViewModel(state).workspaceRows.find(
      (row) => row.name === "gamma"
    )?.workspaceId;

    expect(betaId).toBeTruthy();
    expect(gammaId).toBeTruthy();

    applyAction(state, { type: "workspace.pin.toggle", workspaceId: betaId! });

    const rename = vi.fn();
    const dispatch = vi.fn();
    const view = buildViewModel(state);

    await runWorkspaceContextAction(
      gammaId!,
      "move-top",
      () => findWorkspaceContext(view, gammaId!),
      {
        rename,
        dispatch
      }
    );

    expect(dispatch).toHaveBeenCalledWith({
      type: "workspace.move",
      workspaceId: gammaId,
      toIndex: 2
    });
  });
});

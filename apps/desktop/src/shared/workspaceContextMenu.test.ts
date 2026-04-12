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
          disabled: false
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
});

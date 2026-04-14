import type { AppAction } from "@kmux/core";
import type { Id, ShellViewModel, WorkspaceRowVm } from "@kmux/proto";

export type WorkspaceContextAction =
  | "rename"
  | "pin-toggle"
  | "move-top"
  | "move-up"
  | "move-down"
  | "close-others"
  | "close";

export type WorkspaceContextMenuEntry =
  | {
      id: string;
      kind: "action";
      label: string;
      action: WorkspaceContextAction;
      disabled?: boolean;
      shortcut?: string;
      checked?: boolean;
    }
  | {
      id: string;
      kind: "separator";
    };

export interface WorkspaceContext {
  view: ShellViewModel;
  row: WorkspaceRowVm;
  index: number;
  groupStartIndex: number;
  groupIndex: number;
  groupSize: number;
  totalRows: number;
}

export interface WorkspaceContextActionRunner {
  rename(workspaceId: Id): void | Promise<void>;
  dispatch(action: AppAction): void | Promise<void>;
}

export function findWorkspaceContext(
  view: ShellViewModel,
  workspaceId: Id
): WorkspaceContext | null {
  const index = view.workspaceRows.findIndex(
    (row) => row.workspaceId === workspaceId
  );
  if (index === -1) {
    return null;
  }
  const row = view.workspaceRows[index];
  const groupRows = view.workspaceRows.filter(
    (candidate) => candidate.pinned === row.pinned
  );
  const groupStartIndex = view.workspaceRows.findIndex(
    (candidate) => candidate.pinned === row.pinned
  );
  return {
    view,
    row,
    index,
    groupStartIndex,
    groupIndex: groupRows.findIndex(
      (candidate) => candidate.workspaceId === workspaceId
    ),
    groupSize: groupRows.length,
    totalRows: view.workspaceRows.length
  };
}

export function buildWorkspaceContextMenuEntries(
  context: WorkspaceContext
): WorkspaceContextMenuEntry[] {
  const { groupIndex, groupSize, row, totalRows, view } = context;

  return [
    {
      id: "rename",
      kind: "action",
      label: "Rename Workspace…",
      action: "rename",
      shortcut: view.settings.shortcuts["workspace.rename"]
    },
    {
      id: "pin",
      kind: "action",
      label: "Pin Workspace",
      action: "pin-toggle",
      checked: row.pinned
    },
    { id: "separator-layout", kind: "separator" },
    {
      id: "move-top",
      kind: "action",
      label: "Move to Top",
      action: "move-top",
      disabled: groupIndex <= 0
    },
    {
      id: "move-up",
      kind: "action",
      label: "Move Up",
      action: "move-up",
      disabled: groupIndex <= 0
    },
    {
      id: "move-down",
      kind: "action",
      label: "Move Down",
      action: "move-down",
      disabled: groupIndex === -1 || groupIndex >= groupSize - 1
    },
    { id: "separator-close", kind: "separator" },
    {
      id: "close-others",
      kind: "action",
      label: "Close Other Workspaces",
      action: "close-others",
      disabled: totalRows <= 1
    },
    {
      id: "close",
      kind: "action",
      label: "Close Workspace",
      action: "close",
      disabled: totalRows <= 1,
      shortcut: view.settings.shortcuts["workspace.close"]
    }
  ];
}

export async function runWorkspaceContextAction(
  workspaceId: Id,
  action: WorkspaceContextAction,
  resolveContext: () => WorkspaceContext | null | Promise<WorkspaceContext | null>,
  runner: WorkspaceContextActionRunner
): Promise<void> {
  const context = await resolveContext();
  if (!context) {
    return;
  }

  switch (action) {
    case "rename":
      await runner.rename(workspaceId);
      return;
    case "pin-toggle":
      await runner.dispatch({ type: "workspace.pin.toggle", workspaceId });
      return;
    case "move-top":
      if (context.groupIndex > 0) {
        await runner.dispatch({
          type: "workspace.move",
          workspaceId,
          toIndex: context.groupStartIndex
        });
      }
      return;
    case "move-up":
      if (context.groupIndex > 0) {
        await runner.dispatch({
          type: "workspace.move",
          workspaceId,
          toIndex: context.index - 1
        });
      }
      return;
    case "move-down":
      if (context.groupIndex < context.groupSize - 1) {
        await runner.dispatch({
          type: "workspace.move",
          workspaceId,
          toIndex: context.index + 1
        });
      }
      return;
    case "close-others":
      if (context.totalRows > 1) {
        await runner.dispatch({ type: "workspace.closeOthers", workspaceId });
      }
      return;
    case "close":
      if (context.totalRows > 1) {
        await runner.dispatch({ type: "workspace.close", workspaceId });
      }
      return;
    default:
      return;
  }
}

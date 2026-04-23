import {type RefObject, useEffect, useRef, useState} from "react";

import type {KmuxSettings, WorkspaceRowVm} from "@kmux/proto";

import {
    buildWorkspaceContextMenuEntries,
    findWorkspaceContext,
    type WorkspaceContext,
    type WorkspaceContextMenuEntry
} from "../../../shared/workspaceContextMenu";

export type WorkspaceContextMenuState = {
  workspaceId: string;
  x: number;
  y: number;
};

interface UseWorkspaceContextMenuOptions {
  workspaceRows: WorkspaceRowVm[];
  settings: KmuxSettings | null;
  beginWorkspaceRename: (workspaceId: string) => void;
}

export function useWorkspaceContextMenu(
  options: UseWorkspaceContextMenuOptions
): {
  workspaceContextMenu: WorkspaceContextMenuState | null;
  workspaceContext: WorkspaceContext | null;
  workspaceContextMenuItems: WorkspaceContextMenuEntry[];
  workspaceMenuRef: RefObject<HTMLDivElement>;
  openWorkspaceContextMenu: (
    workspaceId: string,
    x: number,
    y: number
  ) => Promise<void>;
  closeWorkspaceContextMenu: () => void;
} {
  const [workspaceContextMenu, setWorkspaceContextMenu] =
    useState<WorkspaceContextMenuState | null>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null!);
  const renameHandlerRef = useRef(options.beginWorkspaceRename);

  renameHandlerRef.current = options.beginWorkspaceRename;

  useEffect(() => {
    return window.kmux.subscribeWorkspaceRenameRequest((workspaceId) => {
      renameHandlerRef.current(workspaceId);
    });
  }, []);

  useEffect(() => {
    if (
      workspaceContextMenu &&
      !options.workspaceRows.some(
        (row) => row.workspaceId === workspaceContextMenu.workspaceId
      )
    ) {
      setWorkspaceContextMenu(null);
    }
  }, [options.workspaceRows, workspaceContextMenu]);

  useEffect(() => {
    if (!workspaceContextMenu) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      workspaceMenuRef.current
        ?.querySelector<HTMLButtonElement>(
          'button[role="menuitem"]:not(:disabled)'
        )
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [workspaceContextMenu]);

  const workspaceContext =
    workspaceContextMenu && options.settings
      ? findWorkspaceContext(
          {
            workspaceRows: options.workspaceRows,
            settings: options.settings
          },
          workspaceContextMenu.workspaceId
        )
      : null;
  const workspaceContextMenuItems = workspaceContext
    ? buildWorkspaceContextMenuEntries(workspaceContext)
    : [];

  async function openWorkspaceContextMenu(
    workspaceId: string,
    x: number,
    y: number
  ): Promise<void> {
    setWorkspaceContextMenu(null);

    const usedNative = await window.kmux.showWorkspaceContextMenu(
      workspaceId,
      x,
      y
    );
    if (usedNative) {
      return;
    }

    const menuWidth = 272;
    const menuHeight = 252;
    setWorkspaceContextMenu({
      workspaceId,
      x: Math.max(12, Math.min(x, window.innerWidth - menuWidth - 12)),
      y: Math.max(12, Math.min(y, window.innerHeight - menuHeight - 12))
    });
  }

  function closeWorkspaceContextMenu(): void {
    setWorkspaceContextMenu(null);
  }

  return {
    workspaceContextMenu,
    workspaceContext,
    workspaceContextMenuItems,
    workspaceMenuRef,
    openWorkspaceContextMenu,
    closeWorkspaceContextMenu
  };
}

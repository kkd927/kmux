import {
  type KeyboardEvent as ReactKeyboardEvent,
  memo,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef
} from "react";

import type {ActiveWorkspaceActivityVm, WorkspaceRowVm} from "@kmux/proto";
import { useVirtualizer } from "@tanstack/react-virtual";

import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH
} from "../hooks/useSidebarResize";
import styles from "../styles/App.module.css";
import { WorkspaceCard } from "./WorkspaceCard";

interface WorkspaceSidebarProps {
  workspaceRows: WorkspaceRowVm[];
  activeWorkspace: ActiveWorkspaceActivityVm;
  sidebarWidth: number;
  renderedSidebarWidth: number;
  showWorkspaceShortcutHints: boolean;
  editingWorkspaceId: string | null;
  workspaceContextMenuWorkspaceId: string | null;
  dragWorkspaceId: string | null;
  dropWorkspaceId: string | null;
  dropPosition: "before" | "after" | null;
  sidebarResizeActive: boolean;
  onSelectWorkspace: (workspaceId: string) => void;
  onStartRename: (workspaceId: string) => void;
  onOpenContextMenu: (workspaceId: string, x: number, y: number) => void;
  onRenameWorkspace: (workspaceId: string, name: string) => void;
  onDragStartWorkspace: (workspaceId: string) => void;
  onDragTargetWorkspace: (
    workspaceId: string,
    position: "before" | "after"
  ) => void;
  onDragLeaveWorkspace: (workspaceId: string) => void;
  onDropWorkspace: (workspaceId: string, position: "before" | "after") => void;
  onDragEndWorkspace: () => void;
  onSidebarResizeKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onSidebarResizePointerDown: (
    event: ReactPointerEvent<HTMLDivElement>
  ) => void;
}

export const WorkspaceSidebar = memo(function WorkspaceSidebar(
  props: WorkspaceSidebarProps
): JSX.Element {
  const rows = props.workspaceRows;
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => sidebarRef.current,
    getItemKey: (index) => rows[index]?.workspaceId ?? index,
    estimateSize: (index) =>
      estimateWorkspaceRowHeight(rows[index], props.activeWorkspace),
    overscan: 4,
    useAnimationFrameWithResizeObserver: true
  });

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      sidebarRef.current
        ?.querySelectorAll<HTMLElement>("[data-workspace-virtual-item]")
        .forEach((element) => {
          rowVirtualizer.measureElement(element);
        });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    rowVirtualizer,
    rows,
    props.activeWorkspace.id,
    props.activeWorkspace.sidebarStatus,
    props.activeWorkspace.statusEntries.length,
    props.activeWorkspace.progress?.label,
    props.activeWorkspace.progress?.value,
    props.activeWorkspace.logs[0]?.id,
    props.showWorkspaceShortcutHints,
    props.editingWorkspaceId,
    props.renderedSidebarWidth
  ]);

  return (
    <>
      <aside
        className={styles.sidebar}
        data-testid="workspace-tool-window"
        style={{
          width: `${props.renderedSidebarWidth}px`,
          minWidth: `${props.renderedSidebarWidth}px`,
          maxWidth: `${props.renderedSidebarWidth}px`
        }}
      >
        <div className={styles.sidebarPanel}>
          <div className={styles.sidebarHeader}>
            <div className={styles.sidebarHeaderLabelGroup}>
              <div className={styles.sidebarHeaderTitleRow}>
                <div className={styles.sidebarHeaderTitle}>WORKSPACES</div>
                <span className={styles.sidebarHeaderCount}>{rows.length}</span>
              </div>
            </div>
          </div>
          <div ref={sidebarRef} className={styles.sidebarScroll}>
            {rows.length === 0 ? (
              <div
                className={styles.paletteEmpty}
                style={{ margin: "10px", marginTop: "20px" }}
              >
                <div style={{ marginBottom: "6px" }}>No workspaces</div>
                <div style={{ fontSize: "0.769rem", opacity: 0.6 }}>
                  Press Cmd/Ctrl + N or +
                </div>
              </div>
            ) : (
              <div
                className={styles.virtualBody}
                style={{
                  height: rowVirtualizer.getTotalSize()
                }}
              >
                {rowVirtualizer.getVirtualItems().map((item) => {
                  const row = rows[item.index];
                  return (
                    <div
                      key={row.workspaceId}
                      className={styles.virtualItem}
                      data-index={item.index}
                      data-workspace-virtual-item=""
                      ref={rowVirtualizer.measureElement}
                      style={{
                        transform: `translateY(${item.start}px)`
                      }}
                    >
                      <WorkspaceCard
                        row={row}
                        displayName={
                          row.nameLocked ? row.name : "new workspace"
                        }
                        shortcutHint={
                          props.showWorkspaceShortcutHints && item.index < 9
                            ? `⌘${item.index + 1}`
                            : undefined
                        }
                        editing={props.editingWorkspaceId === row.workspaceId}
                        expanded={row.workspaceId === props.activeWorkspace.id}
                        menuOpen={
                          props.workspaceContextMenuWorkspaceId ===
                          row.workspaceId
                        }
                        status={
                          row.workspaceId === props.activeWorkspace.id
                            ? props.activeWorkspace.sidebarStatus
                            : undefined
                        }
                        progress={
                          row.workspaceId === props.activeWorkspace.id
                            ? props.activeWorkspace.progress
                            : undefined
                        }
                        latestLog={
                          row.workspaceId === props.activeWorkspace.id
                            ? props.activeWorkspace.logs[0]
                            : undefined
                        }
                        onSelect={() =>
                          props.onSelectWorkspace(row.workspaceId)
                        }
                        onRenameStart={() =>
                          props.onStartRename(row.workspaceId)
                        }
                        onOpenContextMenu={(position) =>
                          props.onOpenContextMenu(
                            row.workspaceId,
                            position.x,
                            position.y
                          )
                        }
                        onRename={(name) =>
                          props.onRenameWorkspace(row.workspaceId, name)
                        }
                        dragging={props.dragWorkspaceId === row.workspaceId}
                        dropPosition={
                          props.dropWorkspaceId === row.workspaceId
                            ? props.dropPosition
                            : null
                        }
                        onDragStart={() =>
                          props.onDragStartWorkspace(row.workspaceId)
                        }
                        onDragTarget={(position) =>
                          props.onDragTargetWorkspace(row.workspaceId, position)
                        }
                        onDragLeave={() =>
                          props.onDragLeaveWorkspace(row.workspaceId)
                        }
                        onDrop={(position) =>
                          props.onDropWorkspace(row.workspaceId, position)
                        }
                        onDragEnd={props.onDragEndWorkspace}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </aside>
      <div
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuenow={props.sidebarWidth}
        className={styles.sidebarResizer}
        data-active={props.sidebarResizeActive}
        data-testid="sidebar-resizer"
        onKeyDown={props.onSidebarResizeKeyDown}
        onPointerDown={props.onSidebarResizePointerDown}
        role="separator"
        tabIndex={0}
      />
    </>
  );
}, areWorkspaceSidebarPropsEqual);

function areWorkspaceSidebarPropsEqual(
  left: WorkspaceSidebarProps,
  right: WorkspaceSidebarProps
): boolean {
  return (
    left.workspaceRows === right.workspaceRows &&
    left.activeWorkspace === right.activeWorkspace &&
    left.sidebarWidth === right.sidebarWidth &&
    left.renderedSidebarWidth === right.renderedSidebarWidth &&
    left.showWorkspaceShortcutHints === right.showWorkspaceShortcutHints &&
    left.editingWorkspaceId === right.editingWorkspaceId &&
    left.workspaceContextMenuWorkspaceId === right.workspaceContextMenuWorkspaceId &&
    left.dragWorkspaceId === right.dragWorkspaceId &&
    left.dropWorkspaceId === right.dropWorkspaceId &&
    left.dropPosition === right.dropPosition &&
    left.sidebarResizeActive === right.sidebarResizeActive
  );
}

function estimateWorkspaceRowHeight(
  row: WorkspaceRowVm | undefined,
  activeWorkspace: ActiveWorkspaceActivityVm | undefined
): number {
  if (!row) {
    return 100;
  }

  const isActive = row.workspaceId === activeWorkspace?.id;
  let height = 100;

  if (isActive && row.ports.length > 0) {
    height += 27;
  }

  if (
    !isActive &&
    (row.statusEntries ?? []).some(
      (entry) => entry.variant === "attention" || entry.variant === "error"
    )
  ) {
    height += 29;
  }

  if (isActive) {
    if (
      (activeWorkspace?.statusEntries.length ?? 0) > 0 ||
      activeWorkspace?.sidebarStatus
    ) {
      height += 29;
    }
    if (activeWorkspace?.progress) {
      height += 39;
    }
    if (activeWorkspace?.logs[0]) {
      height += 24;
    }
  }

  return height;
}

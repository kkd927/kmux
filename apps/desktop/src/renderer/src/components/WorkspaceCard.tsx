import type {
  SidebarLogEntry,
  SidebarProgress,
  WorkspaceRowVm
} from "@kmux/proto";

import styles from "../styles/App.module.css";
import {Codicon} from "./Codicon";

interface WorkspaceCardProps {
  row: WorkspaceRowVm;
  displayName: string;
  shortcutHint?: string;
  editing: boolean;
  expanded: boolean;
  menuOpen: boolean;
  status?: string;
  progress?: SidebarProgress;
  latestLog?: SidebarLogEntry;
  dragging: boolean;
  dropPosition: "before" | "after" | null;
  onSelect: () => void;
  onRenameStart: () => void;
  onOpenContextMenu: (position: { x: number; y: number }) => void;
  onRename: (name: string) => void;
  onDragStart: () => void;
  onDragTarget: (position: "before" | "after") => void;
  onDragLeave: () => void;
  onDrop: (position: "before" | "after") => void;
  onDragEnd: () => void;
}

export function WorkspaceCard(props: WorkspaceCardProps): JSX.Element {
  const summaryText = props.row.summary.trim() || "Waiting for input";
  const pathText = props.row.cwd?.trim() || "-";
  const branchText = props.row.branch?.trim() || "-";
  const showBranchIcon = Boolean(props.row.branch?.trim());
  const statusText = (props.status ?? props.row.statusText)?.trim() ?? "";
  const showStatus = Boolean(statusText);
  const showShortcut = Boolean(props.shortcutHint);
  const showMeta = props.expanded && props.row.ports.length > 0;
  const showAux =
    props.expanded && Boolean(showStatus || props.progress || props.latestLog);

  return (
    <button
      className={styles.workspaceCard}
      data-workspace-id={props.row.workspaceId}
      data-active={props.row.isActive}
      data-menu-open={props.menuOpen}
      data-dragging={props.dragging}
      data-drop-position={props.dropPosition ?? undefined}
      draggable={!props.editing}
      onClick={props.onSelect}
      onDoubleClick={props.onRenameStart}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onOpenContextMenu({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (
          props.editing ||
          event.target instanceof HTMLInputElement ||
          !(
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          )
        ) {
          return;
        }
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        props.onOpenContextMenu({
          x: rect.right - 12,
          y: rect.top + 14
        });
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", props.row.workspaceId);
        props.onDragStart();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const position =
          event.clientY >= rect.top + rect.height / 2 ? "after" : "before";
        props.onDragTarget(position);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          props.onDragLeave();
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const position =
          event.clientY >= rect.top + rect.height / 2 ? "after" : "before";
        props.onDrop(position);
      }}
      onDragEnd={props.onDragEnd}
    >
      <div className={styles.workspaceCardHeader}>
        <div className={styles.workspaceTextBlock}>
          <div className={styles.workspaceTitleRow}>
            {props.editing ? (
              <input
                autoFocus
                defaultValue={props.row.name}
                onFocus={(event) => event.currentTarget.select()}
                onBlur={(event) => props.onRename(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    props.onRename((event.target as HTMLInputElement).value);
                  }
                }}
              />
            ) : (
              <span className={styles.workspaceTitle}>{props.displayName}</span>
            )}
            <div className={styles.workspaceMetrics}>
              {props.row.pinned ? (
                <span className={styles.workspacePinned}>PIN</span>
              ) : null}
              {props.row.unreadCount > 0 ? (
                <span className={styles.workspaceUnread}>
                  {props.row.unreadCount}
                </span>
              ) : null}
            </div>
          </div>
          <div className={styles.workspaceSummaryRow}>
            <span
              className={styles.workspaceSummary}
              data-workspace-summary=""
            >
              {summaryText}
            </span>
          </div>
          <div className={styles.workspacePathRow}>
            <div className={styles.workspacePath} data-workspace-path="">
              {pathText}
            </div>
          </div>
          <div
            className={`${styles.workspacePathRow} ${styles.workspaceBranchRow}`}
            data-workspace-branch-row=""
          >
            {showBranchIcon ? (
              <span className={styles.workspaceMetaIcon} data-workspace-branch-icon="">
                <Codicon name="git-branch" />
              </span>
            ) : null}
            <div
              className={`${styles.workspacePath} ${
                showShortcut ? styles.workspacePathWithShortcut : ""
              }`}
              data-workspace-branch=""
            >
              {branchText}
            </div>
            {showShortcut ? (
              <span
                className={styles.workspaceShortcutHint}
                data-workspace-shortcut=""
              >
                {props.shortcutHint}
              </span>
            ) : null}
          </div>
          {showMeta ? (
            <div className={styles.workspaceMeta}>
              {props.row.ports.map((port) => (
                <span key={port} className={styles.workspaceMetaChip}>
                  :{port}
                </span>
              ))}
            </div>
          ) : null}
          {showAux ? (
            <div className={styles.workspaceAux}>
              {showStatus ? (
                <div className={styles.statusPill}>{statusText}</div>
              ) : null}
              {props.progress ? (
                <div className={styles.workspaceProgress}>
                  <div className={styles.workspaceProgressLabel}>
                    {props.progress.label ?? "Progress"}
                  </div>
                  <div className={styles.progressTrack}>
                    <div
                      className={styles.progressFill}
                      style={{ width: `${props.progress.value * 100}%` }}
                    />
                  </div>
                </div>
              ) : null}
              {props.latestLog ? (
                <div
                  className={styles.workspaceLog}
                  data-level={props.latestLog.level}
                >
                  <span>{props.latestLog.level}</span>
                  <span>{props.latestLog.message}</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </button>
  );
}

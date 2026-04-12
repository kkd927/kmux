import type { Ref } from "react";

import type {
  WorkspaceContextAction,
  WorkspaceContextMenuEntry
} from "../../../shared/workspaceContextMenu";
import { formatShortcutLabel } from "../shortcutLabels";
import { Codicon } from "./Codicon";
import styles from "../styles/App.module.css";

interface WorkspaceContextMenuProps {
  workspaceName: string;
  position: { x: number; y: number };
  items: WorkspaceContextMenuEntry[];
  isMac: boolean;
  menuRef: Ref<HTMLDivElement>;
  onClose: () => void;
  onAction: (action: WorkspaceContextAction) => void;
}

export function WorkspaceContextMenu(
  props: WorkspaceContextMenuProps
): JSX.Element {
  return (
    <div
      className={styles.menuOverlay}
      onClick={props.onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <div
        className={styles.workspaceMenu}
        ref={props.menuRef}
        role="menu"
        aria-label={`Workspace menu for ${props.workspaceName}`}
        style={{
          left: props.position.x,
          top: props.position.y
        }}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
            return;
          }

          const enabledItems = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              'button[role="menuitem"]:not(:disabled)'
            )
          );
          if (!enabledItems.length) {
            return;
          }

          const currentIndex = enabledItems.findIndex(
            (item) => item === document.activeElement
          );

          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            const nextIndex =
              currentIndex === -1
                ? step > 0
                  ? 0
                  : enabledItems.length - 1
                : (currentIndex + step + enabledItems.length) %
                  enabledItems.length;
            enabledItems[nextIndex]?.focus();
            return;
          }

          if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            enabledItems[event.key === "Home" ? 0 : enabledItems.length - 1]
              ?.focus();
          }
        }}
      >
        {props.items.map((item) =>
          item.kind === "separator" ? (
            <div
              key={item.id}
              className={styles.workspaceMenuSeparator}
              role="separator"
            />
          ) : (
            <button
              key={item.id}
              role="menuitem"
              className={styles.workspaceMenuItem}
              disabled={item.disabled}
              data-checked={item.checked ? "true" : undefined}
              onClick={() => props.onAction(item.action)}
            >
              <span
                className={styles.workspaceMenuCheck}
                data-empty={!item.checked}
                aria-hidden="true"
              >
                {item.checked ? <Codicon name="check" /> : null}
              </span>
              <span className={styles.workspaceMenuLabel}>{item.label}</span>
              {item.shortcut ? (
                <span
                  className={styles.workspaceMenuShortcut}
                  aria-hidden="true"
                >
                  {formatShortcutLabel(item.shortcut, props.isMac)}
                </span>
              ) : null}
            </button>
          )
        )}
      </div>
    </div>
  );
}

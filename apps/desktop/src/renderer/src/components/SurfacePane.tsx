import { useRef, type MouseEvent } from "react";

import { Codicon } from "./Codicon";
import { SurfaceUsageAlertDot } from "./SurfaceUsageAlertDot";
import type { SurfacePaneProps } from "../surfaces/contracts";
import {
  surfaceTabChrome,
  surfaceViewModules,
  surfaceViewProps
} from "../surfaces/registry";
import {
  encodeSurfaceTabDragPayload,
  SURFACE_TAB_DRAG_MIME
} from "../surfaceTabDrag";
import styles from "../styles/TerminalPane.module.css";

export type { SurfacePaneProps } from "../surfaces/contracts";

export function SurfacePane(props: SurfacePaneProps): JSX.Element {
  const activeSurface =
    props.surfaces.find((surface) => surface.id === props.activeSurfaceId) ??
    props.surfaces[0];
  const activeSurfaceByKindRef = useRef(new Map<string, string>());
  activeSurfaceByKindRef.current.set(
    activeSurface.content.kind,
    activeSurface.id
  );
  async function openSurfaceContextMenu(
    event: MouseEvent,
    surfaceId: string
  ): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const surface = props.surfaces.find((entry) => entry.id === surfaceId);
    if (!surface) return;
    const context = surfaceTabChrome(surface, props.settings).contextMenu;
    if (!context) return;
    try {
      await window.kmux.showSurfaceContextMenu(
        surfaceId,
        event.clientX,
        event.clientY,
        context
      );
    } catch (error) {
      console.warn("Failed to show surface context menu", error);
    }
  }

  return (
    <div
      className={styles.pane}
      data-pane-id={props.paneId}
      data-active-surface-id={activeSurface.id}
      data-focused={props.focused}
      tabIndex={-1}
      onMouseDown={() => props.onFocusPane(props.paneId)}
    >
      <div className={styles.header}>
        <div
          className={styles.tabs}
          role="tablist"
          aria-label={`Pane ${props.paneId} surfaces`}
          onWheel={(event) => {
            if (event.deltaY !== 0) {
              event.currentTarget.scrollBy({
                left: event.deltaY,
                behavior: "auto"
              });
            }
          }}
        >
          {props.surfaces.map((surface) => {
            const selected = surface.id === props.activeSurfaceId;
            const active = selected && props.focused;
            const chrome = surfaceTabChrome(surface, props.settings);
            const Icon = chrome.Icon;
            return (
              <div
                key={surface.id}
                className={styles.tabItem}
                data-selected={selected}
                data-active={active}
                data-surface-id={surface.id}
                onContextMenu={(event) => {
                  void openSurfaceContextMenu(event, surface.id);
                }}
              >
                <button
                  className={styles.tab}
                  role="tab"
                  aria-selected={selected}
                  aria-label={`Focus surface ${surface.title}`}
                  onClick={() => props.onFocusSurface(surface.id)}
                  draggable
                  onDragStart={(event) => {
                    const payload = {
                      surfaceId: surface.id,
                      sourcePaneId: props.paneId
                    };
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData(
                      SURFACE_TAB_DRAG_MIME,
                      encodeSurfaceTabDragPayload(payload)
                    );
                    event.dataTransfer.setData("text/plain", surface.id);
                    props.onSurfaceTabDragStart(payload);
                  }}
                  onDragEnd={props.onSurfaceTabDragEnd}
                  title={chrome.title}
                >
                  <span className={styles.tabIcon}>
                    <Icon />
                  </span>
                  <span className={styles.tabLabel}>{surface.title}</span>
                  <SurfaceUsageAlertDot
                    fallbackVisible={
                      surface.attention || surface.unreadCount > 0
                    }
                  />
                  {surface.unreadCount > 0 ? (
                    <span
                      className={styles.badge}
                      data-testid={`surface-unread-badge-${surface.id}`}
                    >
                      {surface.unreadCount}
                    </span>
                  ) : null}
                </button>
                <button
                  className={styles.tabClose}
                  aria-label={`Close tab ${surface.title}`}
                  title={`Close tab ${surface.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onCloseSurface(surface.id);
                  }}
                >
                  <Codicon name="close" />
                </button>
              </div>
            );
          })}
        </div>
        <div className={styles.headerTrailing}>
          <div className={styles.controls}>
            <button
              title="New tab"
              aria-label="Create new tab"
              onClick={() => props.onCreateSurface(props.paneId)}
            >
              <Codicon name="add" />
            </button>
            <button
              title="Split right"
              aria-label="Split active pane right"
              onClick={() => props.onSplitRight(props.paneId)}
            >
              <Codicon name="split-horizontal" />
            </button>
            <button
              title="Split down"
              aria-label="Split active pane down"
              onClick={() => props.onSplitDown(props.paneId)}
            >
              <Codicon name="split-vertical" />
            </button>
            <button
              title="Close pane"
              aria-label="Close active pane"
              onClick={() => props.onClosePane(props.paneId)}
            >
              <Codicon name="close" />
            </button>
          </div>
        </div>
      </div>
      {surfaceViewModules.map((module) => {
        const viewProps = surfaceViewProps(
          module,
          props,
          activeSurface,
          activeSurfaceByKindRef.current.get(module.kind)
        );
        if (!viewProps) return null;
        const View = module.Component;
        return (
          <div
            key={module.kind}
            style={
              viewProps.visible ? { display: "contents" } : { display: "none" }
            }
          >
            <View {...viewProps} />
          </div>
        );
      })}
    </div>
  );
}

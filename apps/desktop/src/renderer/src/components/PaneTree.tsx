import { memo, useEffect, useRef } from "react";

import type {
  ActiveWorkspacePaneTreeVm,
  Id,
  KmuxSettings,
  ResolvedTerminalThemeVm,
  ResolvedTerminalTypographyVm
} from "@kmux/proto";
import type { ColorTheme } from "@kmux/ui";

import type {
  KeyChord,
  PlatformKeyboardPolicy
} from "../../../shared/platform/keyboardPolicy";
import styles from "../styles/PaneTree.module.css";
import { useSmoothnessRenderCounter } from "../hooks/useSmoothnessRenderCounter";
import {
  beginPaneDividerDrag,
  endPaneDividerDrag
} from "../paneDividerDrag";
import { recordRendererSmoothnessProfileEvent } from "../smoothnessProfile";
import type {
  SurfaceTabDragPayload,
  SurfaceTabDropDirection
} from "../surfaceTabDrag";
import { TerminalPane, type TerminalFocusRequest } from "./TerminalPane";

export interface PaneTreeProps {
  workspace: ActiveWorkspacePaneTreeVm;
  active: boolean;
  settings: KmuxSettings;
  reservedSystemChords: KeyChord[];
  keyboardPlatform: PlatformKeyboardPolicy["platform"];
  shortcutLabelStyle: PlatformKeyboardPolicy["labelStyle"];
  copyModeSelectAllShortcut: KeyChord;
  terminalTypography: ResolvedTerminalTypographyVm;
  terminalTheme: ResolvedTerminalThemeVm;
  colorTheme: ColorTheme;
  searchSurfaceId: string | null;
  terminalFocusRequest?: TerminalFocusRequest | null;
  draggedSurfaceTab: SurfaceTabDragPayload | null;
  onSetSplitRatio: (splitNodeId: string, ratio: number) => void;
  onFocusPane: (paneId: string) => void;
  onFocusSurface: (surfaceId: string) => void;
  onCreateSurface: (paneId: string) => void;
  onCloseSurface: (surfaceId: string) => void;
  onCloseOthers: (surfaceId: string) => void;
  onMoveSurfaceToSplit: (
    surfaceId: string,
    targetPaneId: string,
    direction: SurfaceTabDropDirection
  ) => void;
  onSurfaceTabDragStart: (payload: SurfaceTabDragPayload) => void;
  onSurfaceTabDragEnd: () => void;
  onSplitRight: (paneId: string) => void;
  onSplitDown: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onRestartSurface: (surfaceId: string) => void;
  onToggleSearch: (surfaceId: string | null) => void;
}

export const PaneTree = memo(function PaneTree(
  props: PaneTreeProps
): JSX.Element {
  useSmoothnessRenderCounter("pane-tree.render", () => ({
    workspaceId: props.workspace.id,
    paneCount: Object.keys(props.workspace.panes).length,
    surfaceCount: Object.keys(props.workspace.surfaces).length
  }));
  return (
    <div className={styles.tree} data-active={props.active ? "true" : "false"}>
      <PaneNode nodeId={props.workspace.rootNodeId} {...props} />
    </div>
  );
}, arePaneTreePropsEqual);

function arePaneTreePropsEqual(
  left: PaneTreeProps,
  right: PaneTreeProps
): boolean {
  const equal =
    left.workspace === right.workspace &&
    left.active === right.active &&
    left.settings === right.settings &&
    left.reservedSystemChords === right.reservedSystemChords &&
    left.keyboardPlatform === right.keyboardPlatform &&
    left.shortcutLabelStyle === right.shortcutLabelStyle &&
    left.copyModeSelectAllShortcut === right.copyModeSelectAllShortcut &&
    left.terminalTypography === right.terminalTypography &&
    left.terminalTheme === right.terminalTheme &&
    left.colorTheme === right.colorTheme &&
    left.searchSurfaceId === right.searchSurfaceId &&
    left.terminalFocusRequest === right.terminalFocusRequest &&
    left.draggedSurfaceTab === right.draggedSurfaceTab;
  if (equal) {
    recordRendererSmoothnessProfileEvent("pane-tree.memo-skip", {
      workspaceId: left.workspace.id
    });
  }
  return equal;
}

function PaneNode(
  props: PaneTreeProps & {
    nodeId: Id;
  }
): JSX.Element {
  const node = props.workspace.nodes[props.nodeId];
  if (!node) {
    return <div className={styles.invalidPane}>Pane unavailable</div>;
  }
  if (node.kind === "leaf") {
    const pane = props.workspace.panes[node.paneId];
    if (!pane) {
      return <div className={styles.invalidPane}>Pane unavailable</div>;
    }
    const surfaces = pane.surfaceIds.map(
      (surfaceId) => props.workspace.surfaces[surfaceId]
    );
    if (surfaces.length === 0 || surfaces.some((surface) => !surface)) {
      return <div className={styles.invalidPane}>Pane unavailable</div>;
    }
    return (
      <TerminalPane
        paneId={pane.id}
        focused={pane.focused}
        active={props.active}
        surfaces={surfaces}
        activeSurfaceId={pane.activeSurfaceId}
        settings={props.settings}
        reservedSystemChords={props.reservedSystemChords}
        keyboardPlatform={props.keyboardPlatform}
        shortcutLabelStyle={props.shortcutLabelStyle}
        copyModeSelectAllShortcut={props.copyModeSelectAllShortcut}
        terminalTypography={props.terminalTypography}
        terminalTheme={props.terminalTheme}
        colorTheme={props.colorTheme}
        showSearch={props.searchSurfaceId === pane.activeSurfaceId}
        focusRequest={props.terminalFocusRequest}
        draggedSurfaceTab={props.draggedSurfaceTab}
        onFocusPane={props.onFocusPane}
        onFocusSurface={props.onFocusSurface}
        onCreateSurface={props.onCreateSurface}
        onCloseSurface={props.onCloseSurface}
        onCloseOthers={props.onCloseOthers}
        onMoveSurfaceToSplit={props.onMoveSurfaceToSplit}
        onSurfaceTabDragStart={props.onSurfaceTabDragStart}
        onSurfaceTabDragEnd={props.onSurfaceTabDragEnd}
        onSplitRight={props.onSplitRight}
        onSplitDown={props.onSplitDown}
        onClosePane={props.onClosePane}
        onRestartSurface={props.onRestartSurface}
        onToggleSearch={props.onToggleSearch}
      />
    );
  }

  const orientationClass =
    node.axis === "vertical" ? styles.vertical : styles.horizontal;

  return (
    <div className={`${styles.split} ${orientationClass}`}>
      <div className={styles.child} style={{ flex: `${node.ratio} 1 0` }}>
        <PaneNode {...props} nodeId={node.first} />
      </div>
      <SplitDivider
        axis={node.axis}
        ratio={node.ratio}
        onChange={(ratio) => props.onSetSplitRatio(node.id, ratio)}
      />
      <div className={styles.child} style={{ flex: `${1 - node.ratio} 1 0` }}>
        <PaneNode {...props} nodeId={node.second} />
      </div>
    </div>
  );
}

// Mirrors the reducer clamp in packages/core setSplitRatio so the local drag
// preview can never show a layout the store would reject.
const SPLIT_RATIO_MIN = 0.1;
const SPLIT_RATIO_MAX = 0.9;

function clampSplitRatio(ratio: number): number {
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio));
}

function SplitDivider(props: {
  axis: "horizontal" | "vertical";
  ratio: number;
  onChange: (ratio: number) => void;
}): JSX.Element {
  const activeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      // If this divider unmounts mid-drag (e.g. closing a pane collapses
      // this split), the window pointerup/pointercancel/blur listeners may
      // never fire. Run the same cleanup unconditionally so the global drag
      // flag can't get stuck "active" and throttle every terminal's fits.
      activeCleanupRef.current?.();
    };
  }, []);

  return (
    <div
      className={
        props.axis === "vertical"
          ? styles.dividerVertical
          : styles.dividerHorizontal
      }
      data-split-axis={props.axis}
      role="separator"
      tabIndex={0}
      aria-label={
        props.axis === "vertical"
          ? "Resize panes horizontally"
          : "Resize panes vertically"
      }
      aria-orientation={props.axis === "vertical" ? "vertical" : "horizontal"}
      onPointerDown={(event) => {
        event.preventDefault();
        const divider = event.currentTarget;
        const target = divider.parentElement;
        const first = divider.previousElementSibling as HTMLElement | null;
        const second = divider.nextElementSibling as HTMLElement | null;
        if (!target || !first || !second) {
          return;
        }
        divider.setPointerCapture(event.pointerId);
        beginPaneDividerDrag();
        recordRendererSmoothnessProfileEvent("pane-divider.drag.start", {
          axis: props.axis
        });
        const rect = target.getBoundingClientRect();
        // Drag applies the ratio straight to the DOM so panes track the
        // pointer without a main-process round trip per move. The store is
        // only mutated through the reducer on commit (pointerup); when the
        // authoritative ratio comes back it re-renders to the same layout,
        // and any concurrent authoritative change wins over this preview.
        let draggedRatio: number | null = null;
        const applyPreviewRatio = (element: HTMLElement, ratio: number) => {
          element.style.flexGrow = String(ratio);
          element.style.flexShrink = "1";
          element.style.flexBasis = "0";
        };
        const move = (nextEvent: PointerEvent) => {
          const ratio =
            props.axis === "vertical"
              ? (nextEvent.clientX - rect.left) / rect.width
              : (nextEvent.clientY - rect.top) / rect.height;
          draggedRatio = clampSplitRatio(ratio);
          applyPreviewRatio(first, draggedRatio);
          applyPreviewRatio(second, 1 - draggedRatio);
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
          window.removeEventListener("blur", up);
          activeCleanupRef.current = null;
          if (draggedRatio !== null) {
            props.onChange(draggedRatio);
          }
          endPaneDividerDrag();
          recordRendererSmoothnessProfileEvent("pane-divider.drag.end", {
            axis: props.axis,
            ratio: draggedRatio ?? props.ratio
          });
        };
        activeCleanupRef.current = up;
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
        window.addEventListener("blur", up);
      }}
      onKeyDown={(event) => {
        const decrementKey =
          props.axis === "vertical" ? "ArrowLeft" : "ArrowUp";
        const incrementKey =
          props.axis === "vertical" ? "ArrowRight" : "ArrowDown";
        const step = event.shiftKey ? 0.08 : 0.04;

        if (event.key === decrementKey) {
          event.preventDefault();
          props.onChange(Math.max(0.05, props.ratio - step));
          return;
        }
        if (event.key === incrementKey) {
          event.preventDefault();
          props.onChange(Math.min(0.95, props.ratio + step));
          return;
        }
        if (event.key === "Home") {
          event.preventDefault();
          props.onChange(0.5);
        }
      }}
    />
  );
}

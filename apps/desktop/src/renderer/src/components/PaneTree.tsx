import type { ActiveWorkspaceVm, Id, KmuxSettings } from "@kmux/proto";

import styles from "../styles/PaneTree.module.css";
import { TerminalPane } from "./TerminalPane";

interface PaneTreeProps {
  workspace: ActiveWorkspaceVm;
  settings: KmuxSettings;
  searchSurfaceId: string | null;
  renameSurfaceRequest: { surfaceId: string; token: number } | null;
  focusTerminalRequest: { surfaceId: string; token: number } | null;
  onConsumeRenameSurfaceRequest: (token: number) => void;
  onConsumeFocusTerminalRequest: (token: number) => void;
  onSetSplitRatio: (splitNodeId: string, ratio: number) => void;
  onFocusPane: (paneId: string) => void;
  onFocusSurface: (surfaceId: string) => void;
  onRenameSurface: (surfaceId: string, title: string) => void;
  onCreateSurface: (paneId: string) => void;
  onCloseSurface: (surfaceId: string) => void;
  onCloseOthers: (surfaceId: string) => void;
  onSplitRight: (paneId: string) => void;
  onSplitDown: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onToggleSearch: (surfaceId: string | null) => void;
}

export function PaneTree(props: PaneTreeProps): JSX.Element {
  return (
    <div className={styles.tree}>
      <PaneNode nodeId={props.workspace.rootNodeId} {...props} />
    </div>
  );
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
        surfaces={surfaces}
        activeSurfaceId={pane.activeSurfaceId}
        settings={props.settings}
        showSearch={props.searchSurfaceId === pane.activeSurfaceId}
        renameSurfaceRequest={props.renameSurfaceRequest}
        focusTerminalRequest={props.focusTerminalRequest}
        onConsumeRenameSurfaceRequest={props.onConsumeRenameSurfaceRequest}
        onConsumeFocusTerminalRequest={props.onConsumeFocusTerminalRequest}
        onFocusPane={props.onFocusPane}
        onFocusSurface={props.onFocusSurface}
        onRenameSurface={props.onRenameSurface}
        onCreateSurface={props.onCreateSurface}
        onCloseSurface={props.onCloseSurface}
        onCloseOthers={props.onCloseOthers}
        onSplitRight={props.onSplitRight}
        onSplitDown={props.onSplitDown}
        onClosePane={props.onClosePane}
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

function SplitDivider(props: {
  axis: "horizontal" | "vertical";
  ratio: number;
  onChange: (ratio: number) => void;
}): JSX.Element {
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
        const target = event.currentTarget.parentElement;
        if (!target) {
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        const rect = target.getBoundingClientRect();
        const move = (nextEvent: PointerEvent) => {
          const ratio =
            props.axis === "vertical"
              ? (nextEvent.clientX - rect.left) / rect.width
              : (nextEvent.clientY - rect.top) / rect.height;
          props.onChange(ratio);
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
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

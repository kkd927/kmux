import type { ComponentType } from "react";
import type { KmuxSettings, SurfaceKind, SurfaceVm } from "@kmux/proto";

import { Codicon } from "../components/Codicon";
import {
  TerminalSurfaceView,
  type TerminalSurfaceViewProps
} from "./TerminalSurfaceView";
import type { SurfaceContextMenuContext } from "../../../shared/surfaceContextMenu";

export interface SurfaceViewModule<K extends SurfaceKind> {
  readonly kind: K;
  readonly Component: ComponentType<TerminalSurfaceViewProps>;
  readonly Icon: ComponentType;
  tabTitle(surface: SurfaceVm<K>): string;
  contextMenu?(
    surface: SurfaceVm<K>,
    settings: KmuxSettings
  ): SurfaceContextMenuContext;
}

const terminalSurfaceViewModule: SurfaceViewModule<"terminal"> = {
  kind: "terminal",
  Component: TerminalSurfaceView,
  Icon: () => <Codicon name="terminal" />,
  tabTitle: (surface) => surface.content.runtimeMetadata.cwd ?? surface.title,
  contextMenu: (surface, settings) => ({
    canCopy: true,
    canPaste: true,
    canRestart: surface.content.runtimeStatus !== "pending",
    sessionState: surface.content.runtimeStatus,
    settings: { shortcuts: settings.shortcuts }
  })
};

export const surfaceViewRegistry = {
  terminal: terminalSurfaceViewModule
} satisfies { [K in SurfaceKind]: SurfaceViewModule<K> };

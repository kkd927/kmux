import type {
  KmuxSettings,
  ResolvedTerminalThemeVm,
  ResolvedTerminalTypographyVm,
  SurfaceKind,
  SurfaceVm
} from "@kmux/proto";
import type { ColorTheme } from "@kmux/ui";

import type {
  KeyChord,
  KeyboardShortcutPlatform
} from "../../../shared/platform/keyboardPolicy";
import type { ShortcutLabelStyle } from "../shortcutLabels";
import type {
  SurfaceTabDragPayload,
  SurfaceTabDropDirection
} from "../surfaceTabDrag";
import type { TerminalFocusRequest } from "./TerminalSurfaceView";

export interface SurfacePaneProps {
  paneId: string;
  focused: boolean;
  surfaces: SurfaceVm[];
  activeSurfaceId: string;
  settings: KmuxSettings;
  reservedSystemChords: KeyChord[];
  keyboardPlatform: KeyboardShortcutPlatform;
  shortcutLabelStyle: ShortcutLabelStyle;
  copyModeSelectAllShortcut: KeyChord;
  terminalTypography: ResolvedTerminalTypographyVm;
  terminalTheme: ResolvedTerminalThemeVm;
  colorTheme: ColorTheme;
  showSearch: boolean;
  draggedSurfaceTab: SurfaceTabDragPayload | null;
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
  focusRequest?: TerminalFocusRequest | null;
}

export type SurfaceViewProps<K extends SurfaceKind> = Omit<
  SurfacePaneProps,
  "surfaces" | "activeSurfaceId"
> & {
  surface: SurfaceVm<K>;
  surfaces: SurfaceVm<K>[];
  visible: boolean;
};

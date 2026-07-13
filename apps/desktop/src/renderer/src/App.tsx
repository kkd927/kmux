import { useEffect, useMemo, useRef, useState } from "react";

import type { AppAction } from "@kmux/core";
import type { RendererPlatformDescriptor } from "../../shared/platform/rendererPlatform";
import { createFallbackRendererPlatformDescriptor } from "../../shared/platform/rendererPlatform";
import type {
  ImportedTerminalThemePalette,
  KmuxSettings,
  ResolvedTerminalTypographyVm,
  ShellStoreSnapshot,
  TerminalThemeProfile,
  TerminalThemeVariant,
  WorktreeConversionPreview,
  WorktreeDirtyEntryGroup,
  WorkspaceRowVm,
  WorkspaceWorktreeMetadata
} from "@kmux/proto";
import {
  applyThemeVariables,
  BUILTIN_TERMINAL_THEME_PROFILE_ID,
  cloneTerminalColorPalette,
  cloneTerminalThemeProfile,
  DEFAULT_TERMINAL_THEME_MINIMUM_CONTRAST_RATIO,
  isBuiltinTerminalThemeProfileId,
  type ColorTheme,
  resolveColorTheme,
  resolveTerminalTheme,
  sanitizeTerminalThemeSettings
} from "@kmux/ui";

import { AppOverlays } from "./components/AppOverlays";
import { Codicon } from "./components/Codicon";
import { PaneTree } from "./components/PaneTree";
import { RightSidebarHost } from "./components/RightSidebarHost";
import { TitlebarUpdateAction } from "./components/TitlebarUpdateAction";
import { TitlebarWindowControls } from "./components/TitlebarWindowControls";
import { UsageDashboard } from "./components/UsageDashboard";
import { ExternalSessionsPanelContainer } from "./components/ExternalSessionsPanel";
import {
  applyProbeIssuesToResolvedTypography,
  probeResolvedTerminalTypography
} from "./terminalTypography";
import {
  determinePaneCloseStrategy,
  determineSurfaceCloseStrategy
} from "./surfaceCloseStrategy";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useShellSelector, useShellSnapshotRef } from "./hooks/useShellStore";
import { useTerminalInstanceCleanup } from "./hooks/useTerminalInstanceCleanup";
import {
  clampSidebarWidthForWindow,
  MAX_SIDEBAR_WIDTH,
  useSidebarResize
} from "./hooks/useSidebarResize";
import { useWorkspaceContextMenu } from "./hooks/useWorkspaceContextMenu";
import {
  findWorkspaceContext,
  runWorkspaceContextAction as runSharedWorkspaceContextAction,
  type WorkspaceContextAction
} from "../../shared/workspaceContextMenu";
import type {
  SurfaceTabDragPayload,
  SurfaceTabDropDirection
} from "./surfaceTabDrag";
import * as terminalInstanceStore from "./terminalInstanceStore";
import { terminalStreamClient } from "./terminalStreamClient";
import styles from "./styles/App.module.css";

type ActiveShortcutContext = {
  view: ShellStoreSnapshot;
  activePaneId: string;
  activeSurfaceId: string;
};
type RightPanelKind = "usage" | "sessions" | null;
type DismissibleUiState = {
  paletteOpen: boolean;
  notificationsOpen: boolean;
  settingsOpen: boolean;
  searchSurfaceId: string | null;
  workspaceContextMenuOpen: boolean;
  workspaceCloseConfirmOpen: boolean;
  surfaceRestartConfirmOpen: boolean;
  worktreeDialogOpen: boolean;
};

type PendingWorkspaceClose = {
  workspaceId: string;
  closeWorkspaceIds?: string[];
  isLastWorkspace: boolean;
  worktree?: WorkspaceWorktreeMetadata;
  worktrees?: Array<{
    workspaceId: string;
    worktree: WorkspaceWorktreeMetadata;
  }>;
  removeWorktree: boolean;
  dirtyEntries?: string[];
  dirtyWorktrees?: WorktreeDirtyEntryGroup[];
  error?: string | null;
  busy?: boolean;
};

type PendingSurfaceRestart = {
  surfaceId: string;
  sessionId: string;
  title: string;
};

type WorktreeConversionDialog =
  | {
      kind: "create";
      workspaceId: string;
      preview: WorktreeConversionPreview;
      name: string;
      error?: string | null;
      busy?: boolean;
    }
  | {
      kind: "detected";
      workspaceId: string;
      row: WorkspaceRowVm;
      error?: string | null;
      busy?: boolean;
    };

const EMPTY_WORKSPACE_ROWS: ShellStoreSnapshot["workspaceRows"] = [];
const EMPTY_NOTIFICATIONS: ShellStoreSnapshot["notifications"] = [];
const forgetTerminalStreamSurface = (surfaceId: string): void => {
  terminalStreamClient.forgetSurface(surfaceId);
};
const RIGHT_PANEL_TABS = [
  { key: "usage", label: "Usage" },
  { key: "sessions", label: "Sessions" }
] as const;

export function App(): JSX.Element {
  const shellReady = useShellSelector((snapshot) => snapshot !== null);
  const sidebarVisible = useShellSelector(
    (snapshot) => snapshot?.sidebarVisible ?? true
  );
  const sidebarWidth = useShellSelector(
    (snapshot) => snapshot?.sidebarWidth ?? MAX_SIDEBAR_WIDTH
  );
  const workspaceRows = useShellSelector(
    (snapshot) => snapshot?.workspaceRows ?? EMPTY_WORKSPACE_ROWS
  );
  const activeWorkspace = useShellSelector(
    (snapshot) => snapshot?.activeWorkspace ?? null
  );
  const activeWorkspacePaneTree = useShellSelector(
    (snapshot) => snapshot?.activeWorkspacePaneTree ?? null
  );
  const notifications = useShellSelector(
    (snapshot) => snapshot?.notifications ?? EMPTY_NOTIFICATIONS
  );
  const unreadNotifications = useShellSelector(
    (snapshot) => snapshot?.unreadNotifications ?? 0
  );
  const settings = useShellSelector((snapshot) => snapshot?.settings ?? null);
  const terminalTypography = useShellSelector(
    (snapshot) => snapshot?.terminalTypography ?? null
  );
  const [platformDescriptor, setPlatformDescriptor] =
    useState<RendererPlatformDescriptor>(() =>
      createFallbackRendererPlatformDescriptor(
        navigator.userAgent.includes("Mac") ? "darwin" : "other"
      )
    );
  const isMac = platformDescriptor.shortcutStyle === "mac-symbols";
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteSelectedIndex, setPaletteSelectedIndex] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [activeRightPanel, setActiveRightPanel] =
    useState<RightPanelKind>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchSurfaceId, setSearchSurfaceId] = useState<string | null>(null);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(
    null
  );
  const [dragWorkspaceId, setDragWorkspaceId] = useState<string | null>(null);
  const [dropWorkspaceId, setDropWorkspaceId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<"before" | "after" | null>(
    null
  );
  const [draggedSurfaceTab, setDraggedSurfaceTab] =
    useState<SurfaceTabDragPayload | null>(null);
  const [showWorkspaceShortcutHints, setShowWorkspaceShortcutHints] =
    useState(false);
  const terminalFocusRequestTokenRef = useRef(0);
  const [terminalFocusRequest, setTerminalFocusRequest] = useState<{
    surfaceId: string;
    token: number;
  } | null>(null);
  const [sidebarResizeActive, setSidebarResizeActive] = useState(false);
  const sidebarElementRef = useRef<HTMLElement | null>(null);
  const [windowWidth, setWindowWidth] = useState(
    () => document.documentElement.clientWidth || window.innerWidth
  );
  const [prefersDarkColorScheme, setPrefersDarkColorScheme] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  const [settingsDraft, setSettingsDraft] = useState<KmuxSettings>();
  const [
    settingsTerminalTypographyPreview,
    setSettingsTerminalTypographyPreview
  ] = useState<ResolvedTerminalTypographyVm | null>(null);
  const [settingsThemeNotice, setSettingsThemeNotice] = useState<string | null>(
    null
  );
  const [pendingWorkspaceClose, setPendingWorkspaceClose] =
    useState<PendingWorkspaceClose | null>(null);
  const [pendingSurfaceRestart, setPendingSurfaceRestart] =
    useState<PendingSurfaceRestart | null>(null);
  const [worktreeDialog, setWorktreeDialog] =
    useState<WorktreeConversionDialog | null>(null);
  const usageDashboardOpen = activeRightPanel === "usage";
  const rightPanelOpen = activeRightPanel !== null;
  const viewRef = useShellSnapshotRef();
  const reportedTypographyStacksRef = useRef(new Set<string>());
  const dismissedDetectedWorktreesRef = useRef(new Set<string>());
  const dismissibleUiStateRef = useRef<DismissibleUiState>({
    paletteOpen,
    notificationsOpen,
    settingsOpen,
    searchSurfaceId,
    workspaceContextMenuOpen: false,
    workspaceCloseConfirmOpen: false,
    surfaceRestartConfirmOpen: false,
    worktreeDialogOpen: false
  });
  useEffect(() => {
    void window.kmux.setUsageDashboardOpen(usageDashboardOpen);
  }, [usageDashboardOpen]);

  useEffect(() => {
    setDraggedSurfaceTab(null);
  }, [activeWorkspacePaneTree?.id]);

  useTerminalInstanceCleanup({
    forgetTerminalStreamSurface,
    releaseTerminalSurface: terminalInstanceStore.release
  });

  useEffect(() => {
    if (!pendingWorkspaceClose || !shellReady) {
      return;
    }

    if (
      !workspaceRows.some(
        (row) => row.workspaceId === pendingWorkspaceClose.workspaceId
      )
    ) {
      setPendingWorkspaceClose(null);
    }
  }, [pendingWorkspaceClose, shellReady, workspaceRows]);

  useEffect(() => {
    return window.kmux.subscribeWorkspaceWorktreeConvertRequest(
      (workspaceId) => {
        void openWorktreeConversionDialog(workspaceId);
      }
    );
  }, []);

  useEffect(() => {
    return window.kmux.subscribeWorkspaceCloseRequest((workspaceId) => {
      void requestWorkspaceClose(workspaceId);
    });
  }, []);

  useEffect(() => {
    return window.kmux.subscribeWorkspaceCloseOthersRequest((workspaceId) => {
      void requestCloseOtherWorkspaces(workspaceId);
    });
  }, []);

  useEffect(() => {
    const activeRow = workspaceRows.find((row) => row.isActive);
    const detected = activeRow?.detectedWorktree;
    if (!activeRow || !detected || activeRow.worktree || worktreeDialog) {
      return;
    }
    const key = detectedWorktreeDismissKey(
      activeRow.workspaceId,
      detected.path
    );
    if (dismissedDetectedWorktreesRef.current.has(key)) {
      return;
    }

    const timer = window.setTimeout(() => {
      setWorktreeDialog(
        (current) =>
          current ?? {
            kind: "detected",
            workspaceId: activeRow.workspaceId,
            row: activeRow
          }
      );
    }, 350);
    return () => window.clearTimeout(timer);
  }, [workspaceRows, worktreeDialog]);

  useEffect(() => {
    void window.kmux
      .getPlatform()
      .then(setPlatformDescriptor)
      .catch((error: unknown) => {
        console.warn("[platform:get]", error);
      });
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const updatePreference = (
      event: MediaQueryListEvent | MediaQueryList
    ): void => {
      setPrefersDarkColorScheme(event.matches);
    };

    updatePreference(mediaQuery);
    const listener = (event: MediaQueryListEvent) => updatePreference(event);
    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
  }, []);

  useEffect(() => {
    const updateWindowWidth = () => {
      const nextWidth =
        document.documentElement.clientWidth || window.innerWidth;
      setWindowWidth((currentWidth) =>
        currentWidth === nextWidth ? currentWidth : nextWidth
      );
    };

    updateWindowWidth();
    const resizeObserver = new ResizeObserver(() => {
      updateWindowWidth();
    });
    resizeObserver.observe(document.documentElement);
    window.addEventListener("resize", updateWindowWidth);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateWindowWidth);
    };
  }, []);

  useEffect(() => {
    if (!settings || !terminalTypography) {
      return;
    }
    applyAppearanceSettings(
      settings,
      terminalTypography,
      prefersDarkColorScheme
    );
  }, [
    settings?.themeMode,
    settings?.terminalTypography?.fontSize,
    settings?.terminalTypography?.lineHeight,
    terminalTypography?.resolvedFontFamily,
    prefersDarkColorScheme
  ]);

  useEffect(() => {
    if (!terminalTypography?.stackHash) {
      return;
    }

    const stackHash = terminalTypography.stackHash;
    if (reportedTypographyStacksRef.current.has(stackHash)) {
      return;
    }

    let active = true;
    void (async () => {
      const issues = await probeResolvedTerminalTypography(terminalTypography);
      if (!active) {
        return;
      }
      reportedTypographyStacksRef.current.add(stackHash);
      await window.kmux.reportTerminalTypographyProbe({
        stackHash,
        issues
      });
    })();

    return () => {
      active = false;
    };
  }, [terminalTypography?.stackHash, terminalTypography?.resolvedFontFamily]);

  useEffect(() => {
    if (!settingsOpen || !settingsDraft) {
      setSettingsTerminalTypographyPreview(null);
      return;
    }

    let active = true;
    void (async () => {
      const preview = await window.kmux.previewTerminalTypography(
        settingsDraft.terminalTypography
      );
      const issues = await probeResolvedTerminalTypography(preview);
      if (!active) {
        return;
      }
      setSettingsTerminalTypographyPreview(
        applyProbeIssuesToResolvedTypography(preview, issues)
      );
    })();

    return () => {
      active = false;
    };
  }, [
    settingsOpen,
    settingsDraft?.terminalTypography?.preferredTextFontFamily,
    settingsDraft?.terminalTypography?.preferredSymbolFallbackFamilies?.join(
      "\u0000"
    ),
    settingsDraft?.terminalTypography?.fontSize,
    settingsDraft?.terminalTypography?.lineHeight
  ]);

  const resolvedColorTheme = resolveColorTheme(
    settings?.themeMode ?? "dark",
    prefersDarkColorScheme
  );
  const resolvedTerminalTheme = useMemo(
    () => resolveTerminalTheme(settings?.terminalThemes, resolvedColorTheme),
    [resolvedColorTheme, settings?.terminalThemes]
  );
  const resolvedSettingsDraftTerminalTheme = useMemo(
    () =>
      settingsDraft
        ? resolveTerminalTheme(settingsDraft.terminalThemes, resolvedColorTheme)
        : null,
    [resolvedColorTheme, settingsDraft]
  );
  const renderedSidebarWidth = clampSidebarWidthForWindow(
    sidebarWidth,
    windowWidth
  );

  const {
    workspaceContextMenu,
    workspaceContext,
    workspaceContextMenuItems,
    workspaceMenuRef,
    openWorkspaceContextMenu,
    closeWorkspaceContextMenu
  } = useWorkspaceContextMenu({
    workspaceRows,
    settings,
    beginWorkspaceRename
  });

  dismissibleUiStateRef.current = {
    paletteOpen,
    notificationsOpen,
    settingsOpen,
    searchSurfaceId,
    workspaceContextMenuOpen: Boolean(workspaceContextMenu),
    workspaceCloseConfirmOpen: Boolean(pendingWorkspaceClose),
    surfaceRestartConfirmOpen: Boolean(pendingSurfaceRestart),
    worktreeDialogOpen: Boolean(worktreeDialog)
  };

  const { beginSidebarResize, handleSidebarResizeKeyDown } = useSidebarResize({
    viewRef,
    renderedSidebarWidth,
    getSidebarElement: () => sidebarElementRef.current,
    setSidebarResizeActive,
    dispatch
  });

  useGlobalShortcuts({
    keyboardPolicy: platformDescriptor.keyboard,
    viewRef,
    dismissibleUiStateRef,
    setShowWorkspaceShortcutHints,
    closeWorkspaceContextMenu,
    closeWorkspaceCloseConfirm: () => setPendingWorkspaceClose(null),
    closeWorktreeDialog,
    setSearchSurfaceId,
    closeSettingsModal,
    setNotificationsOpen,
    setRightPanelKind: setActiveRightPanel,
    closePalette,
    openPalette,
    openSettingsModal,
    beginWorkspaceRename,
    dispatch,
    requestTerminalFocus,
    requestWorkspaceClose,
    withLatestActiveShortcutContext,
    requestPaneClose,
    requestSurfaceClose,
    closeSurfaceRestartConfirm: () => setPendingSurfaceRestart(null)
  });

  const paletteItems = useMemo(() => {
    if (!shellReady) {
      return [];
    }

    return [
      {
        id: "new-workspace",
        label: "New workspace",
        subtitle: "Create another workspace",
        run: () => void dispatch({ type: "workspace.create" })
      },
      {
        id: "rename-workspace",
        label: "Rename workspace",
        subtitle: "Edit the active workspace name",
        run: () =>
          void withLatestView((latestView) =>
            beginWorkspaceRename(
              latestView.activeWorkspace.id,
              latestView.sidebarVisible
            )
          )
      },
      {
        id: "new-tab",
        label: "New tab in active pane",
        subtitle: "Create a new terminal surface",
        run: () =>
          void withLatestActiveShortcutContext(({ activePaneId }) =>
            dispatch({
              type: "surface.create",
              paneId: activePaneId
            })
          )
      },
      {
        id: "close-other-tabs",
        label: "Close other tabs",
        subtitle: "Keep only the active surface",
        run: () =>
          void withLatestActiveShortcutContext(({ activeSurfaceId }) =>
            dispatch({
              type: "surface.closeOthers",
              surfaceId: activeSurfaceId
            })
          )
      },
      {
        id: "split-right",
        label: "Split right",
        subtitle: "Split active pane horizontally",
        run: () =>
          void withLatestActiveShortcutContext(({ activePaneId }) =>
            dispatch({
              type: "pane.split",
              paneId: activePaneId,
              direction: "right"
            })
          )
      },
      {
        id: "split-down",
        label: "Split down",
        subtitle: "Split active pane vertically",
        run: () =>
          void withLatestActiveShortcutContext(({ activePaneId }) =>
            dispatch({
              type: "pane.split",
              paneId: activePaneId,
              direction: "down"
            })
          )
      },
      {
        id: "close-pane",
        label: "Close active pane",
        subtitle: "Remove the current split",
        run: () =>
          void withLatestActiveShortcutContext(({ activePaneId }) =>
            requestPaneClose(activePaneId)
          )
      },
      {
        id: "jump-unread",
        label: "Jump to latest unread",
        subtitle: "Focus latest notification target",
        run: () => void dispatch({ type: "notification.jumpLatestUnread" })
      },
      {
        id: "toggle-settings",
        label: "Settings",
        subtitle: "Open settings modal",
        run: () => openSettingsModal()
      }
    ].filter(
      (item) =>
        item.label.toLowerCase().includes(paletteQuery.toLowerCase()) ||
        item.subtitle.toLowerCase().includes(paletteQuery.toLowerCase())
    );
  }, [paletteQuery, shellReady]);

  useEffect(() => {
    if (!paletteOpen) {
      return;
    }
    setPaletteSelectedIndex(0);
  }, [paletteOpen, paletteQuery]);

  useEffect(() => {
    if (!paletteItems.length) {
      setPaletteSelectedIndex(0);
      return;
    }

    if (paletteSelectedIndex >= paletteItems.length) {
      setPaletteSelectedIndex(paletteItems.length - 1);
    }
  }, [paletteItems.length, paletteSelectedIndex]);

  if (
    !shellReady ||
    !activeWorkspace ||
    !activeWorkspacePaneTree ||
    !settings ||
    !terminalTypography
  ) {
    return <div className={styles.loading}>Booting kmux…</div>;
  }

  function updateSettingsDraftTerminalThemes(
    update: (
      terminalThemes: KmuxSettings["terminalThemes"]
    ) => KmuxSettings["terminalThemes"]
  ): void {
    setSettingsDraft((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        terminalThemes: sanitizeTerminalThemeSettings(
          update(current.terminalThemes),
          current.terminalThemes
        )
      };
    });
  }

  async function handleImportTerminalTheme(): Promise<void> {
    try {
      const imported = await window.kmux.importTerminalThemePalette();
      if (!imported) {
        return;
      }

      updateSettingsDraftTerminalThemes((terminalThemes) => {
        const profile = createImportedTerminalThemeProfile(
          imported,
          terminalThemes
        );
        return {
          activeProfileId: profile.id,
          profiles: [...terminalThemes.profiles, profile]
        };
      });
      setSettingsThemeNotice(buildThemeImportNotice(imported));
    } catch (error) {
      setSettingsThemeNotice(describeThemeActionError("Import failed", error));
    }
  }

  async function handleReplaceTerminalThemeVariant(
    variant: TerminalThemeVariant
  ): Promise<void> {
    try {
      const imported = await window.kmux.importTerminalThemePalette();
      if (!imported) {
        return;
      }

      updateSettingsDraftTerminalThemes((terminalThemes) =>
        updateEditableActiveTerminalTheme(terminalThemes, (profile) => {
          profile.variants[variant] = cloneTerminalColorPalette(
            imported.palette
          );
          profile.source =
            profile.source === "builtin" ? "custom" : profile.source;
          return profile;
        })
      );
      setSettingsThemeNotice(
        `${buildThemeImportNotice(imported)} Replaced the ${variant} variant.`
      );
    } catch (error) {
      setSettingsThemeNotice(
        describeThemeActionError(`Replacing ${variant} theme failed`, error)
      );
    }
  }

  function handleDuplicateTerminalTheme(): void {
    let duplicateName: string | null = null;
    updateSettingsDraftTerminalThemes((terminalThemes) => {
      const activeProfile = findTerminalThemeProfile(
        terminalThemes,
        terminalThemes.activeProfileId
      );
      if (!activeProfile) {
        return terminalThemes;
      }

      const profile = duplicateTerminalThemeProfile(
        activeProfile,
        terminalThemes
      );
      duplicateName = profile.name;
      return {
        activeProfileId: profile.id,
        profiles: [...terminalThemes.profiles, profile]
      };
    });
    if (duplicateName) {
      setSettingsThemeNotice(
        `Duplicated the active theme as "${duplicateName}".`
      );
    }
  }

  function handleDeleteTerminalTheme(): void {
    let deletedProfileName: string | null = null;
    let blockedDelete = false;
    updateSettingsDraftTerminalThemes((terminalThemes) => {
      const activeProfile = findTerminalThemeProfile(
        terminalThemes,
        terminalThemes.activeProfileId
      );
      if (!activeProfile || activeProfile.source === "builtin") {
        blockedDelete = true;
        return terminalThemes;
      }

      deletedProfileName = activeProfile.name;
      return {
        activeProfileId: BUILTIN_TERMINAL_THEME_PROFILE_ID,
        profiles: terminalThemes.profiles.filter(
          (profile) => profile.id !== activeProfile.id
        )
      };
    });
    if (blockedDelete) {
      setSettingsThemeNotice("Built-in terminal themes cannot be deleted.");
      return;
    }
    if (deletedProfileName) {
      setSettingsThemeNotice(`Deleted "${deletedProfileName}".`);
    }
  }

  function handleSelectTerminalTheme(profileId: string): void {
    updateSettingsDraftTerminalThemes((terminalThemes) => ({
      ...terminalThemes,
      activeProfileId: profileId
    }));
  }

  function handleSetTerminalThemeContrast(value: number): void {
    updateSettingsDraftTerminalThemes((terminalThemes) =>
      updateEditableActiveTerminalTheme(terminalThemes, (profile) => {
        profile.minimumContrastRatio = value;
        profile.source =
          profile.source === "builtin" ? "custom" : profile.source;
        return profile;
      })
    );
  }

  async function handleExportTerminalThemeVariant(
    variant: TerminalThemeVariant
  ): Promise<void> {
    const activeProfile = settingsDraft
      ? findTerminalThemeProfile(
          settingsDraft.terminalThemes,
          settingsDraft.terminalThemes.activeProfileId
        )
      : null;
    if (!activeProfile) {
      return;
    }

    try {
      const didExport = await window.kmux.exportTerminalThemePalette(
        `${activeProfile.name}-${variant}`,
        activeProfile.variants[variant]
      );
      if (didExport) {
        setSettingsThemeNotice(
          `Exported "${activeProfile.name}" (${variant}).`
        );
      }
    } catch (error) {
      setSettingsThemeNotice(
        describeThemeActionError(`Exporting ${variant} theme failed`, error)
      );
    }
  }

  return (
    <div
      className={styles.window}
      data-platform={isMac ? "darwin" : "other"}
      data-window-chrome={platformDescriptor.windowChrome}
    >
      <div className={styles.titlebar}>
        <div className={styles.titlebarLeft}>
          <TitlebarWindowControls
            windowChrome={platformDescriptor.windowChrome}
          />
          <div className={styles.titlebarTools}>
            <button
              aria-label="Toggle sidebar"
              className={styles.titleActionButton}
              onClick={() =>
                void dispatch({ type: "workspace.sidebar.toggle" })
              }
            >
              <Codicon name="layout-sidebar-left" />
            </button>
            <button
              aria-label="Create workspace"
              className={`${styles.titleActionButton} ${styles.titleActionGhost}`}
              onClick={() =>
                void dispatch({
                  type: "workspace.create"
                })
              }
            >
              <Codicon name="add" />
            </button>
          </div>
        </div>
        <div className={styles.titleCenter}>
          <div className={styles.titleWordmark} data-testid="project-header">
            kmux
          </div>
        </div>
        <div className={styles.titleActions}>
          <TitlebarUpdateAction
            className={`${styles.titleActionButton} ${styles.titleActionGhost} ${styles.titleActionTextButton}`}
          />
          <button
            aria-label="Toggle notifications"
            className={`${styles.titleActionButton} ${styles.titleActionGhost}`}
            onClick={() => setNotificationsOpen((open) => !open)}
          >
            <Codicon name="bell" />
            {unreadNotifications > 0 ? (
              <span className={styles.titleActionCount}>
                {unreadNotifications}
              </span>
            ) : null}
          </button>
          <button
            aria-label="Toggle usage dashboard"
            className={`${styles.titleActionButton} ${styles.titleActionGhost} ${
              rightPanelOpen ? styles.titleActionActive : ""
            }`}
            onClick={() =>
              setActiveRightPanel((current) =>
                current === null ? "usage" : null
              )
            }
          >
            <Codicon name="layout-sidebar-right" />
          </button>
          <button
            aria-label="Open settings"
            className={`${styles.titleActionButton} ${styles.titleActionGhost}`}
            onClick={() => openSettingsModal()}
          >
            <Codicon name="gear" />
          </button>
        </div>
      </div>
      <div className={styles.shell}>
        {sidebarVisible ? (
          <WorkspaceSidebar
            workspaceRows={workspaceRows}
            activeWorkspace={activeWorkspace}
            sidebarWidth={sidebarWidth}
            renderedSidebarWidth={renderedSidebarWidth}
            sidebarElementRef={sidebarElementRef}
            showWorkspaceShortcutHints={showWorkspaceShortcutHints}
            editingWorkspaceId={editingWorkspaceId}
            workspaceContextMenuWorkspaceId={
              workspaceContextMenu?.workspaceId ?? null
            }
            dragWorkspaceId={dragWorkspaceId}
            dropWorkspaceId={dropWorkspaceId}
            dropPosition={dropPosition}
            sidebarResizeActive={sidebarResizeActive}
            onSelectWorkspace={(workspaceId) =>
              void dispatch({
                type: "workspace.select",
                workspaceId
              })
            }
            onStartRename={beginWorkspaceRename}
            onOpenContextMenu={(workspaceId, x, y) =>
              void openWorkspaceContextMenu(workspaceId, x, y)
            }
            onRenameWorkspace={(workspaceId, name) => {
              void dispatch({
                type: "workspace.rename",
                workspaceId,
                name
              });
              setEditingWorkspaceId(null);
            }}
            onDragStartWorkspace={(workspaceId) => {
              setDragWorkspaceId(workspaceId);
              setDropWorkspaceId(null);
              setDropPosition(null);
            }}
            onDragTargetWorkspace={(workspaceId, nextDropPosition) => {
              if (!dragWorkspaceId || dragWorkspaceId === workspaceId) {
                setDropWorkspaceId(null);
                setDropPosition(null);
                return;
              }
              setDropWorkspaceId(workspaceId);
              setDropPosition(nextDropPosition);
            }}
            onDragLeaveWorkspace={(workspaceId) => {
              if (dropWorkspaceId === workspaceId) {
                setDropWorkspaceId(null);
                setDropPosition(null);
              }
            }}
            onDropWorkspace={(workspaceId, nextDropPosition) => {
              if (!dragWorkspaceId || dragWorkspaceId === workspaceId) {
                clearWorkspaceDragState();
                return;
              }
              const sourceIndex = workspaceRows.findIndex(
                (entry) => entry.workspaceId === dragWorkspaceId
              );
              const targetIndex = workspaceRows.findIndex(
                (entry) => entry.workspaceId === workspaceId
              );
              if (sourceIndex === -1 || targetIndex === -1) {
                clearWorkspaceDragState();
                return;
              }

              const toIndex =
                nextDropPosition === "after"
                  ? sourceIndex < targetIndex
                    ? targetIndex
                    : targetIndex + 1
                  : sourceIndex < targetIndex
                    ? targetIndex - 1
                    : targetIndex;

              void dispatch({
                type: "workspace.move",
                workspaceId: dragWorkspaceId,
                toIndex
              });
              clearWorkspaceDragState();
            }}
            onDragEndWorkspace={clearWorkspaceDragState}
            onSidebarResizeKeyDown={handleSidebarResizeKeyDown}
            onSidebarResizePointerDown={beginSidebarResize}
          />
        ) : null}
        <main className={styles.main}>
          {activeWorkspacePaneTree ? (
            <PaneTree
              key={activeWorkspacePaneTree.id}
              workspace={activeWorkspacePaneTree}
              settings={settings}
              reservedSystemChords={
                platformDescriptor.keyboard.reservedSystemChords
              }
              keyboardPlatform={platformDescriptor.keyboard.platform}
              shortcutLabelStyle={platformDescriptor.keyboard.labelStyle}
              copyModeSelectAllShortcut={
                platformDescriptor.keyboard.copyModeSelectAllShortcut
              }
              terminalTypography={terminalTypography}
              terminalTheme={resolvedTerminalTheme}
              colorTheme={resolvedColorTheme}
              searchSurfaceId={searchSurfaceId}
              terminalFocusRequest={terminalFocusRequest}
              draggedSurfaceTab={draggedSurfaceTab}
              onSetSplitRatio={(splitNodeId, ratio) =>
                void dispatch({
                  type: "pane.setSplitRatio",
                  splitNodeId,
                  ratio
                })
              }
              onFocusPane={(paneId) =>
                void dispatch({ type: "pane.focus", paneId })
              }
              onFocusSurface={(surfaceId) =>
                void dispatch({ type: "surface.focus", surfaceId })
              }
              onCreateSurface={(paneId) =>
                void dispatch({ type: "surface.create", paneId })
              }
              onCloseSurface={(surfaceId) =>
                void requestSurfaceClose(surfaceId)
              }
              onCloseOthers={(surfaceId) =>
                void dispatch({ type: "surface.closeOthers", surfaceId })
              }
              onMoveSurfaceToSplit={(
                surfaceId: string,
                targetPaneId: string,
                direction: SurfaceTabDropDirection
              ) =>
                void dispatch({
                  type: "surface.moveToSplit",
                  surfaceId,
                  targetPaneId,
                  direction
                })
              }
              onSurfaceTabDragStart={setDraggedSurfaceTab}
              onSurfaceTabDragEnd={() => setDraggedSurfaceTab(null)}
              onSplitRight={(paneId) =>
                void dispatch({
                  type: "pane.split",
                  paneId,
                  direction: "right"
                })
              }
              onSplitDown={(paneId) =>
                void dispatch({
                  type: "pane.split",
                  paneId,
                  direction: "down"
                })
              }
              onClosePane={(paneId) => {
                void requestPaneClose(paneId);
              }}
              onRestartSurface={(surfaceId) => {
                void requestSurfaceRestart(surfaceId);
              }}
              onToggleSearch={(surfaceId) => setSearchSurfaceId(surfaceId)}
            />
          ) : null}
        </main>
        {activeRightPanel ? (
          <RightSidebarHost
            title={activeRightPanel === "usage" ? "Usage" : "Sessions"}
            tabs={[...RIGHT_PANEL_TABS]}
            activeTab={activeRightPanel}
            onSelectTab={(key) => setActiveRightPanel(key as RightPanelKind)}
            testId={
              activeRightPanel === "usage"
                ? "usage-right-panel"
                : "sessions-right-panel"
            }
          >
            {activeRightPanel === "usage" ? (
              <UsageDashboard
                embedded
                onJumpToSurface={(workspaceId, surfaceId) => {
                  if (!surfaceId) {
                    return;
                  }
                  void (async () => {
                    await dispatch({
                      type: "workspace.select",
                      workspaceId
                    });
                    await dispatch({
                      type: "surface.focus",
                      surfaceId
                    });
                  })();
                }}
              />
            ) : (
              <ExternalSessionsPanelContainer />
            )}
          </RightSidebarHost>
        ) : null}
      </div>
      <AppOverlays
        shortcutLabelStyle={platformDescriptor.keyboard.labelStyle}
        reservedSystemChords={platformDescriptor.keyboard.reservedSystemChords}
        surfaceDiagnosticCaptureDefaultEnabled={
          platformDescriptor.debugging.surfaceDiagnosticCaptureDefaultEnabled
        }
        diagnosticLogPath={platformDescriptor.debugging.diagnosticLogPath}
        paletteOpen={paletteOpen}
        paletteQuery={paletteQuery}
        paletteSelectedIndex={paletteSelectedIndex}
        paletteItems={paletteItems}
        onClosePalette={closePalette}
        onChangePaletteQuery={setPaletteQuery}
        onSelectPaletteIndex={setPaletteSelectedIndex}
        onExecutePaletteItem={executePaletteItem}
        workspaceContextMenu={workspaceContextMenu}
        workspaceContext={workspaceContext}
        workspaceContextMenuItems={workspaceContextMenuItems}
        workspaceMenuRef={workspaceMenuRef}
        onCloseWorkspaceContextMenu={closeWorkspaceContextMenu}
        onWorkspaceContextAction={(action, workspaceId) =>
          void handleWorkspaceContextAction(action, workspaceId)
        }
        notificationsOpen={notificationsOpen}
        notifications={notifications}
        onCloseNotifications={() => setNotificationsOpen(false)}
        onJumpNotifications={() => {
          void dispatch({ type: "notification.jumpLatestUnread" });
          setNotificationsOpen(false);
        }}
        onClearNotifications={() =>
          void dispatch({ type: "notification.clear" })
        }
        workspaceCloseConfirm={pendingWorkspaceClose}
        onCloseWorkspaceCloseConfirm={() => setPendingWorkspaceClose(null)}
        onToggleWorkspaceCloseRemoveWorktree={(removeWorktree) =>
          setPendingWorkspaceClose((current) =>
            current
              ? {
                  ...current,
                  removeWorktree,
                  dirtyEntries: removeWorktree
                    ? current.dirtyEntries
                    : undefined,
                  dirtyWorktrees: removeWorktree
                    ? current.dirtyWorktrees
                    : undefined,
                  error: null
                }
              : current
          )
        }
        onConfirmWorkspaceClose={() => void confirmPendingWorkspaceClose()}
        surfaceRestartConfirm={pendingSurfaceRestart}
        onCloseSurfaceRestartConfirm={() => setPendingSurfaceRestart(null)}
        onConfirmSurfaceRestart={() => void confirmPendingSurfaceRestart()}
        worktreeDialog={worktreeDialog}
        onCloseWorktreeDialog={closeWorktreeDialog}
        onDismissDetectedWorktree={dismissDetectedWorktreeDialog}
        onChangeWorktreeName={(name) =>
          setWorktreeDialog((current) =>
            current?.kind === "create"
              ? { ...current, name, error: null }
              : current
          )
        }
        onConfirmWorktreeDialog={() => void confirmWorktreeDialog()}
        settingsOpen={settingsOpen}
        settingsDraft={settingsDraft}
        setSettingsDraft={setSettingsDraft}
        settingsThemeNotice={settingsThemeNotice}
        terminalTypographyPreview={
          settingsTerminalTypographyPreview ?? terminalTypography
        }
        terminalThemePreview={resolvedSettingsDraftTerminalTheme}
        onImportTerminalTheme={() => void handleImportTerminalTheme()}
        onReplaceTerminalThemeVariant={(variant) =>
          void handleReplaceTerminalThemeVariant(variant)
        }
        onDuplicateTerminalTheme={handleDuplicateTerminalTheme}
        onDeleteTerminalTheme={handleDeleteTerminalTheme}
        onSelectTerminalTheme={handleSelectTerminalTheme}
        onSetTerminalThemeContrast={handleSetTerminalThemeContrast}
        onExportTerminalThemeVariant={(variant) =>
          void handleExportTerminalThemeVariant(variant)
        }
        onOpenSettingsJson={() => window.kmux.openSettingsJson()}
        onClearDiagnosticLog={() => window.kmux.clearDiagnosticLog()}
        onCloseSettings={closeSettingsModal}
        onSaveSettings={(draft) => {
          const settingsPatch = {
            ...draft,
            shortcuts: omitDeprecatedShortcuts(draft.shortcuts)
          };
          void dispatch({
            type: "settings.update",
            patch: settingsPatch
          }).then(closeSettingsModal);
        }}
      />
    </div>
  );

  async function dispatch(action: AppAction): Promise<void> {
    await window.kmux.dispatch(action);
  }

  function requestTerminalFocus(surfaceId: string): void {
    terminalFocusRequestTokenRef.current += 1;
    setTerminalFocusRequest({
      surfaceId,
      token: terminalFocusRequestTokenRef.current
    });
  }

  function clearWorkspaceDragState(): void {
    setDragWorkspaceId(null);
    setDropWorkspaceId(null);
    setDropPosition(null);
  }

  function closePalette(): void {
    setPaletteOpen(false);
    setPaletteQuery("");
    setPaletteSelectedIndex(0);
  }

  function closeWorktreeDialog(): void {
    if (worktreeDialog?.kind === "detected") {
      dismissDetectedWorktreeDialog();
      return;
    }
    setWorktreeDialog(null);
  }

  function openPalette(): void {
    setPaletteQuery("");
    setPaletteSelectedIndex(0);
    setPaletteOpen(true);
  }

  function openSettingsModal(): void {
    if (!settings) {
      return;
    }
    setSettingsDraft({
      ...settings,
      shortcuts: omitDeprecatedShortcuts(settings.shortcuts)
    });
    setSettingsThemeNotice(null);
    setSettingsTerminalTypographyPreview(null);
    requestAnimationFrame(() => {
      setSettingsOpen(true);
    });
  }

  function closeSettingsModal(): void {
    setSettingsOpen(false);
    setSettingsDraft(undefined);
    setSettingsTerminalTypographyPreview(null);
    setSettingsThemeNotice(null);
  }

  function beginWorkspaceRename(
    workspaceId: string,
    sidebarVisible = viewRef.current?.sidebarVisible ?? true
  ): void {
    if (!sidebarVisible) {
      void window.kmux.dispatch({ type: "workspace.sidebar.toggle" });
    }
    setEditingWorkspaceId(workspaceId);
  }

  async function requestSurfaceClose(surfaceId: string): Promise<void> {
    const latestView = await window.kmux.getShellState();
    const strategy = determineSurfaceCloseStrategy(latestView, surfaceId);
    if (strategy.kind === "close-surface") {
      await dispatch({ type: "surface.close", surfaceId });
      return;
    }

    setPendingWorkspaceClose({
      workspaceId: strategy.workspaceId,
      isLastWorkspace: strategy.isLastWorkspace,
      worktree: latestView.workspaceRows.find(
        (row) => row.workspaceId === strategy.workspaceId
      )?.worktree,
      removeWorktree: false
    });
  }

  async function requestSurfaceRestart(surfaceId: string): Promise<void> {
    const latestView = await window.kmux.getShellState();
    const surface = latestView.activeWorkspacePaneTree.surfaces[surfaceId];
    if (!surface || surface.sessionState === "pending") {
      return;
    }
    if (surface.sessionState === "running") {
      setPendingSurfaceRestart({
        surfaceId,
        sessionId: surface.sessionId,
        title: surface.title
      });
      return;
    }
    await dispatch({ type: "surface.restartSession", surfaceId });
  }

  async function confirmPendingSurfaceRestart(): Promise<void> {
    const pendingRestart = pendingSurfaceRestart;
    if (!pendingRestart) {
      return;
    }
    setPendingSurfaceRestart(null);
    const latestView = await window.kmux.getShellState();
    const surface =
      latestView.activeWorkspacePaneTree.surfaces[pendingRestart.surfaceId];
    if (
      !surface ||
      surface.sessionId !== pendingRestart.sessionId ||
      surface.sessionState === "pending"
    ) {
      return;
    }
    await dispatch({
      type: "surface.restartSession",
      surfaceId: pendingRestart.surfaceId
    });
  }

  async function requestPaneClose(paneId: string): Promise<void> {
    const latestView = await window.kmux.getShellState();
    const strategy = determinePaneCloseStrategy(latestView, paneId);
    if (strategy.kind === "close-pane") {
      await dispatch({ type: "pane.close", paneId });
      return;
    }
    if (strategy.kind === "close-surface") {
      await dispatch({ type: "surface.close", surfaceId: strategy.surfaceId });
      return;
    }

    setPendingWorkspaceClose({
      workspaceId: strategy.workspaceId,
      isLastWorkspace: strategy.isLastWorkspace,
      worktree: latestView.workspaceRows.find(
        (row) => row.workspaceId === strategy.workspaceId
      )?.worktree,
      removeWorktree: false
    });
  }

  async function requestWorkspaceClose(workspaceId: string): Promise<void> {
    const latestView = await window.kmux.getShellState();
    const row = latestView.workspaceRows.find(
      (entry) => entry.workspaceId === workspaceId
    );
    if (!row) {
      return;
    }
    if (!row.worktree) {
      await dispatch({ type: "workspace.close", workspaceId });
      return;
    }
    setPendingWorkspaceClose({
      workspaceId,
      isLastWorkspace: latestView.workspaceRows.length === 1,
      worktree: row.worktree,
      removeWorktree: false
    });
  }

  async function requestCloseOtherWorkspaces(
    workspaceId: string
  ): Promise<void> {
    const latestView = await window.kmux.getShellState();
    const row = latestView.workspaceRows.find(
      (entry) => entry.workspaceId === workspaceId
    );
    if (!row || latestView.workspaceRows.length <= 1) {
      return;
    }
    const closeRows = latestView.workspaceRows.filter(
      (entry) => entry.workspaceId !== workspaceId
    );
    const worktrees = closeRows
      .filter(
        (
          entry
        ): entry is WorkspaceRowVm & { worktree: WorkspaceWorktreeMetadata } =>
          Boolean(entry.worktree)
      )
      .map((entry) => ({
        workspaceId: entry.workspaceId,
        worktree: entry.worktree
      }));
    if (!worktrees.length) {
      await dispatch({ type: "workspace.closeOthers", workspaceId });
      return;
    }
    setPendingWorkspaceClose({
      workspaceId,
      closeWorkspaceIds: closeRows.map((entry) => entry.workspaceId),
      isLastWorkspace: false,
      worktrees,
      removeWorktree: false
    });
  }

  async function confirmPendingWorkspaceClose(): Promise<void> {
    const nextPendingWorkspaceClose = pendingWorkspaceClose;
    if (!nextPendingWorkspaceClose) {
      return;
    }
    const pendingWorktrees =
      nextPendingWorkspaceClose.worktrees ??
      (nextPendingWorkspaceClose.worktree
        ? [
            {
              workspaceId: nextPendingWorkspaceClose.workspaceId,
              worktree: nextPendingWorkspaceClose.worktree
            }
          ]
        : []);

    setPendingWorkspaceClose({
      ...nextPendingWorkspaceClose,
      busy: true,
      error: null
    });

    if (
      pendingWorktrees.length > 0 &&
      nextPendingWorkspaceClose.removeWorktree
    ) {
      try {
        const forceRemove = Boolean(
          nextPendingWorkspaceClose.dirtyEntries?.length ||
          nextPendingWorkspaceClose.dirtyWorktrees?.length
        );
        const result = nextPendingWorkspaceClose.closeWorkspaceIds
          ? await window.kmux.removeWorkspaceWorktrees(
              pendingWorktrees.map((entry) => entry.workspaceId),
              forceRemove
            )
          : await window.kmux.removeWorkspaceWorktree(
              nextPendingWorkspaceClose.workspaceId,
              forceRemove
            );
        if (result.status === "dirty") {
          setPendingWorkspaceClose({
            ...nextPendingWorkspaceClose,
            dirtyEntries:
              "dirtyEntries" in result ? (result.dirtyEntries ?? []) : [],
            dirtyWorktrees:
              "dirtyWorktrees" in result
                ? (result.dirtyWorktrees ?? [])
                : undefined,
            busy: false,
            error: null
          });
          return;
        }
      } catch (error) {
        setPendingWorkspaceClose({
          ...nextPendingWorkspaceClose,
          busy: false,
          error: describeError(error)
        });
        return;
      }
    }

    setPendingWorkspaceClose(null);

    const latestView = await window.kmux.getShellState();
    if (nextPendingWorkspaceClose.closeWorkspaceIds) {
      if (
        latestView.workspaceRows.some(
          (row) => row.workspaceId === nextPendingWorkspaceClose.workspaceId
        )
      ) {
        await dispatch({
          type: "workspace.closeOthers",
          workspaceId: nextPendingWorkspaceClose.workspaceId
        });
      }
      return;
    }

    const workspaceExists = latestView.workspaceRows.some(
      (row) => row.workspaceId === nextPendingWorkspaceClose.workspaceId
    );
    if (!workspaceExists) {
      return;
    }

    if (latestView.workspaceRows.length === 1) {
      await dispatch({ type: "workspace.create" });
    }

    await dispatch({
      type: "workspace.close",
      workspaceId: nextPendingWorkspaceClose.workspaceId
    });
  }

  async function withLatestActiveShortcutContext(
    run: (context: ActiveShortcutContext) => void | Promise<void>
  ): Promise<void> {
    const latestShellState = await window.kmux.getShellState();
    const latestPaneId = latestShellState.activeWorkspacePaneTree.activePaneId;
    const latestPane =
      latestShellState.activeWorkspacePaneTree.panes[latestPaneId];
    if (!latestPane) {
      return;
    }
    await run({
      view: latestShellState,
      activePaneId: latestPaneId,
      activeSurfaceId: latestPane.activeSurfaceId
    });
  }

  async function withLatestView(
    run: (nextView: ShellStoreSnapshot) => void | Promise<void>
  ): Promise<void> {
    await run(await window.kmux.getShellState());
  }

  async function handleWorkspaceContextAction(
    action: WorkspaceContextAction,
    workspaceId: string
  ): Promise<void> {
    closeWorkspaceContextMenu();

    const resolveWorkspaceContext = async () =>
      findWorkspaceContext(await window.kmux.getShellState(), workspaceId);

    await runSharedWorkspaceContextAction(
      workspaceId,
      action,
      resolveWorkspaceContext,
      {
        rename: async (targetWorkspaceId) => {
          const latestShellState = await window.kmux.getShellState();
          beginWorkspaceRename(
            targetWorkspaceId,
            latestShellState.sidebarVisible
          );
        },
        convertToWorktree: openWorktreeConversionDialog,
        closeWorkspace: requestWorkspaceClose,
        closeOtherWorkspaces: requestCloseOtherWorkspaces,
        dispatch
      }
    );
  }

  async function openWorktreeConversionDialog(
    workspaceId: string
  ): Promise<void> {
    const latestView = await window.kmux.getShellState();
    const row = latestView.workspaceRows.find(
      (entry) => entry.workspaceId === workspaceId
    );
    if (!row || row.worktree) {
      return;
    }
    const detectedRow = row.detectedWorktree
      ? row
      : row.gitRepository?.linkedWorktree
        ? {
            ...row,
            detectedWorktree: {
              path: row.gitRepository.root,
              repoRoot: deriveRepoPathFromCommonGitDir(
                row.gitRepository.commonGitDir
              ),
              commonGitDir: row.gitRepository.commonGitDir,
              baseRef: row.branch ?? "HEAD",
              branch: row.branch ?? "HEAD",
              detectedAt: new Date().toISOString()
            }
          }
        : null;
    if (detectedRow) {
      setWorktreeDialog({
        kind: "detected",
        workspaceId,
        row: detectedRow
      });
      return;
    }

    setWorktreeDialog(null);
    try {
      const preview = await window.kmux.prepareWorktreeConversion(workspaceId);
      if (!preview) {
        return;
      }
      setWorktreeDialog({
        kind: "create",
        workspaceId,
        preview,
        name: preview.name
      });
    } catch (error) {
      setWorktreeDialog({
        kind: "create",
        workspaceId,
        preview: {
          workspaceId,
          name: "",
          repoBasename: "",
          from: "",
          path: "",
          branch: "",
          repoRoot: "",
          commonGitDir: "",
          baseRef: ""
        },
        name: "",
        error: describeError(error)
      });
    }
  }

  async function confirmWorktreeDialog(): Promise<void> {
    const dialog = worktreeDialog;
    if (!dialog) {
      return;
    }

    setWorktreeDialog({ ...dialog, busy: true, error: null });
    try {
      if (dialog.kind === "create") {
        await window.kmux.createWorktreeWorkspace(
          dialog.workspaceId,
          dialog.name
        );
      } else {
        await window.kmux.convertDetectedWorktree(dialog.workspaceId);
      }
      setWorktreeDialog(null);
    } catch (error) {
      setWorktreeDialog({
        ...dialog,
        busy: false,
        error: describeError(error)
      });
    }
  }

  function dismissDetectedWorktreeDialog(): void {
    const dialog = worktreeDialog;
    if (dialog?.kind !== "detected" || !dialog.row.detectedWorktree) {
      setWorktreeDialog(null);
      return;
    }
    const path = dialog.row.detectedWorktree.path;
    dismissedDetectedWorktreesRef.current.add(
      detectedWorktreeDismissKey(dialog.workspaceId, path)
    );
    void dispatch({
      type: "workspace.worktree.dismissDetected",
      workspaceId: dialog.workspaceId,
      path
    });
    setWorktreeDialog(null);
  }

  function executePaletteItem(index: number): void {
    const item = paletteItems[index];
    if (!item) {
      return;
    }
    item.run();
    closePalette();
  }
}

function omitDeprecatedShortcuts(
  shortcuts: Record<string, string>
): Record<string, string> {
  const nextShortcuts = { ...shortcuts };
  delete nextShortcuts["workspace.switcher"];
  delete nextShortcuts["pane.zoom"];
  delete nextShortcuts["surface.rename"];
  return nextShortcuts;
}

function detectedWorktreeDismissKey(workspaceId: string, path: string): string {
  return `${workspaceId}\u0000${path}`;
}

function deriveRepoPathFromCommonGitDir(commonGitDir: string): string {
  return commonGitDir.replace(/[\\/]\.git$/, "");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findTerminalThemeProfile(
  terminalThemes: KmuxSettings["terminalThemes"],
  profileId: string
): TerminalThemeProfile | null {
  return (
    terminalThemes.profiles.find((profile) => profile.id === profileId) ?? null
  );
}

function createImportedTerminalThemeProfile(
  imported: ImportedTerminalThemePalette,
  terminalThemes: KmuxSettings["terminalThemes"]
): TerminalThemeProfile {
  const id = buildUniqueTerminalThemeId(imported.suggestedName, terminalThemes);
  return {
    id,
    name: imported.suggestedName,
    source: "itermcolors",
    minimumContrastRatio: DEFAULT_TERMINAL_THEME_MINIMUM_CONTRAST_RATIO,
    variants: {
      dark: cloneTerminalColorPalette(imported.palette),
      light: cloneTerminalColorPalette(imported.palette)
    }
  };
}

function duplicateTerminalThemeProfile(
  profile: TerminalThemeProfile,
  terminalThemes: KmuxSettings["terminalThemes"]
): TerminalThemeProfile {
  const duplicate = cloneTerminalThemeProfile(profile);
  const nextName = buildCopyName(profile.name, terminalThemes.profiles);
  return {
    ...duplicate,
    id: buildUniqueTerminalThemeId(nextName, terminalThemes),
    name: nextName,
    source: "custom"
  };
}

function updateEditableActiveTerminalTheme(
  terminalThemes: KmuxSettings["terminalThemes"],
  mutate: (profile: TerminalThemeProfile) => TerminalThemeProfile
): KmuxSettings["terminalThemes"] {
  const activeProfile = findTerminalThemeProfile(
    terminalThemes,
    terminalThemes.activeProfileId
  );
  if (!activeProfile) {
    return terminalThemes;
  }

  const editableProfile = isBuiltinTerminalThemeProfileId(activeProfile.id)
    ? duplicateTerminalThemeProfile(activeProfile, terminalThemes)
    : cloneTerminalThemeProfile(activeProfile);
  const nextProfile = mutate(editableProfile);

  if (isBuiltinTerminalThemeProfileId(activeProfile.id)) {
    return {
      activeProfileId: nextProfile.id,
      profiles: [...terminalThemes.profiles, nextProfile]
    };
  }

  return {
    activeProfileId: nextProfile.id,
    profiles: terminalThemes.profiles.map((profile) =>
      profile.id === nextProfile.id ? nextProfile : profile
    )
  };
}

function buildUniqueTerminalThemeId(
  name: string,
  terminalThemes: KmuxSettings["terminalThemes"]
): string {
  const base = slugifyTerminalThemeName(name) || "terminal-theme";
  const existingIds = new Set(
    terminalThemes.profiles.map((profile) => profile.id)
  );
  if (!existingIds.has(base)) {
    return base;
  }

  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function buildCopyName(name: string, profiles: TerminalThemeProfile[]): string {
  const existingNames = new Set(profiles.map((profile) => profile.name));
  const baseName = `${name} Copy`;
  if (!existingNames.has(baseName)) {
    return baseName;
  }

  let suffix = 2;
  while (existingNames.has(`${baseName} ${suffix}`)) {
    suffix += 1;
  }
  return `${baseName} ${suffix}`;
}

function slugifyTerminalThemeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildThemeImportNotice(
  imported: ImportedTerminalThemePalette
): string {
  if (!imported.warnings.length) {
    return `Imported "${imported.suggestedName}".`;
  }
  return `Imported "${imported.suggestedName}" with fallbacks: ${imported.warnings.join(" ")}`;
}

function describeThemeActionError(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}`;
}

function applyAppearanceSettings(
  settings: KmuxSettings,
  terminalTypography: ResolvedTerminalTypographyVm,
  prefersDarkColorScheme: boolean
): ColorTheme {
  const root = document.documentElement;
  const resolvedTheme = resolveColorTheme(
    settings.themeMode,
    prefersDarkColorScheme
  );

  applyThemeVariables(root, resolvedTheme);
  root.dataset.colorTheme = resolvedTheme;
  root.dataset.themeMode = settings.themeMode;
  root.style.colorScheme = resolvedTheme;

  applyTypographySettings(settings, terminalTypography);
  return resolvedTheme;
}

function applyTypographySettings(
  settings: KmuxSettings,
  terminalTypography: ResolvedTerminalTypographyVm
): void {
  const root = document.documentElement;
  root.style.setProperty(
    "--kmux-terminal-font-family",
    terminalTypography.resolvedFontFamily ||
      settings.terminalTypography.preferredTextFontFamily.trim()
  );
  root.style.setProperty(
    "--kmux-terminal-font-size",
    `${Number.isFinite(settings.terminalTypography.fontSize) ? settings.terminalTypography.fontSize : 13}px`
  );
  root.style.setProperty(
    "--kmux-terminal-line-height",
    `${Number.isFinite(settings.terminalTypography.lineHeight) ? settings.terminalTypography.lineHeight : 1}`
  );
}

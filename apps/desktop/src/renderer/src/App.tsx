import { useEffect, useMemo, useRef, useState } from "react";

import type { AppAction } from "@kmux/core";
import type {
  ImportedTerminalThemePalette,
  KmuxSettings,
  ResolvedTerminalTypographyVm,
  ShellStoreSnapshot,
  TerminalThemeProfile,
  TerminalThemeVariant
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
import { UsageDashboard } from "./components/UsageDashboard";
import { ExternalSessionsPanelContainer } from "./components/ExternalSessionsPanel";
import {
  applyProbeIssuesToResolvedTypography,
  probeResolvedTerminalTypography
} from "./terminalTypography";
import { determineSurfaceCloseStrategy } from "./surfaceCloseStrategy";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useShellSelector, useShellSnapshotRef } from "./hooks/useShellStore";
import { useWebglLru } from "./hooks/useWebglLru";
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
};

type PendingWorkspaceClose = {
  workspaceId: string;
  isLastWorkspace: boolean;
};

const EMPTY_WORKSPACE_ROWS: ShellStoreSnapshot["workspaceRows"] = [];
const EMPTY_NOTIFICATIONS: ShellStoreSnapshot["notifications"] = [];
const EMPTY_WORKSPACE_PANE_TREES: ShellStoreSnapshot["workspacePaneTrees"] = {};
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
  const workspacePaneTrees = useShellSelector(
    (snapshot) => snapshot?.workspacePaneTrees ?? EMPTY_WORKSPACE_PANE_TREES
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
  const isMac = navigator.userAgent.includes("Mac");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteSelectedIndex, setPaletteSelectedIndex] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [activeRightPanel, setActiveRightPanel] = useState<RightPanelKind>(null);
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
  const [sidebarResizeActive, setSidebarResizeActive] = useState(false);
  const [windowWidth, setWindowWidth] = useState(
    () => document.documentElement.clientWidth || window.innerWidth
  );
  const [prefersDarkColorScheme, setPrefersDarkColorScheme] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  const [settingsDraft, setSettingsDraft] = useState(settings ?? undefined);
  const [availableTerminalFontFamilies, setAvailableTerminalFontFamilies] =
    useState<string[]>([]);
  const [
    settingsTerminalTypographyPreview,
    setSettingsTerminalTypographyPreview
  ] = useState<ResolvedTerminalTypographyVm | null>(null);
  const [settingsThemeNotice, setSettingsThemeNotice] = useState<string | null>(
    null
  );
  const [pendingWorkspaceClose, setPendingWorkspaceClose] =
    useState<PendingWorkspaceClose | null>(null);
  const usageDashboardOpen = activeRightPanel === "usage";
  const rightPanelOpen = activeRightPanel !== null;
  const viewRef = useShellSnapshotRef();
  const { isPaneWebglEnabled, touch: touchWebglLru, touchMany: touchManyWebglLru, forget: forgetWebglLru } = useWebglLru();
  const reportedTypographyStacksRef = useRef(new Set<string>());
  const dismissibleUiStateRef = useRef<DismissibleUiState>({
    paletteOpen,
    notificationsOpen,
    settingsOpen,
    searchSurfaceId,
    workspaceContextMenuOpen: false,
    workspaceCloseConfirmOpen: false
  });
  useEffect(() => {
    setSettingsDraft(
      settings
        ? {
            ...settings,
            shortcuts: omitDeprecatedShortcuts(settings.shortcuts)
          }
        : undefined
    );
  }, [settings]);

  useEffect(() => {
    if (!settingsOpen) {
      setSettingsThemeNotice(null);
    }
  }, [settingsOpen]);

  useEffect(() => {
    void window.kmux.setUsageDashboardOpen(usageDashboardOpen);
  }, [usageDashboardOpen]);

  useEffect(() => {
    setDraggedSurfaceTab(null);
  }, [activeWorkspacePaneTree?.id]);

  const activePaneIdsKey = Object.keys(activeWorkspacePaneTree?.panes ?? {}).sort().join(",");
  useEffect(() => {
    if (!activeWorkspacePaneTree) {
      return;
    }
    touchManyWebglLru(Object.keys(activeWorkspacePaneTree.panes));
  }, [activePaneIdsKey, touchManyWebglLru]);

  const allWorkspacePaneIdsKey = useMemo(
    () =>
      Object.values(workspacePaneTrees)
        .flatMap((tree) => Object.keys(tree.panes))
        .sort()
        .join(","),
    [workspacePaneTrees]
  );
  const prevAllPaneIdsRef = useRef(new Set<string>());
  useEffect(() => {
    const currentIds = new Set(
      Object.values(workspacePaneTrees).flatMap((tree) =>
        Object.keys(tree.panes)
      )
    );
    for (const paneId of prevAllPaneIdsRef.current) {
      if (!currentIds.has(paneId)) {
        forgetWebglLru(paneId);
        terminalInstanceStore.release(paneId);
      }
    }
    prevAllPaneIdsRef.current = currentIds;
  }, [allWorkspacePaneIdsKey]);

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
  }, [
    terminalTypography?.stackHash,
    terminalTypography?.resolvedFontFamily
  ]);

  useEffect(() => {
    if (!settingsOpen) {
      setSettingsTerminalTypographyPreview(null);
      return;
    }

    let active = true;
    void window.kmux.listTerminalFontFamilies().then((fontFamilies) => {
      if (active) {
        setAvailableTerminalFontFamilies(fontFamilies);
      }
    });

    return () => {
      active = false;
    };
  }, [settingsOpen]);

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
    workspaceCloseConfirmOpen: Boolean(pendingWorkspaceClose)
  };

  const { beginSidebarResize, handleSidebarResizeKeyDown } = useSidebarResize({
    viewRef,
    renderedSidebarWidth,
    setSidebarResizeActive,
    dispatch
  });

  useGlobalShortcuts({
    isMac,
    viewRef,
    dismissibleUiStateRef,
    setShowWorkspaceShortcutHints,
    closeWorkspaceContextMenu,
    closeWorkspaceCloseConfirm: () => setPendingWorkspaceClose(null),
    setSearchSurfaceId,
    setSettingsOpen,
    setNotificationsOpen,
    setRightPanelKind: setActiveRightPanel,
    closePalette,
    openPalette,
    openSettingsModal,
    beginWorkspaceRename,
    dispatch,
    withLatestActiveShortcutContext,
    requestSurfaceClose
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
            dispatch({ type: "pane.close", paneId: activePaneId })
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
    <div className={styles.window} data-platform={isMac ? "darwin" : "other"}>
      <div className={styles.titlebar}>
        <div className={styles.titlebarLeft}>
          {!isMac ? (
            <div className={styles.trafficLights}>
              <button
                aria-label="Close window"
                onClick={() => void window.kmux.windowControl("close")}
              />
              <button
                aria-label="Minimize window"
                onClick={() => void window.kmux.windowControl("minimize")}
              />
              <button
                aria-label="Maximize window"
                onClick={() => void window.kmux.windowControl("maximize")}
              />
            </div>
          ) : null}
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
          {Object.values(workspacePaneTrees).map((tree) => (
            <PaneTree
              key={tree.id}
              workspace={tree}
              active={tree.id === activeWorkspacePaneTree?.id}
              isPaneWebglEnabled={isPaneWebglEnabled}
              settings={settings}
              terminalTypography={terminalTypography}
              terminalTheme={resolvedTerminalTheme}
              colorTheme={resolvedColorTheme}
              searchSurfaceId={searchSurfaceId}
              draggedSurfaceTab={draggedSurfaceTab}
              onSetSplitRatio={(splitNodeId, ratio) =>
                void dispatch({ type: "pane.setSplitRatio", splitNodeId, ratio })
              }
              onFocusPane={(paneId) => {
                touchWebglLru(paneId);
                void dispatch({ type: "pane.focus", paneId });
              }}
              onFocusSurface={(surfaceId) =>
                void dispatch({ type: "surface.focus", surfaceId })
              }
              onCreateSurface={(paneId) => {
                touchWebglLru(paneId);
                void dispatch({ type: "surface.create", paneId });
              }}
              onCloseSurface={(surfaceId) => void requestSurfaceClose(surfaceId)}
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
              onSplitRight={(paneId) => {
                touchWebglLru(paneId);
                void dispatch({ type: "pane.split", paneId, direction: "right" });
              }}
              onSplitDown={(paneId) => {
                touchWebglLru(paneId);
                void dispatch({ type: "pane.split", paneId, direction: "down" });
              }}
              onClosePane={(paneId) => {
                forgetWebglLru(paneId);
                void dispatch({ type: "pane.close", paneId });
              }}
              onToggleSearch={(surfaceId) => setSearchSurfaceId(surfaceId)}
            />
          ))}
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
        isMac={isMac}
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
        onConfirmWorkspaceClose={() => void confirmPendingWorkspaceClose()}
        settingsOpen={settingsOpen}
        settingsDraft={settingsDraft}
        setSettingsDraft={setSettingsDraft}
        settingsThemeNotice={settingsThemeNotice}
        availableTerminalFontFamilies={availableTerminalFontFamilies}
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
        onCloseSettings={() => setSettingsOpen(false)}
        onSaveSettings={(draft) => {
          const settingsPatch = {
            ...draft,
            shortcuts: omitDeprecatedShortcuts(draft.shortcuts)
          };
          void dispatch({
            type: "settings.update",
            patch: settingsPatch
          });
          setSettingsOpen(false);
        }}
      />
    </div>
  );

  async function dispatch(action: AppAction): Promise<void> {
    await window.kmux.dispatch(action);
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

  function openPalette(): void {
    setPaletteQuery("");
    setPaletteSelectedIndex(0);
    setPaletteOpen(true);
  }

  function openSettingsModal(): void {
    requestAnimationFrame(() => {
      setSettingsOpen(true);
    });
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
      isLastWorkspace: strategy.isLastWorkspace
    });
  }

  async function confirmPendingWorkspaceClose(): Promise<void> {
    const nextPendingWorkspaceClose = pendingWorkspaceClose;
    if (!nextPendingWorkspaceClose) {
      return;
    }

    setPendingWorkspaceClose(null);

    const latestView = await window.kmux.getShellState();
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
    const latestPane = latestShellState.activeWorkspacePaneTree.panes[latestPaneId];
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
        dispatch
      }
    );
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

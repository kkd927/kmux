export type Id = string;

export type SocketMode = "kmuxOnly" | "allowAll" | "off";
export type SplitAxis = "horizontal" | "vertical";
export type SplitDirection = "left" | "right" | "up" | "down";
export type NotificationSource =
  | "bell"
  | "agent"
  | "terminal"
  | "socket"
  | "status"
  | "system";
export type NotificationKind = "generic" | "needs_input" | "turn_complete";
export type UsageVendor = "claude" | "codex" | "gemini" | "unknown";
export type SessionRuntimeState = "pending" | "running" | "exited";
export type SidebarLogLevel = "info" | "warn" | "error";
export type SidebarStatusVariant = "info" | "attention" | "muted" | "error";
export type UpdaterStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";
export type AgentEventName =
  | "session_start"
  | "running"
  | "needs_input"
  | "turn_complete"
  | "idle"
  | "session_end";
export type TerminalNotificationProtocol = 9 | 99 | 777;
export type TerminalThemeVariant = "dark" | "light";
export type TerminalThemeProfileSource = "builtin" | "itermcolors" | "custom";
export type UsageSessionState =
  | "active"
  | "waiting"
  | "warning"
  | "overBudget"
  | "unknown";
export type UsageAttributionState = "bound" | "aggregate_only";
export type UsageCostSource = "reported" | "estimated" | "partial";

export const AGENT_HOOK_RPC_TIMEOUT_MS = 1500;

export interface SessionLaunchConfig {
  cwd?: string;
  shell?: string;
  args?: string[];
  initialInput?: string;
  env?: Record<string, string>;
  title?: string;
}

export type ExternalAgentSessionVendor = "codex" | "gemini" | "claude";

export interface ExternalAgentSessionVm {
  key: string;
  vendor: ExternalAgentSessionVendor;
  vendorLabel: "CODEX" | "GEMINI" | "CLAUDE";
  title: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  relativeTimeLabel: string;
  canResume: boolean;
  resumeCommandPreview: string;
}

export interface ExternalAgentSessionsSnapshot {
  sessions: ExternalAgentSessionVm[];
  updatedAt: string;
}

export interface ExternalAgentSessionResumeResult {
  workspaceId: string;
  surfaceId: string;
}

export interface SidebarProgress {
  value: number;
  label?: string;
}

export interface SidebarLogEntry {
  id: Id;
  level: SidebarLogLevel;
  message: string;
  createdAt: string;
}

export interface SidebarStatusEntry {
  key: string;
  text: string;
  label?: string;
  variant: SidebarStatusVariant;
  updatedAt: string;
  surfaceId?: Id;
}

export interface UpdaterState {
  status: UpdaterStatus;
  version?: string;
  errorMessage?: string;
}

export interface WorkspaceRowVm {
  workspaceId: Id;
  name: string;
  nameLocked: boolean;
  summary: string;
  cwd?: string;
  branch?: string;
  ports: number[];
  statusText?: string;
  statusEntries: SidebarStatusEntry[];
  unreadCount: number;
  attention: boolean;
  pinned: boolean;
  isActive: boolean;
}

export interface NotificationItem {
  id: Id;
  workspaceId: Id;
  paneId?: Id;
  surfaceId?: Id;
  title: string;
  message: string;
  source: NotificationSource;
  kind?: NotificationKind;
  agent?: string;
  createdAt: string;
}

export interface TerminalKeyInput {
  key: string;
  text?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export const TERMINAL_CTRL_ENTER_SEQUENCE = "\u001b[13;5u";
export const TERMINAL_SHIFT_ENTER_SEQUENCE = "\u001b[13;2u";

export interface SurfaceSnapshotPayload {
  surfaceId: Id;
  sessionId: Id;
  sequence: number;
  vt: string;
  cols: number;
  rows: number;
  title: string;
  cwd?: string;
  branch?: string;
  ports: number[];
  unreadCount: number;
  attention: boolean;
}

export interface SurfaceSnapshotOptions {
  settleForMs?: number;
  timeoutMs?: number;
}

export interface SurfaceChunkSegment {
  sequence: number;
  length: number;
}

export interface SurfaceChunkPayload {
  surfaceId: Id;
  sessionId: Id;
  fromSequence?: number;
  sequence: number;
  chunk: string;
  segments?: SurfaceChunkSegment[];
}

export interface SurfaceExitPayload {
  surfaceId: Id;
  sessionId: Id;
  exitCode?: number;
}

export interface SurfaceMetadataPayload {
  surfaceId: Id;
  cwd?: string;
  title?: string;
  branch?: string | null;
  ports?: number[];
  attention?: boolean;
  unreadDelta?: number;
}

export interface PtySessionSpec {
  sessionId: Id;
  surfaceId: Id;
  workspaceId: Id;
  launch: SessionLaunchConfig;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export type PtyRequest =
  | { type: "spawn"; spec: PtySessionSpec }
  | { type: "close"; sessionId: Id }
  | {
      type: "resize";
      sessionId: Id;
      cols: number;
      rows: number;
      requestId?: Id;
    }
  | { type: "input:text"; sessionId: Id; text: string }
  | { type: "input:key"; sessionId: Id; input: TerminalKeyInput }
  | {
      type: "snapshot";
      sessionId: Id;
      surfaceId: Id;
      requestId: Id;
      settleForMs?: number;
    };

export type PtyEvent =
  | { type: "ready" }
  | { type: "spawned"; sessionId: Id; pid: number }
  | { type: "snapshot"; requestId: Id; payload: SurfaceSnapshotPayload }
  | { type: "chunk"; payload: SurfaceChunkPayload }
  | { type: "metadata"; payload: SurfaceMetadataPayload }
  | { type: "bell"; surfaceId: Id; sessionId: Id; title: string; cwd?: string }
  | {
      type: "terminal.notification";
      surfaceId: Id;
      sessionId: Id;
      protocol: TerminalNotificationProtocol;
      title?: string;
      message?: string;
    }
  | {
      type: "resize:ack";
      sessionId: Id;
      requestId: Id;
      cols: number;
      rows: number;
    }
  | { type: "exit"; payload: SurfaceExitPayload }
  | { type: "error"; sessionId?: Id; message: string };

export interface JsonRpcEnvelope<T = unknown> {
  jsonrpc: "2.0";
  id?: Id;
  method?: string;
  params?: T;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export type ThemeMode = "dark" | "light" | "system";

export interface TerminalTypographySettings {
  preferredTextFontFamily: string;
  preferredSymbolFallbackFamilies: string[];
  fontSize: number;
  lineHeight: number;
}

export interface TerminalColorPalette {
  foreground: string;
  background: string;
  cursor: string;
  cursorText: string;
  selectionBackground: string;
  selectionForeground: string;
  ansi: string[];
}

export interface TerminalThemeProfile {
  id: Id;
  name: string;
  source: TerminalThemeProfileSource;
  minimumContrastRatio: number;
  variants: Record<TerminalThemeVariant, TerminalColorPalette>;
}

export interface TerminalThemeSettings {
  activeProfileId: Id;
  profiles: TerminalThemeProfile[];
}

export interface ResolvedTerminalThemeVm {
  profileId: Id;
  profileName: string;
  source: TerminalThemeProfileSource;
  minimumContrastRatio: number;
  variant: TerminalThemeVariant;
  palette: TerminalColorPalette;
}

export interface ImportedTerminalThemePalette {
  suggestedName: string;
  palette: TerminalColorPalette;
  warnings: string[];
}

export type TerminalTypographyStatus = "pending" | "ready" | "degraded";

export type TerminalTypographyIssueCode =
  | "text_font_missing"
  | "symbol_font_missing"
  | "non_monospaced_text_font"
  | "nerd_glyph_missing"
  | "powerline_glyph_missing"
  | "powerline_width_mismatch";

export interface TerminalTypographyIssue {
  code: TerminalTypographyIssueCode;
  severity: "info" | "warning";
}

export interface ResolvedTerminalTypographyVm {
  stackHash: string;
  resolvedFontFamily: string;
  textFontFamily: string;
  symbolFallbackFamilies: string[];
  autoFallbackApplied: boolean;
  status: TerminalTypographyStatus;
  issues: TerminalTypographyIssue[];
}

export interface TerminalTypographyProbeReport {
  stackHash: string;
  issues: TerminalTypographyIssue[];
}

export interface KmuxSettings {
  socketMode: SocketMode;
  warnBeforeQuit: boolean;
  notificationDesktop: boolean;
  notificationSound: boolean;
  terminalUseWebgl: boolean;
  themeMode: ThemeMode;
  shell?: string;
  shortcuts: Record<string, string>;
  terminalTypography: TerminalTypographySettings;
  terminalThemes: TerminalThemeSettings;
}

export interface PaneLeafNode {
  id: Id;
  kind: "leaf";
  paneId: Id;
}

export interface PaneSplitNode {
  id: Id;
  kind: "split";
  axis: SplitAxis;
  ratio: number;
  first: Id;
  second: Id;
}

export type PaneTreeNode = PaneLeafNode | PaneSplitNode;

export interface SurfaceVm {
  id: Id;
  title: string;
  cwd?: string;
  branch?: string;
  ports: number[];
  unreadCount: number;
  attention: boolean;
  sessionState: SessionRuntimeState;
  exitCode?: number;
}

export interface PaneVm {
  id: Id;
  surfaceIds: Id[];
  activeSurfaceId: Id;
  focused: boolean;
}

export interface ActiveWorkspaceVm {
  id: Id;
  name: string;
  rootNodeId: Id;
  nodes: Record<Id, PaneTreeNode>;
  panes: Record<Id, PaneVm>;
  surfaces: Record<Id, SurfaceVm>;
  activePaneId: Id;
  sidebarStatus?: string;
  statusEntries: SidebarStatusEntry[];
  progress?: SidebarProgress;
  logs: SidebarLogEntry[];
}

export interface ActiveWorkspaceActivityVm {
  id: Id;
  name: string;
  sidebarStatus?: string;
  statusEntries: SidebarStatusEntry[];
  progress?: SidebarProgress;
  logs: SidebarLogEntry[];
}

export interface ActiveWorkspacePaneTreeVm {
  id: Id;
  rootNodeId: Id;
  nodes: Record<Id, PaneTreeNode>;
  panes: Record<Id, PaneVm>;
  surfaces: Record<Id, SurfaceVm>;
  activePaneId: Id;
}

export interface SurfaceUsageVm {
  surfaceId: Id;
  workspaceId: Id;
  surfaceTitle: string;
  workspaceName: string;
  vendor: UsageVendor;
  model?: string;
  sessionCostUsd: number;
  sessionTokens: number;
  todayCostUsd: number;
  todayTokens: number;
  state: UsageSessionState;
  attributionState: UsageAttributionState;
  costSource?: UsageCostSource;
  updatedAt: string;
}

export interface WorkspaceUsageVm {
  workspaceId: Id;
  workspaceName: string;
  todayCostUsd: number;
  todayTokens: number;
  activeCount: number;
  costSource?: UsageCostSource;
}

export interface DirectoryHotspotVm {
  directoryPath: string;
  directoryLabel: string;
  todayCostUsd: number;
  todayTokens: number;
  costSource?: UsageCostSource;
}

export interface VendorUsageVm {
  vendor: UsageVendor;
  todayCostUsd: number;
  todayTokens: number;
  activeCount: number;
  costSource?: UsageCostSource;
}

export interface ModelUsageVm {
  vendor: UsageVendor;
  modelId: string;
  modelLabel: string;
  todayCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  activeSessionCount: number;
  costSource: UsageCostSource;
}

export interface UsageTokenBreakdownVm {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
  totalTokens: number;
}

export interface UsageTokenCostBreakdownVm {
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
  thinkingCostUsd: number;
  hasUnknownInputCost: boolean;
  hasUnknownOutputCost: boolean;
  hasUnknownCacheReadCost: boolean;
  hasUnknownCacheWriteCost: boolean;
  hasUnknownThinkingCost: boolean;
}

export interface UsageDailyActivityVm {
  dayKey: string;
  totalCostUsd: number;
  totalTokens: number;
  activeSessionCount: number;
  costSource: UsageCostSource;
}

export interface UsagePricingCoverageVm {
  fullyPriced: boolean;
  hasEstimatedCosts: boolean;
  hasMissingPricing: boolean;
  reportedCostUsd: number;
  estimatedCostUsd: number;
  unknownCostTokens: number;
}

export type SubscriptionUsageWindowKind =
  | "session"
  | "weekly"
  | "model"
  | "spend";

export interface SubscriptionUsageRowVm {
  key: string;
  label: string;
  usedPercent: number;
  resetLabel: string;
  resetsAt?: string;
  windowKind: SubscriptionUsageWindowKind;
  usedAmountUsd?: number;
  limitAmountUsd?: number;
  currency?: string;
}

export interface SubscriptionProviderUsageVm {
  provider: UsageVendor;
  providerLabel: string;
  planLabel: string;
  source: string;
  updatedAt: string;
  rows: SubscriptionUsageRowVm[];
}

export interface UsageViewSnapshot {
  dayKey: string;
  updatedAt: string;
  totalTodayCostUsd: number;
  totalTodayTokens: number;
  activeSessionCount: number;
  unattributedTodayCostUsd: number;
  unattributedTodayTokens: number;
  surfaces: Record<Id, SurfaceUsageVm>;
  workspaces: WorkspaceUsageVm[];
  directoryHotspots: DirectoryHotspotVm[];
  vendors: VendorUsageVm[];
  topSessions: SurfaceUsageVm[];
  models?: ModelUsageVm[];
  todayTokenBreakdown?: UsageTokenBreakdownVm;
  todayTokenCostBreakdown?: UsageTokenCostBreakdownVm;
  dailyActivity?: UsageDailyActivityVm[];
  pricingCoverage?: UsagePricingCoverageVm;
  subscriptionUsage: SubscriptionProviderUsageVm[];
}

export interface ShellViewModel {
  windowId: Id;
  title: string;
  sidebarVisible: boolean;
  sidebarWidth: number;
  workspaceRows: WorkspaceRowVm[];
  activeWorkspace: ActiveWorkspaceVm;
  notifications: NotificationItem[];
  unreadNotifications: number;
  settings: KmuxSettings;
  terminalTypography: ResolvedTerminalTypographyVm;
}

export interface ShellStoreSnapshot {
  version: number;
  windowId: Id;
  title: string;
  sidebarVisible: boolean;
  sidebarWidth: number;
  workspaceRows: WorkspaceRowVm[];
  activeWorkspace: ActiveWorkspaceActivityVm;
  activeWorkspacePaneTree: ActiveWorkspacePaneTreeVm;
  workspacePaneTrees: Record<Id, ActiveWorkspacePaneTreeVm>;
  notifications: NotificationItem[];
  unreadNotifications: number;
  settings: KmuxSettings;
  terminalTypography: ResolvedTerminalTypographyVm;
}

export interface WorkspaceRowsPatch {
  upsert?: WorkspaceRowVm[];
  remove?: Id[];
  order?: Id[];
}

export interface WorkspacePaneTreesPatch {
  upsert?: Record<Id, ActiveWorkspacePaneTreeVm>;
  remove?: Id[];
}

export interface ShellPatch {
  version: number;
  windowId?: Id;
  title?: string;
  sidebarVisible?: boolean;
  sidebarWidth?: number;
  workspaceRows?: WorkspaceRowVm[];
  workspaceRowsPatch?: WorkspaceRowsPatch;
  activeWorkspace?: ActiveWorkspaceActivityVm;
  activeWorkspacePaneTree?: ActiveWorkspacePaneTreeVm;
  workspacePaneTreesPatch?: WorkspacePaneTreesPatch;
  notifications?: NotificationItem[];
  unreadNotifications?: number;
  settings?: KmuxSettings;
  terminalTypography?: ResolvedTerminalTypographyVm;
}

export function createEmptyUsageViewSnapshot(
  dayKey = "1970-01-01",
  updatedAt = new Date(0).toISOString()
): UsageViewSnapshot {
  return {
    dayKey,
    updatedAt,
    totalTodayCostUsd: 0,
    totalTodayTokens: 0,
    activeSessionCount: 0,
    unattributedTodayCostUsd: 0,
    unattributedTodayTokens: 0,
    surfaces: {},
    workspaces: [],
    directoryHotspots: [],
    vendors: [],
    topSessions: [],
    models: [],
    todayTokenBreakdown: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
      totalTokens: 0
    },
    todayTokenCostBreakdown: {
      inputCostUsd: 0,
      outputCostUsd: 0,
      cacheReadCostUsd: 0,
      cacheWriteCostUsd: 0,
      thinkingCostUsd: 0,
      hasUnknownInputCost: false,
      hasUnknownOutputCost: false,
      hasUnknownCacheReadCost: false,
      hasUnknownCacheWriteCost: false,
      hasUnknownThinkingCost: false
    },
    dailyActivity: [],
    pricingCoverage: {
      fullyPriced: true,
      hasEstimatedCosts: false,
      hasMissingPricing: false,
      reportedCostUsd: 0,
      estimatedCostUsd: 0,
      unknownCostTokens: 0
    },
    subscriptionUsage: []
  };
}

export interface ShellIdentity {
  socketPath: string;
  socketMode: SocketMode;
  windowId: Id;
  activeWorkspaceId: Id;
  activeSurfaceId: Id;
  capabilities: string[];
}

export function makeId(prefix: string): Id {
  return `${prefix}_${createUuid()}`;
}

export function isoNow(date = new Date()): string {
  return date.toISOString();
}

function createUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export * from "./agentHooks";

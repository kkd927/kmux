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
export type UsageVendor = "claude" | "codex" | "antigravity" | "unknown";
export type SubscriptionUsageProvider = Exclude<UsageVendor, "unknown">;
export type ImageAttachmentMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";
export type ImageAttachmentSource = "drop" | "clipboard";
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
  | "needs_input"
  | "turn_complete"
  | "idle"
  | "session_end";
export type TerminalNotificationProtocol = 9 | 99 | 777;
export type TerminalThemeVariant = "dark" | "light";
export type TerminalThemeProfileSource = "builtin" | "itermcolors" | "custom";
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

export type ExternalAgentSessionVendor = "codex" | "claude" | "antigravity";

export interface ExternalAgentSessionRef {
  vendor: ExternalAgentSessionVendor;
  externalKey: string;
  sessionId: string;
}

export interface ExternalAgentSessionVm {
  key: string;
  vendor: ExternalAgentSessionVendor;
  vendorLabel: "CODEX" | "CLAUDE" | "AGY";
  title: string;
  recentConversation?: string;
  model?: string;
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

export interface CreateImageAttachmentPayload {
  source: ImageAttachmentSource;
  originalName?: string;
  mimeType?: string;
  bytes: Uint8Array | ArrayBuffer | number[];
}

export interface ImageAttachmentVm {
  id: string;
  surfaceId: Id;
  sessionId: Id;
  absolutePath: string;
  displayName: string;
  mimeType: ImageAttachmentMimeType;
  byteLength: number;
  createdAt: string;
}

export interface CreateImageAttachmentsResult {
  attachments: ImageAttachmentVm[];
  promptText: string;
  skippedCount: number;
  status: "attached" | "partial" | "empty" | "failed";
  message: string;
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

export interface WorkspaceGitRepositoryMetadata {
  root: string;
  gitDir: string;
  commonGitDir: string;
  linkedWorktree: boolean;
}

export interface WorkspaceWorktreeMetadata {
  name: string;
  path: string;
  repoRoot: string;
  commonGitDir: string;
  baseRef: string;
  branch: string;
  createdByKmux: boolean;
}

export interface WorkspaceDetectedWorktreeMetadata {
  path: string;
  repoRoot: string;
  commonGitDir: string;
  baseRef: string;
  branch: string;
  detectedAt: string;
}

export interface WorktreeConversionPreview {
  workspaceId: Id;
  name: string;
  repoBasename: string;
  from: string;
  path: string;
  branch: string;
  repoRoot: string;
  commonGitDir: string;
  baseRef: string;
}

export interface WorktreeRemoveResult {
  status: "removed" | "dirty";
  dirtyEntries?: string[];
}

export interface WorktreeDirtyEntryGroup {
  workspaceId: Id;
  path: string;
  branch: string;
  dirtyEntries: string[];
}

export interface WorktreeBulkRemoveResult {
  status: "removed" | "dirty";
  dirtyWorktrees?: WorktreeDirtyEntryGroup[];
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
  gitRepository?: WorkspaceGitRepositoryMetadata;
  worktree?: WorkspaceWorktreeMetadata;
  detectedWorktree?: WorkspaceDetectedWorktreeMetadata;
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

export interface TerminalFileLinkResolveCandidate {
  id: string;
  rawPath: string;
  linkText: string;
  startIndex: number;
  endIndex: number;
  hasSuffix: boolean;
  baseCwd?: string;
}

export interface TerminalFileLinkResolved {
  id: string;
  openRawPath: string;
  resolvedPath: string;
  linkText: string;
  startIndex: number;
  endIndex: number;
}

export interface TerminalFileLinkResolveResult {
  links: TerminalFileLinkResolved[];
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
  rawOutputTail?: string;
  rawOutputTailTruncated?: boolean;
  rawOutputLogPath?: string;
  rawOutputIndexPath?: string;
  rawOutputLogBytes?: number;
  rawOutputLogChunks?: number;
  cwdRanges?: SurfaceSnapshotCwdRange[];
}

export interface SurfaceSnapshotOptions {
  settleForMs?: number;
  timeoutMs?: number;
  includeRawOutputTail?: boolean;
}

export type SurfaceCaptureOptions = SurfaceSnapshotOptions;

export interface SurfaceCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SurfaceCaptureDomRow {
  index: number;
  text: string;
  rect: SurfaceCaptureRect;
}

export interface SurfaceCaptureBufferRow {
  index: number;
  absoluteY: number;
  text: string;
  isWrapped: boolean;
}

export interface SurfaceCaptureDiagnosticSequences {
  hydratedSequence: number | null;
  renderedSequence: number | null;
}

// The rendered/hydrated sequences live in several places (element props,
// dataset attributes, the renderer's instance store) that can disagree when
// diagnostics updates stop reaching an element - e.g. a stale prop copied
// onto a wrapper during a reparent. Captures record every source so the
// divergence itself is visible, plus the resolved (max) value the capture
// wait loop used.
export interface SurfaceCaptureDiagnosticSources {
  wrapperProp: SurfaceCaptureDiagnosticSequences | null;
  hostProp: SurfaceCaptureDiagnosticSequences | null;
  wrapperDataset: SurfaceCaptureDiagnosticSequences | null;
  store: {
    lastHydratedSurfaceId: string | null;
    lastHydratedSurfaceSequence: number | null;
  } | null;
}

export interface SurfaceCaptureRendererDom {
  surfaceId: Id;
  documentHasFocus: boolean;
  fontStatus: string;
  devicePixelRatio: number;
  viewport: {
    width: number;
    height: number;
  };
  terminalDiagnostics: {
    hydratedSequence: number | null;
    renderedSequence: number | null;
    targetSequence: number | null;
    waitTimedOut: boolean;
    waitDurationMs: number;
    sources: SurfaceCaptureDiagnosticSources;
  };
  scroll: {
    isAtBottom: boolean;
    scrollOffsetRows: number;
  } | null;
  rootRect: SurfaceCaptureRect;
  xtermRect: SurfaceCaptureRect | null;
  screenRect: SurfaceCaptureRect | null;
  rows: SurfaceCaptureDomRow[];
  text: string;
  bufferRows: SurfaceCaptureBufferRow[];
  bufferText: string;
  // Bottom-anchored buffer window, captured without touching the user's
  // scroll position; empty when the viewport is already at the bottom.
  bottomRows: SurfaceCaptureBufferRow[];
  bottomText: string;
  // Plain text of the last few screens of the buffer, used to check the
  // renderer's recent content against the pty snapshot.
  recentText: string;
  bufferState: {
    type: string;
    cols: number;
    rows: number;
    baseY: number;
    viewportY: number;
    cursorX: number;
    cursorY: number;
    length: number;
  } | null;
  terminalAttrs: Record<string, string>;
}

export interface SurfaceCaptureRendererPayload {
  ok: boolean;
  error?: string;
  dom?: SurfaceCaptureRendererDom;
}

export interface SurfaceCaptureFiles {
  json: string;
  text: string;
  screenshot?: string;
  rawOutputTail?: string;
  rawOutputLog?: string;
  rawOutputIndex?: string;
}

export type SurfaceCaptureSnapshotAttemptKind = "settled" | "immediate";
export type SurfaceCaptureSnapshotAttemptStatus =
  | "ok"
  | "unavailable"
  | "error";

export interface SurfaceCaptureSnapshotAttempt {
  kind: SurfaceCaptureSnapshotAttemptKind;
  settleForMs: number;
  timeoutMs: number;
  status: SurfaceCaptureSnapshotAttemptStatus;
  sequence?: number;
  error?: string;
}

export interface SurfaceCaptureSnapshotDiagnostics {
  selected: SurfaceCaptureSnapshotAttemptKind | "unavailable";
  attempts: SurfaceCaptureSnapshotAttempt[];
}

// Each capture layer sees a different moment while a session streams; the
// per-layer completion timestamps let diffs be attributed to timing skew
// instead of being misread as corruption.
export interface SurfaceCaptureTimings {
  snapshotCompletedAt: string;
  rendererCompletedAt: string;
  screenshotCompletedAt?: string;
}

export type SurfaceCaptureContentConsistencyVerdict =
  | "consistent"
  | "behind"
  | "indeterminate";

// Content-based cross-check between the pty snapshot and the renderer's
// recent buffer content. Classifies a sequence-wait timeout as stale
// instrumentation (content consistent) versus a genuinely lagging renderer
// (content behind); rendered-sequence diagnostics alone cannot tell the two
// apart when their updates stop reaching the DOM.
export interface SurfaceCaptureContentConsistency {
  verdict: SurfaceCaptureContentConsistencyVerdict;
  sampledLines: number;
  matchedLines: number;
}

export interface SurfaceCapturePayload {
  surfaceId: Id;
  sessionId?: Id;
  workspaceId?: Id;
  paneId?: Id;
  capturedAt: string;
  outDir: string;
  files: SurfaceCaptureFiles;
  snapshot: SurfaceSnapshotPayload | null;
  snapshotDiagnostics: SurfaceCaptureSnapshotDiagnostics;
  rawOutputCopyErrors?: string[];
  renderer: SurfaceCaptureRendererPayload;
  timings: SurfaceCaptureTimings;
  contentConsistency: SurfaceCaptureContentConsistency;
  // True when the renderer capture can be trusted: the sequence wait
  // completed, or it timed out but the content cross-check says the
  // renderer is current. Null when no renderer DOM was captured.
  rendererTrusted: boolean | null;
}

export interface SurfaceSnapshotCwdRange {
  startLine: number;
  endLine: number;
  cwd: string;
}

export interface SurfaceExitPayload {
  surfaceId: Id;
  sessionId: Id;
  exitCode?: number;
}

export interface SurfaceMetadataPayload {
  surfaceId: Id;
  sessionId: Id;
  cwd?: string;
  title?: string;
  branch?: string | null;
  ports?: number[];
  gitRepository?: WorkspaceGitRepositoryMetadata | null;
  attention?: boolean;
  unreadDelta?: number;
}

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

export type ShortcutDefaultsPlatform = "darwin" | "linux";
export type SurfaceDiagnosticCaptureMode = "default" | "enabled" | "disabled";

export interface KmuxSettings {
  settingsVersion?: number;
  socketMode: SocketMode;
  warnBeforeQuit: boolean;
  restoreWorkspacesAfterQuit: boolean;
  notificationDesktop: boolean;
  notificationSound: boolean;
  themeMode: ThemeMode;
  shell?: string;
  shortcutDefaultsPlatform?: ShortcutDefaultsPlatform;
  surfaceDiagnosticCaptureMode: SurfaceDiagnosticCaptureMode;
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
  sessionId: Id;
  title: string;
  cwd?: string;
  branch?: string;
  gitRepository?: WorkspaceGitRepositoryMetadata;
  ports: number[];
  unreadCount: number;
  attention: boolean;
  sessionState: SessionRuntimeState;
  shellInputReady: boolean;
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
  attributionState: UsageAttributionState;
  costSource?: UsageCostSource;
  updatedAt: string;
}

export interface WorkspaceUsageVm {
  workspaceId: Id;
  workspaceName: string;
  todayCostUsd: number;
  todayTokens: number;
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
  | "spend"
  | "credits";

interface SubscriptionUsageBaseRowVm {
  key: string;
  label: string;
  resetLabel: string;
  resetsAt?: string;
  windowKind: SubscriptionUsageWindowKind;
}

export type SubscriptionUsageRowVm =
  | (SubscriptionUsageBaseRowVm & {
      valueKind?: "percent";
      usedPercent: number;
      windowKind: Exclude<SubscriptionUsageWindowKind, "credits">;
      usedAmountUsd?: number;
      limitAmountUsd?: number;
      currency?: string;
    })
  | (SubscriptionUsageBaseRowVm & {
      valueKind: "unlimited";
      windowKind: "credits";
    });

export interface SubscriptionProviderUsageVm {
  provider: SubscriptionUsageProvider;
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
  /** Lightweight inventory used to dispose inactive warm terminals after gaps. */
  surfaceIds: Id[];
  windowId: Id;
  title: string;
  sidebarVisible: boolean;
  sidebarWidth: number;
  workspaceRows: WorkspaceRowVm[];
  activeWorkspace: ActiveWorkspaceActivityVm;
  activeWorkspacePaneTree: ActiveWorkspacePaneTreeVm;
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

export interface ShellPatch {
  version: number;
  /** Full lightweight inventory, emitted only when surface membership changes. */
  surfaceIds?: Id[];
  windowId?: Id;
  title?: string;
  sidebarVisible?: boolean;
  sidebarWidth?: number;
  workspaceRows?: WorkspaceRowVm[];
  workspaceRowsPatch?: WorkspaceRowsPatch;
  activeWorkspace?: ActiveWorkspaceActivityVm;
  activeWorkspacePaneTree?: ActiveWorkspacePaneTreeVm;
  removedSurfaceIds?: Id[];
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
export * from "./terminalDataPlane";

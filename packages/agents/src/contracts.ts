import type {
  AgentCapabilityKey,
  AgentDescriptorDto,
  AgentId,
  AgentPresentationDto,
  AgentScopeSettings,
  AgentSettings,
  MetadataSourceRoleId,
  SubscriptionProviderUsageVm
} from "@kmux/proto";
import type {
  AgentMetadataInventoryService,
  AgentMetadataLocalQueryPlan,
  AgentMetadataQueryRequest,
  AgentMetadataQueryResult,
  AgentMetadataTextReadRequest,
  AgentStorageRoots,
  SessionInventory,
  SessionInventoryLimits,
  UsageAdapter
} from "@kmux/metadata";
import type { CoreUsageEventSample } from "@kmux/metadata/core";

export interface AgentDescriptor {
  readonly id: AgentId;
  readonly displayName: string;
  readonly aliases: readonly AgentId[];
  readonly presentation?: Readonly<AgentPresentationDto>;
}

export interface AgentCommandDefinition {
  readonly executable: string;
}

/**
 * Serializable policy for the reviewed, version-gated command-wrapper
 * primitive. The PTY owner may materialize this policy, but it never chooses
 * an agent implementation by name.
 */
export interface AgentCommandWrapperDefinition {
  readonly homeEnvironmentVariable: string;
  readonly defaultHomeRelativePath: string;
  readonly integrationRelativePath: string;
  readonly integrationContractMarker: string;
  readonly legacyHooksFeature: string;
  readonly currentHooksFeature: string;
  readonly currentHooksFeatureMinor: number;
  readonly notificationMethod: string;
}

export interface ResolvedAgentCommandWrapperDefinition extends AgentCommandWrapperDefinition {
  readonly agentId: AgentId;
  readonly executable: string;
  readonly integrationManagedMarker: string;
}

export interface AgentResumeCapability {
  build(
    commonArgs: readonly string[],
    sessionId: string,
    options?: { readonly fork?: boolean }
  ): readonly string[];
  readonly supportsFork?: boolean;
}

export type NormalizedAgentEventName =
  | "session_start"
  | "needs_input"
  | "turn_complete"
  | "idle"
  | "session_end";

export interface NormalizedAgentHookResult {
  readonly event: NormalizedAgentEventName;
  readonly vendorSessionId?: string;
  readonly title?: string;
  readonly message?: string;
  readonly details?: Record<string, unknown>;
}

export interface AgentPortableHookDefinition {
  readonly format: "grouped-hooks" | "namespaced-hooks";
  /**
   * Optional agent-owned base for paths that normally live below HOME but may
   * be relocated by a reviewed environment variable such as CODEX_HOME.
   * `relativePath` remains relative to HOME when this definition is absent.
   */
  readonly pathRoot?: AgentPortablePathRootDefinition;
  readonly relativePath: string;
  readonly namespace?: string;
  readonly marker: string;
  readonly managed: readonly {
    readonly event: string;
    readonly matcher?: string;
  }[];
  readonly deprecated: readonly string[];
  readonly outputMode: "silent" | "json";
  readonly successResponse: Readonly<Record<string, unknown>>;
  readonly fallbackResponse: Readonly<Record<string, unknown>>;
  readonly fallbackByEvent?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly sessionClaim?: {
    readonly startEvents: readonly string[];
    readonly sessionIdFields: readonly string[];
  };
}

export interface AgentPortablePathRootDefinition {
  readonly defaultHomeRelativePath: string;
  readonly environmentVariable: string;
}

export interface AgentHookCapability {
  readonly portable: AgentPortableHookDefinition;
  resolveLocalConfigPath?(options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly homeDir: string;
    readonly agentStorageRoots: AgentStorageRoots;
  }): string;
  normalize(
    event: string,
    payload: Record<string, unknown>
  ): NormalizedAgentHookResult | null;
  normalizeNotification?(
    event: string,
    payload: Record<string, unknown>
  ): { readonly title: string; readonly message: string } | null;
}

export type AgentMetadataSourceFormat = "jsonl" | "sqlite";
export type AgentMetadataPurpose = "externalSessions" | "history" | "usage";

export interface AgentMetadataSourceDefinition {
  readonly role: MetadataSourceRoleId;
  readonly format: AgentMetadataSourceFormat;
  readonly pattern: string;
  readonly purposes: readonly AgentMetadataPurpose[];
  readonly claimScope?: "session" | "agent";
  readonly queryPlanIds?: readonly string[];
}

export interface AgentMetadataSourcesCapability {
  readonly revision: string;
  /** `defaultRoot` is relative to this base when present, otherwise HOME. */
  readonly pathRoot?: AgentPortablePathRootDefinition;
  readonly defaultRoot: string;
  readonly sources: readonly AgentMetadataSourceDefinition[];
  readonly localQueryPlans?: Readonly<
    Record<string, AgentMetadataLocalQueryPlan>
  >;
  resolveLocalRoots?(options: AgentMetadataRuntimeOptions): readonly string[];
}

export interface AgentMetadataRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly agentStorageRoots?: AgentStorageRoots;
  readonly agentSettings?: AgentScopeSettings;
}

export interface AgentExternalSessionRecordProjection {
  readonly sessionId: string;
  readonly title?: string;
  readonly recentConversation?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly updatedAtMs: number;
}

export interface AgentExternalSessionProjectionResult {
  readonly records: readonly AgentExternalSessionRecordProjection[];
  readonly truncated: boolean;
}

export interface AgentExternalSessionProjectionInput {
  readonly roots: readonly string[];
  readonly inventory: SessionInventory;
  readonly maxRecords: number;
  readonly scanLimits?: Partial<SessionInventoryLimits>;
  readText(request: AgentMetadataTextReadRequest): Promise<string>;
  query(request: AgentMetadataQueryRequest): Promise<AgentMetadataQueryResult>;
}

export interface AgentExternalSessionMetadataProjection {
  project(
    input: AgentExternalSessionProjectionInput
  ): Promise<AgentExternalSessionProjectionResult>;
}

export interface AgentExternalSessionProjectionOptions extends AgentMetadataRuntimeOptions {
  readonly indexPath?: string;
}

export interface AgentExternalSessionsCapability {
  createMetadataProjection?(
    options: AgentExternalSessionProjectionOptions
  ): AgentExternalSessionMetadataProjection;
}

export interface AgentHistoryCapability {
  createMetadataProjection?(
    options: AgentExternalSessionProjectionOptions
  ): AgentExternalSessionMetadataProjection;
  createSourceProjection?(): AgentHistorySourceProjection;
}

export interface AgentHistorySourceClaimProjection {
  readonly sessionId: string;
  readonly claimedAtUnixMs?: number;
  readonly lastSeenAtUnixMs?: number;
  readonly cwd?: string;
  readonly workspacePaths?: string[];
  readonly launchTitle?: string;
}

export interface AgentHistorySourceProjectionInput {
  readonly role: MetadataSourceRoleId;
  readonly format: AgentMetadataSourceFormat;
  readonly logicalName: string;
  readonly mtimeMs: number;
  readonly records?: readonly unknown[];
  readonly query?: {
    readonly queryPlanId: string;
    readonly rows: readonly {
      readonly index: number;
      readonly stepType: number;
      readonly payloadBase64: string;
    }[];
  };
  readonly claim?: AgentHistorySourceClaimProjection;
}

export interface AgentHistorySourceProjection {
  projectSource(
    input: AgentHistorySourceProjectionInput
  ):
    | readonly AgentExternalSessionRecordProjection[]
    | Promise<readonly AgentExternalSessionRecordProjection[]>;
}

export interface AgentUsageCapabilityFactory {
  readonly pricingVendorId?: "claude" | "codex" | "gemini";
  createLocalAdapter?(options: AgentUsageRuntimeOptions): UsageAdapter;
  createSourceProjection?(): AgentUsageSourceProjection;
}

export interface AgentUsageSourceProjection {
  createSession(): AgentUsageSourceProjectionSession;
}

export interface AgentUsageSourceProjectionSession {
  clone(): AgentUsageSourceProjectionSession;
  beginInventory(options: { readonly truncated: boolean }): void;
  applySourceClaim(options: {
    readonly role: MetadataSourceRoleId;
    readonly claim: AgentHistorySourceClaimProjection;
  }): void;
  createParser(options: {
    readonly role: MetadataSourceRoleId;
    readonly format: AgentMetadataSourceFormat;
    readonly sourcePath: string;
    readonly maximumPendingBytes: number;
  }): AgentUsageSourceParser;
}

export interface AgentUsageSourceParser {
  append(
    text: string,
    range: { readonly fromMs: number; readonly toMs?: number },
    options?: { readonly eof?: boolean }
  ): readonly CoreUsageEventSample[];
  reset(): void;
  clone(session: AgentUsageSourceProjectionSession): AgentUsageSourceParser;
}

export interface AgentUsageRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly agentStorageRoots?: AgentStorageRoots;
  readonly agentSettings?: Readonly<Record<AgentId, AgentSettings>>;
  readonly platform?: NodeJS.Platform;
  readonly metadataInventory?: AgentMetadataInventoryService;
}

export interface AgentSubscriptionCapabilityFactory {
  createFetcher(
    options: AgentSubscriptionRuntimeOptions
  ): () => Promise<SubscriptionProviderUsageVm | null>;
  createAuthDetector(
    options: AgentSubscriptionRuntimeOptions
  ): () => Promise<boolean>;
}

export interface AgentSubscriptionRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly agentStorageRoots?: AgentStorageRoots;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly appVersion?: string;
}

export interface AgentProcessDetectionCapability {
  readonly executableBasenames: readonly string[];
  readonly wrapperAliases?: readonly string[];
  readonly packageNames?: readonly string[];
}

export type AgentTerminalNotificationDecision =
  | { readonly disposition: "needs_input"; readonly reason: string }
  | { readonly disposition: "turn_complete"; readonly reason: string }
  | { readonly disposition: "suppressed"; readonly reason: string }
  | { readonly disposition: "generic" };

export interface AgentTerminalNotificationCapability {
  classify(title: string, message: string): AgentTerminalNotificationDecision;
}

export interface AgentModule {
  readonly descriptor: AgentDescriptor;
  readonly definitionRevision: string;
  readonly command?: AgentCommandDefinition;
  readonly commandWrapper?: AgentCommandWrapperDefinition;
  readonly resume?: AgentResumeCapability;
  readonly hooks?: AgentHookCapability;
  readonly metadataSources?: AgentMetadataSourcesCapability;
  readonly externalSessions?: AgentExternalSessionsCapability;
  readonly history?: AgentHistoryCapability;
  readonly usage?: AgentUsageCapabilityFactory;
  readonly subscription?: AgentSubscriptionCapabilityFactory;
  readonly processDetection?: AgentProcessDetectionCapability;
  readonly terminalNotifications?: AgentTerminalNotificationCapability;
}

export interface AgentCatalog {
  listDescriptors(): readonly AgentDescriptorDto[];
  descriptor(id: AgentId): AgentDescriptorDto | undefined;
  resolveOperationalIngress(input: string): AgentId | undefined;
}

export type AgentCapabilityFor<K extends AgentCapabilityKey> =
  K extends "resume"
    ? AgentResumeCapability
    : K extends "hooks"
      ? AgentHookCapability
      : K extends "externalSessions"
        ? AgentExternalSessionsCapability
        : K extends "history"
          ? AgentHistoryCapability
          : K extends "usage"
            ? AgentUsageCapabilityFactory
            : K extends "subscription"
              ? AgentSubscriptionCapabilityFactory
              : K extends "processDetection"
                ? AgentProcessDetectionCapability
                : K extends "terminalNotifications"
                  ? AgentTerminalNotificationCapability
                  : never;

export interface CapabilityResolver<K extends AgentCapabilityKey> {
  resolve(id: AgentId): AgentCapabilityFor<K> | undefined;
}

export interface AgentCapabilityBinding<K extends AgentCapabilityKey> {
  readonly agentId: AgentId;
  readonly capability: AgentCapabilityFor<K>;
}

import {
  cloneState,
  type AppState,
  type RemoteResourceKey,
  type RemoteSessionStorageStatus,
  type RemoteOperationProjection
} from "@kmux/core";
import {
  applyMainRemoteSessionObservationFact,
  type MainRemoteSessionObservationFact
} from "@kmux/core/main";
import {
  uint64,
  type Id,
  type RemotePersistenceLevel,
  type Uint64
} from "@kmux/proto";

import {
  retainedTerminationHasDurableTombstone,
  type RetainedSessionInventoryEntry,
  type RetainedSessionInventoryStore,
  type RetainedSessionObservationUpdate
} from "./retainedSessionInventory";
import type { DurableRemoteOperationStore } from "./durableRemoteOperationStore";

const MAX_OBSERVED_KEEPERS = 4_096;
const MAX_ID_BYTES = 256;

export type RemoteTargetStatus = "unknown" | "offline" | "ready" | "mismatch";

export interface ObservedSessionKeeper {
  resourceKey: RemoteResourceKey & { sessionId: Id };
  generation: Id;
  processState: "running" | "exited";
  remoteResourceRevision: Uint64;
  persistenceLevel: RemotePersistenceLevel;
  storageStatus: RemoteSessionStorageStatus;
  checkpointAvailable: boolean;
  retainedRangeTruncated: boolean;
  exitCode?: number;
  descriptor?: {
    createOperationId: Id;
    canonicalCreatePayloadHash: string;
    lastOperationId: Id;
    lastOperationPayloadHash: string;
    lastResultDigest: string;
    launch: {
      cwd: string;
      shell?: string;
      args?: string[];
      env?: Record<string, string>;
      title?: string;
    };
    lifecycleState: "committed" | "provisional" | "abandoned";
    conversionTransactionId?: Id;
    remoteSnapshotHash?: string;
    provisionalCreatedAt?: string;
    everGrantedWriterLease: boolean;
  };
}

export interface RemoteObservedState {
  targetId: Id;
  targetStatus: RemoteTargetStatus;
  inventoryComplete: boolean;
  bridgeGeneration?: Id;
  persistenceLevel?: RemotePersistenceLevel;
  keepers: ObservedSessionKeeper[];
  lastObservedAt?: string;
}

export interface RemoteReconciler {
  observe(value: unknown): MainRemoteSessionObservationFact[];
  getObservedState(targetId: Id): RemoteObservedState | null;
  pendingOperations(targetId: Id): RemoteOperationProjection[];
  retainWorkspace(
    workspaceId: Id,
    reason: "workspace-close"
  ): RetainedSessionInventoryEntry[];
  retainWorkspaces(
    workspaceIds: Id[],
    reason: "workspace-close"
  ): RetainedSessionInventoryEntry[];
  retainOwnedForRestoreDisabled(): {
    retained: RetainedSessionInventoryEntry[];
    missingDescriptorKeys: Array<RemoteResourceKey & { sessionId: Id }>;
  };
  listRetainedSessions(): RetainedSessionInventoryEntry[];
}

export interface CreateRemoteReconcilerOptions {
  desktopInstallationId: Id;
  getState: () => AppState;
  dispatchFact: (fact: MainRemoteSessionObservationFact) => void;
  retainedInventory?: RetainedSessionInventoryStore;
  resourceReceiptStore?: Pick<
    DurableRemoteOperationStore,
    "recordResourceReceipt"
  >;
}

/**
 * Converges authority-bearing inventory into product liveness facts. Transport
 * loss and partial inventories deliberately produce only `unknown` facts.
 */
export function createRemoteReconciler(
  options: CreateRemoteReconcilerOptions
): RemoteReconciler {
  const observedStates = new Map<Id, RemoteObservedState>();

  return Object.freeze({
    observe(value: unknown): MainRemoteSessionObservationFact[] {
      const observed = decodeRemoteObservedState(value);
      const state = options.getState();
      authorizeObservedKeepers(state, observed, options.desktopInstallationId);
      const sessions = remoteSessionsForTarget(state, observed.targetId);
      const facts = buildObservationFacts(
        sessions,
        observed,
        options.desktopInstallationId
      );
      // Validate the complete snapshot and construct every fact before the
      // first product-state mutation, so one bad keeper cannot half-apply.
      const validationState = cloneState(state);
      for (const fact of facts) {
        applyMainRemoteSessionObservationFact(validationState, fact);
      }
      if (
        options.resourceReceiptStore &&
        observed.targetStatus === "ready" &&
        observed.inventoryComplete
      ) {
        recordResourceReceipts(observed, options.resourceReceiptStore);
      }
      if (
        options.retainedInventory &&
        observed.targetStatus === "ready" &&
        observed.inventoryComplete
      ) {
        synchronizeRetainedInventory(
          state,
          observed,
          options.retainedInventory
        );
      }
      for (const fact of facts) {
        options.dispatchFact(fact);
      }
      observedStates.set(observed.targetId, structuredClone(observed));
      return facts;
    },

    getObservedState(targetId: Id): RemoteObservedState | null {
      const observed = observedStates.get(targetId);
      return observed ? structuredClone(observed) : null;
    },

    pendingOperations(targetId: Id): RemoteOperationProjection[] {
      return Object.values(options.getState().remoteOperations)
        .filter(
          (operation) =>
            operation.resourceKey.targetId === targetId &&
            (operation.state === "pending" ||
              operation.state === "termination-pending")
        )
        .map((operation) => structuredClone(operation));
    },

    retainWorkspace(
      workspaceId: Id,
      reason: "workspace-close"
    ): RetainedSessionInventoryEntry[] {
      const inventory = requireRetainedInventory(options.retainedInventory);
      const state = options.getState();
      const workspace = state.workspaces[workspaceId];
      if (!workspace || workspace.location.target.kind !== "ssh") {
        throw new Error("retained workspace must be an SSH workspace");
      }
      const keys = remoteSessionKeysForWorkspace(
        state,
        options.desktopInstallationId,
        workspaceId
      );
      // The store performs the complete batch as one atomic replacement. A
      // workspace is never removed after only a prefix became traceable.
      return inventory.retainCachedMany(keys, reason);
    },

    retainWorkspaces(
      workspaceIds: Id[],
      reason: "workspace-close"
    ): RetainedSessionInventoryEntry[] {
      const inventory = requireRetainedInventory(options.retainedInventory);
      const state = options.getState();
      const distinctWorkspaceIds = [...new Set(workspaceIds)];
      if (distinctWorkspaceIds.length !== workspaceIds.length) {
        throw new Error("retained workspace batch contains duplicates");
      }
      const keys = distinctWorkspaceIds.flatMap((workspaceId) => {
        const workspace = state.workspaces[workspaceId];
        if (!workspace || workspace.location.target.kind !== "ssh") {
          throw new Error("retained workspace must be an SSH workspace");
        }
        return remoteSessionKeysForWorkspace(
          state,
          options.desktopInstallationId,
          workspaceId
        );
      });
      // One inventory replacement covers the entire close-others set. A
      // missing descriptor therefore cannot reclassify only a prefix before
      // the product close is rejected.
      return inventory.retainCachedMany(keys, reason);
    },

    retainOwnedForRestoreDisabled(): {
      retained: RetainedSessionInventoryEntry[];
      missingDescriptorKeys: Array<RemoteResourceKey & { sessionId: Id }>;
    } {
      const inventory = requireRetainedInventory(options.retainedInventory);
      const state = options.getState();
      const keys = Object.values(state.workspaces)
        .filter((workspace) => workspace.location.target.kind === "ssh")
        .flatMap((workspace) =>
          remoteSessionKeysForWorkspace(
            state,
            options.desktopInstallationId,
            workspace.id
          )
        );
      const cached = keys.filter((key) => inventory.get(key) !== null);
      const missingDescriptorKeys = keys
        .filter((key) => inventory.get(key) === null)
        .map((key) => structuredClone(key));
      return {
        retained:
          cached.length === 0
            ? []
            : inventory.retainCachedMany(cached, "restore-disabled"),
        missingDescriptorKeys
      };
    },

    listRetainedSessions(): RetainedSessionInventoryEntry[] {
      return options.retainedInventory?.listRetained() ?? [];
    }
  });
}

function recordResourceReceipts(
  observed: RemoteObservedState,
  store: Pick<DurableRemoteOperationStore, "recordResourceReceipt">
): void {
  for (const keeper of observed.keepers) {
    const descriptor = keeper.descriptor;
    if (!descriptor) {
      throw new Error(
        "authoritative inventory omitted resource descriptor evidence"
      );
    }
    store.recordResourceReceipt({
      resourceKey: structuredClone(keeper.resourceKey),
      remoteResourceRevision: keeper.remoteResourceRevision,
      keeperGeneration: keeper.generation,
      processState: keeper.processState,
      createOperationId: descriptor.createOperationId,
      canonicalCreatePayloadHash: descriptor.canonicalCreatePayloadHash,
      lastOperationId: descriptor.lastOperationId,
      lastOperationPayloadHash: descriptor.lastOperationPayloadHash,
      lastResultDigest: descriptor.lastResultDigest,
      observedAt: observed.lastObservedAt!
    });
  }
}

function synchronizeRetainedInventory(
  state: AppState,
  observed: RemoteObservedState,
  inventory: RetainedSessionInventoryStore
): void {
  const ordinaryUpdates: RetainedSessionObservationUpdate[] = [];
  for (const keeper of observed.keepers) {
    const owned = productOwnsKeeper(state, keeper);
    const termination = latestSessionTermination(state, keeper.resourceKey);
    const retainedEntry = inventory.get(keeper.resourceKey);
    if (
      retainedEntry?.termination &&
      retainedTerminationHasDurableTombstone(retainedEntry, keeper)
    ) {
      if (owned) {
        inventory.clearTermination(keeper, observed.lastObservedAt!, true);
      } else {
        inventory.remove(keeper.resourceKey);
      }
      continue;
    }
    if (
      retainedEntry?.termination &&
      retainedEntry.termination.operationId !== termination?.operationId
    ) {
      ordinaryUpdates.push(
        retainedObservationUpdate(keeper, observed.lastObservedAt!, owned)
      );
      continue;
    }
    if (termination) {
      if (!terminationCanDescribeKeeper(termination, keeper)) {
        if (retainedEntry?.termination) {
          inventory.clearTermination(keeper, observed.lastObservedAt!, owned);
        } else {
          ordinaryUpdates.push(
            retainedObservationUpdate(keeper, observed.lastObservedAt!, owned)
          );
        }
        continue;
      }
      if (termination.state === "succeeded") {
        if (owned) {
          if (retainedEntry?.termination) {
            inventory.clearTermination(keeper, observed.lastObservedAt!, true);
          } else {
            ordinaryUpdates.push({
              disposition: "owned",
              keeper,
              observedAt: observed.lastObservedAt!
            });
          }
        } else if (retainedEntry) {
          inventory.remove(keeper.resourceKey);
        }
        continue;
      }
      const priorReason =
        retainedEntry?.termination?.priorReason ??
        (retainedEntry?.reason && retainedEntry.reason !== "termination-pending"
          ? retainedEntry.reason
          : "unowned-observation");
      inventory.markTerminationPending(keeper, observed.lastObservedAt!, {
        operationId: termination.operationId,
        canonicalPayloadHash: termination.canonicalPayloadHash,
        expectedWorkspaceRevision: termination.expectedWorkspaceRevision,
        expectedRemoteResourceRevision:
          termination.expectedRemoteResourceRevision,
        nextRemoteResourceRevision: termination.nextRemoteResourceRevision,
        admittedAt: termination.createdAt,
        priorReason
      });
      if (termination.state === "failed") {
        if (
          !termination.resultDigest ||
          !termination.completedAt ||
          !termination.failure
        ) {
          throw new Error(
            "failed retained termination lacks authoritative result evidence"
          );
        }
        if (owned) {
          inventory.clearTermination(keeper, observed.lastObservedAt!, true);
        } else {
          inventory.recordTerminationFailure(keeper.resourceKey, {
            operationId: termination.operationId,
            resultDigest: termination.resultDigest,
            code: termination.failure.code,
            message: termination.failure.message,
            completedAt: termination.completedAt
          });
        }
        continue;
      }
      continue;
    }
    ordinaryUpdates.push(
      retainedObservationUpdate(keeper, observed.lastObservedAt!, owned)
    );
  }
  inventory.synchronizeObserved(ordinaryUpdates);
}

function retainedObservationUpdate(
  keeper: ObservedSessionKeeper,
  observedAt: string,
  owned: boolean
): RetainedSessionObservationUpdate {
  return owned
    ? { disposition: "owned", keeper, observedAt }
    : {
        disposition: "retained",
        keeper,
        reason: "unowned-observation",
        observedAt
      };
}

function terminationCanDescribeKeeper(
  termination: RemoteOperationProjection,
  keeper: ObservedSessionKeeper
): boolean {
  if (termination.state === "succeeded") {
    return Boolean(
      termination.resultDigest &&
      keeper.processState === "exited" &&
      keeper.remoteResourceRevision ===
        termination.nextRemoteResourceRevision &&
      keeper.descriptor?.lastOperationId === termination.operationId &&
      keeper.descriptor.lastOperationPayloadHash ===
        termination.canonicalPayloadHash &&
      keeper.descriptor.lastResultDigest === termination.resultDigest
    );
  }
  if (termination.state === "failed") {
    return (
      keeper.remoteResourceRevision ===
      termination.expectedRemoteResourceRevision
    );
  }
  return (
    keeper.remoteResourceRevision ===
      termination.expectedRemoteResourceRevision ||
    (keeper.remoteResourceRevision === termination.nextRemoteResourceRevision &&
      keeper.descriptor?.lastOperationId === termination.operationId &&
      keeper.descriptor.lastOperationPayloadHash ===
        termination.canonicalPayloadHash)
  );
}

function latestSessionTermination(
  state: AppState,
  resourceKey: RemoteResourceKey & { sessionId: Id }
): RemoteOperationProjection | undefined {
  return Object.values(state.remoteOperations)
    .filter(
      (operation) =>
        operation.kind === "session.terminate" &&
        operation.resourceKey.desktopInstallationId ===
          resourceKey.desktopInstallationId &&
        operation.resourceKey.targetId === resourceKey.targetId &&
        operation.resourceKey.workspaceId === resourceKey.workspaceId &&
        operation.resourceKey.sessionId === resourceKey.sessionId
    )
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.operationId.localeCompare(left.operationId)
    )[0];
}

function productOwnsKeeper(
  state: AppState,
  keeper: ObservedSessionKeeper
): boolean {
  const session = state.sessions[keeper.resourceKey.sessionId];
  const surface = session ? state.surfaces[session.surfaceId] : undefined;
  const pane = surface ? state.panes[surface.paneId] : undefined;
  const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
  return Boolean(
    session &&
    surface &&
    pane &&
    workspace &&
    workspace.id === keeper.resourceKey.workspaceId &&
    workspace.location.target.kind === "ssh" &&
    workspace.location.target.targetId === keeper.resourceKey.targetId
  );
}

function remoteSessionKeysForWorkspace(
  state: AppState,
  desktopInstallationId: Id,
  workspaceId: Id
): Array<RemoteResourceKey & { sessionId: Id }> {
  const workspace = state.workspaces[workspaceId];
  if (!workspace || workspace.location.target.kind !== "ssh") return [];
  const targetId = workspace.location.target.targetId;
  return Object.values(state.sessions)
    .flatMap((session) => {
      const surface = state.surfaces[session.surfaceId];
      const pane = surface ? state.panes[surface.paneId] : undefined;
      return pane?.workspaceId === workspaceId
        ? [
            {
              desktopInstallationId,
              targetId,
              workspaceId,
              sessionId: session.id
            }
          ]
        : [];
    })
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

function requireRetainedInventory(
  inventory: RetainedSessionInventoryStore | undefined
): RetainedSessionInventoryStore {
  if (!inventory) {
    throw new Error("retained-session inventory is not configured");
  }
  return inventory;
}

export function decodeRemoteObservedState(value: unknown): RemoteObservedState {
  const record = requireRecord(value, "remote observed state");
  assertExactKeys(record, [
    "targetId",
    "targetStatus",
    "inventoryComplete",
    "bridgeGeneration",
    "persistenceLevel",
    "keepers",
    "lastObservedAt"
  ]);
  const targetId = requireId(record.targetId, "targetId");
  const targetStatus = requireTargetStatus(record.targetStatus);
  if (typeof record.inventoryComplete !== "boolean") {
    throw new TypeError("inventoryComplete must be a boolean");
  }
  if (targetStatus !== "ready" && record.inventoryComplete) {
    throw new TypeError("only a ready target can provide a complete inventory");
  }
  if (
    !Array.isArray(record.keepers) ||
    record.keepers.length > MAX_OBSERVED_KEEPERS
  ) {
    throw new TypeError("keepers must be a bounded array");
  }
  const keepers = record.keepers.map(decodeObservedSessionKeeper);
  const sessionIds = new Set<Id>();
  for (const keeper of keepers) {
    if (sessionIds.has(keeper.resourceKey.sessionId)) {
      throw new TypeError("remote observed state contains a duplicate session");
    }
    sessionIds.add(keeper.resourceKey.sessionId);
  }
  const bridgeGeneration =
    record.bridgeGeneration === undefined
      ? undefined
      : requireId(record.bridgeGeneration, "bridgeGeneration");
  const persistenceLevel =
    record.persistenceLevel === undefined
      ? undefined
      : requirePersistenceLevel(record.persistenceLevel);
  const lastObservedAt =
    record.lastObservedAt === undefined
      ? undefined
      : requireTimestamp(record.lastObservedAt, "lastObservedAt");
  if (
    targetStatus === "ready" &&
    (lastObservedAt === undefined || persistenceLevel === undefined)
  ) {
    throw new TypeError(
      "a ready target observation requires time and persistence capability"
    );
  }
  return {
    targetId,
    targetStatus,
    inventoryComplete: record.inventoryComplete,
    ...(bridgeGeneration === undefined ? {} : { bridgeGeneration }),
    ...(persistenceLevel === undefined ? {} : { persistenceLevel }),
    keepers,
    ...(lastObservedAt === undefined ? {} : { lastObservedAt })
  };
}

function decodeObservedSessionKeeper(value: unknown): ObservedSessionKeeper {
  const record = requireRecord(value, "observed session keeper");
  assertExactKeys(record, [
    "resourceKey",
    "generation",
    "processState",
    "remoteResourceRevision",
    "persistenceLevel",
    "storageStatus",
    "checkpointAvailable",
    "retainedRangeTruncated",
    "exitCode",
    "descriptor"
  ]);
  const resource = requireRecord(record.resourceKey, "remote resource key");
  assertExactKeys(resource, [
    "desktopInstallationId",
    "targetId",
    "workspaceId",
    "sessionId"
  ]);
  const processState = record.processState;
  if (processState !== "running" && processState !== "exited") {
    throw new TypeError("observed keeper processState is invalid");
  }
  const exitCode = requireExitCode(record.exitCode);
  if (processState === "running" && exitCode !== undefined) {
    throw new TypeError("a running keeper cannot have an exit code");
  }
  if (typeof record.remoteResourceRevision !== "bigint") {
    throw new TypeError("remoteResourceRevision must be an in-memory bigint");
  }
  if (
    record.persistenceLevel !== "ssh-disconnect" &&
    record.persistenceLevel !== "user-logout" &&
    record.persistenceLevel !== "host-reboot"
  ) {
    throw new TypeError("observed keeper persistence level is invalid");
  }
  if (
    typeof record.checkpointAvailable !== "boolean" ||
    typeof record.retainedRangeTruncated !== "boolean"
  ) {
    throw new TypeError("observed keeper retention state must be boolean");
  }
  return {
    resourceKey: {
      desktopInstallationId: requireId(
        resource.desktopInstallationId,
        "desktopInstallationId"
      ),
      targetId: requireId(resource.targetId, "targetId"),
      workspaceId: requireId(resource.workspaceId, "workspaceId"),
      sessionId: requireId(resource.sessionId, "sessionId")
    },
    generation: requireId(record.generation, "generation"),
    processState,
    remoteResourceRevision: uint64(record.remoteResourceRevision),
    persistenceLevel: record.persistenceLevel,
    storageStatus: decodeObservedStorageStatus(record.storageStatus),
    checkpointAvailable: record.checkpointAvailable,
    retainedRangeTruncated: record.retainedRangeTruncated,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(record.descriptor === undefined
      ? {}
      : { descriptor: decodeObservedDescriptor(record.descriptor) })
  };
}

function decodeObservedDescriptor(
  value: unknown
): NonNullable<ObservedSessionKeeper["descriptor"]> {
  const record = requireRecord(value, "observed session descriptor");
  assertExactKeys(record, [
    "createOperationId",
    "canonicalCreatePayloadHash",
    "lastOperationId",
    "lastOperationPayloadHash",
    "lastResultDigest",
    "launch",
    "lifecycleState",
    "conversionTransactionId",
    "remoteSnapshotHash",
    "provisionalCreatedAt",
    "everGrantedWriterLease"
  ]);
  if (
    record.lifecycleState !== "committed" &&
    record.lifecycleState !== "provisional" &&
    record.lifecycleState !== "abandoned"
  ) {
    throw new TypeError("observed descriptor lifecycleState is invalid");
  }
  if (typeof record.everGrantedWriterLease !== "boolean") {
    throw new TypeError("everGrantedWriterLease must be a boolean");
  }
  const launchRecord = requireRecord(record.launch, "observed launch");
  assertExactKeys(launchRecord, ["cwd", "shell", "args", "env", "title"]);
  const launch = decodeObservedLaunch(launchRecord);
  return {
    createOperationId: requireId(record.createOperationId, "createOperationId"),
    canonicalCreatePayloadHash: requireDigest(
      record.canonicalCreatePayloadHash,
      "canonicalCreatePayloadHash"
    ),
    lastOperationId: requireId(record.lastOperationId, "lastOperationId"),
    lastOperationPayloadHash: requireDigest(
      record.lastOperationPayloadHash,
      "lastOperationPayloadHash"
    ),
    lastResultDigest: requireDigest(
      record.lastResultDigest,
      "lastResultDigest"
    ),
    launch,
    lifecycleState: record.lifecycleState,
    ...(record.conversionTransactionId === undefined
      ? {}
      : {
          conversionTransactionId: requireId(
            record.conversionTransactionId,
            "conversionTransactionId"
          )
        }),
    ...(record.remoteSnapshotHash === undefined
      ? {}
      : {
          remoteSnapshotHash: requireDigest(
            record.remoteSnapshotHash,
            "remoteSnapshotHash"
          )
        }),
    ...(record.provisionalCreatedAt === undefined
      ? {}
      : {
          provisionalCreatedAt: requireTimestamp(
            record.provisionalCreatedAt,
            "provisionalCreatedAt"
          )
        }),
    everGrantedWriterLease: record.everGrantedWriterLease
  };
}

function decodeObservedLaunch(
  record: Record<string, unknown>
): NonNullable<ObservedSessionKeeper["descriptor"]>["launch"] {
  if (
    record.args !== undefined &&
    (!Array.isArray(record.args) ||
      record.args.length > 256 ||
      record.args.some((item) => typeof item !== "string"))
  ) {
    throw new TypeError("observed launch args are invalid");
  }
  const env =
    record.env === undefined
      ? undefined
      : requireRecord(record.env, "launch.env");
  if (env && Object.keys(env).length > 256) {
    throw new TypeError("observed launch env is oversized");
  }
  return {
    cwd: requireBoundedString(record.cwd, "launch.cwd", 32 * 1024),
    ...(record.shell === undefined
      ? {}
      : {
          shell: requireBoundedString(record.shell, "launch.shell", 32 * 1024)
        }),
    ...(record.args === undefined
      ? {}
      : {
          args: record.args.map((item) =>
            requireBoundedString(item, "launch argument", 32 * 1024)
          )
        }),
    ...(env === undefined
      ? {}
      : {
          env: Object.fromEntries(
            Object.entries(env).map(([key, item]) => [
              requireBoundedString(key, "launch env key", 256),
              requireBoundedString(item, "launch env value", 32 * 1024)
            ])
          )
        }),
    ...(record.title === undefined
      ? {}
      : {
          title: requireBoundedString(record.title, "launch.title", 4 * 1024)
        })
  };
}

function authorizeObservedKeepers(
  state: AppState,
  observed: RemoteObservedState,
  desktopInstallationId: Id
): void {
  for (const keeper of observed.keepers) {
    if (
      keeper.resourceKey.desktopInstallationId !== desktopInstallationId ||
      keeper.resourceKey.targetId !== observed.targetId
    ) {
      throw new Error("observed keeper is outside the reconciler authority");
    }
    const session = state.sessions[keeper.resourceKey.sessionId];
    if (!session) {
      continue;
    }
    const surface = state.surfaces[session.surfaceId];
    const pane = surface ? state.panes[surface.paneId] : undefined;
    const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
    if (
      !workspace ||
      workspace.id !== keeper.resourceKey.workspaceId ||
      workspace.location.target.kind !== "ssh" ||
      workspace.location.target.targetId !== observed.targetId
    ) {
      throw new Error("observed keeper does not match product ownership");
    }
  }
}

function remoteSessionsForTarget(
  state: AppState,
  targetId: Id
): Array<{
  workspaceId: Id;
  sessionId: Id;
  keeperGeneration?: Id;
  remoteResourceRevision?: Uint64;
}> {
  const result: Array<{
    workspaceId: Id;
    sessionId: Id;
    keeperGeneration?: Id;
    remoteResourceRevision?: Uint64;
  }> = [];
  for (const session of Object.values(state.sessions)) {
    const surface = state.surfaces[session.surfaceId];
    const pane = surface ? state.panes[surface.paneId] : undefined;
    const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
    if (
      workspace?.location.target.kind === "ssh" &&
      workspace.location.target.targetId === targetId
    ) {
      result.push({
        workspaceId: workspace.id,
        sessionId: session.id,
        ...(session.remoteRuntime === undefined
          ? {}
          : {
              keeperGeneration: session.remoteRuntime.keeperGeneration,
              remoteResourceRevision:
                session.remoteRuntime.remoteResourceRevision
            })
      });
    }
  }
  return result.sort((left, right) =>
    left.sessionId.localeCompare(right.sessionId)
  );
}

function buildObservationFacts(
  sessions: Array<{
    workspaceId: Id;
    sessionId: Id;
    keeperGeneration?: Id;
    remoteResourceRevision?: Uint64;
  }>,
  observed: RemoteObservedState,
  desktopInstallationId: Id
): MainRemoteSessionObservationFact[] {
  const authoritative =
    observed.targetStatus === "ready" && observed.inventoryComplete;
  const keepers = new Map(
    observed.keepers.map((keeper) => [keeper.resourceKey.sessionId, keeper])
  );
  return sessions.map(
    ({
      workspaceId,
      sessionId,
      keeperGeneration: priorGeneration,
      remoteResourceRevision: priorRevision
    }) => {
      const resourceKey = {
        desktopInstallationId,
        targetId: observed.targetId,
        workspaceId,
        sessionId
      };
      if (!authoritative) {
        return {
          type: "remote-session.observation-unknown" as const,
          resourceKey
        };
      }
      const keeper = keepers.get(sessionId);
      if (!keeper) {
        return {
          type: "remote-session.absent" as const,
          resourceKey,
          observedAt: observed.lastObservedAt!,
          ...(priorGeneration === undefined || priorRevision === undefined
            ? {}
            : {
                expectedKeeperGeneration: priorGeneration,
                expectedRemoteResourceRevision: priorRevision
              })
        };
      }
      return {
        type: "remote-session.observed" as const,
        resourceKey,
        processState: keeper.processState,
        observedAt: observed.lastObservedAt!,
        keeperGeneration: keeper.generation,
        remoteResourceRevision: keeper.remoteResourceRevision,
        storageStatus: keeper.storageStatus,
        ...(keeper.exitCode === undefined ? {} : { exitCode: keeper.exitCode })
      };
    }
  );
}

function decodeObservedStorageStatus(
  value: unknown
): RemoteSessionStorageStatus {
  if (value === undefined) {
    return {
      state: "normal",
      journalAdmitted: uint64(0n),
      journalSynced: uint64(0n),
      emergencyBytes: 0
    };
  }
  const record = requireRecord(value, "observed storage status");
  assertExactKeys(record, [
    "state",
    "journalAdmitted",
    "journalSynced",
    "emergencyBytes",
    "lastSyncDurationMs"
  ]);
  if (
    record.state !== "normal" &&
    record.state !== "degraded" &&
    record.state !== "backpressured"
  ) {
    throw new TypeError("observed storage state is invalid");
  }
  if (
    typeof record.journalAdmitted !== "bigint" ||
    typeof record.journalSynced !== "bigint" ||
    record.journalSynced > record.journalAdmitted ||
    typeof record.emergencyBytes !== "number" ||
    !Number.isSafeInteger(record.emergencyBytes) ||
    record.emergencyBytes < 0 ||
    record.emergencyBytes > 4 * 1024 * 1024 ||
    (record.lastSyncDurationMs !== undefined &&
      (typeof record.lastSyncDurationMs !== "number" ||
        !Number.isSafeInteger(record.lastSyncDurationMs) ||
        record.lastSyncDurationMs < 0))
  ) {
    throw new TypeError("observed storage status is invalid");
  }
  return {
    state: record.state,
    journalAdmitted: uint64(record.journalAdmitted),
    journalSynced: uint64(record.journalSynced),
    emergencyBytes: record.emergencyBytes,
    ...(record.lastSyncDurationMs === undefined
      ? {}
      : { lastSyncDurationMs: record.lastSyncDurationMs })
  };
}

function requireTargetStatus(value: unknown): RemoteTargetStatus {
  if (
    value !== "unknown" &&
    value !== "offline" &&
    value !== "ready" &&
    value !== "mismatch"
  ) {
    throw new TypeError("targetStatus is invalid");
  }
  return value;
}

function requirePersistenceLevel(value: unknown): RemotePersistenceLevel {
  if (
    value !== "ssh-disconnect" &&
    value !== "user-logout" &&
    value !== "host-reboot"
  ) {
    throw new TypeError("remote persistence level is invalid");
  }
  return value;
}

function requireExitCode(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value)) {
    throw new TypeError("exitCode must be a safe integer");
  }
  return value as number;
}

function requireTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return value;
}

function requireId(value: unknown, field: string): Id {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAX_ID_BYTES ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function requireDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireBoundedString(
  value: unknown,
  field: string,
  maxBytes: number
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxBytes ||
    /\0/u.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unexpected) {
    throw new TypeError(`unexpected remote observation field: ${unexpected}`);
  }
}

import {
  formatUint64Decimal,
  parseUint64Decimal,
  uint64,
  type Id,
  type Uint64
} from "@kmux/proto";
import type { AppState } from "@kmux/core";

import type {
  RemoteEventReceiptRecord,
  RemoteEventReceiptStore
} from "./remoteEventReceiptStore";

export type RemoteEventCheckpointConflictReason =
  | "current-snapshot-checkpoint-mismatch"
  | "incompatible-snapshot"
  | "pending-receipt"
  | "ssh-workspace-reference"
  | "remote-operation-reference"
  | "incomplete-conversion-reference"
  | "unresolved-durable-operation-reference"
  | "product-cursor-ahead-of-durable"
  | "pending-event-identity-mismatch"
  | "durable-receipt-unreadable"
  | "product-cursor-mismatch";

export class RemoteEventCheckpointConflictError extends Error {
  constructor(
    readonly targetId: Id,
    readonly productThrough: Uint64,
    readonly durableThrough: Uint64 | undefined,
    readonly reason: RemoteEventCheckpointConflictReason,
    options: { cause?: unknown } = {}
  ) {
    const cursorDetails =
      durableThrough === undefined
        ? `(product ${formatUint64Decimal(productThrough)}, durable unavailable)`
        : `(product ${formatUint64Decimal(productThrough)}, durable ${formatUint64Decimal(durableThrough)})`;
    super(
      `remote event checkpoint conflict for ${targetId}: ${reason} ` +
        cursorDetails,
      options.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = "RemoteEventCheckpointConflictError";
  }
}

export type RemoteRecoverySnapshotSource =
  | { status: "ok"; schemaVersion: 1 | 2 | 3 | 4 }
  | { status: "missing" }
  | { status: "incompatible" };

interface TargetReference {
  targetId: Id;
}

interface ConversionReference {
  state: string;
  workspaceResourceKey: TargetReference;
}

interface DurableOperationReference {
  intent: { resourceKey: TargetReference };
  result?: unknown;
}

export interface RemoteEventCheckpointRecoveryOptions {
  desktopInstallationId: Id;
  state: AppState;
  sourceSnapshot: RemoteRecoverySnapshotSource;
  bindingTargetIds: readonly Id[];
  retained: readonly { resourceKey: TargetReference }[];
  conversions: readonly ConversionReference[];
  durableOperations: readonly DurableOperationReference[];
  eventReceiptStore: RemoteEventReceiptStore;
  persistDurableProductSnapshot: (state: AppState) => void;
}

export interface RemoteEventCheckpointRecoveryResult {
  recovered: Array<{
    targetId: Id;
    productThrough: Uint64;
    durableThrough: Uint64;
  }>;
  conflicts: RemoteEventCheckpointConflictError[];
}

/**
 * Repairs only the cursor shape produced by legacy/missing product snapshots.
 * Every candidate is validated before the single durable product save.
 */
export function recoverLegacyRemoteEventCheckpoints(
  options: RemoteEventCheckpointRecoveryOptions
): RemoteEventCheckpointRecoveryResult {
  const targetIds = collectTargetIds(options);
  const recovered: RemoteEventCheckpointRecoveryResult["recovered"] = [];
  const conflicts: RemoteEventCheckpointConflictError[] = [];

  for (const targetId of targetIds) {
    const productReceipt = options.state.remoteRecovery.eventReceipts[targetId];
    const productThrough = productReceipt?.throughSequence ?? uint64(0n);
    let durableReceipt: RemoteEventReceiptRecord;
    try {
      durableReceipt = options.eventReceiptStore.load(
        options.desktopInstallationId,
        targetId
      );
    } catch (error) {
      conflicts.push(
        new RemoteEventCheckpointConflictError(
          targetId,
          productThrough,
          undefined,
          "durable-receipt-unreadable",
          { cause: error }
        )
      );
      continue;
    }
    const durableThrough = durableReceipt.appliedThrough;

    if (productThrough > durableThrough) {
      const pending = durableReceipt.pending;
      const pendingThrough = pending
        ? parseUint64Decimal(pending.sequence)
        : undefined;
      if (
        pending &&
        pendingThrough === productThrough &&
        productReceipt?.recentEventIds.includes(pending.eventId)
      ) {
        continue;
      }
      conflicts.push(
        new RemoteEventCheckpointConflictError(
          targetId,
          productThrough,
          durableThrough,
          pendingThrough === productThrough
            ? "pending-event-identity-mismatch"
            : "product-cursor-ahead-of-durable"
        )
      );
      continue;
    }
    if (productThrough === durableThrough) continue;

    const reason = legacyRepairConflictReason(
      options,
      targetId,
      durableReceipt.pending !== undefined
    );
    if (reason) {
      conflicts.push(
        new RemoteEventCheckpointConflictError(
          targetId,
          productThrough,
          durableThrough,
          reason
        )
      );
      continue;
    }
    recovered.push({ targetId, productThrough, durableThrough });
  }

  if (recovered.length > 0) {
    for (const checkpoint of recovered) {
      options.state.remoteRecovery.eventReceipts[checkpoint.targetId] = {
        throughSequence: checkpoint.durableThrough,
        recentEventIds: []
      };
    }
    options.persistDurableProductSnapshot(options.state);
  }

  return { recovered, conflicts };
}

function collectTargetIds(options: RemoteEventCheckpointRecoveryOptions): Id[] {
  const targetIds = new Set<Id>(options.bindingTargetIds);
  for (const targetId of Object.keys(
    options.state.remoteRecovery.eventReceipts
  )) {
    targetIds.add(targetId);
  }
  for (const workspace of Object.values(options.state.workspaces)) {
    if (workspace.location.target.kind === "ssh") {
      targetIds.add(workspace.location.target.targetId);
    }
  }
  for (const operation of Object.values(
    options.state.remoteRecovery.operations
  )) {
    targetIds.add(operation.resourceKey.targetId);
  }
  for (const entry of options.retained) {
    targetIds.add(entry.resourceKey.targetId);
  }
  for (const conversion of options.conversions) {
    targetIds.add(conversion.workspaceResourceKey.targetId);
  }
  for (const operation of options.durableOperations) {
    targetIds.add(operation.intent.resourceKey.targetId);
  }
  return [...targetIds].sort((left, right) => left.localeCompare(right));
}

function legacyRepairConflictReason(
  options: RemoteEventCheckpointRecoveryOptions,
  targetId: Id,
  pending: boolean
): RemoteEventCheckpointConflictReason | null {
  if (options.sourceSnapshot.status === "incompatible") {
    return "incompatible-snapshot";
  }
  if (
    options.sourceSnapshot.status === "ok" &&
    options.sourceSnapshot.schemaVersion === 4
  ) {
    return "current-snapshot-checkpoint-mismatch";
  }
  if (pending) return "pending-receipt";
  if (
    Object.values(options.state.workspaces).some(
      (workspace) =>
        workspace.location.target.kind === "ssh" &&
        workspace.location.target.targetId === targetId
    )
  ) {
    return "ssh-workspace-reference";
  }
  if (
    Object.values(options.state.remoteRecovery.operations).some(
      (operation) => operation.resourceKey.targetId === targetId
    )
  ) {
    return "remote-operation-reference";
  }
  if (
    options.conversions.some(
      (conversion) =>
        conversion.state !== "cleanup-complete" &&
        conversion.workspaceResourceKey.targetId === targetId
    )
  ) {
    return "incomplete-conversion-reference";
  }
  if (
    options.durableOperations.some(
      (operation) =>
        operation.result === undefined &&
        operation.intent.resourceKey.targetId === targetId
    )
  ) {
    return "unresolved-durable-operation-reference";
  }
  return null;
}

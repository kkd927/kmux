import type { AppState } from "@kmux/core";
import type { Id } from "@kmux/proto";

const MAX_PARALLEL_STARTUP_RESTORES = 4;

interface RetainedTargetReference {
  resourceKey: { targetId: Id };
  processState: "running" | "exited";
  termination?: unknown;
}

interface ConversionTargetReference {
  state: string;
  workspaceResourceKey: { targetId: Id };
}

interface OperationTargetReference {
  intent: { resourceKey: { targetId: Id } };
  result?: unknown;
}

export interface SshStartupRestoreResult {
  connected: Id[];
  failed: Array<{ targetId: Id; error: Error }>;
}

/**
 * Selects only targets with live desired/recovery work. Historical completed
 * operation receipts alone do not cause an SSH connection at every launch.
 */
export function collectSshStartupTargetIds(options: {
  state: AppState;
  retained: readonly RetainedTargetReference[];
  conversions: readonly ConversionTargetReference[];
  operations: readonly OperationTargetReference[];
}): Id[] {
  const targetIds = new Set<Id>();
  for (const workspace of Object.values(options.state.workspaces)) {
    if (workspace.location.target.kind === "ssh") {
      targetIds.add(workspace.location.target.targetId);
    }
  }
  for (const entry of options.retained) {
    if (entry.processState === "running" || entry.termination !== undefined) {
      targetIds.add(entry.resourceKey.targetId);
    }
  }
  for (const record of options.conversions) {
    if (record.state !== "cleanup-complete") {
      targetIds.add(record.workspaceResourceKey.targetId);
    }
  }
  for (const record of options.operations) {
    if (record.result === undefined) {
      targetIds.add(record.intent.resourceKey.targetId);
    }
  }
  return [...targetIds].sort((left, right) => left.localeCompare(right));
}

export async function restoreSshStartupTargets(options: {
  targetIds: readonly Id[];
  restoreTarget: (targetId: Id) => Promise<unknown>;
  onConnected?: (targetId: Id) => void | Promise<void>;
  onFailure?: (targetId: Id, error: Error) => void;
}): Promise<SshStartupRestoreResult> {
  const pending = [...new Set(options.targetIds)].sort((left, right) =>
    left.localeCompare(right)
  );
  const connected: Id[] = [];
  const failed: Array<{ targetId: Id; error: Error }> = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const targetId = pending[cursor++];
      if (targetId === undefined) return;
      try {
        await options.restoreTarget(targetId);
        connected.push(targetId);
        await options.onConnected?.(targetId);
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        failed.push({ targetId, error: failure });
        options.onFailure?.(targetId, failure);
      }
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(MAX_PARALLEL_STARTUP_RESTORES, pending.length)
      },
      worker
    )
  );
  connected.sort((left, right) => left.localeCompare(right));
  failed.sort((left, right) => left.targetId.localeCompare(right.targetId));
  return { connected, failed };
}

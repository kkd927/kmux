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

export type SshStartupTargetMode =
  | "interactive-restore"
  | "non-interactive-maintenance";

export interface SshStartupTargetPlan {
  targetId: Id;
  mode: SshStartupTargetMode;
}

export interface SshStartupRestoreResult {
  connected: Id[];
  failed: Array<{ targetId: Id; error: Error }>;
}

/**
 * Plans only targets with live desired/recovery work. A product restore takes
 * priority over background maintenance when both refer to the same target.
 * Ordinary retained sessions deliberately do not cause a startup connection.
 */
export function collectSshStartupTargets(options: {
  state: AppState;
  retained: readonly RetainedTargetReference[];
  conversions: readonly ConversionTargetReference[];
  operations: readonly OperationTargetReference[];
}): SshStartupTargetPlan[] {
  const modes = new Map<Id, SshStartupTargetMode>();
  const add = (targetId: Id, mode: SshStartupTargetMode): void => {
    if (mode === "interactive-restore" || !modes.has(targetId)) {
      modes.set(targetId, mode);
    }
  };
  for (const workspace of Object.values(options.state.workspaces)) {
    if (workspace.location.target.kind === "ssh") {
      add(workspace.location.target.targetId, "interactive-restore");
    }
  }
  for (const entry of options.retained) {
    if (entry.termination !== undefined) {
      add(entry.resourceKey.targetId, "non-interactive-maintenance");
    }
  }
  for (const record of options.conversions) {
    if (record.state !== "cleanup-complete") {
      add(record.workspaceResourceKey.targetId, "interactive-restore");
    }
  }
  for (const record of options.operations) {
    if (record.result === undefined) {
      add(record.intent.resourceKey.targetId, "non-interactive-maintenance");
    }
  }
  return [...modes]
    .map(([targetId, mode]) => ({ targetId, mode }))
    .sort((left, right) => left.targetId.localeCompare(right.targetId));
}

export async function restoreSshStartupTargets(options: {
  targets: readonly SshStartupTargetPlan[];
  restoreTarget: (targetId: Id, mode: SshStartupTargetMode) => Promise<unknown>;
  onConnected?: (targetId: Id) => void | Promise<void>;
  onFailure?: (targetId: Id, error: Error) => void;
}): Promise<SshStartupRestoreResult> {
  const pending = mergeStartupPlans(options.targets);
  const connected: Id[] = [];
  const failed: Array<{ targetId: Id; error: Error }> = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const target = pending[cursor++];
      if (target === undefined) return;
      try {
        await options.restoreTarget(target.targetId, target.mode);
        connected.push(target.targetId);
        await options.onConnected?.(target.targetId);
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        failed.push({ targetId: target.targetId, error: failure });
        options.onFailure?.(target.targetId, failure);
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

function mergeStartupPlans(
  targets: readonly SshStartupTargetPlan[]
): SshStartupTargetPlan[] {
  const modes = new Map<Id, SshStartupTargetMode>();
  for (const target of targets) {
    if (target.mode === "interactive-restore" || !modes.has(target.targetId)) {
      modes.set(target.targetId, target.mode);
    }
  }
  return [...modes]
    .map(([targetId, mode]) => ({ targetId, mode }))
    .sort((left, right) => left.targetId.localeCompare(right.targetId));
}

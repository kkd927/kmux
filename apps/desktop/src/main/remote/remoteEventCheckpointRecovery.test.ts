import { applyAction, createInitialState, type AppState } from "@kmux/core";
import { uint64, type Id, type RemoteSpoolEventDto } from "@kmux/proto";

import type {
  RemoteEventReceiptRecord,
  RemoteEventReceiptStore
} from "./remoteEventReceiptStore";
import {
  RemoteEventCheckpointConflictError,
  recoverLegacyRemoteEventCheckpoints,
  type RemoteEventCheckpointConflictReason,
  type RemoteEventCheckpointRecoveryOptions
} from "./remoteEventCheckpointRecovery";

describe("legacy remote event checkpoint recovery", () => {
  it("repairs two safe legacy targets in one durable snapshot", () => {
    const state = createInitialState("/bin/zsh");
    const save = vi.fn();
    const result = recoverLegacyRemoteEventCheckpoints({
      ...baseOptions(state, {
        target_a: receipt("target_a", 12n),
        target_b: receipt("target_b", 20n)
      }),
      sourceSnapshot: { status: "ok", schemaVersion: 3 },
      bindingTargetIds: ["target_a", "target_b"],
      retained: [
        { resourceKey: { targetId: "target_a" } },
        { resourceKey: { targetId: "target_b" } }
      ],
      persistDurableProductSnapshot: save
    });

    expect(result.conflicts).toEqual([]);
    expect(result.recovered).toEqual([
      {
        targetId: "target_a",
        productThrough: 0n,
        durableThrough: 12n
      },
      {
        targetId: "target_b",
        productThrough: 0n,
        durableThrough: 20n
      }
    ]);
    expect(state.remoteRecovery.eventReceipts).toEqual({
      target_a: { throughSequence: 12n, recentEventIds: [] },
      target_b: { throughSequence: 20n, recentEventIds: [] }
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(state);
  });

  it("also repairs a missing snapshot when only retained inventory and a binding remain", () => {
    const state = createInitialState("/bin/zsh");
    const save = vi.fn();
    const result = recoverLegacyRemoteEventCheckpoints({
      ...baseOptions(state, {
        target_retained: receipt("target_retained", 7n)
      }),
      sourceSnapshot: { status: "missing" },
      bindingTargetIds: ["target_retained"],
      retained: [{ resourceKey: { targetId: "target_retained" } }],
      persistDurableProductSnapshot: save
    });

    expect(result.conflicts).toEqual([]);
    expect(state.remoteRecovery.eventReceipts.target_retained).toEqual({
      throughSequence: 7n,
      recentEventIds: []
    });
    expect(save).toHaveBeenCalledOnce();
  });

  it("fails closed on a v4 cursor mismatch", () => {
    const state = createInitialState("/bin/zsh");
    const save = vi.fn();
    const result = recoverLegacyRemoteEventCheckpoints({
      ...baseOptions(state, { target_1: receipt("target_1", 12n) }),
      sourceSnapshot: { status: "ok", schemaVersion: 4 },
      bindingTargetIds: ["target_1"],
      persistDurableProductSnapshot: save
    });

    expectConflict(result.conflicts, "current-snapshot-checkpoint-mismatch");
    expect(save).not.toHaveBeenCalled();
    expect(state.remoteRecovery.eventReceipts.target_1).toBeUndefined();
  });

  it.each([12n, 13n])(
    "leaves a valid staged v4 event recoverable at product cursor %s",
    (productThrough) => {
      const state = createInitialState("/bin/zsh");
      state.remoteRecovery.eventReceipts.target_1 = {
        throughSequence: uint64(productThrough),
        recentEventIds: productThrough === 13n ? ["event_13"] : []
      };
      const save = vi.fn();
      const result = recoverLegacyRemoteEventCheckpoints({
        ...baseOptions(state, {
          target_1: receipt("target_1", 12n, {
            sequence: "13",
            eventId: "event_13"
          } as RemoteSpoolEventDto)
        }),
        sourceSnapshot: { status: "ok", schemaVersion: 4 },
        bindingTargetIds: ["target_1"],
        persistDurableProductSnapshot: save
      });

      expect(result).toEqual({ recovered: [], conflicts: [] });
      expect(save).not.toHaveBeenCalled();
    }
  );

  it("fails closed when a projected pending sequence lacks its event identity", () => {
    const state = createInitialState("/bin/zsh");
    state.remoteRecovery.eventReceipts.target_1 = {
      throughSequence: uint64(13n),
      recentEventIds: []
    };
    const save = vi.fn();
    const result = recoverLegacyRemoteEventCheckpoints({
      ...baseOptions(state, {
        target_1: receipt("target_1", 12n, {
          sequence: "13",
          eventId: "event_13"
        } as RemoteSpoolEventDto)
      }),
      sourceSnapshot: { status: "ok", schemaVersion: 4 },
      bindingTargetIds: ["target_1"],
      persistDurableProductSnapshot: save
    });

    expect(result.recovered).toEqual([]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        targetId: "target_1",
        productThrough: 13n,
        durableThrough: 12n,
        reason: "pending-event-identity-mismatch"
      })
    ]);
    expect(save).not.toHaveBeenCalled();
  });

  it("isolates an unreadable receipt while recovering healthy targets once", () => {
    const state = createInitialState("/bin/zsh");
    const save = vi.fn();
    const options = {
      ...baseOptions(state, {
        target_healthy: receipt("target_healthy", 20n)
      }),
      sourceSnapshot: { status: "ok" as const, schemaVersion: 3 as const },
      bindingTargetIds: ["target_broken", "target_healthy"],
      persistDurableProductSnapshot: save
    };
    const load = options.eventReceiptStore.load;
    options.eventReceiptStore.load = (desktopInstallationId, targetId) => {
      if (targetId === "target_broken") {
        throw new Error("remote event receipt digest does not match");
      }
      return load(desktopInstallationId, targetId);
    };

    const result = recoverLegacyRemoteEventCheckpoints(options);

    expect(result.recovered).toEqual([
      {
        targetId: "target_healthy",
        productThrough: 0n,
        durableThrough: 20n
      }
    ]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        targetId: "target_broken",
        productThrough: 0n,
        durableThrough: undefined,
        reason: "durable-receipt-unreadable"
      })
    ]);
    expect(result.conflicts[0]?.cause).toEqual(
      new Error("remote event receipt digest does not match")
    );
    expect(state.remoteRecovery.eventReceipts.target_healthy).toEqual({
      throughSequence: 20n,
      recentEventIds: []
    });
    expect(save).toHaveBeenCalledOnce();
  });

  it.each<{
    name: string;
    reason: RemoteEventCheckpointConflictReason;
    configure: (
      state: AppState,
      options: RemoteEventCheckpointRecoveryOptions
    ) => void;
  }>([
    {
      name: "pending receipt",
      reason: "pending-receipt",
      configure: (_state, options) => {
        const records = (options.eventReceiptStore as FixtureReceiptStore)
          .records;
        records.target_1 = receipt("target_1", 12n, {} as RemoteSpoolEventDto);
      }
    },
    {
      name: "SSH workspace",
      reason: "ssh-workspace-reference",
      configure: (state) => {
        applyAction(state, {
          type: "workspace.create",
          target: { kind: "ssh", targetId: "target_1" }
        });
      }
    },
    {
      name: "remote operation projection",
      reason: "remote-operation-reference",
      configure: (state) => {
        state.remoteRecovery.operations.operation_1 = {
          resourceKey: { targetId: "target_1" }
        } as never;
      }
    },
    {
      name: "incomplete conversion",
      reason: "incomplete-conversion-reference",
      configure: (_state, options) => {
        (
          options.conversions as Array<{
            state: string;
            workspaceResourceKey: { targetId: Id };
          }>
        ).push({
          state: "commit-decided",
          workspaceResourceKey: { targetId: "target_1" }
        });
      }
    },
    {
      name: "unresolved durable operation",
      reason: "unresolved-durable-operation-reference",
      configure: (_state, options) => {
        (
          options.durableOperations as Array<{
            intent: { resourceKey: { targetId: Id } };
          }>
        ).push({
          intent: { resourceKey: { targetId: "target_1" } }
        });
      }
    }
  ])(
    "does not repair a legacy cursor with a $name",
    ({ reason, configure }) => {
      const state = createInitialState("/bin/zsh");
      const save = vi.fn();
      const options = {
        ...baseOptions(state, { target_1: receipt("target_1", 12n) }),
        sourceSnapshot: { status: "ok" as const, schemaVersion: 3 as const },
        bindingTargetIds: ["target_1"],
        persistDurableProductSnapshot: save
      };
      configure(state, options);

      const result = recoverLegacyRemoteEventCheckpoints(options);

      expectConflict(result.conflicts, reason);
      expect(save).not.toHaveBeenCalled();
      expect(state.remoteRecovery.eventReceipts.target_1).toBeUndefined();
    }
  );
});

interface FixtureReceiptStore extends RemoteEventReceiptStore {
  records: Record<Id, RemoteEventReceiptRecord>;
}

function baseOptions(
  state: AppState,
  records: Record<Id, RemoteEventReceiptRecord>
): RemoteEventCheckpointRecoveryOptions & {
  eventReceiptStore: FixtureReceiptStore;
} {
  return {
    desktopInstallationId: "desktop_1",
    state,
    sourceSnapshot: { status: "missing" },
    bindingTargetIds: [],
    retained: [],
    conversions: [],
    durableOperations: [],
    eventReceiptStore: {
      records,
      load: (_desktopInstallationId, targetId) =>
        structuredClone(records[targetId] ?? receipt(targetId, 0n)),
      stage: () => {
        throw new Error("not used");
      },
      complete: () => {
        throw new Error("not used");
      }
    },
    persistDurableProductSnapshot: vi.fn()
  };
}

function receipt(
  targetId: Id,
  appliedThrough: bigint,
  pending?: RemoteSpoolEventDto
): RemoteEventReceiptRecord {
  return {
    desktopInstallationId: "desktop_1",
    targetId,
    appliedThrough: uint64(appliedThrough),
    ...(pending === undefined ? {} : { pending })
  };
}

function expectConflict(
  conflicts: RemoteEventCheckpointConflictError[],
  reason: RemoteEventCheckpointConflictReason
): void {
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]).toBeInstanceOf(RemoteEventCheckpointConflictError);
  expect(conflicts[0]).toMatchObject({
    targetId: "target_1",
    productThrough: 0n,
    durableThrough: 12n,
    reason
  });
}

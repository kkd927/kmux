import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { uint64 } from "@kmux/proto";

import {
  createRetainedSessionInventoryStore,
  retainedTerminationHasDurableTombstone
} from "./retainedSessionInventory";
import { durableAtomicReplace } from "./durableAtomicWrite";
import type { ObservedSessionKeeper } from "./remoteReconciler";

describe("retained-session inventory", () => {
  let sandbox: string;
  let inventoryPath: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "kmux-retained-sessions-"));
    inventoryPath = join(sandbox, "remote", "retained-sessions.json");
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("durably caches an owned descriptor and exposes it only after explicit retention", () => {
    const store = createRetainedSessionInventoryStore(inventoryPath, {
      now: () => "2026-07-18T00:00:02.000Z"
    });
    const keeper = observedKeeper({
      storageStatus: {
        state: "degraded",
        journalAdmitted: uint64(9n),
        journalSynced: uint64(8n),
        emergencyBytes: 1024,
        lastSyncDurationMs: 2100
      },
      checkpointAvailable: true,
      retainedRangeTruncated: true
    });

    store.cacheOwned(keeper, "2026-07-18T00:00:00.000Z");
    expect(store.listRetained()).toEqual([]);

    const retained = store.retainCached(keeper.resourceKey, "restore-disabled");
    expect(retained).toMatchObject({
      ownership: "retained",
      reason: "restore-disabled",
      retainedAt: "2026-07-18T00:00:02.000Z",
      keeperGeneration: "keeper_1",
      remoteResourceRevision: 4n,
      persistenceLevel: "ssh-disconnect",
      storageStatus: {
        state: "degraded",
        journalAdmitted: 9n,
        journalSynced: 8n,
        emergencyBytes: 1024
      },
      checkpointAvailable: true,
      retainedRangeTruncated: true
    });

    const reloaded = createRetainedSessionInventoryStore(inventoryPath);
    expect(reloaded.listRetained()).toEqual([retained]);
    const envelope = JSON.parse(readFileSync(inventoryPath, "utf8")) as {
      entriesDigest: string;
    };
    expect(envelope.entriesDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps offline termination retained until the exact result and tombstone are both durable", () => {
    const store = createRetainedSessionInventoryStore(inventoryPath, {
      now: () => "2026-07-18T00:00:01.000Z"
    });
    const keeper = observedKeeper();
    const pending = store.markTerminationPending(
      keeper,
      "2026-07-18T00:00:00.000Z",
      {
        operationId: "terminate_1",
        canonicalPayloadHash: "d".repeat(64),
        expectedWorkspaceRevision: "c".repeat(64),
        expectedRemoteResourceRevision: uint64(4n),
        nextRemoteResourceRevision: uint64(5n),
        admittedAt: "2026-07-18T00:00:01.000Z",
        priorReason: "unowned-observation"
      }
    );

    expect(pending.reason).toBe("termination-pending");
    expect(retainedTerminationHasDurableTombstone(pending, keeper)).toBe(false);
    expect(store.listRetained()).toHaveLength(1);

    const withResult = store.recordTerminationResult(
      keeper.resourceKey,
      "terminate_1",
      "e".repeat(64)
    );
    expect(retainedTerminationHasDurableTombstone(withResult, keeper)).toBe(
      false
    );

    const tombstone = observedKeeper({
      processState: "exited",
      remoteResourceRevision: uint64(5n),
      exitCode: 0,
      descriptor: {
        ...keeper.descriptor!,
        lastOperationId: "terminate_1",
        lastOperationPayloadHash: "d".repeat(64),
        lastResultDigest: "e".repeat(64)
      }
    });
    expect(retainedTerminationHasDurableTombstone(withResult, tombstone)).toBe(
      true
    );
    expect(store.remove(keeper.resourceKey)).toBe(true);
    expect(store.listRetained()).toEqual([]);
  });

  it("does not lose an explicit retention reason on a later unowned observation", () => {
    const store = createRetainedSessionInventoryStore(inventoryPath);
    const keeper = observedKeeper();
    store.retain(
      keeper,
      "workspace-close",
      "2026-07-18T00:00:00.000Z",
      "2026-07-18T00:00:01.000Z"
    );

    const updated = store.retain(
      observedKeeper({ remoteResourceRevision: uint64(5n) }),
      "unowned-observation",
      "2026-07-18T00:00:02.000Z"
    );

    expect(updated.reason).toBe("workspace-close");
    expect(updated.retainedAt).toBe("2026-07-18T00:00:01.000Z");
    expect(updated.remoteResourceRevision).toBe(5n);
  });

  it("durably admits and audits an explicit retained-session termination failure", () => {
    const store = createRetainedSessionInventoryStore(inventoryPath);
    const keeper = observedKeeper();
    store.retain(
      keeper,
      "workspace-close",
      "2026-07-18T00:00:00.000Z",
      "2026-07-18T00:00:01.000Z"
    );
    const termination = {
      operationId: "terminate_retained_1",
      canonicalPayloadHash: "d".repeat(64),
      expectedWorkspaceRevision: "c".repeat(64),
      expectedRemoteResourceRevision: uint64(4n),
      nextRemoteResourceRevision: uint64(5n),
      admittedAt: "2026-07-18T00:00:02.000Z",
      priorReason: "workspace-close" as const
    };

    expect(
      store.admitRetainedTermination(keeper.resourceKey, termination)
    ).toMatchObject({
      reason: "termination-pending",
      termination
    });
    const failed = store.recordTerminationFailure(keeper.resourceKey, {
      operationId: termination.operationId,
      resultDigest: "e".repeat(64),
      code: "not-authorized",
      message: "termination was rejected",
      completedAt: "2026-07-18T00:00:03.000Z"
    });
    expect(failed).toMatchObject({
      reason: "workspace-close",
      lastTerminationFailure: {
        operationId: termination.operationId,
        code: "not-authorized"
      }
    });
    expect(failed.termination).toBeUndefined();

    expect(
      createRetainedSessionInventoryStore(inventoryPath).listRetained()
    ).toEqual([failed]);
  });

  it("persists one bounded observation batch and skips identical reconnect fsyncs", () => {
    let writes = 0;
    const store = createRetainedSessionInventoryStore(inventoryPath, {
      write: (root, fileName, bytes) => {
        writes += 1;
        durableAtomicReplace(root, fileName, bytes);
      }
    });
    const first = observedKeeper();
    const second = observedKeeper({
      resourceKey: {
        ...first.resourceKey,
        sessionId: "session_2"
      },
      generation: "keeper_2"
    });

    store.synchronizeObserved([
      {
        disposition: "owned",
        keeper: first,
        observedAt: "2026-07-18T00:00:00.000Z"
      },
      {
        disposition: "retained",
        keeper: second,
        reason: "unowned-observation",
        observedAt: "2026-07-18T00:00:00.000Z"
      }
    ]);
    expect(writes).toBe(1);

    store.synchronizeObserved([
      {
        disposition: "owned",
        keeper: first,
        observedAt: "2026-07-18T00:01:00.000Z"
      },
      {
        disposition: "retained",
        keeper: second,
        reason: "unowned-observation",
        observedAt: "2026-07-18T00:01:00.000Z"
      }
    ]);
    expect(writes).toBe(1);
    expect(store.get(first.resourceKey)?.lastObservedAt).toBe(
      "2026-07-18T00:01:00.000Z"
    );

    store.synchronizeObserved([
      {
        disposition: "retained",
        keeper: observedKeeper({
          resourceKey: second.resourceKey,
          generation: second.generation,
          remoteResourceRevision: uint64(5n)
        }),
        reason: "unowned-observation",
        observedAt: "2026-07-18T00:02:00.000Z"
      }
    ]);
    expect(writes).toBe(2);
  });

  it("fails closed on digest corruption and unsafe permissions", () => {
    const store = createRetainedSessionInventoryStore(inventoryPath);
    store.cacheOwned(observedKeeper(), "2026-07-18T00:00:00.000Z");
    const envelope = JSON.parse(readFileSync(inventoryPath, "utf8")) as {
      entries: Array<{ keeperGeneration: string }>;
    };
    envelope.entries[0].keeperGeneration = "tampered";
    writeFileSync(inventoryPath, JSON.stringify(envelope), { mode: 0o600 });
    expect(() => createRetainedSessionInventoryStore(inventoryPath)).toThrow(
      /digest mismatch/u
    );

    chmodSync(inventoryPath, 0o644);
    expect(() => createRetainedSessionInventoryStore(inventoryPath)).toThrow(
      /group or other permissions/u
    );
  });
});

function observedKeeper(
  overrides: Partial<ObservedSessionKeeper> = {}
): ObservedSessionKeeper {
  const base: ObservedSessionKeeper = {
    resourceKey: {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: "workspace_1",
      sessionId: "session_1"
    },
    generation: "keeper_1",
    processState: "running",
    persistenceLevel: "ssh-disconnect",
    remoteResourceRevision: uint64(4n),
    storageStatus: {
      state: "normal",
      journalAdmitted: uint64(4n),
      journalSynced: uint64(4n),
      emergencyBytes: 0
    },
    checkpointAvailable: false,
    retainedRangeTruncated: false,
    descriptor: {
      createOperationId: "create_1",
      canonicalCreatePayloadHash: "a".repeat(64),
      lastOperationId: "create_1",
      lastOperationPayloadHash: "a".repeat(64),
      lastResultDigest: "b".repeat(64),
      launch: {
        cwd: "/srv/app",
        shell: "/bin/sh",
        args: ["-l"],
        env: { TERM: "xterm-256color" },
        title: "agent"
      },
      lifecycleState: "committed",
      everGrantedWriterLease: true
    }
  };
  return {
    ...base,
    ...overrides,
    resourceKey: overrides.resourceKey ?? base.resourceKey,
    descriptor: overrides.descriptor ?? base.descriptor
  };
}

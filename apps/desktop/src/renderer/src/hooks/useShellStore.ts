import {
  type MutableRefObject,
  useEffect,
  useRef,
  useSyncExternalStore
} from "react";

import type {
  ShellPatch,
  ShellStoreSnapshot,
  WorkspaceRowVm,
  WorkspaceRowsPatch
} from "@kmux/proto";
import {
  isRendererSmoothnessProfileEnabled,
  recordRendererSmoothnessProfileEvent
} from "../smoothnessProfile";

let snapshot: ShellStoreSnapshot | null = null;
let initialized = false;
let unsubscribeRemote: (() => void) | null = null;
let snapshotRequest: Promise<void> | null = null;
let pendingPatches: ShellPatch[] = [];
let recoveringGap = false;
let refetchAfterCurrentRequest = false;
const listeners = new Set<() => void>();

function ensureInitialized(): void {
  if (initialized) {
    return;
  }
  initialized = true;
  unsubscribeRemote = window.kmux.subscribeShellPatches((patch) => {
    if (!snapshot || recoveringGap) {
      queuePendingPatch(patch);
      void requestShellState();
      return;
    }
    applyOrRecoverFromShellPatch(snapshot, patch);
  });
  void requestShellState();
}

function queuePendingPatch(patch: ShellPatch): void {
  pendingPatches.push(patch);
}

function requestShellState(): Promise<void> {
  if (!snapshotRequest) {
    snapshotRequest = window.kmux
      .getShellState()
      .then((nextSnapshot) => {
        if (initialized) {
          publishSnapshot(applyPendingPatches(nextSnapshot));
        }
      })
      .finally(() => {
        snapshotRequest = null;
        if (initialized && refetchAfterCurrentRequest) {
          refetchAfterCurrentRequest = false;
          void requestShellState();
        }
      });
  }
  return snapshotRequest;
}

function applyPendingPatches(
  nextSnapshot: ShellStoreSnapshot
): ShellStoreSnapshot {
  let resolvedSnapshot = nextSnapshot;
  const queuedPatches = pendingPatches.sort(
    (left, right) => left.version - right.version
  );
  pendingPatches = [];
  recoveringGap = false;
  for (const patch of queuedPatches) {
    if (patch.version <= resolvedSnapshot.version) {
      continue;
    }
    if (patch.version > resolvedSnapshot.version + 1) {
      queuePendingPatch(patch);
      recoveringGap = true;
      refetchAfterCurrentRequest = true;
      continue;
    }
    resolvedSnapshot = applyShellPatchWithProfile(resolvedSnapshot, patch);
  }
  return resolvedSnapshot;
}

function applyOrRecoverFromShellPatch(
  currentSnapshot: ShellStoreSnapshot,
  patch: ShellPatch
): void {
  if (patch.version <= currentSnapshot.version) {
    return;
  }
  if (patch.version !== currentSnapshot.version + 1) {
    queuePendingPatch(patch);
    recoveringGap = true;
    void requestShellState();
    return;
  }
  publishSnapshot(applyShellPatchWithProfile(currentSnapshot, patch));
}

function applyShellPatchWithProfile(
  currentSnapshot: ShellStoreSnapshot,
  patch: ShellPatch
): ShellStoreSnapshot {
  if (!isRendererSmoothnessProfileEnabled()) {
    return applyShellPatch(currentSnapshot, patch);
  }
  const startedAt = performance.now();
  const nextSnapshot = applyShellPatch(currentSnapshot, patch);
  recordRendererSmoothnessProfileEvent("shell.patch.apply", {
    version: patch.version,
    keys: Object.keys(patch).filter((key) => key !== "version"),
    durationMs: performance.now() - startedAt
  });
  return nextSnapshot;
}

function applyShellPatch(
  currentSnapshot: ShellStoreSnapshot,
  patch: ShellPatch
): ShellStoreSnapshot {
  if (patch.version <= currentSnapshot.version) {
    return currentSnapshot;
  }
  const { workspaceRowsPatch, ...snapshotPatch } = patch;
  const workspaceRows = workspaceRowsPatch
    ? applyWorkspaceRowsPatch(currentSnapshot.workspaceRows, workspaceRowsPatch)
    : (patch.workspaceRows ?? currentSnapshot.workspaceRows);

  return {
    ...currentSnapshot,
    ...snapshotPatch,
    workspaceRows
  };
}

function applyWorkspaceRowsPatch(
  currentRows: WorkspaceRowVm[],
  patch: WorkspaceRowsPatch
): WorkspaceRowVm[] {
  const nextById = new Map(
    currentRows.map((row) => [row.workspaceId, row] as const)
  );
  for (const workspaceId of patch.remove ?? []) {
    nextById.delete(workspaceId);
  }
  for (const row of patch.upsert ?? []) {
    nextById.set(row.workspaceId, row);
  }

  const order =
    patch.order ??
    currentRows
      .map((row) => row.workspaceId)
      .filter((workspaceId) => nextById.has(workspaceId));
  const orderedRows = order
    .map((workspaceId) => nextById.get(workspaceId))
    .filter((row): row is WorkspaceRowVm => Boolean(row));
  const orderedIds = new Set(order);
  for (const row of nextById.values()) {
    if (!orderedIds.has(row.workspaceId)) {
      orderedRows.push(row);
    }
  }
  return orderedRows;
}

function publishSnapshot(nextSnapshot: ShellStoreSnapshot): void {
  if (snapshot && nextSnapshot.version <= snapshot.version) {
    return;
  }
  snapshot = nextSnapshot;
  const notifyStartedAt = isRendererSmoothnessProfileEnabled()
    ? performance.now()
    : 0;
  for (const listener of listeners) {
    listener();
  }
  if (isRendererSmoothnessProfileEnabled()) {
    recordRendererSmoothnessProfileEvent("shell.selector.notify", {
      version: nextSnapshot.version,
      listenerCount: listeners.size,
      durationMs: performance.now() - notifyStartedAt
    });
  }
}

function subscribe(listener: () => void): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && unsubscribeRemote) {
      unsubscribeRemote();
      unsubscribeRemote = null;
      initialized = false;
      snapshot = null;
      snapshotRequest = null;
      pendingPatches = [];
      recoveringGap = false;
      refetchAfterCurrentRequest = false;
    }
  };
}

export function useShellSnapshot(): ShellStoreSnapshot | null {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

export function useShellSnapshotRef(): MutableRefObject<ShellStoreSnapshot | null> {
  const snapshotRef = useRef(snapshot);

  useEffect(() => {
    snapshotRef.current = snapshot;
    return subscribe(() => {
      snapshotRef.current = snapshot;
    });
  }, []);

  return snapshotRef;
}

export function useShellSelector<T>(
  selector: (snapshot: ShellStoreSnapshot | null) => T,
  isEqual: (left: T, right: T) => boolean = Object.is
): T {
  const selectorRef = useRef(selector);
  const valueRef = useRef(selector(snapshot));

  selectorRef.current = selector;

  return useSyncExternalStore(
    subscribe,
    () => {
      const nextValue = selectorRef.current(snapshot);
      if (!isEqual(valueRef.current, nextValue)) {
        valueRef.current = nextValue;
      }
      return valueRef.current;
    },
    () => valueRef.current
  );
}

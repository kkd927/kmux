import { useSyncExternalStore } from "react";

import type { UpdaterState } from "@kmux/proto";

let snapshot: UpdaterState = {
  status: "disabled"
};
let initialized = false;
let deliveredFromSubscription = false;
let unsubscribeRemote: (() => void) | null = null;
const listeners = new Set<() => void>();

function ensureInitialized(): void {
  if (initialized) {
    return;
  }
  initialized = true;
  unsubscribeRemote = window.kmux.subscribeUpdater((nextSnapshot) => {
    deliveredFromSubscription = true;
    publish(nextSnapshot);
  });
  void window.kmux.getUpdaterState().then((nextSnapshot) => {
    if (!deliveredFromSubscription) {
      publish(nextSnapshot);
    }
  });
}

function publish(nextSnapshot: UpdaterState): void {
  if (
    snapshot.status === nextSnapshot.status &&
    snapshot.version === nextSnapshot.version &&
    snapshot.errorMessage === nextSnapshot.errorMessage
  ) {
    return;
  }

  snapshot = nextSnapshot;
  for (const listener of listeners) {
    listener();
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
      deliveredFromSubscription = false;
    }
  };
}

export function useUpdaterState(): UpdaterState {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

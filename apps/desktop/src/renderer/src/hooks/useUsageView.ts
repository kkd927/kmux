import { useRef, useSyncExternalStore } from "react";

import {
  createEmptyUsageViewSnapshot,
  type UsageViewSnapshot
} from "@kmux/proto";

let snapshot = createEmptyUsageViewSnapshot();
let initialized = false;
let deliveredFromSubscription = false;
let unsubscribeRemote: (() => void) | null = null;
const listeners = new Set<() => void>();

function ensureInitialized(): void {
  if (initialized) {
    return;
  }
  initialized = true;
  unsubscribeRemote = window.kmux.subscribeUsage((nextSnapshot) => {
    deliveredFromSubscription = true;
    publish(nextSnapshot);
  });
  void window.kmux.getUsageView().then((nextSnapshot) => {
    if (!deliveredFromSubscription) {
      publish(nextSnapshot);
    }
  });
}

function publish(nextSnapshot: UsageViewSnapshot): void {
  if (snapshot === nextSnapshot) {
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

export function useUsageSnapshot(): UsageViewSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

export function useUsageSelector<T>(
  selector: (snapshot: UsageViewSnapshot) => T,
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

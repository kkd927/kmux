import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { Unicode11Addon } from "@xterm/addon-unicode11";
import type { Terminal } from "@xterm/xterm";

export interface TerminalInstance {
  host: HTMLDivElement;
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  unicode11: Unicode11Addon;
  lastHydratedSurfaceId: string | null;
  lastHydratedSurfaceSequence: number | null;
}

const store = new Map<string, TerminalInstance>();

export function acquire(
  paneId: string,
  init: () => TerminalInstance
): { instance: TerminalInstance; isNew: boolean } {
  const existing = store.get(paneId);
  if (existing) {
    return { instance: existing, isNew: false };
  }
  const instance = init();
  store.set(paneId, instance);
  return { instance, isNew: true };
}

export function detach(paneId: string): void {
  const instance = store.get(paneId);
  if (instance?.host.parentNode) {
    instance.host.parentNode.removeChild(instance.host);
  }
}

export function release(paneId: string): void {
  const instance = store.get(paneId);
  if (!instance) {
    return;
  }
  store.delete(paneId);
  if (instance.host.parentNode) {
    instance.host.parentNode.removeChild(instance.host);
  }
  instance.terminal.dispose();
}

export function getLastHydratedSurfaceId(paneId: string): string | null {
  return store.get(paneId)?.lastHydratedSurfaceId ?? null;
}

export function getLastHydratedSurfaceSequence(paneId: string): number | null {
  return store.get(paneId)?.lastHydratedSurfaceSequence ?? null;
}

export function markSurfaceHydrated(
  paneId: string,
  surfaceId: string,
  sequence: number | null = null
): void {
  const instance = store.get(paneId);
  if (instance) {
    instance.lastHydratedSurfaceId = surfaceId;
    instance.lastHydratedSurfaceSequence = sequence;
  }
}

export function markSurfaceRendered(
  paneId: string,
  surfaceId: string,
  sequence: number
): void {
  const instance = store.get(paneId);
  if (instance?.lastHydratedSurfaceId === surfaceId) {
    instance.lastHydratedSurfaceSequence = Math.max(
      instance.lastHydratedSurfaceSequence ?? 0,
      sequence
    );
  }
}

export function releaseAll(): void {
  for (const paneId of [...store.keys()]) {
    release(paneId);
  }
}

import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { Unicode11Addon } from "@xterm/addon-unicode11";
import type { WebLinksAddon } from "@xterm/addon-web-links";
import type { Terminal } from "@xterm/xterm";

export interface TerminalInstance {
  host: HTMLDivElement;
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  unicode11: Unicode11Addon;
  webLinks: WebLinksAddon;
  lastHydratedSurfaceId: string | null;
  lastHydratedSurfaceSequence: number | null;
  // Active stream attachment cleanup. The terminal widget may stay cached by
  // surface, but the IPC attachment must only live while that surface is active.
  attachmentCleanup: (() => void) | null;
  renderSink: TerminalRenderSink | null;
}

export interface TerminalRenderSink {
  write(data: string, afterWrite?: () => void, surfaceId?: string): void;
  fitAndSync(): Promise<void>;
  beforeFitAndSync?(): void;
}

const store = new Map<string, TerminalInstance>();

export function acquire(
  key: string,
  init: () => TerminalInstance
): { instance: TerminalInstance; isNew: boolean } {
  const existing = store.get(key);
  if (existing) {
    return { instance: existing, isNew: false };
  }
  const instance = init();
  store.set(key, instance);
  return { instance, isNew: true };
}

export function hasAttachment(key: string): boolean {
  return Boolean(store.get(key)?.attachmentCleanup);
}

export function registerAttachment(key: string, cleanup: () => void): boolean {
  const instance = store.get(key);
  if (!instance || instance.attachmentCleanup) {
    return false;
  }
  instance.attachmentCleanup = cleanup;
  return true;
}

export function clearAttachment(key: string, cleanup: () => void): boolean {
  const instance = store.get(key);
  if (instance?.attachmentCleanup !== cleanup) {
    return false;
  }
  instance.attachmentCleanup = null;
  return true;
}

function detachAttachment(key: string): void {
  const instance = store.get(key);
  const cleanup = instance?.attachmentCleanup;
  if (!instance || !cleanup) {
    return;
  }
  instance.attachmentCleanup = null;
  cleanup();
}

export function setRenderSink(key: string, sink: TerminalRenderSink): void {
  const instance = store.get(key);
  if (instance) {
    instance.renderSink = sink;
  }
}

export function clearRenderSink(key: string, sink: TerminalRenderSink): void {
  const instance = store.get(key);
  if (instance?.renderSink === sink) {
    instance.renderSink = null;
  }
}

export function getRenderSink(key: string): TerminalRenderSink | null {
  return store.get(key)?.renderSink ?? null;
}

export function release(key: string): void {
  const instance = store.get(key);
  if (!instance) {
    return;
  }
  detachAttachment(key);
  store.delete(key);
  if (instance.host.parentNode) {
    instance.host.parentNode.removeChild(instance.host);
  }
  instance.terminal.dispose();
}

export function getLastHydratedSurfaceId(key: string): string | null {
  return store.get(key)?.lastHydratedSurfaceId ?? null;
}

export function getLastHydratedSurfaceSequence(key: string): number | null {
  return store.get(key)?.lastHydratedSurfaceSequence ?? null;
}

export function markSurfaceHydrated(
  key: string,
  surfaceId: string,
  sequence: number | null = null
): void {
  const instance = store.get(key);
  if (instance) {
    const nextSequence =
      instance.lastHydratedSurfaceId === surfaceId
        ? maxSequence(instance.lastHydratedSurfaceSequence, sequence)
        : sequence;
    instance.lastHydratedSurfaceId = surfaceId;
    instance.lastHydratedSurfaceSequence = nextSequence;
  }
}

function maxSequence(
  current: number | null,
  next: number | null
): number | null {
  if (next === null) {
    return current;
  }
  if (current === null) {
    return next;
  }
  return Math.max(current, next);
}

export function markSurfaceRendered(
  key: string,
  surfaceId: string,
  sequence: number
): void {
  const instance = store.get(key);
  if (instance?.lastHydratedSurfaceId === surfaceId) {
    instance.lastHydratedSurfaceSequence = Math.max(
      instance.lastHydratedSurfaceSequence ?? 0,
      sequence
    );
  }
}

export function releaseAll(): void {
  for (const key of [...store.keys()]) {
    release(key);
  }
}

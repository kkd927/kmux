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
  // Surface-scoped lifetime: this cleanup must run from release(), not from a
  // TerminalPane unmount/remount caused by tab switches or pane splits.
  attachmentCleanup: (() => void) | null;
  renderSink: TerminalRenderSink | null;
}

export interface TerminalRenderSink {
  write(data: string, afterWrite?: () => void, surfaceId?: string): void;
  fitAndSync(): Promise<void>;
  beforeFitAndSync?(): void;
  onSnapshotRendered?(): void;
}

const store = new Map<string, TerminalInstance>();
const webglTerminals = new Set<Terminal>();

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

export function registerAttachment(
  key: string,
  cleanup: () => void
): boolean {
  const instance = store.get(key);
  if (!instance || instance.attachmentCleanup) {
    return false;
  }
  instance.attachmentCleanup = cleanup;
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

export function clearRenderSink(
  key: string,
  sink: TerminalRenderSink
): void {
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
  unregisterWebglTerminal(instance.terminal);
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
    instance.lastHydratedSurfaceId = surfaceId;
    instance.lastHydratedSurfaceSequence = sequence;
  }
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
  webglTerminals.clear();
}

export function registerWebglTerminal(terminal: Terminal): void {
  webglTerminals.add(terminal);
}

export function unregisterWebglTerminal(terminal: Terminal): void {
  webglTerminals.delete(terminal);
}

export function recoverWebglTextureAtlases(): number {
  const recoverable: Terminal[] = [];
  for (const terminal of [...webglTerminals]) {
    try {
      terminal.clearTextureAtlas();
      recoverable.push(terminal);
    } catch {
      webglTerminals.delete(terminal);
    }
  }
  for (const terminal of recoverable) {
    try {
      if (terminal.rows > 0) {
        terminal.refresh(0, terminal.rows - 1);
      }
    } catch {
      webglTerminals.delete(terminal);
    }
  }
  return recoverable.length;
}

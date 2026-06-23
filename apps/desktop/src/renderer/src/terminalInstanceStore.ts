import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { Unicode11Addon } from "@xterm/addon-unicode11";
import type { WebLinksAddon } from "@xterm/addon-web-links";
import type { IDisposable, Terminal } from "@xterm/xterm";

import type { TerminalLineCwdTracker } from "./terminalLineCwdTracker";

export interface TerminalInstance {
  host: HTMLDivElement;
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  unicode11: Unicode11Addon;
  webLinks: WebLinksAddon;
  fileLinks: IDisposable;
  lineCwdTrimListener: IDisposable;
  lineCwds: TerminalLineCwdTracker;
  lastHydratedSurfaceId: string | null;
  lastHydratedSurfaceSequence: number | null;
  // Active stream attachment cleanup. The terminal widget is cached by surface,
  // and the IPC attachment is scoped to the live surface session rather than a
  // particular TerminalPane render.
  attachmentCleanup: AttachmentCleanup | null;
  attachmentSessionId: string | null;
  attachmentToken: TerminalAttachmentToken | null;
  readyAttachId: string | null;
  pendingDetachPromise: Promise<void> | null;
  renderSink: TerminalRenderSink | null;
}

export type TerminalAttachmentToken = object;
type AttachmentCleanup = () => Promise<void> | void;

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

export function hasAttachment(key: string, sessionId?: string): boolean {
  const instance = store.get(key);
  if (!instance?.attachmentCleanup) {
    return false;
  }
  return sessionId === undefined || instance.attachmentSessionId === sessionId;
}

export function isCurrentAttachment(
  key: string,
  sessionId: string,
  token: TerminalAttachmentToken
): boolean {
  const instance = store.get(key);
  return Boolean(
    instance?.attachmentCleanup &&
    instance.attachmentSessionId === sessionId &&
    instance.attachmentToken === token
  );
}

export function getAttachmentSessionId(key: string): string | null {
  const instance = store.get(key);
  return instance?.attachmentCleanup ? instance.attachmentSessionId : null;
}

export function registerAttachment(
  key: string,
  sessionId: string,
  cleanup: AttachmentCleanup
): TerminalAttachmentToken | null {
  const instance = store.get(key);
  if (!instance || instance.attachmentCleanup) {
    return null;
  }
  const token: TerminalAttachmentToken = {};
  instance.attachmentCleanup = cleanup;
  instance.attachmentSessionId = sessionId;
  instance.attachmentToken = token;
  instance.readyAttachId = null;
  return token;
}

export function clearAttachment(key: string, cleanup: () => void): boolean {
  const instance = store.get(key);
  if (instance?.attachmentCleanup !== cleanup) {
    return false;
  }
  instance.attachmentCleanup = null;
  instance.attachmentSessionId = null;
  instance.attachmentToken = null;
  instance.readyAttachId = null;
  return true;
}

export function detachAttachment(key: string): void {
  const instance = store.get(key);
  const cleanup = instance?.attachmentCleanup;
  if (!instance || !cleanup) {
    return;
  }
  instance.attachmentCleanup = null;
  instance.attachmentSessionId = null;
  instance.attachmentToken = null;
  instance.readyAttachId = null;
  let cleanupResult: Promise<void> | void;
  try {
    cleanupResult = cleanup();
  } catch (error) {
    cleanupResult = Promise.reject(error);
  }
  trackPendingDetach(instance, cleanupResult);
}

export function waitForPendingDetach(key: string): Promise<void> {
  return store.get(key)?.pendingDetachPromise ?? Promise.resolve();
}

function trackPendingDetach(
  instance: TerminalInstance,
  result: Promise<void> | void
): void {
  const previous = instance.pendingDetachPromise ?? Promise.resolve();
  const pending = Promise.allSettled([previous, Promise.resolve(result)])
    .then(() => undefined)
    .finally(() => {
      if (instance.pendingDetachPromise === pending) {
        instance.pendingDetachPromise = null;
      }
    });
  instance.pendingDetachPromise = pending;
}

export function markAttachmentReady(
  key: string,
  sessionId: string,
  attachId: string,
  token: TerminalAttachmentToken
): boolean {
  const instance = store.get(key);
  if (
    !instance?.attachmentCleanup ||
    instance.attachmentSessionId !== sessionId ||
    instance.attachmentToken !== token
  ) {
    return false;
  }
  instance.readyAttachId = attachId;
  return true;
}

export function clearAttachmentReady(
  key: string,
  sessionId: string,
  token: TerminalAttachmentToken
): boolean {
  const instance = store.get(key);
  if (
    !instance?.attachmentCleanup ||
    instance.attachmentSessionId !== sessionId ||
    instance.attachmentToken !== token
  ) {
    return false;
  }
  instance.readyAttachId = null;
  return true;
}

export function getReadyAttachId(
  key: string,
  sessionId: string
): string | null {
  const instance = store.get(key);
  if (
    !instance?.attachmentCleanup ||
    instance.attachmentSessionId !== sessionId
  ) {
    return null;
  }
  return instance.readyAttachId;
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
  instance.fileLinks.dispose();
  instance.lineCwdTrimListener.dispose();
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

export function invalidateHydration(key: string): void {
  const instance = store.get(key);
  if (instance) {
    instance.lastHydratedSurfaceId = null;
    instance.lastHydratedSurfaceSequence = null;
    instance.lineCwds.clear();
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

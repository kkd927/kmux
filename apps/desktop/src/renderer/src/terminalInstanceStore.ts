import type { Terminal } from "@xterm/xterm";

import type { SurfaceTerminalCheckpointController } from "./terminalCheckpointController";
import { disposeTerminalBundle, type TerminalBundle } from "./terminalBundle";

export interface TerminalInstance extends TerminalBundle {
  lastHydratedSurfaceId: string | null;
  lastHydratedSurfaceSequence: number | null;
  // Active stream attachment cleanup. The terminal widget is cached by surface,
  // and the IPC attachment is scoped to the live surface session rather than a
  // particular TerminalPane render.
  attachmentCleanup: AttachmentCleanup | null;
  attachmentSessionId: string | null;
  attachmentToken: TerminalAttachmentToken | null;
  readyAttachId: string | null;
  renderSink: TerminalRenderSink | null;
  checkpointController?: SurfaceTerminalCheckpointController;
}

export type TerminalAttachmentToken = object;
type AttachmentCleanup = () => void;

export interface TerminalRenderSink {
  write(data: string, afterWrite?: () => void, surfaceId?: string): boolean;
  fitAndSync(): Promise<void>;
}

const store = new Map<string, TerminalInstance>();

export const WARM_TERMINAL_MAX_COUNT = 4;
export const WARM_TERMINAL_MAX_BUFFER_CELLS = 4_000_000;

export type TerminalVisibilityPin = object;

interface TerminalCacheState {
  visibilityPins: Set<TerminalVisibilityPin>;
}

interface WarmTerminalEntry {
  bufferCells: number;
}

const cacheStates = new Map<string, TerminalCacheState>();
// Map insertion order is the LRU order: oldest detached terminal first.
const warmTerminals = new Map<string, WarmTerminalEntry>();
const visibilityReservations = new Map<string, TerminalVisibilityPin>();
let warmBufferCells = 0;
let peakWarmTerminalCount = 0;
let peakWarmBufferCells = 0;
let warmBoundViolationCount = 0;

export interface TerminalStoreDiagnostics {
  lastHydratedSurfaceId: string | null;
  lastHydratedSurfaceSequence: number | null;
  attachmentSessionId: string | null;
  readyAttachId: string | null;
  hasAttachment: boolean;
  visibilityPins: number;
}

export interface TerminalCacheDiagnostics {
  totalTerminals: number;
  visibleTerminals: number;
  warmTerminals: number;
  warmBufferCells: number;
  peakWarmTerminals: number;
  peakWarmBufferCells: number;
  maxWarmTerminals: number;
  maxWarmBufferCells: number;
  boundViolationCount: number;
}

export function getTerminalCacheDiagnostics(): TerminalCacheDiagnostics {
  let visibleTerminals = 0;
  for (const state of cacheStates.values()) {
    if (state.visibilityPins.size > 0) {
      visibleTerminals += 1;
    }
  }
  return {
    totalTerminals: store.size,
    visibleTerminals,
    warmTerminals: warmTerminals.size,
    warmBufferCells,
    peakWarmTerminals: peakWarmTerminalCount,
    peakWarmBufferCells,
    maxWarmTerminals: WARM_TERMINAL_MAX_COUNT,
    maxWarmBufferCells: WARM_TERMINAL_MAX_BUFFER_CELLS,
    boundViolationCount: warmBoundViolationCount
  };
}

export function getStoreDiagnostics(
  key: string
): TerminalStoreDiagnostics | null {
  const instance = store.get(key);
  if (!instance) {
    return null;
  }
  return {
    lastHydratedSurfaceId: instance.lastHydratedSurfaceId,
    lastHydratedSurfaceSequence: instance.lastHydratedSurfaceSequence,
    attachmentSessionId: instance.attachmentSessionId,
    readyAttachId: instance.readyAttachId,
    hasAttachment: instance.attachmentCleanup !== null,
    visibilityPins: cacheStates.get(key)?.visibilityPins.size ?? 0
  };
}

// Element-level diagnostics (props/dataset) can go stale when updates stop
// reaching an element; surface captures read this hook to record the store's
// authoritative sequences alongside them.
declare global {
  interface Window {
    __kmuxTerminalStoreDiagnostics?: (
      key: string
    ) => TerminalStoreDiagnostics | null;
    __kmuxTerminalCacheDiagnostics?: () => TerminalCacheDiagnostics;
  }
}

if (typeof window !== "undefined") {
  window.__kmuxTerminalStoreDiagnostics = getStoreDiagnostics;
  window.__kmuxTerminalCacheDiagnostics = getTerminalCacheDiagnostics;
}

/**
 * Acquires a terminal for a visible surface and pins it atomically so cache
 * enforcement cannot dispose it between creation and mount.
 */
export function acquireVisible(
  key: string,
  init: () => TerminalInstance
): {
  instance: TerminalInstance;
  isNew: boolean;
  visibilityPin: TerminalVisibilityPin;
} {
  const result = getOrCreate(key, init);
  forgetWarm(key);
  const visibilityPin: TerminalVisibilityPin = {};
  const state = cacheStates.get(key)!;
  state.visibilityPins.add(visibilityPin);
  const reservation = visibilityReservations.get(key);
  if (reservation) {
    visibilityReservations.delete(key);
    state.visibilityPins.delete(reservation);
  }
  return { ...result, visibilityPin };
}

/**
 * Keeps a just-hidden xterm alive while its sealed stream drains renderer work
 * that was admitted before the MessagePort closed. The lease is not a stream
 * attachment and is normally released within the same parser turn.
 */
export function acquireSettlementPin(
  key: string
): TerminalVisibilityPin | null {
  const instance = store.get(key);
  const state = cacheStates.get(key);
  if (!instance || !state) {
    return null;
  }
  const pin: TerminalVisibilityPin = {};
  state.visibilityPins.add(pin);
  forgetWarm(key);
  return pin;
}

/**
 * Protects warm terminals that are about to become visible before React
 * unmounts the outgoing pane tree. Without this batch boundary, releasing the
 * outgoing four terminals can evict the incoming four in the same commit.
 */
export function prepareVisibleSet(keys: Iterable<string>): void {
  const desired = new Set(keys);
  for (const [key, reservation] of [...visibilityReservations]) {
    if (!desired.has(key)) {
      releaseVisibilityReservation(key, reservation);
    }
  }

  const batch: Array<[string, TerminalVisibilityPin]> = [];
  for (const key of desired) {
    const state = cacheStates.get(key);
    if (
      !state ||
      state.visibilityPins.size > 0 ||
      visibilityReservations.has(key)
    ) {
      continue;
    }
    const reservation: TerminalVisibilityPin = {};
    visibilityReservations.set(key, reservation);
    state.visibilityPins.add(reservation);
    forgetWarm(key);
    batch.push([key, reservation]);
  }

  if (batch.length === 0) {
    return;
  }
  scheduleAfterReactCommit(() => {
    for (const [key, reservation] of batch) {
      if (visibilityReservations.get(key) === reservation) {
        releaseVisibilityReservation(key, reservation);
      }
    }
  });
}

function scheduleAfterReactCommit(callback: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => callback());
    return;
  }
  setTimeout(callback, 0);
}

function releaseVisibilityReservation(
  key: string,
  reservation: TerminalVisibilityPin
): void {
  if (visibilityReservations.get(key) !== reservation) {
    return;
  }
  visibilityReservations.delete(key);
  const instance = store.get(key);
  const state = cacheStates.get(key);
  if (!instance || !state?.visibilityPins.delete(reservation)) {
    return;
  }
  if (state.visibilityPins.size === 0) {
    markWarm(key, instance);
    enforceWarmLimits();
    recordWarmBounds();
  }
}

/**
 * Releases one visible owner. The terminal becomes a warm LRU entry only when
 * its last owner leaves, which keeps pane-move/remount handoffs pinned.
 */
export function releaseVisibilityPin(
  key: string,
  visibilityPin: TerminalVisibilityPin
): void {
  const instance = store.get(key);
  const state = cacheStates.get(key);
  if (!instance || !state?.visibilityPins.delete(visibilityPin)) {
    return;
  }
  if (state.visibilityPins.size > 0) {
    return;
  }
  // Seal the direct stream before this xterm enters the evictable warm LRU.
  // TerminalPane's cleanup takes a settlement pin when admitted parser work
  // still needs the widget, so re-check ownership before marking it warm.
  if (instance.attachmentCleanup) {
    detachAttachment(key);
    if (state.visibilityPins.size > 0) {
      return;
    }
  }
  markWarm(key, instance);
  enforceWarmLimits();
  recordWarmBounds();
}

export function hasVisibilityPin(key: string): boolean {
  return (cacheStates.get(key)?.visibilityPins.size ?? 0) > 0;
}

function getOrCreate(
  key: string,
  init: () => TerminalInstance
): { instance: TerminalInstance; isNew: boolean } {
  const existing = store.get(key);
  if (existing) {
    return { instance: existing, isNew: false };
  }
  const instance = init();
  store.set(key, instance);
  cacheStates.set(key, { visibilityPins: new Set() });
  return { instance, isNew: true };
}

function markWarm(key: string, instance: TerminalInstance): void {
  forgetWarm(key);
  const bufferCells = terminalBufferCells(instance.terminal);
  warmTerminals.set(key, { bufferCells });
  warmBufferCells += bufferCells;
}

function forgetWarm(key: string): void {
  const warm = warmTerminals.get(key);
  if (!warm) {
    return;
  }
  warmTerminals.delete(key);
  warmBufferCells -= warm.bufferCells;
}

function enforceWarmLimits(): void {
  while (
    warmTerminals.size > WARM_TERMINAL_MAX_COUNT ||
    warmBufferCells > WARM_TERMINAL_MAX_BUFFER_CELLS
  ) {
    const oldestKey = warmTerminals.keys().next().value as string | undefined;
    if (!oldestKey) {
      return;
    }
    release(oldestKey);
  }
}

function recordWarmBounds(): void {
  peakWarmTerminalCount = Math.max(peakWarmTerminalCount, warmTerminals.size);
  peakWarmBufferCells = Math.max(peakWarmBufferCells, warmBufferCells);
  if (
    warmTerminals.size > WARM_TERMINAL_MAX_COUNT ||
    warmBufferCells > WARM_TERMINAL_MAX_BUFFER_CELLS
  ) {
    warmBoundViolationCount += 1;
  }
}

function terminalBufferCells(terminal: Terminal): number {
  const dimensions = terminal as unknown as {
    cols?: number;
    rows?: number;
    buffer?: {
      active?: { length?: number };
      normal?: { length?: number };
      alternate?: { length?: number };
    };
  };
  const cols = nonNegativeInteger(dimensions.cols);
  const normalLines = finiteNonNegativeInteger(
    dimensions.buffer?.normal?.length
  );
  const alternateLines = finiteNonNegativeInteger(
    dimensions.buffer?.alternate?.length
  );
  const bufferLines =
    normalLines !== null || alternateLines !== null
      ? (normalLines ?? 0) + (alternateLines ?? 0)
      : (finiteNonNegativeInteger(dimensions.buffer?.active?.length) ??
        nonNegativeInteger(dimensions.rows));
  return cols * bufferLines;
}

function finiteNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function nonNegativeInteger(value: unknown): number {
  return finiteNonNegativeInteger(value) ?? 0;
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
  try {
    cleanup();
  } catch (error) {
    console.warn("Failed to detach terminal attachment", error);
  }
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

export function isCurrentTerminal(key: string, terminal: Terminal): boolean {
  return store.get(key)?.terminal === terminal;
}

/**
 * Atomically changes only the concrete xterm widget owned by a visible
 * surface. Attachment tokens, port cleanup, hydration metadata, and cache
 * ownership remain on the stable TerminalInstance object.
 */
export function replaceTerminalBundle(
  key: string,
  expectedTerminal: Terminal,
  replacement: TerminalBundle
): TerminalBundle | null {
  const instance = store.get(key);
  const state = cacheStates.get(key);
  if (
    !instance ||
    instance.terminal !== expectedTerminal ||
    !state ||
    state.visibilityPins.size === 0
  ) {
    return null;
  }
  const previous = bundleFromInstance(instance);
  instance.host = replacement.host;
  instance.terminal = replacement.terminal;
  instance.fit = replacement.fit;
  instance.search = replacement.search;
  instance.unicode11 = replacement.unicode11;
  instance.webLinks = replacement.webLinks;
  instance.fileLinks = replacement.fileLinks;
  instance.lineCwdTrimListener = replacement.lineCwdTrimListener;
  instance.lineCwds = replacement.lineCwds;
  return previous;
}

function bundleFromInstance(instance: TerminalInstance): TerminalBundle {
  return {
    host: instance.host,
    terminal: instance.terminal,
    fit: instance.fit,
    search: instance.search,
    unicode11: instance.unicode11,
    webLinks: instance.webLinks,
    fileLinks: instance.fileLinks,
    lineCwdTrimListener: instance.lineCwdTrimListener,
    lineCwds: instance.lineCwds
  };
}

export function getTerminalBundle(key: string): TerminalBundle | null {
  const instance = store.get(key);
  return instance ? bundleFromInstance(instance) : null;
}

export function release(key: string): void {
  const instance = store.get(key);
  if (!instance) {
    return;
  }
  detachAttachment(key);
  visibilityReservations.delete(key);
  instance.checkpointController?.dispose();
  instance.checkpointController = undefined;
  forgetWarm(key);
  cacheStates.delete(key);
  store.delete(key);
  disposeTerminalBundle(bundleFromInstance(instance));
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

/** Restores an exact pre-transaction cursor after a failed widget swap. */
export function restoreHydrationState(
  key: string,
  surfaceId: string | null,
  sequence: number | null
): void {
  const instance = store.get(key);
  if (!instance) {
    return;
  }
  instance.lastHydratedSurfaceId = surfaceId;
  instance.lastHydratedSurfaceSequence = sequence;
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
  peakWarmTerminalCount = 0;
  peakWarmBufferCells = 0;
  warmBoundViolationCount = 0;
  visibilityReservations.clear();
}

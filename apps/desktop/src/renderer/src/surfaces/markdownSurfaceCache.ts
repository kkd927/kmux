import type {
  Id,
  MarkdownDocumentErrorCode,
  MarkdownDocumentEvent
} from "@kmux/proto";

const MAX_CACHED_MARKDOWN_SURFACES = 32;

export type MarkdownSurfaceStatus = "loading" | "ready" | "offline" | "error";

export interface MarkdownSurfaceCacheEntry {
  revision: number;
  status: MarkdownSurfaceStatus;
  text?: string;
  errorCode?: MarkdownDocumentErrorCode;
  scrollTop: number;
}

const entries = new Map<Id, MarkdownSurfaceCacheEntry>();

export function readMarkdownSurfaceCache(
  surfaceId: Id
): MarkdownSurfaceCacheEntry {
  const existing = entries.get(surfaceId);
  if (existing) {
    touch(surfaceId, existing);
    return existing;
  }
  const entry: MarkdownSurfaceCacheEntry = {
    revision: 0,
    status: "loading",
    scrollTop: 0
  };
  touch(surfaceId, entry);
  trimCache();
  return entry;
}

export function applyMarkdownDocumentEvent(
  event: MarkdownDocumentEvent
): MarkdownSurfaceCacheEntry | null {
  const previous = readMarkdownSurfaceCache(event.surfaceId);
  if (event.revision <= previous.revision) return null;

  let next: MarkdownSurfaceCacheEntry;
  if (event.type === "snapshot") {
    next = {
      revision: event.revision,
      status: "ready",
      text: event.text,
      scrollTop: previous.scrollTop
    };
  } else if (event.type === "offline") {
    next = {
      revision: event.revision,
      status: "offline",
      ...(previous.text === undefined ? {} : { text: previous.text }),
      scrollTop: previous.scrollTop
    };
  } else if (event.type === "error") {
    next = {
      revision: event.revision,
      status: "error",
      errorCode: event.errorCode,
      scrollTop: previous.scrollTop
    };
  } else {
    next =
      previous.text !== undefined
        ? { ...previous, revision: event.revision }
        : {
            revision: event.revision,
            status: "loading",
            scrollTop: previous.scrollTop
          };
  }
  touch(event.surfaceId, next);
  return next;
}

export function markMarkdownSubscriptionError(
  surfaceId: Id
): MarkdownSurfaceCacheEntry {
  const previous = readMarkdownSurfaceCache(surfaceId);
  const next: MarkdownSurfaceCacheEntry = {
    revision: previous.revision + 1,
    status: "error",
    errorCode: "read-failed",
    scrollTop: previous.scrollTop
  };
  touch(surfaceId, next);
  return next;
}

export function updateMarkdownSurfaceScroll(
  surfaceId: Id,
  scrollTop: number
): void {
  const previous = readMarkdownSurfaceCache(surfaceId);
  touch(surfaceId, {
    ...previous,
    scrollTop: Math.max(0, scrollTop)
  });
}

export function releaseMarkdownSurfaceCache(surfaceId: Id): void {
  entries.delete(surfaceId);
}

export function sameMarkdownRenderState(
  left: MarkdownSurfaceCacheEntry,
  right: MarkdownSurfaceCacheEntry
): boolean {
  return (
    left.status === right.status &&
    left.text === right.text &&
    left.errorCode === right.errorCode
  );
}

export function clearMarkdownSurfaceCacheForTest(): void {
  entries.clear();
}

function touch(surfaceId: Id, entry: MarkdownSurfaceCacheEntry): void {
  entries.delete(surfaceId);
  entries.set(surfaceId, entry);
}

function trimCache(): void {
  while (entries.size > MAX_CACHED_MARKDOWN_SURFACES) {
    const oldestSurfaceId = entries.keys().next().value as Id | undefined;
    if (!oldestSurfaceId) return;
    entries.delete(oldestSurfaceId);
  }
}

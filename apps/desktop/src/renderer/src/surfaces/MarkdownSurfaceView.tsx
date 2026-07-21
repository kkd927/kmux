import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type UIEvent
} from "react";

import type { SurfaceViewProps } from "./contracts";
import {
  applyMarkdownDocumentEvent,
  markMarkdownSubscriptionError,
  readMarkdownSurfaceCache,
  sameMarkdownRenderState,
  updateMarkdownSurfaceScroll,
  type MarkdownSurfaceCacheEntry
} from "./markdownSurfaceCache";
import { SurfaceRenderErrorBoundary } from "./SurfaceRenderErrorBoundary";
import "../styles/MarkdownSurface.css";

const LazyMarkdownRenderedContent = lazy(async () => {
  const module = await import("./MarkdownRenderedContent");
  return { default: module.MarkdownRenderedContent };
});

interface RenderedState {
  entry: MarkdownSurfaceCacheEntry;
  surfaceId: string;
}

export function MarkdownSurfaceView({
  colorTheme,
  onFocusPane,
  paneId,
  surface,
  visible
}: SurfaceViewProps<"markdown">): JSX.Element | null {
  const [renderedState, setRenderedState] = useState<RenderedState>(() => ({
    entry: readMarkdownSurfaceCache(surface.id),
    surfaceId: surface.id
  }));
  const [renderAttempt, setRenderAttempt] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const entry =
    renderedState.surfaceId === surface.id
      ? renderedState.entry
      : readMarkdownSurfaceCache(surface.id);

  const publishEntry = useCallback(
    (next: MarkdownSurfaceCacheEntry) => {
      setRenderedState((previous) => {
        if (
          previous.surfaceId === surface.id &&
          sameMarkdownRenderState(previous.entry, next)
        ) {
          return previous;
        }
        return { entry: next, surfaceId: surface.id };
      });
    },
    [surface.id]
  );

  useEffect(() => {
    if (!visible) return;
    publishEntry(readMarkdownSurfaceCache(surface.id));
    let active = true;
    const unsubscribeEvents = window.kmux.subscribeDocumentEvents((event) => {
      if (event.surfaceId !== surface.id) return;
      const next = applyMarkdownDocumentEvent(event);
      if (next) publishEntry(next);
    });
    void window.kmux.subscribeDocument(surface.id).catch(() => {
      if (active) publishEntry(markMarkdownSubscriptionError(surface.id));
    });
    return () => {
      active = false;
      const viewport = viewportRef.current;
      if (viewport) {
        updateMarkdownSurfaceScroll(surface.id, viewport.scrollTop);
      }
      unsubscribeEvents();
      void window.kmux.unsubscribeDocument(surface.id);
    };
  }, [publishEntry, surface.id, visible]);

  const restoreScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollTop = readMarkdownSurfaceCache(surface.id).scrollTop;
    }
  }, [surface.id]);

  useLayoutEffect(restoreScroll, [restoreScroll]);

  if (!visible) return null;
  const body = entry.text;
  const renderKey = `${surface.id}:${colorTheme}:${body ?? "empty"}:${renderAttempt}`;

  function focusPaneShell(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onFocusPane(paneId);
    event.currentTarget
      .closest<HTMLElement>("[data-pane-id]")
      ?.focus({ preventScroll: true });
  }

  function rememberScroll(event: UIEvent<HTMLDivElement>): void {
    updateMarkdownSurfaceScroll(surface.id, event.currentTarget.scrollTop);
  }

  return (
    <div
      ref={viewportRef}
      className="kmuxMarkdownSurface"
      role="document"
      aria-label={`Markdown preview ${surface.title}`}
      onKeyDown={focusPaneShell}
      onScroll={rememberScroll}
      tabIndex={0}
    >
      <div className="kmuxMarkdownSurface__content">
        {entry.status === "offline" ? (
          <div
            className="kmuxMarkdownSurface__status"
            data-offline="true"
            role="status"
          >
            Remote document is offline. The last available version is shown.
            <button
              type="button"
              onClick={() => void window.kmux.subscribeDocument(surface.id)}
            >
              Retry
            </button>
          </div>
        ) : null}
        {entry.status === "error" ? (
          <div className="kmuxMarkdownSurface__error" role="alert">
            Markdown preview failed: {entry.errorCode ?? "read-failed"}.
            <button
              type="button"
              onClick={() => void window.kmux.subscribeDocument(surface.id)}
            >
              Retry
            </button>
          </div>
        ) : null}
        {body === undefined ? (
          entry.status === "error" ? null : (
            <div className="kmuxMarkdownSurface__status" role="status">
              Loading Markdown preview…
            </div>
          )
        ) : (
          <SurfaceRenderErrorBoundary
            fallback={
              <div className="kmuxMarkdownSurface__error" role="alert">
                Markdown rendering failed. Edit the file or retry the preview.
                <button
                  type="button"
                  onClick={() => {
                    setRenderAttempt((attempt) => attempt + 1);
                    void window.kmux.subscribeDocument(surface.id);
                  }}
                >
                  Retry
                </button>
              </div>
            }
            resetKey={renderKey}
          >
            <Suspense
              fallback={
                <div className="kmuxMarkdownSurface__status" role="status">
                  Preparing Markdown renderer…
                </div>
              }
            >
              <LazyMarkdownRenderedContent
                colorTheme={colorTheme}
                markdown={body}
                onReady={restoreScroll}
                surfaceId={surface.id}
                viewportRef={viewportRef}
              />
            </Suspense>
          </SurfaceRenderErrorBoundary>
        )}
      </div>
    </div>
  );
}

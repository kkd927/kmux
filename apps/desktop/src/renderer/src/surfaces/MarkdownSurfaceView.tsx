import { useEffect, useRef, useState } from "react";
import type { MarkdownDocumentEvent } from "@kmux/proto";

import type { SurfaceViewProps } from "./contracts";

type PlaceholderState =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "offline"; text?: string }
  | { status: "error"; errorCode: string };

export function MarkdownSurfaceView({
  surface,
  visible
}: SurfaceViewProps<"markdown">): JSX.Element {
  const [state, setState] = useState<PlaceholderState>({ status: "loading" });
  const revisionRef = useRef(0);

  useEffect(() => {
    if (!visible) return;
    const unsubscribeEvents = window.kmux.subscribeDocumentEvents((event) => {
      if (
        event.surfaceId !== surface.id ||
        event.revision <= revisionRef.current
      ) {
        return;
      }
      revisionRef.current = event.revision;
      setState((previous) => nextPlaceholderState(previous, event));
    });
    void window.kmux.subscribeDocument(surface.id).catch(() => {
      setState({ status: "error", errorCode: "read-failed" });
    });
    return () => {
      unsubscribeEvents();
      void window.kmux.unsubscribeDocument(surface.id);
    };
  }, [surface.id, visible]);

  const body =
    state.status === "ready"
      ? state.text
      : state.status === "offline"
        ? state.text
        : undefined;
  return (
    <div
      role="document"
      aria-label={`Markdown preview ${surface.title}`}
      style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "24px" }}
    >
      {state.status === "offline" ? (
        <div role="status">Remote document is offline. Retrying…</div>
      ) : null}
      {state.status === "error" ? (
        <div role="alert">
          Markdown preview failed: {state.errorCode}.{" "}
          <button
            onClick={() => void window.kmux.subscribeDocument(surface.id)}
          >
            Retry
          </button>
        </div>
      ) : body === undefined ? (
        <div role="status">Loading Markdown preview…</div>
      ) : (
        <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{body}</pre>
      )}
    </div>
  );
}

function nextPlaceholderState(
  previous: PlaceholderState,
  event: MarkdownDocumentEvent
): PlaceholderState {
  if (event.type === "snapshot") return { status: "ready", text: event.text };
  if (event.type === "offline") {
    const text =
      previous.status === "ready" || previous.status === "offline"
        ? previous.text
        : undefined;
    return { status: "offline", ...(text === undefined ? {} : { text }) };
  }
  if (event.type === "error") {
    return { status: "error", errorCode: event.errorCode };
  }
  return previous.status === "ready" ? previous : { status: "loading" };
}

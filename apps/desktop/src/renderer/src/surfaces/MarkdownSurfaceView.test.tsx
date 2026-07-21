// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MarkdownDocumentEvent, SurfaceVm } from "@kmux/proto";

import { MarkdownSurfaceView } from "./MarkdownSurfaceView";
import type { SurfaceViewProps } from "./contracts";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("MarkdownSurfaceView document lifecycle", () => {
  let container: HTMLDivElement;
  let root: ReactDOMClient.Root | null;
  let documentListener: ((event: MarkdownDocumentEvent) => void) | undefined;
  const subscribeDocument = vi.fn(async () => undefined);
  const unsubscribeDocument = vi.fn(async () => undefined);
  const unsubscribeEvents = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = ReactDOMClient.createRoot(container);
    documentListener = undefined;
    subscribeDocument.mockClear();
    unsubscribeDocument.mockClear();
    unsubscribeEvents.mockClear();
    Object.defineProperty(window, "kmux", {
      configurable: true,
      value: {
        subscribeDocument,
        unsubscribeDocument,
        subscribeDocumentEvents: vi.fn(
          (listener: (event: MarkdownDocumentEvent) => void) => {
            documentListener = listener;
            return unsubscribeEvents;
          }
        )
      }
    });
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container.remove();
  });

  it("subscribes a restored visible surface and releases it on unmount", async () => {
    const surface: SurfaceVm<"markdown"> = {
      id: "surface_markdown",
      paneId: "pane_1",
      title: "README.md",
      titleLocked: false,
      unreadCount: 0,
      attention: false,
      content: { kind: "markdown" }
    };

    await act(async () => {
      root?.render(
        <MarkdownSurfaceView
          {...({ surface, visible: true } as SurfaceViewProps<"markdown">)}
        />
      );
    });

    expect(subscribeDocument).toHaveBeenCalledWith(surface.id);
    act(() => {
      documentListener?.({
        type: "snapshot",
        surfaceId: surface.id,
        revision: 1,
        text: "# Restored",
        byteLength: 10
      });
    });
    expect(container.textContent).toContain("# Restored");

    act(() => root?.unmount());
    root = null;
    expect(unsubscribeEvents).toHaveBeenCalledOnce();
    expect(unsubscribeDocument).toHaveBeenCalledWith(surface.id);
  });
});

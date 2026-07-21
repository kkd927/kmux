// @vitest-environment jsdom

import { act, useEffect } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MarkdownDocumentEvent, SurfaceVm } from "@kmux/proto";

import { MarkdownSurfaceView } from "./MarkdownSurfaceView";
import { clearMarkdownSurfaceCacheForTest } from "./markdownSurfaceCache";
import type { SurfaceViewProps } from "./contracts";

const renderedMarkdown = vi.hoisted(() => vi.fn());

vi.mock("./MarkdownRenderedContent", () => ({
  MarkdownRenderedContent: (props: {
    markdown: string;
    onReady: () => void;
  }) => {
    renderedMarkdown(props.markdown);
    useEffect(props.onReady, [props.onReady]);
    return <article>{props.markdown}</article>;
  }
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("MarkdownSurfaceView document lifecycle", () => {
  let container: HTMLDivElement;
  let pane: HTMLDivElement;
  let root: ReactDOMClient.Root | null;
  let documentListener: ((event: MarkdownDocumentEvent) => void) | undefined;
  const subscribeDocument = vi.fn(async () => undefined);
  const unsubscribeDocument = vi.fn(async () => undefined);
  const unsubscribeEvents = vi.fn();
  const onFocusPane = vi.fn();

  beforeEach(() => {
    clearMarkdownSurfaceCacheForTest();
    renderedMarkdown.mockClear();
    container = document.createElement("div");
    pane = document.createElement("div");
    pane.dataset.paneId = "pane_1";
    pane.tabIndex = -1;
    pane.append(container);
    document.body.append(pane);
    root = ReactDOMClient.createRoot(container);
    documentListener = undefined;
    subscribeDocument.mockClear();
    unsubscribeDocument.mockClear();
    unsubscribeEvents.mockClear();
    onFocusPane.mockClear();
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
    pane.remove();
  });

  it("subscribes a restored visible surface and releases it on unmount", async () => {
    await renderView();

    expect(subscribeDocument).toHaveBeenCalledWith(surface.id);
    await emit({
      type: "snapshot",
      surfaceId: surface.id,
      revision: 1,
      text: "# Restored",
      byteLength: 10
    });
    expect(container.textContent).toContain("# Restored");

    act(() => root?.unmount());
    root = null;
    expect(unsubscribeEvents).toHaveBeenCalledOnce();
    expect(unsubscribeDocument).toHaveBeenCalledWith(surface.id);
  });

  it("does not subscribe or render while hidden", async () => {
    await act(async () => {
      root?.render(
        <MarkdownSurfaceView
          {...({
            colorTheme: "dark",
            onFocusPane,
            paneId: "pane_1",
            surface,
            visible: false
          } as unknown as SurfaceViewProps<"markdown">)}
        />
      );
    });

    expect(subscribeDocument).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe("");
  });

  it("keeps the last body offline and skips stale or duplicate parses", async () => {
    await renderView();
    await emit({
      type: "snapshot",
      surfaceId: surface.id,
      revision: 2,
      text: "current body",
      byteLength: 12
    });
    const parseCount = renderedMarkdown.mock.calls.length;

    await emit({
      type: "snapshot",
      surfaceId: surface.id,
      revision: 3,
      text: "current body",
      byteLength: 12
    });
    await emit({
      type: "snapshot",
      surfaceId: surface.id,
      revision: 1,
      text: "stale body",
      byteLength: 10
    });
    expect(renderedMarkdown).toHaveBeenCalledTimes(parseCount);

    await emit({ type: "offline", surfaceId: surface.id, revision: 4 });
    expect(container.textContent).toContain("current body");
    expect(container.textContent).toContain("last available version");
  });

  it("restores scroll after switching away and back", async () => {
    await renderView();
    await emit({
      type: "snapshot",
      surfaceId: surface.id,
      revision: 1,
      text: "long body",
      byteLength: 9
    });
    const viewport = container.querySelector<HTMLElement>("[role=document]")!;
    viewport.scrollTop = 144;
    act(() => viewport.dispatchEvent(new Event("scroll", { bubbles: true })));
    act(() => root?.unmount());

    root = ReactDOMClient.createRoot(container);
    await renderView();
    expect(
      container.querySelector<HTMLElement>("[role=document]")?.scrollTop
    ).toBe(144);
  });

  it("returns Escape focus to the pane shell", async () => {
    await renderView();
    const viewport = container.querySelector<HTMLElement>("[role=document]")!;
    viewport.focus();
    act(() =>
      viewport.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );

    expect(onFocusPane).toHaveBeenCalledWith("pane_1");
    expect(document.activeElement).toBe(pane);
  });

  async function renderView(): Promise<void> {
    await act(async () => {
      root?.render(
        <MarkdownSurfaceView
          {...({
            colorTheme: "dark",
            onFocusPane,
            paneId: "pane_1",
            surface,
            visible: true
          } as unknown as SurfaceViewProps<"markdown">)}
        />
      );
    });
  }

  async function emit(event: MarkdownDocumentEvent): Promise<void> {
    await act(async () => {
      documentListener?.(event);
      await Promise.resolve();
    });
  }
});

const surface: SurfaceVm<"markdown"> = {
  id: "surface_markdown",
  paneId: "pane_1",
  title: "README.md",
  titleLocked: false,
  unreadCount: 0,
  attention: false,
  content: { kind: "markdown" }
};

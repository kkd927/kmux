// @vitest-environment jsdom

import { act } from "react";
import { useRef, useState, type MutableRefObject } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppAction } from "@kmux/core";
import type { ShellStoreSnapshot } from "@kmux/proto";

import {
  isPaneDividerDragActive,
  resetPaneDividerDragForTests
} from "../paneDividerDrag";
import { useSidebarResize } from "./useSidebarResize";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const RENDERED_SIDEBAR_WIDTH = 200;

function Harness(props: {
  dispatch: (action: AppAction) => Promise<void>;
}): JSX.Element {
  const viewRef = useRef({
    sidebarVisible: true,
    sidebarWidth: RENDERED_SIDEBAR_WIDTH
  } as unknown as ShellStoreSnapshot) as MutableRefObject<ShellStoreSnapshot | null>;
  const sidebarElementRef = useRef<HTMLElement | null>(null);
  const [sidebarResizeActive, setSidebarResizeActive] = useState(false);
  const { beginSidebarResize } = useSidebarResize({
    viewRef,
    renderedSidebarWidth: RENDERED_SIDEBAR_WIDTH,
    getSidebarElement: () => sidebarElementRef.current,
    setSidebarResizeActive,
    dispatch: props.dispatch
  });
  return (
    <div>
      <aside
        ref={(node) => {
          sidebarElementRef.current = node;
        }}
        data-testid="sidebar"
        style={{ width: `${RENDERED_SIDEBAR_WIDTH}px` }}
      />
      <div
        data-testid="resizer"
        data-active={sidebarResizeActive ? "true" : "false"}
        onPointerDown={beginSidebarResize}
      />
    </div>
  );
}

describe("useSidebarResize drag", () => {
  let container: HTMLDivElement;
  let root: ReactDOMClient.Root;

  beforeEach(() => {
    resetPaneDividerDragForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    resetPaneDividerDragForTests();
    container.remove();
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  it("applies drag width locally and commits once on pointerup", () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);

    act(() => {
      root.render(<Harness dispatch={dispatch} />);
    });

    const resizer = container.querySelector<HTMLElement>(
      '[data-testid="resizer"]'
    )!;
    const sidebar = container.querySelector<HTMLElement>(
      '[data-testid="sidebar"]'
    )!;

    act(() => {
      resizer.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 400
        })
      );
    });
    expect(isPaneDividerDragActive()).toBe(true);
    expect(resizer.dataset.active).toBe("true");

    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 450 }));
    });
    expect(sidebar.style.width).toBe("250px");
    expect(sidebar.style.minWidth).toBe("250px");
    expect(sidebar.style.maxWidth).toBe("250px");
    expect(dispatch).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 430 }));
    });
    expect(sidebar.style.width).toBe("230px");
    expect(dispatch).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", {}));
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: "workspace.sidebar.setWidth",
      width: 230
    });
    expect(isPaneDividerDragActive()).toBe(false);
    expect(resizer.dataset.active).toBe("false");
  });

  it("clamps the local drag width to the window-aware sidebar bounds", () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);

    act(() => {
      root.render(<Harness dispatch={dispatch} />);
    });

    const resizer = container.querySelector<HTMLElement>(
      '[data-testid="resizer"]'
    )!;
    const sidebar = container.querySelector<HTMLElement>(
      '[data-testid="sidebar"]'
    )!;

    act(() => {
      resizer.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 400
        })
      );
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 0 }));
    });
    expect(sidebar.style.width).toBe("110px");

    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", {}));
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "workspace.sidebar.setWidth",
      width: 110
    });
  });

  it("does not commit when the pointer never moved", () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);

    act(() => {
      root.render(<Harness dispatch={dispatch} />);
    });

    const resizer = container.querySelector<HTMLElement>(
      '[data-testid="resizer"]'
    )!;

    act(() => {
      resizer.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 400
        })
      );
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", {}));
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(isPaneDividerDragActive()).toBe(false);
  });
});

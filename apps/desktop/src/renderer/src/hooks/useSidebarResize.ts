import {
    type Dispatch,
    type KeyboardEvent as ReactKeyboardEvent,
    type MutableRefObject,
    type PointerEvent as ReactPointerEvent,
    type SetStateAction,
    useEffect,
    useRef
} from "react";

import type {AppAction} from "@kmux/core";
import type {ShellViewModel} from "@kmux/proto";

export const MIN_SIDEBAR_WIDTH = 110;
export const MAX_SIDEBAR_WIDTH = 320;
const NARROW_WINDOW_SIDEBAR_BREAKPOINT = 1180;
const NARROW_WINDOW_MAX_SIDEBAR_WIDTH = 272;

type SidebarResizeState = {
  startX: number;
  startWidth: number;
};

interface UseSidebarResizeOptions {
  viewRef: MutableRefObject<ShellViewModel | null>;
  renderedSidebarWidth: number;
  setSidebarResizeActive: Dispatch<SetStateAction<boolean>>;
  dispatch: (action: AppAction) => Promise<void>;
}

export function maxSidebarWidthForWindow(windowWidth: number): number {
  return windowWidth <= NARROW_WINDOW_SIDEBAR_BREAKPOINT
    ? Math.min(MAX_SIDEBAR_WIDTH, NARROW_WINDOW_MAX_SIDEBAR_WIDTH)
    : MAX_SIDEBAR_WIDTH;
}

export function clampSidebarWidthForWindow(
  width: number,
  windowWidth: number
): number {
  return Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(maxSidebarWidthForWindow(windowWidth), Math.round(width))
  );
}

export function useSidebarResize(options: UseSidebarResizeOptions): {
  beginSidebarResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleSidebarResizeKeyDown: (
    event: ReactKeyboardEvent<HTMLDivElement>
  ) => void;
} {
  const optionsRef = useRef(options);
  const sidebarResizeStateRef = useRef<SidebarResizeState | null>(null);

  optionsRef.current = options;

  useEffect(() => {
    const stopSidebarResize = () => {
      if (!sidebarResizeStateRef.current) {
        return;
      }
      sidebarResizeStateRef.current = null;
      optionsRef.current.setSidebarResizeActive(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    const onPointerMove = (event: PointerEvent) => {
      const dragState = sidebarResizeStateRef.current;
      if (!dragState) {
        return;
      }
      const nextWidth = clampSidebarWidthForWindow(
        dragState.startWidth + event.clientX - dragState.startX,
        window.innerWidth
      );
      const currentRenderedWidth = clampSidebarWidthForWindow(
        optionsRef.current.viewRef.current?.sidebarWidth ?? nextWidth,
        window.innerWidth
      );
      if (nextWidth === currentRenderedWidth) {
        return;
      }
      void optionsRef.current.dispatch({
        type: "workspace.sidebar.setWidth",
        width: nextWidth
      });
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopSidebarResize);
    window.addEventListener("pointercancel", stopSidebarResize);
    window.addEventListener("blur", stopSidebarResize);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopSidebarResize);
      window.removeEventListener("pointercancel", stopSidebarResize);
      window.removeEventListener("blur", stopSidebarResize);
      stopSidebarResize();
    };
  }, []);

  function setSidebarWidth(width: number): void {
    const nextWidth = clampSidebarWidthForWindow(width, window.innerWidth);
    if (nextWidth === optionsRef.current.renderedSidebarWidth) {
      return;
    }
    void optionsRef.current.dispatch({
      type: "workspace.sidebar.setWidth",
      width: nextWidth
    });
  }

  function beginSidebarResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || !optionsRef.current.viewRef.current?.sidebarVisible) {
      return;
    }
    sidebarResizeStateRef.current = {
      startX: event.clientX,
      startWidth: optionsRef.current.renderedSidebarWidth
    };
    optionsRef.current.setSidebarResizeActive(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    event.preventDefault();
  }

  function handleSidebarResizeKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>
  ): void {
    if (!optionsRef.current.viewRef.current?.sidebarVisible) {
      return;
    }
    const currentWidth = optionsRef.current.renderedSidebarWidth;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSidebarWidth(currentWidth - 12);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setSidebarWidth(currentWidth + 12);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setSidebarWidth(MIN_SIDEBAR_WIDTH);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setSidebarWidth(maxSidebarWidthForWindow(window.innerWidth));
    }
  }

  return {
    beginSidebarResize,
    handleSidebarResizeKeyDown
  };
}

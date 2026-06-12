// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TitlebarWindowControls } from "./TitlebarWindowControls";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("TitlebarWindowControls", () => {
  let container: HTMLDivElement;
  let root: ReactDOMClient.Root;
  let windowControl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
    windowControl = vi.fn(async () => undefined);
    window.kmux = {
      ...window.kmux,
      windowControl
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders no custom traffic-light controls for native window chrome", () => {
    act(() => {
      root.render(<TitlebarWindowControls windowChrome="native" />);
    });

    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("routes custom chrome buttons through the preload window-control bridge", async () => {
    act(() => {
      root.render(<TitlebarWindowControls windowChrome="custom" />);
    });

    const close = container.querySelector('button[aria-label="Close window"]');
    const minimize = container.querySelector(
      'button[aria-label="Minimize window"]'
    );
    const maximize = container.querySelector(
      'button[aria-label="Maximize window"]'
    );

    expect(close).toBeTruthy();
    expect(minimize).toBeTruthy();
    expect(maximize).toBeTruthy();

    await act(async () => {
      close?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      minimize?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      maximize?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(windowControl).toHaveBeenCalledTimes(3);
    expect(windowControl).toHaveBeenNthCalledWith(1, "close");
    expect(windowControl).toHaveBeenNthCalledWith(2, "minimize");
    expect(windowControl).toHaveBeenNthCalledWith(3, "maximize");
  });
});

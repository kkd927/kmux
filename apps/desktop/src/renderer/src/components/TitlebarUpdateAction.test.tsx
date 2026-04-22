// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdaterState } from "@kmux/proto";

import { getTitlebarUpdaterAction } from "../../../shared/updaterPresentation";
import { TitlebarUpdateActionButton } from "./TitlebarUpdateAction";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("TitlebarUpdateAction", () => {
  let container: HTMLDivElement;
  let root: ReactDOMClient.Root;
  let downloadAvailableUpdate: ReturnType<typeof vi.fn>;
  let installDownloadedUpdate: ReturnType<typeof vi.fn>;
  const originalUserAgent = navigator.userAgent;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
    downloadAvailableUpdate = vi.fn(async () => undefined);
    installDownloadedUpdate = vi.fn(async () => undefined);
    window.kmux = {
      ...window.kmux,
      downloadAvailableUpdate,
      installDownloadedUpdate
    };
  });

  afterEach(() => {
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: originalUserAgent
    });
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderButton(updaterState: UpdaterState): void {
    act(() => {
      root.render(
        <TitlebarUpdateActionButton
          className="titlebar-update-action"
          updaterState={updaterState}
        />
      );
    });
  }

  it("renders nothing when there is no actionable update state", () => {
    renderButton({ status: "idle" });
    expect(container.querySelector("button")).toBeNull();

    renderButton({ status: "checking" });
    expect(container.querySelector("button")).toBeNull();
  });

  it("does not render a preview CTA in dev-like Electron renderer mode", () => {
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "kmux Electron"
    });

    renderButton({ status: "idle" });

    expect(container.querySelector("button")).toBeNull();
  });

  it("shows the update CTA and routes clicks through the preload bridge", async () => {
    const updaterState = { status: "available", version: "0.2.3" } satisfies UpdaterState;
    const action = getTitlebarUpdaterAction(updaterState);
    renderButton(updaterState);
    const button = container.querySelector("button");

    expect(action).toBeTruthy();
    expect(button?.textContent).toBe(action?.label);
    expect(button?.getAttribute("aria-label")).toBe(action?.ariaLabel ?? null);
    expect(button?.getAttribute("title")).toBe(action?.title ?? null);
    expect(button?.hasAttribute("disabled")).toBe(action?.disabled ?? false);

    await act(async () => {
      button?.click();
    });

    expect(downloadAvailableUpdate).toHaveBeenCalledTimes(1);
    expect(installDownloadedUpdate).not.toHaveBeenCalled();
  });

  it("shows a disabled downloading CTA without routing clicks", async () => {
    const updaterState = {
      status: "downloading",
      version: "0.2.3"
    } satisfies UpdaterState;
    const action = getTitlebarUpdaterAction(updaterState);
    renderButton(updaterState);
    const button = container.querySelector("button");

    expect(action).toBeTruthy();
    expect(button?.textContent).toBe(action?.label);
    expect(button?.getAttribute("aria-label")).toBe(action?.ariaLabel ?? null);
    expect(button?.hasAttribute("disabled")).toBe(action?.disabled ?? false);

    await act(async () => {
      button?.click();
    });

    expect(downloadAvailableUpdate).not.toHaveBeenCalled();
    expect(installDownloadedUpdate).not.toHaveBeenCalled();
  });

  it("shows the restart CTA and routes clicks through the install bridge", async () => {
    const updaterState = {
      status: "downloaded",
      version: "0.2.3"
    } satisfies UpdaterState;
    const action = getTitlebarUpdaterAction(updaterState);
    renderButton(updaterState);
    const button = container.querySelector("button");

    expect(action).toBeTruthy();
    expect(button?.textContent).toBe(action?.label);
    expect(button?.getAttribute("aria-label")).toBe(action?.ariaLabel ?? null);
    expect(button?.getAttribute("title")).toBe(action?.title ?? null);
    expect(button?.hasAttribute("disabled")).toBe(action?.disabled ?? false);

    await act(async () => {
      button?.click();
    });

    expect(installDownloadedUpdate).toHaveBeenCalledTimes(1);
    expect(downloadAvailableUpdate).not.toHaveBeenCalled();
  });
});

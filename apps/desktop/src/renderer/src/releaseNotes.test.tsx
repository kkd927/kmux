// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  releaseNotesSeenStorageKey,
  type BundledReleaseNotes,
  useReleaseNotesModal
} from "./releaseNotes";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const releaseNotes: BundledReleaseNotes = {
  version: "1.2.0",
  markdown: "# Release",
  imageSources: {}
};

describe("useReleaseNotesModal", () => {
  let container: HTMLDivElement;
  let root: ReactDOMClient.Root;
  let openRequest: (() => void) | undefined;
  let stored: Map<string, string>;
  const storage = {
    getItem: vi.fn((key: string) => stored.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      stored.set(key, value);
    })
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = ReactDOMClient.createRoot(container);
    openRequest = undefined;
    stored = new Map();
    storage.getItem.mockClear();
    storage.setItem.mockClear();
    Object.defineProperty(window, "kmux", {
      configurable: true,
      value: {
        subscribeReleaseNotesOpenRequest(listener: () => void) {
          openRequest = listener;
          return () => {
            openRequest = undefined;
          };
        }
      }
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("opens unseen notes only after shell restore and remembers them on close", () => {
    render({ shellReady: false });
    expect(isOpen()).toBe(false);

    render({ shellReady: true });
    expect(isOpen()).toBe(true);
    act(() => {
      container.querySelector<HTMLButtonElement>("button")?.click();
    });

    expect(isOpen()).toBe(false);
    expect(storage.setItem).toHaveBeenCalledWith(
      releaseNotesSeenStorageKey("1.2.0"),
      "1"
    );

    act(() => root.unmount());
    root = ReactDOMClient.createRoot(container);
    render({ shellReady: true });
    expect(isOpen()).toBe(false);
  });

  it("opens seen notes from Help after another dialog closes", () => {
    stored.set(releaseNotesSeenStorageKey("1.2.0"), "1");
    render({ shellReady: true, blockingDialogOpen: true });

    act(() => openRequest?.());
    expect(isOpen()).toBe(false);

    render({ shellReady: true, blockingDialogOpen: false });
    expect(isOpen()).toBe(true);
  });

  it("temporarily yields a Help-opened modal to a higher-priority dialog", () => {
    stored.set(releaseNotesSeenStorageKey("1.2.0"), "1");
    render({ shellReady: true });
    act(() => openRequest?.());
    expect(isOpen()).toBe(true);

    render({ shellReady: true, blockingDialogOpen: true });
    expect(isOpen()).toBe(false);

    render({ shellReady: true, blockingDialogOpen: false });
    expect(isOpen()).toBe(true);
  });

  it("keeps notes dismissed in memory when storage writes fail", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failingStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error("quota unavailable");
      })
    };

    render({ shellReady: true, storage: failingStorage });
    expect(isOpen()).toBe(true);
    act(() => {
      container.querySelector<HTMLButtonElement>("button")?.click();
    });

    expect(isOpen()).toBe(false);
    expect(failingStorage.setItem).toHaveBeenCalledOnce();
    act(() => openRequest?.());
    expect(isOpen()).toBe(true);
    warn.mockRestore();
  });

  it("keeps notes dismissed in memory when storage reads fail", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failingStorage = {
      getItem: vi.fn(() => {
        throw new Error("storage blocked");
      }),
      setItem: vi.fn()
    };

    render({ shellReady: true, storage: failingStorage });
    expect(isOpen()).toBe(true);
    act(() => {
      container.querySelector<HTMLButtonElement>("button")?.click();
    });

    expect(isOpen()).toBe(false);
    expect(failingStorage.setItem).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  function render(options: {
    shellReady: boolean;
    blockingDialogOpen?: boolean;
    storage?: Pick<Storage, "getItem" | "setItem">;
  }): void {
    act(() => {
      root.render(
        <Harness
          blockingDialogOpen={options.blockingDialogOpen ?? false}
          shellReady={options.shellReady}
          storage={options.storage ?? storage}
        />
      );
    });
  }

  function isOpen(): boolean {
    return container.querySelector("[data-release-notes-open]") !== null;
  }

  function Harness(props: {
    blockingDialogOpen: boolean;
    shellReady: boolean;
    storage: Pick<Storage, "getItem" | "setItem">;
  }): JSX.Element {
    const modal = useReleaseNotesModal({
      releaseNotes,
      shellReady: props.shellReady,
      blockingDialogOpen: props.blockingDialogOpen,
      storage: props.storage
    });
    return modal.open ? (
      <button data-release-notes-open onClick={modal.close}>
        Close
      </button>
    ) : (
      <span />
    );
  }
});

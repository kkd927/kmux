// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RELEASE_NOTES_CONTENT_PRELOAD_TIMEOUT_MS,
  RELEASE_NOTES_IMAGE_PRELOAD_TIMEOUT_MS,
  releaseNotesSeenStorageKey,
  selectReleaseNotes,
  type BundledReleaseNotesCatalog,
  type ReleaseNotesPreparationContext,
  useReleaseNotesModal
} from "./releaseNotes";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const releaseNotes: BundledReleaseNotesCatalog = {
  version: "1.2",
  default: {
    markdown: "# Default release",
    imageSources: {}
  },
  localized: {
    ko: {
      markdown: "# 한국어 릴리즈",
      imageSources: {}
    }
  }
};

const releaseNotesWithImages: BundledReleaseNotesCatalog = {
  ...releaseNotes,
  default: {
    markdown: "# Default release",
    imageSources: {
      "./assets/one.png": "file:///app/one.png",
      "./assets/two.png": "file:///app/two.png"
    }
  }
};

describe("release note language selection", () => {
  const document = (markdown: string) => ({
    markdown,
    imageSources: {}
  });

  it("matches a general language note from a regional OS preference", () => {
    expect(selectReleaseNotes(releaseNotes, ["ko-KR"]).markdown).toBe(
      "# 한국어 릴리즈"
    );
  });

  it("prefers exact, script, and region matches before general language", () => {
    const catalog: BundledReleaseNotesCatalog = {
      version: "1.2",
      default: document("default"),
      localized: {
        zh: document("language"),
        "zh-CN": document("region"),
        "zh-Hans": document("script"),
        "pt-BR": document("exact region"),
        pt: document("generic Portuguese")
      }
    };

    expect(selectReleaseNotes(catalog, ["zh-Hans-CN"]).markdown).toBe("script");
    expect(selectReleaseNotes(catalog, ["pt-BR"]).markdown).toBe(
      "exact region"
    );
  });

  it("checks OS preferred languages in order", () => {
    const catalog: BundledReleaseNotesCatalog = {
      version: "1.2",
      default: document("default"),
      localized: {
        fr: document("French"),
        ko: document("Korean")
      }
    };

    expect(
      selectReleaseNotes(catalog, ["de-DE", "fr-CA", "ko-KR"]).markdown
    ).toBe("French");
  });

  it("normalizes casing and ignores invalid or unknown language values", () => {
    expect(
      selectReleaseNotes(releaseNotes, ["not_a_locale", 42, "KO-kr"]).markdown
    ).toBe("# 한국어 릴리즈");
    expect(selectReleaseNotes(releaseNotes, ["xx-ZZ"]).markdown).toBe(
      "# Default release"
    );
    expect(selectReleaseNotes(releaseNotes, null).markdown).toBe(
      "# Default release"
    );
  });
});

describe("useReleaseNotesModal", () => {
  let container: HTMLDivElement;
  let root: ReactDOMClient.Root;
  let openRequest: (() => void) | undefined;
  let stored: Map<string, string>;
  let getPreferredSystemLanguages: () => Promise<string[]>;
  let imageDecodes: Array<Deferred<void>>;
  const storage = {
    get length(): number {
      return stored.size;
    },
    getItem: vi.fn((key: string) => stored.get(key) ?? null),
    key: vi.fn((index: number) => [...stored.keys()][index] ?? null),
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
    imageDecodes = [];
    getPreferredSystemLanguages = vi.fn(async () => ["en-US"]);
    storage.getItem.mockClear();
    storage.key.mockClear();
    storage.setItem.mockClear();
    exposeKmuxBridge();

    class PreloadImage {
      src = "";

      decode(): Promise<void> {
        const decode = deferred<void>();
        imageDecodes.push(decode);
        return decode.promise;
      }
    }

    vi.stubGlobal("Image", PreloadImage);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens unseen notes only after shell restore and remembers the minor on close", async () => {
    await render({ shellReady: false });
    expect(isOpen()).toBe(false);

    await render({ shellReady: true });
    expect(isOpen()).toBe(true);
    expect(selectedMarkdown()).toBe("# Default release");
    act(() => {
      container.querySelector<HTMLButtonElement>("button")?.click();
    });

    expect(isOpen()).toBe(false);
    expect(storage.setItem).toHaveBeenCalledWith(
      releaseNotesSeenStorageKey("1.2"),
      "1"
    );

    act(() => root.unmount());
    root = ReactDOMClient.createRoot(container);
    getPreferredSystemLanguages = vi.fn(async () => ["ko-KR"]);
    exposeKmuxBridge();
    await render({ shellReady: true });
    expect(isOpen()).toBe(false);
  });

  it.each(["1.2.3", "1.2.0-alpha.1"])(
    "migrates legacy seen key %s and suppresses the automatic dialog",
    async (legacyVersion) => {
      stored.set(releaseNotesSeenStorageKey(legacyVersion), "1");

      await render({ shellReady: true });

      expect(isOpen()).toBe(false);
      expect(stored.get(releaseNotesSeenStorageKey(legacyVersion))).toBe("1");
      expect(storage.setItem).toHaveBeenCalledWith(
        releaseNotesSeenStorageKey("1.2"),
        "1"
      );
    }
  );

  it("does not mistake another minor's legacy key for the current notes", async () => {
    stored.set(releaseNotesSeenStorageKey("1.10.3"), "1");

    await render({ shellReady: true });

    expect(isOpen()).toBe(true);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("treats a legacy key as seen even when canonical migration cannot be saved", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stored.set(releaseNotesSeenStorageKey("1.2.3"), "1");
    const migrationFailingStorage = {
      get length(): number {
        return stored.size;
      },
      getItem: vi.fn((key: string) => stored.get(key) ?? null),
      key: vi.fn((index: number) => [...stored.keys()][index] ?? null),
      setItem: vi.fn(() => {
        throw new Error("quota unavailable");
      })
    };

    await render({ shellReady: true, storage: migrationFailingStorage });

    expect(isOpen()).toBe(false);
    expect(migrationFailingStorage.setItem).toHaveBeenCalledWith(
      releaseNotesSeenStorageKey("1.2"),
      "1"
    );
    warn.mockRestore();
  });

  it("opens only after every release note image decode settles", async () => {
    await render({
      releaseNotesCatalog: releaseNotesWithImages,
      shellReady: true
    });

    expect(imageDecodes).toHaveLength(2);
    expect(isOpen()).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();

    await act(async () => {
      imageDecodes[0].reject(new Error("broken image"));
      await Promise.resolve();
    });
    expect(isOpen()).toBe(false);

    await act(async () => {
      imageDecodes[1].resolve(undefined);
      await Promise.resolve();
    });
    expect(isOpen()).toBe(true);
  });

  it("does not open while modal content loads, then opens once ready", async () => {
    const content = deferred<void>();

    await render({
      shellReady: true,
      prepareContent: () => content.promise
    });

    expect(isOpen()).toBe(false);

    await act(async () => {
      content.resolve(undefined);
      await content.promise;
    });
    expect(isOpen()).toBe(true);
  });

  it("starts a new Help attempt after modal content preparation fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const languages = deferred<string[]>();
    const prepareContent = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("chunk unavailable"))
      .mockResolvedValueOnce(undefined);
    getPreferredSystemLanguages = vi.fn(() => languages.promise);
    exposeKmuxBridge();

    await render({ shellReady: true, prepareContent });
    expect(prepareContent).not.toHaveBeenCalled();

    act(() => openRequest?.());
    expect(isOpen()).toBe(false);

    await act(async () => {
      languages.resolve(["en-US"]);
      await languages.promise;
      for (let index = 0; index < 4; index += 1) {
        await Promise.resolve();
      }
    });
    expect(isOpen()).toBe(false);
    expect(prepareContent).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (let index = 0; index < 4; index += 1) {
        await Promise.resolve();
      }
    });
    expect(prepareContent).toHaveBeenCalledTimes(1);

    await act(async () => {
      openRequest?.();
      for (let index = 0; index < 4; index += 1) {
        await Promise.resolve();
      }
    });
    expect(isOpen()).toBe(true);
    expect(prepareContent).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "Failed to prepare release notes",
      expect.any(Error)
    );
    warn.mockRestore();
  });

  it("times out stalled modal content and starts a fresh Help attempt", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stalledContent = deferred<void>();
    let firstSignal: AbortSignal | undefined;
    const prepareContent = vi
      .fn<(context: ReleaseNotesPreparationContext) => Promise<void>>()
      .mockImplementationOnce(({ signal }) => {
        firstSignal = signal;
        return stalledContent.promise;
      })
      .mockResolvedValueOnce(undefined);
    stored.set(releaseNotesSeenStorageKey("1.2"), "1");

    await render({ shellReady: true, prepareContent });
    await act(async () => {
      openRequest?.();
      for (let index = 0; index < 4; index += 1) {
        await Promise.resolve();
      }
    });
    expect(prepareContent).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        RELEASE_NOTES_CONTENT_PRELOAD_TIMEOUT_MS
      );
    });
    expect(firstSignal?.aborted).toBe(true);
    expect(isOpen()).toBe(false);
    expect(prepareContent).toHaveBeenCalledTimes(1);

    await act(async () => {
      openRequest?.();
      for (let index = 0; index < 4; index += 1) {
        await Promise.resolve();
      }
    });
    expect(isOpen()).toBe(true);
    expect(prepareContent).toHaveBeenCalledTimes(2);

    await act(async () => {
      stalledContent.resolve(undefined);
      await stalledContent.promise;
    });
    expect(isOpen()).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "Failed to prepare release notes",
      expect.objectContaining({ name: "TimeoutError" })
    );
    warn.mockRestore();
  });

  it("opens after the image preload timeout when decode remains pending", async () => {
    vi.useFakeTimers();
    await render({
      releaseNotesCatalog: releaseNotesWithImages,
      shellReady: true
    });

    expect(isOpen()).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELEASE_NOTES_IMAGE_PRELOAD_TIMEOUT_MS);
    });

    expect(isOpen()).toBe(true);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("preserves a Help request made while language selection is pending", async () => {
    let resolveLanguages: ((languages: string[]) => void) | undefined;
    const languages = new Promise<string[]>((resolve) => {
      resolveLanguages = resolve;
    });
    getPreferredSystemLanguages = vi.fn(() => languages);
    exposeKmuxBridge();

    await render({ shellReady: true });
    expect(isOpen()).toBe(false);

    act(() => openRequest?.());
    expect(isOpen()).toBe(false);

    await act(async () => {
      resolveLanguages?.(["ko-KR"]);
      await languages;
    });
    expect(isOpen()).toBe(true);
    expect(selectedMarkdown()).toBe("# 한국어 릴리즈");
  });

  it("falls back to the default note when language lookup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    getPreferredSystemLanguages = vi.fn(async () => {
      throw new Error("language service unavailable");
    });
    exposeKmuxBridge();

    await render({ shellReady: true });

    expect(isOpen()).toBe(true);
    expect(selectedMarkdown()).toBe("# Default release");
    expect(warn).toHaveBeenCalledWith(
      "Failed to read preferred system languages",
      expect.any(Error)
    );
  });

  it("opens seen notes from Help after another dialog closes", async () => {
    stored.set(releaseNotesSeenStorageKey("1.2"), "1");
    await render({ shellReady: true, blockingDialogOpen: true });

    act(() => openRequest?.());
    expect(isOpen()).toBe(false);

    await render({ shellReady: true, blockingDialogOpen: false });
    expect(isOpen()).toBe(true);
  });

  it("temporarily yields a Help-opened modal to a higher-priority dialog", async () => {
    stored.set(releaseNotesSeenStorageKey("1.2"), "1");
    await render({ shellReady: true });
    act(() => openRequest?.());
    expect(isOpen()).toBe(true);

    await render({ shellReady: true, blockingDialogOpen: true });
    expect(isOpen()).toBe(false);

    await render({ shellReady: true, blockingDialogOpen: false });
    expect(isOpen()).toBe(true);
  });

  it("keeps notes dismissed in memory when storage writes fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failingStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error("quota unavailable");
      })
    };

    await render({ shellReady: true, storage: failingStorage });
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

  it("keeps notes dismissed in memory when storage reads fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failingStorage = {
      getItem: vi.fn(() => {
        throw new Error("storage blocked");
      }),
      setItem: vi.fn()
    };

    await render({ shellReady: true, storage: failingStorage });
    expect(isOpen()).toBe(true);
    act(() => {
      container.querySelector<HTMLButtonElement>("button")?.click();
    });

    expect(isOpen()).toBe(false);
    expect(failingStorage.setItem).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  function exposeKmuxBridge(): void {
    Object.defineProperty(window, "kmux", {
      configurable: true,
      value: {
        getPreferredSystemLanguages,
        subscribeReleaseNotesOpenRequest(listener: () => void) {
          openRequest = listener;
          return () => {
            openRequest = undefined;
          };
        }
      }
    });
  }

  async function render(options: {
    shellReady: boolean;
    blockingDialogOpen?: boolean;
    contentPreparationTimeoutMs?: number;
    releaseNotesCatalog?: BundledReleaseNotesCatalog;
    prepareContent?: (
      context: ReleaseNotesPreparationContext
    ) => Promise<unknown>;
    storage?: Pick<Storage, "getItem" | "setItem">;
  }): Promise<void> {
    await act(async () => {
      root.render(
        <Harness
          blockingDialogOpen={options.blockingDialogOpen ?? false}
          contentPreparationTimeoutMs={options.contentPreparationTimeoutMs}
          prepareContent={options.prepareContent}
          releaseNotesCatalog={options.releaseNotesCatalog ?? releaseNotes}
          shellReady={options.shellReady}
          storage={options.storage ?? storage}
        />
      );
      for (let index = 0; index < 4; index += 1) {
        await Promise.resolve();
      }
    });
  }

  function isOpen(): boolean {
    return container.querySelector("[data-release-notes-open]") !== null;
  }

  function selectedMarkdown(): string | undefined {
    return container.querySelector<HTMLElement>("[data-release-notes-open]")
      ?.dataset.markdown;
  }

  function Harness(props: {
    blockingDialogOpen: boolean;
    contentPreparationTimeoutMs?: number;
    prepareContent?: (
      context: ReleaseNotesPreparationContext
    ) => Promise<unknown>;
    releaseNotesCatalog: BundledReleaseNotesCatalog;
    shellReady: boolean;
    storage: Pick<Storage, "getItem" | "setItem">;
  }): JSX.Element {
    const modal = useReleaseNotesModal({
      releaseNotes: props.releaseNotesCatalog,
      shellReady: props.shellReady,
      blockingDialogOpen: props.blockingDialogOpen,
      contentPreparationTimeoutMs: props.contentPreparationTimeoutMs,
      prepareContent: props.prepareContent,
      storage: props.storage
    });
    return modal.open ? (
      <button
        data-markdown={modal.releaseNotes?.markdown}
        data-release-notes-open
        onClick={modal.close}
      >
        Close
      </button>
    ) : (
      <span />
    );
  }
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

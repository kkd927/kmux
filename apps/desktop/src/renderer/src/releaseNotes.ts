import { useCallback, useEffect, useReducer, useRef, useState } from "react";

export interface BundledReleaseNoteDocument {
  markdown: string;
  imageSources: Readonly<Record<string, string>>;
}

export interface BundledReleaseNotesCatalog {
  version: string;
  default: BundledReleaseNoteDocument;
  localized: Readonly<Record<string, BundledReleaseNoteDocument>>;
}

export interface SelectedReleaseNotes extends BundledReleaseNoteDocument {
  version: string;
}

export const RELEASE_NOTES_SEEN_KEY_PREFIX = "kmux.releaseNotes.seen.";
export const RELEASE_NOTES_IMAGE_PRELOAD_TIMEOUT_MS = 2_000;
export const RELEASE_NOTES_CONTENT_PRELOAD_TIMEOUT_MS = 10_000;

export interface ReleaseNotesPreparationContext {
  signal: AbortSignal;
}

type ReleaseNotesStorage = Pick<Storage, "getItem" | "setItem"> &
  Partial<Pick<Storage, "key">> & {
    readonly length?: number;
  };

export function releaseNotesSeenStorageKey(version: string): string {
  return `${RELEASE_NOTES_SEEN_KEY_PREFIX}${version}`;
}

export function selectReleaseNotes(
  releaseNotes: BundledReleaseNotesCatalog,
  preferredLanguages: unknown
): SelectedReleaseNotes {
  const localized = new Map<string, BundledReleaseNoteDocument>();
  for (const [locale, document] of Object.entries(releaseNotes.localized)) {
    const normalized = normalizeLanguageTag(locale);
    if (normalized && !localized.has(normalized)) {
      localized.set(normalized, document);
    }
  }

  if (Array.isArray(preferredLanguages)) {
    for (const preferredLanguage of preferredLanguages) {
      const normalized = normalizeLanguageTag(preferredLanguage);
      if (!normalized) {
        continue;
      }
      const locale = new Intl.Locale(normalized);
      const candidates = [
        normalized,
        locale.script ? `${locale.language}-${locale.script}` : null,
        locale.region ? `${locale.language}-${locale.region}` : null,
        locale.language
      ];
      for (const candidate of candidates) {
        if (!candidate) {
          continue;
        }
        const document = localized.get(candidate);
        if (document) {
          return {
            version: releaseNotes.version,
            ...document
          };
        }
      }
    }
  }

  return {
    version: releaseNotes.version,
    ...releaseNotes.default
  };
}

function normalizeLanguageTag(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return Intl.getCanonicalLocales(value)[0] ?? null;
  } catch {
    return null;
  }
}

type ReleaseNotesOpenIntent = "automatic" | "manual";

type ReleaseNotesModalState = {
  attemptId: number;
  attemptedVersion: string | null;
} & (
  | { phase: "idle"; intent: null }
  | {
      phase: "queued" | "preparing" | "open" | "suspended";
      intent: ReleaseNotesOpenIntent;
    }
);

type ReleaseNotesModalAction =
  | { type: "automatic-requested" }
  | { type: "manual-requested" }
  | { type: "preparation-started"; version: string }
  | { type: "preparation-succeeded"; attemptId: number }
  | { type: "preparation-failed"; attemptId: number }
  | { type: "blocking-dialog-opened" }
  | { type: "blocking-dialog-closed" }
  | { type: "closed" };

const INITIAL_RELEASE_NOTES_MODAL_STATE: ReleaseNotesModalState = {
  phase: "idle",
  intent: null,
  attemptId: 0,
  attemptedVersion: null
};

function reduceReleaseNotesModalState(
  state: ReleaseNotesModalState,
  action: ReleaseNotesModalAction
): ReleaseNotesModalState {
  switch (action.type) {
    case "automatic-requested":
      if (state.phase !== "idle") {
        return state;
      }
      return {
        ...state,
        phase: "queued",
        intent: "automatic"
      };
    case "manual-requested": {
      if (state.phase === "open" || state.phase === "suspended") {
        return state;
      }
      if (state.phase !== "idle" && state.intent === "manual") {
        return state;
      }
      return {
        ...state,
        phase: state.phase === "preparing" ? "preparing" : "queued",
        intent: "manual"
      };
    }
    case "preparation-started":
      if (state.phase !== "queued") {
        return state;
      }
      return {
        ...state,
        phase: "preparing",
        attemptId: state.attemptId + 1,
        attemptedVersion: action.version
      };
    case "preparation-succeeded":
      if (state.phase !== "preparing" || state.attemptId !== action.attemptId) {
        return state;
      }
      return { ...state, phase: "open" };
    case "preparation-failed":
      if (state.phase !== "preparing" || state.attemptId !== action.attemptId) {
        return state;
      }
      return { ...state, phase: "idle", intent: null };
    case "blocking-dialog-opened":
      if (state.phase === "preparing") {
        return { ...state, phase: "queued" };
      }
      if (state.phase === "open") {
        return { ...state, phase: "suspended" };
      }
      return state;
    case "blocking-dialog-closed":
      return state.phase === "suspended" ? { ...state, phase: "open" } : state;
    case "closed":
      return state.phase === "idle"
        ? state
        : { ...state, phase: "idle", intent: null };
  }
}

export function useReleaseNotesModal(options: {
  releaseNotes: BundledReleaseNotesCatalog | null;
  shellReady: boolean;
  blockingDialogOpen: boolean;
  prepareContent?: (
    context: ReleaseNotesPreparationContext
  ) => Promise<unknown>;
  contentPreparationTimeoutMs?: number;
  storage?: ReleaseNotesStorage;
}): {
  open: boolean;
  close: () => void;
  releaseNotes: SelectedReleaseNotes | null;
} {
  const {
    releaseNotes: releaseNotesCatalog,
    shellReady,
    blockingDialogOpen,
    prepareContent,
    contentPreparationTimeoutMs = RELEASE_NOTES_CONTENT_PRELOAD_TIMEOUT_MS
  } = options;
  const fallbackStorageRef = useRef<ReleaseNotesStorage | null>();
  if (
    options.storage === undefined &&
    fallbackStorageRef.current === undefined
  ) {
    try {
      fallbackStorageRef.current = globalThis.localStorage ?? null;
    } catch (error) {
      fallbackStorageRef.current = null;
      console.warn("Failed to access release notes storage", error);
    }
  }
  const storage = options.storage ?? fallbackStorageRef.current ?? null;
  const [releaseNotes, setReleaseNotes] = useState<SelectedReleaseNotes | null>(
    null
  );
  const [modalState, dispatchModal] = useReducer(
    reduceReleaseNotesModalState,
    INITIAL_RELEASE_NOTES_MODAL_STATE
  );
  const preloadedImagesRef = useRef<HTMLImageElement[]>([]);
  const dismissedVersionsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!releaseNotesCatalog) {
      setReleaseNotes(null);
      return;
    }
    let active = true;
    setReleaseNotes(null);
    const fallback = selectReleaseNotes(releaseNotesCatalog, []);
    void Promise.resolve()
      .then(() => window.kmux.getPreferredSystemLanguages())
      .then((preferredLanguages) =>
        selectReleaseNotes(releaseNotesCatalog, preferredLanguages)
      )
      .catch((error) => {
        console.warn("Failed to read preferred system languages", error);
        return fallback;
      })
      .then((selectedReleaseNotes) => {
        if (active) {
          setReleaseNotes(selectedReleaseNotes);
        }
      });
    return () => {
      active = false;
    };
  }, [releaseNotesCatalog]);

  useEffect(() => {
    if (!releaseNotesCatalog) {
      return;
    }
    return window.kmux.subscribeReleaseNotesOpenRequest(() => {
      dispatchModal({ type: "manual-requested" });
    });
  }, [releaseNotesCatalog]);

  useEffect(() => {
    dispatchModal({
      type: blockingDialogOpen
        ? "blocking-dialog-opened"
        : "blocking-dialog-closed"
    });
  }, [blockingDialogOpen]);

  useEffect(() => {
    if (
      !releaseNotes ||
      !shellReady ||
      modalState.phase !== "idle" ||
      modalState.attemptedVersion === releaseNotes.version
    ) {
      return;
    }
    const dismissed = dismissedVersionsRef.current.has(releaseNotes.version);
    if (dismissed) {
      return;
    }
    const seen = storage
      ? hasSeenReleaseNotes(storage, releaseNotes.version)
      : false;
    if (seen) {
      return;
    }
    dispatchModal({ type: "automatic-requested" });
  }, [
    modalState.attemptedVersion,
    modalState.phase,
    releaseNotes,
    shellReady,
    storage
  ]);

  useEffect(() => {
    if (
      !releaseNotes ||
      !shellReady ||
      blockingDialogOpen ||
      modalState.phase !== "queued"
    ) {
      return;
    }
    dispatchModal({
      type: "preparation-started",
      version: releaseNotes.version
    });
  }, [blockingDialogOpen, modalState.phase, releaseNotes, shellReady]);

  useEffect(() => {
    if (
      !releaseNotes ||
      !shellReady ||
      blockingDialogOpen ||
      modalState.phase !== "preparing"
    ) {
      return;
    }

    let cancelled = false;
    let finished = false;
    let imageTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let contentTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const contentAbortController = prepareContent
      ? new AbortController()
      : null;
    const attemptId = modalState.attemptId;
    const finishOpening = (): void => {
      if (cancelled || finished) {
        return;
      }
      finished = true;
      if (imageTimeoutId !== undefined) {
        clearTimeout(imageTimeoutId);
      }
      if (contentTimeoutId !== undefined) {
        clearTimeout(contentTimeoutId);
      }
      dispatchModal({ type: "preparation-succeeded", attemptId });
    };
    const images = Object.values(releaseNotes.imageSources).map((src) => {
      const image = new Image();
      image.src = src;
      return image;
    });
    preloadedImagesRef.current = images;

    const imagesReady = new Promise<void>((resolve) => {
      if (images.length === 0) {
        resolve();
        return;
      }
      let imagesFinished = false;
      const finishImages = (): void => {
        if (imagesFinished) {
          return;
        }
        imagesFinished = true;
        if (imageTimeoutId !== undefined) {
          clearTimeout(imageTimeoutId);
        }
        resolve();
      };
      imageTimeoutId = setTimeout(
        finishImages,
        RELEASE_NOTES_IMAGE_PRELOAD_TIMEOUT_MS
      );
      void Promise.allSettled(images.map(async (image) => image.decode())).then(
        finishImages
      );
    });
    if (images.length === 0 && !prepareContent) {
      finishOpening();
    } else {
      const contentReady = prepareContent && contentAbortController
        ? Promise.race([
            Promise.resolve().then(() =>
              prepareContent({ signal: contentAbortController.signal })
            ),
            new Promise<never>((_resolve, reject) => {
              contentTimeoutId = setTimeout(() => {
                const error = new Error(
                  `Timed out preparing release notes content after ${contentPreparationTimeoutMs}ms`
                );
                error.name = "TimeoutError";
                contentAbortController.abort(error);
                reject(error);
              }, contentPreparationTimeoutMs);
            })
          ]).finally(() => {
            if (contentTimeoutId !== undefined) {
              clearTimeout(contentTimeoutId);
            }
          })
        : Promise.resolve();
      void Promise.all([imagesReady, contentReady])
        .then(finishOpening)
        .catch((error) => {
          if (!cancelled) {
            if (imageTimeoutId !== undefined) {
              clearTimeout(imageTimeoutId);
            }
            if (contentTimeoutId !== undefined) {
              clearTimeout(contentTimeoutId);
            }
            if (contentAbortController?.signal.aborted === false) {
              contentAbortController.abort(error);
            }
            preloadedImagesRef.current = [];
            console.warn("Failed to prepare release notes", error);
            dispatchModal({ type: "preparation-failed", attemptId });
          }
        });
    }

    return () => {
      cancelled = true;
      if (imageTimeoutId !== undefined) {
        clearTimeout(imageTimeoutId);
      }
      if (contentTimeoutId !== undefined) {
        clearTimeout(contentTimeoutId);
      }
      if (!finished) {
        if (contentAbortController?.signal.aborted === false) {
          contentAbortController.abort();
        }
        preloadedImagesRef.current = [];
      }
    };
  }, [
    blockingDialogOpen,
    contentPreparationTimeoutMs,
    modalState.attemptId,
    modalState.phase,
    prepareContent,
    releaseNotes,
    shellReady
  ]);

  const close = useCallback(() => {
    preloadedImagesRef.current = [];
    if (releaseNotes) {
      dismissedVersionsRef.current.add(releaseNotes.version);
      if (storage) {
        try {
          storage.setItem(
            releaseNotesSeenStorageKey(releaseNotes.version),
            "1"
          );
        } catch (error) {
          console.warn("Failed to remember viewed release notes", error);
        }
      }
    }
    dispatchModal({ type: "closed" });
  }, [releaseNotes, storage]);

  useEffect(
    () => () => {
      preloadedImagesRef.current = [];
    },
    []
  );

  return {
    open: modalState.phase === "open" && !blockingDialogOpen,
    close,
    releaseNotes
  };
}

function hasSeenReleaseNotes(
  storage: ReleaseNotesStorage,
  releaseNotesVersion: string
): boolean {
  const canonicalKey = releaseNotesSeenStorageKey(releaseNotesVersion);
  let canonicalValue: string | null;
  try {
    canonicalValue = storage.getItem(canonicalKey);
  } catch (error) {
    console.warn("Failed to read viewed release notes", error);
    return false;
  }
  if (canonicalValue === "1") {
    return true;
  }
  if (canonicalValue !== null) {
    return false;
  }

  const legacyKeyPrefix = `${canonicalKey}.`;
  try {
    const { length, key } = storage;
    if (typeof length !== "number" || typeof key !== "function") {
      return false;
    }
    for (let index = 0; index < length; index += 1) {
      const legacyKey = key.call(storage, index);
      if (
        legacyKey?.startsWith(legacyKeyPrefix) &&
        storage.getItem(legacyKey) === "1"
      ) {
        try {
          storage.setItem(canonicalKey, "1");
        } catch (error) {
          console.warn("Failed to migrate viewed release notes", error);
        }
        return true;
      }
    }
  } catch (error) {
    console.warn("Failed to read viewed release notes", error);
  }
  return false;
}

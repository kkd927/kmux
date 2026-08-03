import { useCallback, useEffect, useRef, useState } from "react";

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

export function useReleaseNotesModal(options: {
  releaseNotes: BundledReleaseNotesCatalog | null;
  shellReady: boolean;
  blockingDialogOpen: boolean;
  storage?: ReleaseNotesStorage;
}): {
  open: boolean;
  close: () => void;
  releaseNotes: SelectedReleaseNotes | null;
} {
  const {
    releaseNotes: releaseNotesCatalog,
    shellReady,
    blockingDialogOpen
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
  const [open, setOpen] = useState(false);
  const [manualRequestPending, setManualRequestPending] = useState(false);
  const preloadedImagesRef = useRef<HTMLImageElement[]>([]);
  const openedManuallyRef = useRef(false);
  const dismissedVersionsRef = useRef(new Set<string>());
  const openRef = useRef(open);
  openRef.current = open && !blockingDialogOpen;

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
      if (!openRef.current) {
        setManualRequestPending(true);
      }
    });
  }, [releaseNotesCatalog]);

  useEffect(() => {
    if (!open || !blockingDialogOpen) {
      return;
    }
    if (openedManuallyRef.current) {
      setManualRequestPending(true);
    }
    setOpen(false);
  }, [blockingDialogOpen, open]);

  useEffect(() => {
    if (!releaseNotes || !shellReady || blockingDialogOpen || open) {
      return;
    }
    const dismissed = dismissedVersionsRef.current.has(releaseNotes.version);
    if (!manualRequestPending && dismissed) {
      return;
    }
    const seen = storage
      ? hasSeenReleaseNotes(storage, releaseNotes.version)
      : false;
    if (!manualRequestPending && seen) {
      return;
    }

    let cancelled = false;
    let finished = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const finishOpening = (): void => {
      if (cancelled || finished) {
        return;
      }
      finished = true;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      openedManuallyRef.current = manualRequestPending;
      setManualRequestPending(false);
      setOpen(true);
    };
    const images = Object.values(releaseNotes.imageSources).map((src) => {
      const image = new Image();
      image.src = src;
      return image;
    });
    preloadedImagesRef.current = images;

    if (images.length === 0) {
      finishOpening();
    } else {
      timeoutId = setTimeout(
        finishOpening,
        RELEASE_NOTES_IMAGE_PRELOAD_TIMEOUT_MS
      );
      void Promise.allSettled(images.map(async (image) => image.decode())).then(
        finishOpening
      );
    }

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      if (!finished) {
        preloadedImagesRef.current = [];
      }
    };
  }, [
    blockingDialogOpen,
    manualRequestPending,
    open,
    releaseNotes,
    shellReady,
    storage
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
    openedManuallyRef.current = false;
    setOpen(false);
  }, [releaseNotes, storage]);

  useEffect(
    () => () => {
      preloadedImagesRef.current = [];
    },
    []
  );

  return {
    open: open && !blockingDialogOpen,
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

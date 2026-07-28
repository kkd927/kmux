import { useCallback, useEffect, useRef, useState } from "react";

export interface BundledReleaseNotes {
  version: string;
  markdown: string;
  imageSources: Readonly<Record<string, string>>;
}

export const RELEASE_NOTES_SEEN_KEY_PREFIX = "kmux.releaseNotes.seen.";

export function releaseNotesSeenStorageKey(version: string): string {
  return `${RELEASE_NOTES_SEEN_KEY_PREFIX}${version}`;
}

export function useReleaseNotesModal(options: {
  releaseNotes: BundledReleaseNotes | null;
  shellReady: boolean;
  blockingDialogOpen: boolean;
  storage?: Pick<Storage, "getItem" | "setItem">;
}): {
  open: boolean;
  close: () => void;
} {
  const { releaseNotes, shellReady, blockingDialogOpen } = options;
  const fallbackStorageRef = useRef<Pick<
    Storage,
    "getItem" | "setItem"
  > | null>();
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
  const [open, setOpen] = useState(false);
  const [manualRequestPending, setManualRequestPending] = useState(false);
  const openedManuallyRef = useRef(false);
  const dismissedVersionsRef = useRef(new Set<string>());
  const openRef = useRef(open);
  openRef.current = open && !blockingDialogOpen;

  useEffect(() => {
    if (!releaseNotes) {
      return;
    }
    return window.kmux.subscribeReleaseNotesOpenRequest(() => {
      if (!openRef.current) {
        setManualRequestPending(true);
      }
    });
  }, [releaseNotes]);

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
    let seen = false;
    if (storage) {
      try {
        seen =
          storage.getItem(releaseNotesSeenStorageKey(releaseNotes.version)) ===
          "1";
      } catch (error) {
        console.warn("Failed to read viewed release notes", error);
      }
    }
    if (!manualRequestPending && seen) {
      return;
    }
    openedManuallyRef.current = manualRequestPending;
    setManualRequestPending(false);
    setOpen(true);
  }, [
    blockingDialogOpen,
    manualRequestPending,
    open,
    releaseNotes,
    shellReady,
    storage
  ]);

  const close = useCallback(() => {
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

  return { open: open && !blockingDialogOpen, close };
}

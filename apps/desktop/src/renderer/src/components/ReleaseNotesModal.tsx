import { useCallback, useRef } from "react";

import type { ColorTheme } from "@kmux/ui";

import type { SelectedReleaseNotes } from "../releaseNotes";
import { MarkdownRenderedContent } from "../surfaces/MarkdownRenderedContent";
import styles from "../styles/App.module.css";
import "../styles/MarkdownSurface.css";

interface ReleaseNotesModalProps {
  colorTheme: ColorTheme;
  onClose: () => void;
  releaseNotes: SelectedReleaseNotes;
  surfaceId: string;
}

export function ReleaseNotesModal({
  colorTheme,
  onClose,
  releaseNotes,
  surfaceId
}: ReleaseNotesModalProps): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const onReady = useCallback(() => undefined, []);

  return (
    <div
      className={`${styles.overlay} ${styles.settingsOverlay}`}
      data-testid="release-notes-overlay"
    >
      <section
        className={styles.releaseNotesDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="release-notes-title"
      >
        <header className={styles.modalHeader}>
          <h2 id="release-notes-title">
            Release Notes · {releaseNotes.version}
          </h2>
          <button
            autoFocus
            type="button"
            aria-label="Close release notes"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div
          ref={viewportRef}
          className={`kmuxMarkdownSurface ${styles.releaseNotesBody}`}
          role="document"
          aria-label={`Release notes for ${releaseNotes.version}`}
        >
          <div className="kmuxMarkdownSurface__content">
            <MarkdownRenderedContent
              colorTheme={colorTheme}
              imageSources={releaseNotes.imageSources}
              markdown={releaseNotes.markdown}
              onReady={onReady}
              surfaceId={surfaceId}
              viewportRef={viewportRef}
            />
          </div>
        </div>
        <footer className={styles.modalActions}>
          <button type="button" data-primary="true" onClick={onClose}>
            Close
          </button>
        </footer>
      </section>
    </div>
  );
}

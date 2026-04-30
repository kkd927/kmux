import type { SurfaceSnapshotPayload } from "@kmux/proto";

export interface AttachedTerminalLike {
  cols: number;
  rows: number;
  resize(cols: number, rows: number): void;
  reset(): void;
}

type TerminalSnapshotLike = Pick<
  SurfaceSnapshotPayload,
  "cols" | "rows" | "sequence" | "vt"
>;

interface HydrateAttachedTerminalOptions<TTerminal extends AttachedTerminalLike> {
  terminal: TTerminal;
  isMounted: () => boolean;
  isTerminalActive: (terminal: TTerminal) => boolean;
  waitForTerminalFonts: () => Promise<void>;
  fitAndSyncTerminal: (terminal: TTerminal) => Promise<void>;
  attachSurface: () => Promise<TerminalSnapshotLike | null>;
  writeTerminal: (
    terminal: TTerminal,
    data: string,
    afterWrite?: () => void
  ) => void;
  onSnapshotRendered?: (snapshot: TerminalSnapshotLike) => void;
}

interface ReattachPreservedTerminalOptions<
  TTerminal extends AttachedTerminalLike
> {
  terminal: TTerminal;
  isMounted: () => boolean;
  isTerminalActive: (terminal: TTerminal) => boolean;
  waitForTerminalFonts: () => Promise<void>;
  attachSurface: () => Promise<TerminalSnapshotLike | null>;
  lastRenderedSequence: number | null;
  beforeFitAndSync?: () => void;
  fitAndSyncTerminal: (terminal: TTerminal) => Promise<void>;
  writeTerminal: (
    terminal: TTerminal,
    data: string,
    afterWrite?: () => void
  ) => void;
  onSnapshotRendered?: (snapshot: TerminalSnapshotLike) => void;
}

export async function hydrateAttachedTerminal<
  TTerminal extends AttachedTerminalLike
>({
  terminal,
  isMounted,
  isTerminalActive,
  waitForTerminalFonts,
  fitAndSyncTerminal,
  attachSurface,
  writeTerminal,
  onSnapshotRendered
}: HydrateAttachedTerminalOptions<TTerminal>): Promise<void> {
  const canContinue = () => isMounted() && isTerminalActive(terminal);

  await waitForTerminalFonts();
  if (!canContinue()) {
    return;
  }

  await fitAndSyncTerminal(terminal);
  if (!canContinue()) {
    return;
  }

  const snapshot = await attachSurface();
  if (!snapshot || !canContinue()) {
    return;
  }

  const hasLiveTerminalSize = terminal.cols > 0 && terminal.rows > 0;
  if (
    !hasLiveTerminalSize &&
    snapshot.cols > 0 &&
    snapshot.rows > 0 &&
    (terminal.cols !== snapshot.cols || terminal.rows !== snapshot.rows)
  ) {
    terminal.resize(snapshot.cols, snapshot.rows);
  }

  terminal.reset();
  writeTerminal(terminal, snapshot.vt, () => {
    if (!canContinue()) {
      return;
    }
    onSnapshotRendered?.(snapshot);
    void fitAndSyncTerminal(terminal);
  });
}

export async function reattachPreservedTerminal<
  TTerminal extends AttachedTerminalLike
>({
  terminal,
  isMounted,
  isTerminalActive,
  waitForTerminalFonts,
  attachSurface,
  lastRenderedSequence,
  beforeFitAndSync,
  fitAndSyncTerminal,
  writeTerminal,
  onSnapshotRendered
}: ReattachPreservedTerminalOptions<TTerminal>): Promise<void> {
  const canContinue = () => isMounted() && isTerminalActive(terminal);

  await waitForTerminalFonts();
  if (!canContinue()) {
    return;
  }

  const snapshot = await attachSurface();
  if (!snapshot || !canContinue()) {
    return;
  }

  if (lastRenderedSequence === null || snapshot.sequence > lastRenderedSequence) {
    terminal.reset();
    writeTerminal(terminal, snapshot.vt, () => {
      if (!canContinue()) {
        return;
      }
      onSnapshotRendered?.(snapshot);
      beforeFitAndSync?.();
      void fitAndSyncTerminal(terminal);
    });
    return;
  }

  onSnapshotRendered?.(snapshot);
  beforeFitAndSync?.();
  await fitAndSyncTerminal(terminal);
}

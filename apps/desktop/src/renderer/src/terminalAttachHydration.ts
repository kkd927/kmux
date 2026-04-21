import type { SurfaceSnapshotPayload } from "@kmux/proto";

export interface AttachedTerminalLike {
  cols: number;
  rows: number;
  resize(cols: number, rows: number): void;
  reset(): void;
}

type TerminalSnapshotLike = Pick<SurfaceSnapshotPayload, "cols" | "rows" | "vt">;

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
  writeTerminal
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
    void fitAndSyncTerminal(terminal);
  });
}

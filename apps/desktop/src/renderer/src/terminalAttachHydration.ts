import type {
  SurfaceAttachPayload,
  SurfaceSnapshotPayload
} from "@kmux/proto";

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

type TerminalAttachPayloadLike = Pick<SurfaceAttachPayload, "attachId"> & {
  snapshot: TerminalSnapshotLike;
};

type TerminalAttachCompletionResultLike =
  | { status: "ready" }
  | { status: "stale" }
  | { status: "replay"; attachId: string; snapshot: TerminalSnapshotLike };

type MaybePromise<T> = T | Promise<T>;

interface HydrateAttachedTerminalOptions<TTerminal extends AttachedTerminalLike> {
  terminal: TTerminal;
  isMounted: () => boolean;
  isTerminalActive: (terminal: TTerminal) => boolean;
  waitForTerminalFonts: () => Promise<void>;
  fitAndSyncTerminal: (terminal: TTerminal) => Promise<void>;
  attachSurface: () => Promise<TerminalAttachPayloadLike | null>;
  writeTerminal: (
    terminal: TTerminal,
    data: string,
    afterWrite?: () => void
  ) => void;
  onSnapshotRendered?: (
    attachId: string,
    snapshot: TerminalSnapshotLike
  ) => MaybePromise<TerminalAttachCompletionResultLike | void>;
}

interface ReattachPreservedTerminalOptions<
  TTerminal extends AttachedTerminalLike
> {
  terminal: TTerminal;
  isMounted: () => boolean;
  isTerminalActive: (terminal: TTerminal) => boolean;
  waitForTerminalFonts: () => Promise<void>;
  attachSurface: () => Promise<TerminalAttachPayloadLike | null>;
  lastRenderedSequence: number | null;
  beforeFitAndSync?: () => void;
  fitAndSyncTerminal: (terminal: TTerminal) => Promise<void>;
  writeTerminal: (
    terminal: TTerminal,
    data: string,
    afterWrite?: () => void
  ) => void;
  onSnapshotRendered?: (
    attachId: string,
    snapshot: TerminalSnapshotLike
  ) => MaybePromise<TerminalAttachCompletionResultLike | void>;
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

  const attachPayload = await attachSurface();
  if (!attachPayload || !canContinue()) {
    return;
  }
  let snapshot = attachPayload.snapshot;
  let attachId = attachPayload.attachId;
  let applySnapshotDimensions = false;

  const hasLiveTerminalSize = terminal.cols > 0 && terminal.rows > 0;
  if (
    !hasLiveTerminalSize &&
    snapshot.cols > 0 &&
    snapshot.rows > 0 &&
    (terminal.cols !== snapshot.cols || terminal.rows !== snapshot.rows)
  ) {
    terminal.resize(snapshot.cols, snapshot.rows);
  }

  for (;;) {
    const completion = await replaySnapshot({
      terminal,
      snapshot,
      attachId,
      applySnapshotDimensions,
      canContinue,
      fitAndSyncTerminal,
      writeTerminal,
      onSnapshotRendered
    });
    if (completion?.status !== "replay") {
      return;
    }
    attachId = completion.attachId;
    snapshot = completion.snapshot;
    applySnapshotDimensions = true;
  }
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

  const attachPayload = await attachSurface();
  if (!attachPayload || !canContinue()) {
    return;
  }
  let snapshot = attachPayload.snapshot;
  let attachId = attachPayload.attachId;
  let forceReplay = false;
  let applySnapshotDimensions = false;

  for (;;) {
    if (
      forceReplay ||
      lastRenderedSequence === null ||
      snapshot.sequence > lastRenderedSequence
    ) {
      const completion = await replaySnapshot({
        terminal,
        snapshot,
        attachId,
        applySnapshotDimensions,
        canContinue,
        beforeFitAndSync,
        fitAndSyncTerminal,
        writeTerminal,
        onSnapshotRendered
      });
      if (completion?.status !== "replay") {
        return;
      }
      attachId = completion.attachId;
      snapshot = completion.snapshot;
      forceReplay = true;
      applySnapshotDimensions = true;
      continue;
    }

    const completion = await onSnapshotRendered?.(attachId, snapshot);
    if (completion?.status === "replay") {
      attachId = completion.attachId;
      snapshot = completion.snapshot;
      forceReplay = true;
      applySnapshotDimensions = true;
      continue;
    }
    if (canContinue()) {
      beforeFitAndSync?.();
      await fitAndSyncTerminal(terminal);
    }
    return;
  }
}

async function replaySnapshot<TTerminal extends AttachedTerminalLike>({
  terminal,
  snapshot,
  attachId,
  applySnapshotDimensions,
  canContinue,
  beforeFitAndSync,
  fitAndSyncTerminal,
  writeTerminal,
  onSnapshotRendered
}: {
  terminal: TTerminal;
  snapshot: TerminalSnapshotLike;
  attachId: string;
  applySnapshotDimensions: boolean;
  canContinue: () => boolean;
  beforeFitAndSync?: () => void;
  fitAndSyncTerminal: (terminal: TTerminal) => Promise<void>;
  writeTerminal: (
    terminal: TTerminal,
    data: string,
    afterWrite?: () => void
  ) => void;
  onSnapshotRendered?: (
    attachId: string,
    snapshot: TerminalSnapshotLike
  ) => MaybePromise<TerminalAttachCompletionResultLike | void>;
}): Promise<TerminalAttachCompletionResultLike | void> {
  if (
    applySnapshotDimensions &&
    snapshot.cols > 0 &&
    snapshot.rows > 0 &&
    (terminal.cols !== snapshot.cols || terminal.rows !== snapshot.rows)
  ) {
    terminal.resize(snapshot.cols, snapshot.rows);
  }
  terminal.reset();
  if (snapshot.vt.length > 0) {
    await new Promise<void>((resolve) => {
      writeTerminal(terminal, snapshot.vt, resolve);
    });
  }

  const completion = await onSnapshotRendered?.(attachId, snapshot);
  if (completion?.status === "replay") {
    return completion;
  }
  if (canContinue()) {
    beforeFitAndSync?.();
    await fitAndSyncTerminal(terminal);
  }
  return completion;
}

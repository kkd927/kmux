export const TERMINAL_OUTPUT_GAP_THRESHOLD_MS = 2_000;

export function resolveTerminalOutputGapMs(
  previousOutputAt: number | undefined,
  outputAt: number
): number | undefined {
  if (
    previousOutputAt === undefined ||
    !Number.isFinite(previousOutputAt) ||
    !Number.isFinite(outputAt)
  ) {
    return undefined;
  }
  const gapMs = outputAt - previousOutputAt;
  return gapMs >= TERMINAL_OUTPUT_GAP_THRESHOLD_MS ? gapMs : undefined;
}

export function settlePtyProfileBucketsBeforeDiagnosticsDisable(options: {
  continuousProfileEnabled: boolean;
  flushAll: () => void;
}): void {
  if (!options.continuousProfileEnabled) {
    options.flushAll();
  }
}

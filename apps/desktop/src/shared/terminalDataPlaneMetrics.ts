export interface HighResolutionClock {
  readonly timeOrigin: number;
  now(): number;
}

/** Returns a process-comparable, monotonic-within-process epoch timestamp. */
export function terminalDataPlaneNowMs(clock: HighResolutionClock): number {
  return clock.timeOrigin + clock.now();
}

export function nonNegativeDurationMs(
  startedAt: number | undefined,
  endedAt: number | undefined
): number | undefined {
  if (
    startedAt === undefined ||
    endedAt === undefined ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(endedAt)
  ) {
    return undefined;
  }
  return Math.max(0, endedAt - startedAt);
}

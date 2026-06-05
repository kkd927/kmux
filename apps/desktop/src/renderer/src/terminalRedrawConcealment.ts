const DEFAULT_QUIET_MS = 120;
const DEFAULT_MAX_MS = 500;

type TimeoutHandle = ReturnType<typeof setTimeout>;
type AnimationFrameHandle = number;

interface TerminalRedrawConcealmentOptions {
  hide: (surfaceId: string) => void;
  reveal: (surfaceId: string) => void;
  quietMs?: number;
  maxMs?: number;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
}

export interface TerminalRedrawConcealmentController {
  start(surfaceId: string): void;
  touch(surfaceId: string): void;
  revealNow(surfaceId: string): void;
  revealAllNow(): void;
}

interface ConcealmentState {
  startedAt: number;
  timeout: TimeoutHandle | null;
  frame: AnimationFrameHandle | null;
}

export function createTerminalRedrawConcealment({
  hide,
  reveal,
  quietMs = DEFAULT_QUIET_MS,
  maxMs = DEFAULT_MAX_MS,
  now = () => performance.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  requestAnimationFrame = defaultRequestAnimationFrame,
  cancelAnimationFrame = defaultCancelAnimationFrame
}: TerminalRedrawConcealmentOptions): TerminalRedrawConcealmentController {
  const states = new Map<string, ConcealmentState>();

  function clearScheduledWork(state: ConcealmentState): void {
    if (state.timeout !== null) {
      clearTimeoutFn(state.timeout);
      state.timeout = null;
    }
    if (state.frame !== null) {
      cancelAnimationFrame(state.frame);
      state.frame = null;
    }
  }

  function revealSurfaceNow(surfaceId: string): void {
    const state = states.get(surfaceId);
    if (!state) {
      return;
    }
    clearScheduledWork(state);
    states.delete(surfaceId);
    reveal(surfaceId);
  }

  function revealAfterPaint(surfaceId: string, state: ConcealmentState): void {
    clearScheduledWork(state);
    state.frame = requestAnimationFrame(() => {
      state.frame = requestAnimationFrame(() => {
        state.frame = null;
        revealSurfaceNow(surfaceId);
      });
    });
  }

  function scheduleReveal(surfaceId: string, state: ConcealmentState): void {
    if (state.timeout !== null) {
      clearTimeoutFn(state.timeout);
      state.timeout = null;
    }
    if (state.frame !== null) {
      cancelAnimationFrame(state.frame);
      state.frame = null;
    }

    const elapsedMs = Math.max(0, now() - state.startedAt);
    const delayMs = Math.max(0, Math.min(quietMs, maxMs - elapsedMs));
    state.timeout = setTimeoutFn(() => {
      state.timeout = null;
      revealAfterPaint(surfaceId, state);
    }, delayMs);
  }

  return {
    start(surfaceId: string): void {
      const existing = states.get(surfaceId);
      if (existing) {
        scheduleReveal(surfaceId, existing);
        return;
      }

      const state: ConcealmentState = {
        startedAt: now(),
        timeout: null,
        frame: null
      };
      states.set(surfaceId, state);
      hide(surfaceId);
      scheduleReveal(surfaceId, state);
    },
    touch(surfaceId: string): void {
      const state = states.get(surfaceId);
      if (!state) {
        return;
      }
      scheduleReveal(surfaceId, state);
    },
    revealNow: revealSurfaceNow,
    revealAllNow(): void {
      for (const surfaceId of [...states.keys()]) {
        revealSurfaceNow(surfaceId);
      }
    }
  };
}

function defaultRequestAnimationFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }
  return setTimeout(() => callback(performance.now()), 0) as unknown as number;
}

function defaultCancelAnimationFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

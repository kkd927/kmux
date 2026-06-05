const TERMINAL_REPLAY_HIDDEN_ATTR = "terminalReplayHidden";

type ReplayElement = HTMLElement | null | undefined;

interface TerminalReplayVisibilityOptions {
  host: ReplayElement;
  wrapper: ReplayElement;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
}

export interface TerminalReplayVisibilityController {
  hide(): void;
  revealAfterPaint(): void;
  dispose(): void;
}

let nextReplayVisibilityId = 1;

export function createTerminalReplayVisibility({
  host,
  wrapper,
  requestAnimationFrame = defaultRequestAnimationFrame,
  cancelAnimationFrame = defaultCancelAnimationFrame
}: TerminalReplayVisibilityOptions): TerminalReplayVisibilityController {
  const ownerId = `replay-${nextReplayVisibilityId++}`;
  let generation = 0;
  let activeToken: string | null = null;
  let revealFrame: number | null = null;
  let disposed = false;
  let hiddenElements = new Set<HTMLElement>();

  const elements = (): Set<HTMLElement> =>
    new Set(
      [host, wrapper].filter((element): element is HTMLElement =>
        Boolean(element)
      )
    );

  const cancelReveal = (): void => {
    if (revealFrame === null) {
      return;
    }
    cancelAnimationFrame(revealFrame);
    revealFrame = null;
  };

  const revealOwned = (token: string | null): void => {
    if (!token) {
      return;
    }
    for (const element of hiddenElements) {
      if (element.dataset[TERMINAL_REPLAY_HIDDEN_ATTR] === token) {
        delete element.dataset[TERMINAL_REPLAY_HIDDEN_ATTR];
      }
    }
    if (activeToken === token) {
      activeToken = null;
      hiddenElements = new Set();
    }
  };

  return {
    hide(): void {
      if (disposed) {
        return;
      }
      cancelReveal();
      const token = `${ownerId}:${++generation}`;
      activeToken = token;
      hiddenElements = elements();
      for (const element of hiddenElements) {
        element.dataset[TERMINAL_REPLAY_HIDDEN_ATTR] = token;
      }
    },
    revealAfterPaint(): void {
      if (disposed || !activeToken) {
        return;
      }
      cancelReveal();
      const token = activeToken;
      revealFrame = requestAnimationFrame(() => {
        revealFrame = requestAnimationFrame(() => {
          revealFrame = null;
          if (!disposed) {
            revealOwned(token);
          }
        });
      });
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      cancelReveal();
      revealOwned(activeToken);
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

export type TerminalResizeSyncStatus = "synced" | "superseded" | "failed";

export interface TerminalResizeSyncRequest {
  surfaceId: string;
  attachId: string | null;
  generation: number;
  cols: number;
  rows: number;
  gestureActive: boolean;
}

export type TerminalResizeSyncResult = TerminalResizeSyncRequest & {
  status: TerminalResizeSyncStatus;
  error?: unknown;
};

interface TerminalResizeSyncOptions {
  sendResize: (
    surfaceId: string,
    attachId: string | null,
    cols: number,
    rows: number,
    gestureActive: boolean
  ) => Promise<void>;
}

interface PendingResize extends TerminalResizeSyncRequest {
  resolve: (result: TerminalResizeSyncResult) => void;
}

interface SurfaceResizeState {
  inFlight: PendingResize | null;
  pending: PendingResize | null;
}

export function createTerminalResizeSync(options: TerminalResizeSyncOptions): {
  request(request: TerminalResizeSyncRequest): Promise<TerminalResizeSyncResult>;
} {
  const states = new Map<string, SurfaceResizeState>();

  function resolveResize(
    request: PendingResize,
    status: TerminalResizeSyncStatus,
    error?: unknown
  ): void {
    request.resolve({
      surfaceId: request.surfaceId,
      attachId: request.attachId,
      generation: request.generation,
      cols: request.cols,
      rows: request.rows,
      gestureActive: request.gestureActive,
      status,
      ...(error === undefined ? {} : { error })
    });
  }

  function stateForSurface(surfaceId: string): SurfaceResizeState {
    const existing = states.get(surfaceId);
    if (existing) {
      return existing;
    }
    const state: SurfaceResizeState = {
      inFlight: null,
      pending: null
    };
    states.set(surfaceId, state);
    return state;
  }

  function cleanup(surfaceId: string, state: SurfaceResizeState): void {
    if (!state.inFlight && !state.pending) {
      states.delete(surfaceId);
    }
  }

  function start(state: SurfaceResizeState, request: PendingResize): void {
    state.inFlight = request;
    void (async () => {
      let failed = false;
      let error: unknown;
      try {
        await options.sendResize(
          request.surfaceId,
          request.attachId,
          request.cols,
          request.rows,
          request.gestureActive
        );
      } catch (caughtError) {
        failed = true;
        error = caughtError;
      }

      if (state.inFlight === request) {
        state.inFlight = null;
      }
      resolveResize(request, failed ? "failed" : "synced", error);

      const pending = state.pending;
      state.pending = null;
      if (!pending) {
        cleanup(request.surfaceId, state);
        return;
      }

      if (
        !failed &&
        pending.attachId === request.attachId &&
        pending.cols === request.cols &&
        pending.rows === request.rows &&
        // A gesture-end request must reach the pty-host even when the size
        // matches the in-flight one: it releases the held PTY commit.
        pending.gestureActive === request.gestureActive
      ) {
        resolveResize(pending, "synced");
        cleanup(request.surfaceId, state);
        return;
      }

      start(state, pending);
    })();
  }

  return {
    request(request): Promise<TerminalResizeSyncResult> {
      return new Promise((resolve) => {
        const state = stateForSurface(request.surfaceId);
        const pending: PendingResize = {
          ...request,
          resolve
        };
        if (!state.inFlight) {
          start(state, pending);
          return;
        }
        if (state.pending) {
          resolveResize(state.pending, "superseded");
        }
        state.pending = pending;
      });
    }
  };
}

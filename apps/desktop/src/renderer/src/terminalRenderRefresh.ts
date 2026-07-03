import type { Terminal } from "@xterm/xterm";

interface XtermPausedResizeTask {
  flush?: () => void;
}

interface XtermRenderServiceInternals {
  _isPaused?: boolean;
  _needsFullRefresh?: boolean;
  _pausedResizeTask?: XtermPausedResizeTask;
  refreshRows?: (start: number, end: number, isRedrawOnly?: boolean) => void;
  _renderRows?: (start: number, end: number) => void;
}

type TerminalWithRenderService = Terminal & {
  _core?: {
    _renderService?: XtermRenderServiceInternals;
  };
  refresh?: (start: number, end: number) => void;
};

export interface TerminalRenderRefreshOptions {
  force?: boolean;
}

export function pauseTerminalRenderer(terminal: Terminal): boolean {
  const terminalWithInternals = terminal as TerminalWithRenderService;
  const renderService = terminalWithInternals._core?._renderService;
  if (!renderService) {
    return false;
  }

  renderService._isPaused = true;
  renderService._needsFullRefresh = true;
  return true;
}

export function resumeAndRefreshTerminalRenderer(
  terminal: Terminal,
  options: TerminalRenderRefreshOptions = {}
): boolean {
  const force = options.force ?? false;
  const endRow = Math.max(0, terminal.rows - 1);
  const terminalWithInternals = terminal as TerminalWithRenderService;
  const renderService = terminalWithInternals._core?._renderService;

  if (renderService) {
    const wasPaused = renderService._isPaused === true;
    const needsFullRefresh = renderService._needsFullRefresh === true;
    if (!force && !wasPaused && !needsFullRefresh) {
      return false;
    }

    if (wasPaused) {
      renderService._isPaused = false;
    }
    renderService._pausedResizeTask?.flush?.();
    if (typeof renderService.refreshRows === "function") {
      renderService.refreshRows(0, endRow);
      if (force && typeof renderService._renderRows === "function") {
        renderService._renderRows(0, endRow);
      }
      renderService._needsFullRefresh = false;
      return true;
    }
  } else if (!force) {
    return false;
  }

  if (typeof terminalWithInternals.refresh !== "function") {
    return false;
  }
  terminalWithInternals.refresh(0, endRow);
  return true;
}

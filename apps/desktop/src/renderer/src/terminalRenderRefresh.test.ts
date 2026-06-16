import { describe, expect, it, vi } from "vitest";

import type { Terminal } from "@xterm/xterm";

import { resumeAndRefreshTerminalRenderer } from "./terminalRenderRefresh";

function createTerminal(
  rows: number,
  renderService?: {
    _isPaused?: boolean;
    _needsFullRefresh?: boolean;
    _pausedResizeTask?: { flush?: () => void };
    refreshRows?: (start: number, end: number) => void;
    _renderRows?: (start: number, end: number) => void;
  }
): Terminal {
  return {
    rows,
    refresh: vi.fn(),
    _core: renderService
      ? {
          _renderService: renderService
        }
      : undefined
  } as unknown as Terminal;
}

describe("resumeAndRefreshTerminalRenderer", () => {
  it("resumes a paused xterm render service before requesting a full refresh", () => {
    const flush = vi.fn();
    const refreshRows = vi.fn();
    const renderRows = vi.fn();
    const renderService = {
      _isPaused: true,
      _needsFullRefresh: true,
      _pausedResizeTask: { flush },
      refreshRows,
      _renderRows: renderRows
    };
    const terminal = createTerminal(24, renderService);

    expect(resumeAndRefreshTerminalRenderer(terminal)).toBe(true);

    expect(renderService._isPaused).toBe(false);
    expect(renderService._needsFullRefresh).toBe(false);
    expect(flush).toHaveBeenCalledOnce();
    expect(refreshRows).toHaveBeenCalledWith(0, 23);
    expect(renderRows).not.toHaveBeenCalled();
    expect(terminal.refresh).not.toHaveBeenCalled();
  });

  it("refreshes a render service that recorded work while paused", () => {
    const refreshRows = vi.fn();
    const renderService = {
      _isPaused: false,
      _needsFullRefresh: true,
      refreshRows
    };
    const terminal = createTerminal(40, renderService);

    expect(resumeAndRefreshTerminalRenderer(terminal)).toBe(true);

    expect(refreshRows).toHaveBeenCalledWith(0, 39);
    expect(renderService._needsFullRefresh).toBe(false);
  });

  it("does not refresh an already current render service unless forced", () => {
    const refreshRows = vi.fn();
    const terminal = createTerminal(10, {
      _isPaused: false,
      _needsFullRefresh: false,
      refreshRows
    });

    expect(resumeAndRefreshTerminalRenderer(terminal)).toBe(false);
    expect(refreshRows).not.toHaveBeenCalled();

    expect(
      resumeAndRefreshTerminalRenderer(terminal, { force: true })
    ).toBe(true);
    expect(refreshRows).toHaveBeenCalledWith(0, 9);
  });

  it("forces an immediate render when animation frames are throttled", () => {
    const refreshRows = vi.fn();
    const renderRows = vi.fn();
    const terminal = createTerminal(8, {
      _isPaused: false,
      _needsFullRefresh: false,
      refreshRows,
      _renderRows: renderRows
    });

    expect(
      resumeAndRefreshTerminalRenderer(terminal, { force: true })
    ).toBe(true);

    expect(refreshRows).toHaveBeenCalledWith(0, 7);
    expect(renderRows).toHaveBeenCalledWith(0, 7);
  });

  it("falls back to public refresh when xterm internals are unavailable", () => {
    const terminal = createTerminal(12);

    expect(
      resumeAndRefreshTerminalRenderer(terminal, { force: true })
    ).toBe(true);

    expect(terminal.refresh).toHaveBeenCalledWith(0, 11);
  });
});

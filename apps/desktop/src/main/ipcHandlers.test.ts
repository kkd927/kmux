import { describe, expect, it, vi } from "vitest";

import type {
  ExternalAgentSessionResumeResult,
  ExternalAgentSessionsSnapshot
} from "@kmux/proto";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn()
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    })
  },
  Menu: {
    buildFromTemplate: vi.fn()
  }
}));

import { registerIpcHandlers } from "./ipcHandlers";

function registerTestHandlers(options: {
  snapshot: ExternalAgentSessionsSnapshot;
  resumeResult: ExternalAgentSessionResumeResult;
}): void {
  handlers.clear();
  registerIpcHandlers({
    getShellState: vi.fn(),
    getWorkspaceContextView: vi.fn(),
    getUsageView: vi.fn(),
    getUpdaterState: vi.fn(),
    dispatchAppAction: vi.fn(),
    attachSurface: vi.fn(),
    snapshotSurface: vi.fn(),
    detachSurface: vi.fn(),
    sendText: vi.fn(),
    sendKeyInput: vi.fn(),
    resizeSurface: vi.fn(),
    identify: vi.fn(),
    listTerminalFontFamilies: vi.fn(),
    previewTerminalTypography: vi.fn(),
    reportTerminalTypographyProbe: vi.fn(),
    importTerminalThemePalette: vi.fn(),
    exportTerminalThemePalette: vi.fn(),
    setUsageDashboardOpen: vi.fn(),
    downloadAvailableUpdate: vi.fn(),
    installDownloadedUpdate: vi.fn(),
    getExternalAgentSessions: () => options.snapshot,
    resumeExternalAgentSession: () => options.resumeResult
  });
}

describe("ipc handlers", () => {
  it("registers external session list and resume handlers", async () => {
    const snapshot: ExternalAgentSessionsSnapshot = {
      updatedAt: "2026-04-26T12:00:00.000Z",
      sessions: []
    };
    const resumeResult = {
      workspaceId: "workspace-1",
      surfaceId: "surface-1"
    };
    registerTestHandlers({ snapshot, resumeResult });

    const listHandler = handlers.get("kmux:external-sessions:get");
    const resumeHandler = handlers.get("kmux:external-sessions:resume");

    expect(listHandler).toBeTypeOf("function");
    expect(resumeHandler).toBeTypeOf("function");
    await expect(Promise.resolve(listHandler?.({}))).resolves.toBe(snapshot);
    await expect(
      Promise.resolve(resumeHandler?.({}, "codex:session"))
    ).resolves.toBe(resumeResult);
  });
});

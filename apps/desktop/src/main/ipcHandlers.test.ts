import { describe, expect, it, vi } from "vitest";

import type {
  CreateImageAttachmentsResult,
  CreateImageAttachmentPayload,
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
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }
    )
  },
  Menu: {
    buildFromTemplate: vi.fn()
  }
}));

import { registerIpcHandlers } from "./ipcHandlers";

function registerTestHandlers(options: {
  snapshot: ExternalAgentSessionsSnapshot;
  resumeResult: ExternalAgentSessionResumeResult;
  attachmentResult?: CreateImageAttachmentsResult;
  completeAttachSurface?: (
    contentsId: number,
    surfaceId: string,
    attachId: string
  ) => Promise<{ status: "ready" }>;
  resizeSurface?: (
    contentsId: number,
    surfaceId: string,
    attachId: string | null,
    cols: number,
    rows: number
  ) => Promise<void>;
}): void {
  handlers.clear();
  registerIpcHandlers({
    getShellState: vi.fn(),
    getWorkspaceContextView: vi.fn(),
    getUsageView: vi.fn(),
    getUpdaterState: vi.fn(),
    dispatchAppAction: vi.fn(),
    attachSurface: vi.fn(),
    completeAttachSurface: options.completeAttachSurface ?? vi.fn(),
    snapshotSurface: vi.fn(),
    detachSurface: vi.fn(),
    sendText: vi.fn(),
    sendKeyInput: vi.fn(),
    resizeSurface: options.resizeSurface ?? vi.fn(),
    identify: vi.fn(),
    listTerminalFontFamilies: vi.fn(),
    previewTerminalTypography: vi.fn(),
    reportTerminalTypographyProbe: vi.fn(),
    importTerminalThemePalette: vi.fn(),
    exportTerminalThemePalette: vi.fn(),
    openSettingsJson: vi.fn(),
    prepareWorktreeConversion: vi.fn(),
    createWorktreeWorkspace: vi.fn(),
    convertDetectedWorktree: vi.fn(),
    removeWorkspaceWorktree: vi.fn(),
    removeWorkspaceWorktrees: vi.fn(),
    setUsageDashboardOpen: vi.fn(),
    downloadAvailableUpdate: vi.fn(),
    installDownloadedUpdate: vi.fn(),
    getExternalAgentSessions: () => options.snapshot,
    resumeExternalAgentSession: () => options.resumeResult,
    createImageAttachments: async (
      _surfaceId: string,
      _payloads: CreateImageAttachmentPayload[]
    ) => {
      return (
        options.attachmentResult ?? {
          attachments: [],
          promptText: "",
          skippedCount: 0,
          status: "empty",
          message: "No supported image found"
        }
      );
    }
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

  it("registers image attachment creation handler", async () => {
    const snapshot: ExternalAgentSessionsSnapshot = {
      updatedAt: "2026-05-07T12:00:00.000Z",
      sessions: []
    };
    const resumeResult = {
      workspaceId: "workspace-1",
      surfaceId: "surface-1"
    };
    const attachmentResult: CreateImageAttachmentsResult = {
      attachments: [],
      promptText: "@/tmp/kmux/image.png",
      skippedCount: 0,
      status: "attached",
      message: "Attached image.png"
    };
    registerTestHandlers({ snapshot, resumeResult, attachmentResult });

    const attachmentHandler = handlers.get("kmux:image-attachments:create");

    expect(attachmentHandler).toBeTypeOf("function");
    await expect(
      Promise.resolve(
        attachmentHandler?.({}, "surface-1", [
          {
            source: "drop",
            originalName: "image.png",
            mimeType: "image/png",
            bytes: new Uint8Array([1, 2, 3])
          }
        ])
      )
    ).resolves.toBe(attachmentResult);
  });

  it("registers attach completion handler", async () => {
    const completeAttachSurface = vi.fn(async () => ({
      status: "ready" as const
    }));
    registerTestHandlers({
      snapshot: {
        updatedAt: "2026-05-13T12:00:00.000Z",
        sessions: []
      },
      resumeResult: {
        workspaceId: "workspace-1",
        surfaceId: "surface-1"
      },
      completeAttachSurface
    });

    const handler = handlers.get("kmux:attach-surface-complete");

    expect(handler).toBeTypeOf("function");
    await expect(
      Promise.resolve(
        handler?.({ sender: { id: 44 } }, "surface-1", "attach-1")
      )
    ).resolves.toEqual({ status: "ready" });
    expect(completeAttachSurface).toHaveBeenCalledWith(
      44,
      "surface-1",
      "attach-1"
    );
  });

  it("routes resize requests with sender and attach identity", async () => {
    const resizeSurface = vi.fn(async () => {});
    registerTestHandlers({
      snapshot: {
        updatedAt: "2026-05-13T12:00:00.000Z",
        sessions: []
      },
      resumeResult: {
        workspaceId: "workspace-1",
        surfaceId: "surface-1"
      },
      resizeSurface
    });

    const handler = handlers.get("kmux:terminal:resize");

    expect(handler).toBeTypeOf("function");
    await Promise.resolve(
      handler?.({ sender: { id: 44 } }, "surface-1", "attach-1", 132, 43)
    );
    expect(resizeSurface).toHaveBeenCalledWith(
      44,
      "surface-1",
      "attach-1",
      132,
      43
    );
  });
});

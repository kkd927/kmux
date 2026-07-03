import { beforeEach, describe, expect, it, vi } from "vitest";

const { clipboardMock, fsMock } = vi.hoisted(() => ({
  clipboardMock: {
    availableFormats: vi.fn(),
    read: vi.fn(),
    readBookmark: vi.fn(),
    readBuffer: vi.fn(),
    readImage: vi.fn(),
    readText: vi.fn(),
    writeText: vi.fn()
  },
  fsMock: {
    readFileSync: vi.fn(),
    statSync: vi.fn()
  }
}));

vi.mock("electron", () => ({
  clipboard: clipboardMock
}));

vi.mock("node:fs", () => fsMock);

import { createMainClipboardService } from "./clipboard";

describe("main clipboard service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clipboardMock.availableFormats.mockReturnValue([]);
    clipboardMock.read.mockReturnValue("");
    clipboardMock.readBookmark.mockReturnValue({ title: "", url: "" });
    clipboardMock.readBuffer.mockReturnValue(Buffer.alloc(0));
    clipboardMock.readImage.mockReturnValue({
      isEmpty: () => true,
      toPNG: () => Buffer.alloc(0)
    });
    clipboardMock.readText.mockReturnValue("");
  });

  it("detects pasteable image-file URLs without reading file bytes", () => {
    clipboardMock.read.mockImplementation((format: string) =>
      format === "public/file-url" ? "file:///tmp/screenshot.png" : ""
    );

    const service = createMainClipboardService();

    expect(service.hasPasteableContent()).toBe(true);
    expect(fsMock.statSync).not.toHaveBeenCalled();
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });
});

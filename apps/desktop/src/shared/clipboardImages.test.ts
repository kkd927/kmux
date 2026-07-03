import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  collectClipboardImagePayloads,
  MAX_CLIPBOARD_IMAGE_FILE_BYTES,
  parseClipboardFileUrls
} from "./clipboardImages";

const tempRoots: string[] = [];
const pngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("clipboard image payload helpers", () => {
  it("parses file URLs from native clipboard strings and bookmarks", () => {
    expect(
      parseClipboardFileUrls({
        bookmarkUrl: "file:///Users/test/Screen%20Shot.png",
        rawValues: [
          "",
          "file:///Users/test/other.jpg\nhttps://example.com/not-local"
        ]
      })
    ).toEqual([
      "file:///Users/test/Screen%20Shot.png",
      "file:///Users/test/other.jpg"
    ]);
  });

  it("turns copied image-file URLs into attachment payloads before text fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-clipboard-image-"));
    tempRoots.push(root);
    const imagePath = join(root, "screenshot.png");
    writeFileSync(imagePath, pngBytes);

    const payloads = collectClipboardImagePayloads({
      readNativeImagePng: () => null,
      readFileUrls: () => [pathToFileURL(imagePath).toString()],
      readFileBytes: (path) => new Uint8Array(readFileSync(path))
    });

    expect(payloads).toEqual([
      {
        source: "clipboard",
        originalName: "screenshot.png",
        mimeType: "image/png",
        bytes: pngBytes
      }
    ]);
  });

  it("skips malformed copied file URLs instead of breaking paste", () => {
    const readFileBytes = vi.fn(() => pngBytes);

    const payloads = collectClipboardImagePayloads({
      readNativeImagePng: () => null,
      readFileUrls: () => [
        "file://example.com/screenshot.png",
        "file:///Users/test/not-image.txt"
      ],
      readFileBytes
    });

    expect(payloads).toEqual([]);
    expect(readFileBytes).not.toHaveBeenCalled();
  });

  it("skips oversized copied image files before reading bytes", () => {
    const readFileBytes = vi.fn(() => pngBytes);

    const payloads = collectClipboardImagePayloads({
      readNativeImagePng: () => null,
      readFileUrls: () => ["file:///Users/test/huge.png"],
      readFileSize: () => MAX_CLIPBOARD_IMAGE_FILE_BYTES + 1,
      readFileBytes
    });

    expect(payloads).toEqual([]);
    expect(readFileBytes).not.toHaveBeenCalled();
  });

  it("uses native bitmap clipboard data when it exists", () => {
    const readFileUrls = vi.fn(() => ["file:///Users/test/screenshot.png"]);

    const payloads = collectClipboardImagePayloads({
      readNativeImagePng: () => pngBytes,
      readFileUrls,
      readFileBytes: () => {
        throw new Error("file URL fallback should not run for native image data");
      }
    });

    expect(payloads).toEqual([
      {
        source: "clipboard",
        originalName: "clipboard.png",
        mimeType: "image/png",
        bytes: pngBytes
      }
    ]);
    expect(readFileUrls).not.toHaveBeenCalled();
  });
});

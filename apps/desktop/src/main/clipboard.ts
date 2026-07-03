import { clipboard } from "electron";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CreateImageAttachmentPayload } from "@kmux/proto";

import {
  collectClipboardImagePayloads,
  isSupportedClipboardImagePath,
  parseClipboardFileUrls
} from "../shared/clipboardImages";

export interface MainClipboardService {
  readText(): string;
  writeText(text: string): void;
  readImages(): CreateImageAttachmentPayload[];
  hasPasteableContent(): boolean;
}

export function createMainClipboardService(): MainClipboardService {
  return {
    readText: () => clipboard.readText(),
    writeText: (text) => {
      clipboard.writeText(text);
    },
    readImages: () =>
      collectClipboardImagePayloads({
        readNativeImagePng: () => {
          const image = clipboard.readImage();
          if (!image.isEmpty()) {
            const png = image.toPNG();
            return new Uint8Array(
              png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)
            );
          }
          return readClipboardBuffer("public/png");
        },
        readFileUrls: readClipboardFileUrls,
        readFileSize: (path) => {
          try {
            return statSync(path).size;
          } catch {
            return null;
          }
        },
        readFileBytes: (path) => {
          try {
            return new Uint8Array(readFileSync(path));
          } catch {
            return null;
          }
        }
      }),
    hasPasteableContent: () =>
      hasClipboardText() ||
      hasNativeImage() ||
      hasClipboardImageFormat() ||
      hasClipboardImageFileUrl()
  };
}

function hasClipboardText(): boolean {
  try {
    return clipboard.readText().length > 0;
  } catch {
    return false;
  }
}

function hasNativeImage(): boolean {
  try {
    return !clipboard.readImage().isEmpty();
  } catch {
    return false;
  }
}

function hasClipboardImageFormat(): boolean {
  try {
    return clipboard.availableFormats().some((format) =>
      /^(?:image\/|public\.(?:png|jpeg|tiff)|png$|jpeg$|jpg$|tiff$)/i.test(
        format
      )
    );
  } catch {
    return false;
  }
}

function hasClipboardImageFileUrl(): boolean {
  return readClipboardFileUrls().some((fileUrl) => {
    try {
      return isSupportedClipboardImagePath(fileURLToPath(fileUrl));
    } catch {
      return false;
    }
  });
}

function readClipboardFileUrls(): string[] {
  const bookmark = readClipboardBookmarkUrl();
  const knownFormats = [
    readClipboardFormat("public/file-url"),
    readClipboardFormat("public/url"),
    readClipboardFormat("text/uri-list")
  ];
  const discoveredFormats = readClipboardAvailableFormats()
    .filter((format) => /file-url|uri-list|\burl\b/i.test(format))
    .map(readClipboardFormat);
  return parseClipboardFileUrls({
    bookmarkUrl: bookmark,
    rawValues: [...knownFormats, ...discoveredFormats]
  });
}

function readClipboardBookmarkUrl(): string {
  try {
    return clipboard.readBookmark().url;
  } catch {
    return "";
  }
}

function readClipboardAvailableFormats(): string[] {
  try {
    return clipboard.availableFormats();
  } catch {
    return [];
  }
}

function readClipboardFormat(format: string): string {
  try {
    return clipboard.read(format);
  } catch {
    return "";
  }
}

function readClipboardBuffer(format: string): Uint8Array | null {
  try {
    const buffer = clipboard.readBuffer(format);
    if (!buffer.byteLength) {
      return null;
    }
    return new Uint8Array(
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
      )
    );
  } catch {
    return null;
  }
}

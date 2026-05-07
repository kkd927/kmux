import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CreateImageAttachmentPayload,
  ImageAttachmentMimeType
} from "@kmux/proto";

const IMAGE_MIME_BY_EXTENSION: Record<string, ImageAttachmentMimeType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
};
export const MAX_CLIPBOARD_IMAGE_FILE_BYTES = 20 * 1024 * 1024;

export interface ClipboardImagePayloadReaders {
  readNativeImagePng: () => Uint8Array | null;
  readFileUrls: () => string[];
  readFileSize?: (path: string) => number | null;
  readFileBytes: (path: string) => Uint8Array | null;
  maxFileBytes?: number;
}

export function parseClipboardFileUrls(input: {
  bookmarkUrl?: string;
  rawValues: string[];
}): string[] {
  const candidates = [
    input.bookmarkUrl ?? "",
    ...input.rawValues.flatMap((value) =>
      value.replaceAll("\0", "\n").split(/\r?\n+/)
    )
  ];
  const seen = new Set<string>();
  const fileUrls: string[] = [];

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("file://") || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    fileUrls.push(trimmed);
  }

  return fileUrls;
}

export function collectClipboardImagePayloads(
  readers: ClipboardImagePayloadReaders
): CreateImageAttachmentPayload[] {
  const nativeImage = readers.readNativeImagePng();
  if (nativeImage && nativeImage.byteLength > 0) {
    return [
      {
        source: "clipboard",
        originalName: "clipboard.png",
        mimeType: "image/png",
        bytes: nativeImage
      }
    ];
  }

  const payloads: CreateImageAttachmentPayload[] = [];
  for (const fileUrl of readers.readFileUrls()) {
    const path = fileUrlToLocalPath(fileUrl);
    if (!path) {
      continue;
    }
    const mimeType = imageMimeTypeForPath(path);
    if (!mimeType) {
      continue;
    }
    if (isFileLargerThanLimit(path, readers)) {
      continue;
    }
    const bytes = readers.readFileBytes(path);
    if (!bytes || bytes.byteLength === 0) {
      continue;
    }
    payloads.push({
      source: "clipboard",
      originalName: basename(path),
      mimeType,
      bytes
    });
  }
  return payloads;
}

function fileUrlToLocalPath(fileUrl: string): string | null {
  try {
    return fileURLToPath(fileUrl);
  } catch {
    return null;
  }
}

function isFileLargerThanLimit(
  path: string,
  readers: ClipboardImagePayloadReaders
): boolean {
  if (!readers.readFileSize) {
    return false;
  }
  let size: number | null;
  try {
    size = readers.readFileSize(path);
  } catch {
    return true;
  }
  if (size === null || !Number.isFinite(size)) {
    return false;
  }
  return size > (readers.maxFileBytes ?? MAX_CLIPBOARD_IMAGE_FILE_BYTES);
}

function imageMimeTypeForPath(path: string): ImageAttachmentMimeType | null {
  return IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? null;
}

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  CreateImageAttachmentPayload,
  CreateImageAttachmentsResult,
  Id,
  ImageAttachmentMimeType,
  ImageAttachmentVm,
  UsageVendor
} from "@kmux/proto";

export const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const IMAGE_ATTACHMENT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
export const IMAGE_ATTACHMENT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
export const IMAGE_ATTACHMENT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const MIME_EXTENSIONS: Record<ImageAttachmentMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp"
};

interface ImageAttachmentServiceOptions {
  attachmentRoot: string;
  getSurfaceSessionId(surfaceId: Id): Id | null;
  getSurfaceVendor(surfaceId: Id): UsageVendor;
  now?: () => Date;
  randomId?: () => string;
}

export interface ImageAttachmentService {
  createImageAttachments(
    surfaceId: Id,
    payloads: CreateImageAttachmentPayload[]
  ): Promise<CreateImageAttachmentsResult>;
  cleanupImageAttachments(
    options?: ImageAttachmentCleanupOptions
  ): Promise<ImageAttachmentCleanupResult>;
}

export interface ImageAttachmentCleanupOptions {
  maxAgeMs?: number;
  maxTotalBytes?: number;
}

export interface ImageAttachmentCleanupResult {
  deletedCount: number;
  deletedBytes: number;
  remainingBytes: number;
}

export function detectImageMimeType(
  bytes: Uint8Array
): ImageAttachmentMimeType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

export function createSafeAttachmentDisplayName(input: {
  originalName?: string;
  mimeType: ImageAttachmentMimeType;
  id: string;
  timestamp: string;
}): string {
  const leafName = (input.originalName ?? "")
    .split(/[\\/]/)
    .filter(Boolean)
    .at(-1);
  const extension = MIME_EXTENSIONS[input.mimeType];
  const basename =
    leafName?.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]+/g, "-") ??
    input.timestamp.replace(/[^0-9]+/g, "-");
  const trimmed = basename.replace(/^-+|-+$/g, "").slice(0, 80);
  const safeBasename = trimmed || "image";

  return `${safeBasename}-${input.id}.${extension}`;
}

export function formatImageAttachmentReference(
  vendor: UsageVendor,
  attachments: ImageAttachmentVm[]
): string {
  if (vendor === "gemini") {
    return attachments
      .map((attachment) => `@${attachment.absolutePath}`)
      .join("\n");
  }

  return attachments
    .map((attachment) => `Attached image: ${attachment.absolutePath}`)
    .join("\n");
}

export function createImageAttachmentService(
  options: ImageAttachmentServiceOptions
): ImageAttachmentService {
  return {
    async cleanupImageAttachments(cleanupOptions = {}) {
      return cleanupImageAttachmentFiles({
        attachmentRoot: options.attachmentRoot,
        now: options.now?.() ?? new Date(),
        maxAgeMs:
          cleanupOptions.maxAgeMs ?? IMAGE_ATTACHMENT_RETENTION_MS,
        maxTotalBytes:
          cleanupOptions.maxTotalBytes ?? IMAGE_ATTACHMENT_MAX_TOTAL_BYTES
      });
    },
    async createImageAttachments(surfaceId, payloads) {
      const sessionId = options.getSurfaceSessionId(surfaceId);
      if (!sessionId) {
        return {
          attachments: [],
          promptText: "",
          skippedCount: payloads.length,
          status: "failed",
          message: "Terminal session is unavailable"
        };
      }

      const attachments: ImageAttachmentVm[] = [];
      let skippedCount = 0;
      const now = options.now ?? (() => new Date());
      const randomId =
        options.randomId ??
        (() => Math.random().toString(36).slice(2, 10) || "attachment");
      const safeSurfaceId = createSafePathSegment(surfaceId);
      const surfaceAttachmentRoot = join(options.attachmentRoot, safeSurfaceId);
      await mkdir(surfaceAttachmentRoot, { recursive: true, mode: 0o700 });

      for (const payload of payloads) {
        const bytes = normalizeAttachmentBytes(payload.bytes);
        const detectedMimeType = detectImageMimeType(bytes);
        if (
          !detectedMimeType ||
          bytes.byteLength === 0 ||
          bytes.byteLength > MAX_IMAGE_ATTACHMENT_BYTES
        ) {
          skippedCount += 1;
          continue;
        }

        const createdAt = now().toISOString();
        const id = randomId();
        const displayName = createSafeAttachmentDisplayName({
          originalName: payload.originalName,
          mimeType: detectedMimeType,
          id,
          timestamp: createdAt
        });
        const absolutePath = join(surfaceAttachmentRoot, displayName);
        await writeFile(absolutePath, bytes, { mode: 0o600 });
        attachments.push({
          id,
          surfaceId,
          sessionId,
          absolutePath,
          displayName,
          mimeType: detectedMimeType,
          byteLength: bytes.byteLength,
          createdAt
        });
      }

      if (!attachments.length) {
        return {
          attachments: [],
          promptText: "",
          skippedCount,
          status: "empty",
          message: "No supported image found"
        };
      }

      const promptText = formatImageAttachmentReference(
        options.getSurfaceVendor(surfaceId),
        attachments
      );

      return {
        attachments,
        promptText,
        skippedCount,
        status: skippedCount > 0 ? "partial" : "attached",
        message: formatAttachmentStatusMessage(attachments, skippedCount)
      };
    }
  };
}

export async function cleanupImageAttachmentFiles(options: {
  attachmentRoot: string;
  now: Date;
  maxAgeMs: number;
  maxTotalBytes: number;
}): Promise<ImageAttachmentCleanupResult> {
  const files = await listAttachmentFiles(options.attachmentRoot);
  const cutoffMs = options.now.getTime() - options.maxAgeMs;
  let deletedCount = 0;
  let deletedBytes = 0;
  const remainingFiles: AttachmentFileEntry[] = [];

  for (const file of files) {
    if (file.mtimeMs < cutoffMs) {
      if (await deleteAttachmentFile(file.path)) {
        deletedCount += 1;
        deletedBytes += file.size;
      }
      continue;
    }
    remainingFiles.push(file);
  }

  let remainingBytes = remainingFiles.reduce((sum, file) => sum + file.size, 0);
  if (remainingBytes > options.maxTotalBytes) {
    for (const file of [...remainingFiles].sort((left, right) => {
      if (left.mtimeMs !== right.mtimeMs) {
        return left.mtimeMs - right.mtimeMs;
      }
      return left.path.localeCompare(right.path);
    })) {
      if (remainingBytes <= options.maxTotalBytes) {
        break;
      }
      if (await deleteAttachmentFile(file.path)) {
        deletedCount += 1;
        deletedBytes += file.size;
        remainingBytes -= file.size;
      }
    }
  }

  return {
    deletedCount,
    deletedBytes,
    remainingBytes
  };
}

function normalizeAttachmentBytes(
  bytes: CreateImageAttachmentPayload["bytes"]
): Uint8Array {
  if (bytes instanceof Uint8Array) {
    return bytes;
  }
  if (bytes instanceof ArrayBuffer) {
    return new Uint8Array(bytes);
  }
  return new Uint8Array(bytes);
}

interface AttachmentFileEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

async function listAttachmentFiles(root: string): Promise<AttachmentFileEntry[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry): Promise<AttachmentFileEntry[]> => {
        const entryPath = join(root, entry.name);
        if (entry.isDirectory()) {
          return listAttachmentFiles(entryPath);
        }
        if (!entry.isFile()) {
          return [];
        }
        try {
          const stats = await stat(entryPath);
          return [
            {
              path: entryPath,
              size: stats.size,
              mtimeMs: stats.mtimeMs
            }
          ];
        } catch {
          return [];
        }
      })
    );
    return files.flat();
  } catch {
    return [];
  }
}

async function deleteAttachmentFile(path: string): Promise<boolean> {
  try {
    await rm(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

function createSafePathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "surface";
}

function formatAttachmentStatusMessage(
  attachments: ImageAttachmentVm[],
  skippedCount: number
): string {
  const attachedMessage =
    attachments.length === 1
      ? `Attached ${attachments[0]!.displayName}`
      : `Attached ${attachments.length} images`;
  if (skippedCount > 0) {
    return `${attachedMessage}, skipped ${skippedCount}`;
  }
  return attachedMessage;
}

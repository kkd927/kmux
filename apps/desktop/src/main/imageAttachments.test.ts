import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  utimesSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ImageAttachmentVm } from "@kmux/proto";
import {
  createSafeAttachmentDisplayName,
  createImageAttachmentService,
  detectImageMimeType,
  formatImageAttachmentReference
} from "./imageAttachments";

const tempRoots: string[] = [];
const pngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);

const attachment: ImageAttachmentVm = {
  id: "attachment_1",
  surfaceId: "surface_1",
  sessionId: "session_1",
  absolutePath: "/tmp/kmux/image.png",
  displayName: "image.png",
  mimeType: "image/png",
  byteLength: 8,
  createdAt: "2026-05-07T12:00:00.000Z"
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("image attachment helpers", () => {
  it("detects supported image MIME types from file signatures", () => {
    expect(
      detectImageMimeType(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )
    ).toBe("image/png");
    expect(detectImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "image/jpeg"
    );
    expect(
      detectImageMimeType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))
    ).toBe("image/gif");
    expect(
      detectImageMimeType(
        new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50
        ])
      )
    ).toBe("image/webp");
    expect(
      detectImageMimeType(new TextEncoder().encode("not an image"))
    ).toBeNull();
  });

  it("creates safe display names with detected extensions", () => {
    expect(
      createSafeAttachmentDisplayName({
        originalName: "../Screen Shot: agent prompt?.png",
        mimeType: "image/png",
        id: "abc123",
        timestamp: "2026-05-07T12:34:56.789Z"
      })
    ).toBe("Screen-Shot-agent-prompt-abc123.png");

    expect(
      createSafeAttachmentDisplayName({
        originalName: "diagram.txt",
        mimeType: "image/jpeg",
        id: "def456",
        timestamp: "2026-05-07T12:34:56.789Z"
      })
    ).toBe("diagram-def456.jpg");
  });

  it("formats vendor-aware image attachment references", () => {
    expect(formatImageAttachmentReference("claude", [attachment])).toBe(
      "Attached image: /tmp/kmux/image.png"
    );
    expect(formatImageAttachmentReference("codex", [attachment])).toBe(
      "Attached image: /tmp/kmux/image.png"
    );
    expect(formatImageAttachmentReference("antigravity", [attachment])).toBe(
      "Attached image: /tmp/kmux/image.png"
    );
    expect(formatImageAttachmentReference("unknown", [attachment])).toBe(
      "Attached image: /tmp/kmux/image.png"
    );
  });
});

describe("image attachment service", () => {
  it("persists image attachments and returns vendor prompt text", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-image-attachments-"));
    tempRoots.push(root);
    const service = createImageAttachmentService({
      attachmentRoot: join(root, "attachments"),
      getSurfaceSessionId: (surfaceId) =>
        surfaceId === "surface_1" ? "session_1" : null,
      getSurfaceVendor: () => "antigravity",
      now: () => new Date("2026-05-07T12:34:56.789Z"),
      randomId: () => "abc123"
    });

    const result = await service.createImageAttachments("surface_1", [
      {
        source: "drop",
        originalName: "diagram.png",
        mimeType: "image/png",
        bytes: pngBytes
      }
    ]);

    const saved = result.attachments[0];
    expect(result.status).toBe("attached");
    expect(result.skippedCount).toBe(0);
    expect(saved?.sessionId).toBe("session_1");
    expect(saved?.absolutePath).toContain(
      `${sep}attachments${sep}surface_1${sep}`
    );
    expect(readFileSync(saved!.absolutePath)).toEqual(Buffer.from(pngBytes));
    expect(result.promptText).toBe(`Attached image: ${saved!.absolutePath}`);
    expect(result.message).toBe("Attached diagram-abc123.png");
  });

  it("skips invalid images without writing prompt text", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-image-attachments-"));
    tempRoots.push(root);
    const service = createImageAttachmentService({
      attachmentRoot: join(root, "attachments"),
      getSurfaceSessionId: () => "session_1",
      getSurfaceVendor: () => "codex",
      now: () => new Date("2026-05-07T12:34:56.789Z"),
      randomId: () => "abc123"
    });

    const result = await service.createImageAttachments("surface_1", [
      {
        source: "clipboard",
        originalName: "notes.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("not an image")
      }
    ]);

    expect(result).toEqual({
      attachments: [],
      promptText: "",
      skippedCount: 1,
      status: "empty",
      message: "No supported image found"
    });
  });

  it("deletes attachment files older than the retention window", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-image-attachments-"));
    tempRoots.push(root);
    const attachmentRoot = join(root, "attachments");
    const surfaceRoot = join(attachmentRoot, "surface_1");
    mkdirSync(surfaceRoot, { recursive: true });
    const oldFile = join(surfaceRoot, "old.png");
    const freshFile = join(surfaceRoot, "fresh.png");
    writeFileSync(oldFile, pngBytes);
    writeFileSync(freshFile, pngBytes);
    const now = new Date("2026-05-08T12:00:00.000Z");
    utimesSync(
      oldFile,
      new Date("2026-05-04T11:59:59.000Z"),
      new Date("2026-05-04T11:59:59.000Z")
    );
    utimesSync(
      freshFile,
      new Date("2026-05-07T12:00:00.000Z"),
      new Date("2026-05-07T12:00:00.000Z")
    );
    const service = createImageAttachmentService({
      attachmentRoot,
      getSurfaceSessionId: () => "session_1",
      getSurfaceVendor: () => "codex",
      now: () => now
    });

    const result = await service.cleanupImageAttachments({
      maxAgeMs: 3 * 24 * 60 * 60 * 1000,
      maxTotalBytes: 1024 * 1024
    });

    expect(result.deletedCount).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
  });

  it("deletes oldest attachment files when total size exceeds the cap", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-image-attachments-"));
    tempRoots.push(root);
    const attachmentRoot = join(root, "attachments");
    const surfaceRoot = join(attachmentRoot, "surface_1");
    mkdirSync(surfaceRoot, { recursive: true });
    const oldestFile = join(surfaceRoot, "oldest.png");
    const middleFile = join(surfaceRoot, "middle.png");
    const newestFile = join(surfaceRoot, "newest.png");
    writeFileSync(oldestFile, Buffer.alloc(600));
    writeFileSync(middleFile, Buffer.alloc(600));
    writeFileSync(newestFile, Buffer.alloc(600));
    utimesSync(
      oldestFile,
      new Date("2026-05-08T09:00:00.000Z"),
      new Date("2026-05-08T09:00:00.000Z")
    );
    utimesSync(
      middleFile,
      new Date("2026-05-08T10:00:00.000Z"),
      new Date("2026-05-08T10:00:00.000Z")
    );
    utimesSync(
      newestFile,
      new Date("2026-05-08T11:00:00.000Z"),
      new Date("2026-05-08T11:00:00.000Z")
    );
    const service = createImageAttachmentService({
      attachmentRoot,
      getSurfaceSessionId: () => "session_1",
      getSurfaceVendor: () => "codex",
      now: () => new Date("2026-05-08T12:00:00.000Z")
    });

    const result = await service.cleanupImageAttachments({
      maxAgeMs: 3 * 24 * 60 * 60 * 1000,
      maxTotalBytes: 1000
    });

    expect(result.deletedCount).toBe(2);
    expect(existsSync(oldestFile)).toBe(false);
    expect(existsSync(middleFile)).toBe(false);
    expect(existsSync(newestFile)).toBe(true);
  });
});

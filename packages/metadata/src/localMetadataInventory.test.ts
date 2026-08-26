import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLocalMetadataInventoryService } from "./localMetadataInventory";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    rmSync(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

describe("local metadata inventory coordination", () => {
  it("shares one inventory result across projections with the same topology key", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-local-inventory-"));
    cleanupPaths.push(root);
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "session.jsonl"), "{}\n", "utf8");
    const service = createLocalMetadataInventoryService({
      principal: "uid:test",
      sourceDefinitionRevisions: { fixture: "fixture-metadata-v1" }
    });
    const leases = [
      service.acquire("fixture", [root]),
      service.acquire("fixture", [join(root, "nested"), root]),
      service.acquire("fixture", [root, join(root, "nested")])
    ];

    try {
      const [sessions, usage, secondProjection] = await Promise.all([
        leases[0]!.inventory(),
        leases[1]!.inventory(),
        leases[2]!.inventory()
      ]);
      expect(usage).toBe(sessions);
      expect(secondProjection).toBe(sessions);
      expect(sessions.candidates).toHaveLength(1);

      leases[0]!.invalidate();
      const refreshed = await leases[1]!.inventory();
      expect(refreshed).not.toBe(sessions);
    } finally {
      await Promise.all(leases.map((lease) => lease.release()));
      await service.close();
    }
  });

  it("shares bounded reads while rejecting paths outside the topology root", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-local-read-root-"));
    const outside = mkdtempSync(join(tmpdir(), "kmux-local-read-outside-"));
    cleanupPaths.push(root, outside);
    const sourcePath = join(root, "session.jsonl");
    const unicodePath = join(root, "unicode.jsonl");
    const outsidePath = join(outside, "secret.jsonl");
    writeFileSync(sourcePath, "first\nsecond\n", "utf8");
    writeFileSync(unicodePath, "ab한cd", "utf8");
    writeFileSync(outsidePath, "secret\n", "utf8");
    symlinkSync(outsidePath, join(root, "linked.jsonl"));
    const service = createLocalMetadataInventoryService({
      principal: "uid:test",
      sourceDefinitionRevisions: { fixture: "fixture-metadata-v1" }
    });
    const lease = service.acquire("fixture", [root], {
      maxDepth: 2,
      maxDirectories: 16,
      maxEntries: 64
    });

    try {
      await expect(
        Promise.all([
          lease.readText({
            path: sourcePath,
            offset: 0,
            maxBytes: 5
          }),
          lease.readText({
            path: sourcePath,
            offset: 0,
            maxBytes: 5
          })
        ])
      ).resolves.toEqual(["first", "first"]);
      const unicodePrefix = await lease.readText({
        path: unicodePath,
        offset: 0,
        maxBytes: 4
      });
      const unicodeSuffix = await lease.readText({
        path: unicodePath,
        offset: Buffer.byteLength(unicodePrefix, "utf8"),
        maxBytes: 5
      });
      expect(unicodePrefix + unicodeSuffix).toBe("ab한cd");
      await expect(
        lease.readText({
          path: outsidePath,
          offset: 0,
          maxBytes: 16
        })
      ).rejects.toThrow(/outside/u);
      await expect(
        lease.readText({
          path: join(root, "linked.jsonl"),
          offset: 0,
          maxBytes: 16
        })
      ).rejects.toThrow(/regular file/u);
      await expect(
        lease.readText({
          path: sourcePath,
          offset: 0,
          maxBytes: 256 * 1024 + 1
        })
      ).rejects.toThrow(/hard bounds/u);
    } finally {
      await lease.release();
      await service.close();
    }
  });
});

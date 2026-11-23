import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileOrchestrationArtifactStore } from "./artifacts";

describe("local orchestration artifact store", () => {
  it("reads only bounded content whose storage bytes still match the reference", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-artifacts-"));
    try {
      const store = new FileOrchestrationArtifactStore({
        root,
        now: () => "2026-08-30T00:00:00.000Z",
        id: () => "artifact:test"
      });
      const bytes = Buffer.from("trusted repository patch", "utf8");
      const artifact = await store.put({
        kind: "git-dirty-patch",
        bytes,
        maxBytes: 1024
      });
      await expect(
        store.get({
          artifact,
          expectedKind: "git-dirty-patch",
          maxBytes: 1024
        })
      ).resolves.toEqual(new Uint8Array(bytes));
      await expect(
        store.get({
          artifact,
          expectedKind: "git-untracked-manifest",
          maxBytes: 1024
        })
      ).rejects.toThrow("invalid or out of bounds");

      const digest = createHash("sha256").update(bytes).digest("hex");
      writeFileSync(
        join(root, digest.slice(0, 2), `${digest}.bin`),
        Buffer.alloc(bytes.byteLength, 0x78)
      );
      await expect(store.get({ artifact, maxBytes: 1024 })).rejects.toThrow(
        "content hash does not match"
      );
      await expect(
        store.put({ kind: "git-dirty-patch", bytes, maxBytes: 1024 })
      ).rejects.toThrow("does not match content");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

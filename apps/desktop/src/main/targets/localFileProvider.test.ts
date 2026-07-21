import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeLocalPath } from "@kmux/core";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalFileProvider } from "./localTargetProviders";
import { createLocalPathResolver } from "./targetServiceRegistry";

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(
    sandboxes
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("local FileProvider", () => {
  it("reports file metadata and enforces the actual read bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "kmux-local-files-"));
    sandboxes.push(root);
    const filePath = join(root, "README.md");
    const directoryPath = join(root, "docs");
    await writeFile(filePath, "# hello", "utf8");
    await mkdir(directoryPath);
    const provider = createLocalFileProvider({
      resolveLocalPath: createLocalPathResolver(),
      homeDir: root
    });

    await expect(
      provider.stat(decodeLocalPath(filePath))
    ).resolves.toMatchObject({
      kind: "file",
      size: 7,
      modifiedAtMs: expect.any(Number)
    });
    await expect(
      provider.stat(decodeLocalPath(directoryPath))
    ).resolves.toMatchObject({ kind: "directory" });
    await expect(
      provider.stat(decodeLocalPath(join(root, "missing.md")))
    ).resolves.toBeNull();
    await expect(
      provider.read(decodeLocalPath(filePath), { maxBytes: 7 })
    ).resolves.toEqual(new TextEncoder().encode("# hello"));
    await expect(
      provider.read(decodeLocalPath(filePath), { maxBytes: 6 })
    ).rejects.toThrow(/read bound/u);
  });
});

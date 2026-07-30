import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  normalizeStableVersion,
  renderHomebrewCask,
  updateHomebrewCask
} from "./generate-homebrew-cask.mjs";

describe("Homebrew Cask generation", () => {
  it("renders immutable architecture-specific URLs and checksums", async () => {
    await withTempDirectory(async (directory) => {
      const arm64Path = await writeDmg(
        directory,
        "kmux-1.2.3-mac-arm64.dmg",
        "arm64 release"
      );
      const x64Path = await writeDmg(
        directory,
        "kmux-1.2.3-mac-x64.dmg",
        "x64 release"
      );
      const outputPath = path.join(directory, "Casks", "kmux.rb");

      const result = await updateHomebrewCask({
        version: "v1.2.3",
        dmgPaths: [x64Path, arm64Path],
        outputPath
      });

      expect(result.status).toBe("updated");
      expect(await readFile(outputPath, "utf8")).toBe(
        renderHomebrewCask({
          version: "1.2.3",
          arm64Sha256: digest("arm64 release"),
          x64Sha256: digest("x64 release")
        })
      );
    });
  });

  it.each([
    "v1.2.3-alpha.1",
    "1.2.3-beta.1",
    "v1.2.3+rebuilt",
    "v01.2.3",
    "1.02.3",
    "1.2.03"
  ])("rejects non-stable or invalid version %s", (version) => {
    expect(() => normalizeStableVersion(version)).toThrow(
      /Invalid stable version/
    );
  });

  it("rejects missing, duplicate, and mismatched DMGs", async () => {
    await withTempDirectory(async (directory) => {
      const x64Path = await writeDmg(
        directory,
        "kmux-1.2.3-mac-x64.dmg",
        "x64 release"
      );
      const duplicateDirectory = path.join(directory, "duplicate");
      await mkdir(duplicateDirectory);
      const duplicateX64Path = await writeDmg(
        duplicateDirectory,
        "kmux-1.2.3-mac-x64.dmg",
        "other x64 release"
      );
      const wrongVersionPath = await writeDmg(
        directory,
        "kmux-1.2.4-mac-arm64.dmg",
        "wrong release"
      );
      const outputPath = path.join(directory, "kmux.rb");

      await expect(
        updateHomebrewCask({
          version: "1.2.3",
          dmgPaths: [x64Path],
          outputPath
        })
      ).rejects.toThrow(/Expected exactly two DMGs/);
      await expect(
        updateHomebrewCask({
          version: "1.2.3",
          dmgPaths: [x64Path, duplicateX64Path],
          outputPath
        })
      ).rejects.toThrow(/Duplicate x64 DMG/);
      await expect(
        updateHomebrewCask({
          version: "1.2.3",
          dmgPaths: [x64Path, wrongVersionPath],
          outputPath
        })
      ).rejects.toThrow(/Unexpected DMG filename/);
    });
  });

  it("does not replace a newer Cask with an older release", async () => {
    await withTempDirectory(async (directory) => {
      const outputPath = path.join(directory, "kmux.rb");
      const currentSource = renderHomebrewCask({
        version: "2.0.0",
        arm64Sha256: "a".repeat(64),
        x64Sha256: "b".repeat(64)
      });
      await writeFile(outputPath, currentSource, "utf8");
      const arm64Path = await writeDmg(
        directory,
        "kmux-1.9.9-mac-arm64.dmg",
        "arm64 release"
      );
      const x64Path = await writeDmg(
        directory,
        "kmux-1.9.9-mac-x64.dmg",
        "x64 release"
      );

      const result = await updateHomebrewCask({
        version: "1.9.9",
        dmgPaths: [arm64Path, x64Path],
        outputPath,
        currentCaskPath: outputPath
      });

      expect(result).toMatchObject({
        status: "skipped-downgrade",
        version: "1.9.9",
        currentVersion: "2.0.0"
      });
      expect(await readFile(outputPath, "utf8")).toBe(currentSource);
    });
  });

  it("is a no-op for matching assets and refreshes changed same-version assets", async () => {
    await withTempDirectory(async (directory) => {
      const outputPath = path.join(directory, "kmux.rb");
      const arm64Path = await writeDmg(
        directory,
        "kmux-1.2.3-mac-arm64.dmg",
        "arm64 release"
      );
      const x64Path = await writeDmg(
        directory,
        "kmux-1.2.3-mac-x64.dmg",
        "x64 release"
      );
      const options = {
        version: "1.2.3",
        dmgPaths: [arm64Path, x64Path],
        outputPath,
        currentCaskPath: outputPath
      };

      await updateHomebrewCask({
        ...options,
        currentCaskPath: undefined
      });
      const originalSource = await readFile(outputPath, "utf8");
      expect((await updateHomebrewCask(options)).status).toBe("unchanged");

      await writeFile(arm64Path, "rebuilt arm64 release", "utf8");
      expect((await updateHomebrewCask(options)).status).toBe("updated");
      const rebuiltSource = await readFile(outputPath, "utf8");
      expect(rebuiltSource).not.toBe(originalSource);
      expect(rebuiltSource).toContain(digest("rebuilt arm64 release"));
    });
  });
});

async function writeDmg(directory, basename, contents) {
  const filePath = path.join(directory, basename);
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function withTempDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kmux-cask-test-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

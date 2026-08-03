import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadBundledReleaseNotes,
  prepareGitHubReleaseNotes
} from "./release-notes.mjs";

describe("release note bundle source", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each(["1.2.3", "1.2.3-beta.1"])(
    "loads the default and localized notes for application version %s from its minor document",
    (applicationVersion) => {
      const root = createRepository(applicationVersion);
      writeNote(root, "v1.1.md", "# Old release");
      writeNote(root, "v1.1.ko.md", "# 이전 릴리즈");

      expect(loadBundledReleaseNotes({ repoRoot: root })).toBeNull();

      writeNote(root, "v1.2.md", " \n\t");
      expect(loadBundledReleaseNotes({ repoRoot: root })).toBeNull();

      writeNote(root, "v1.2.md", "# Current release\n");
      writeNote(root, "v1.2.ko.md", "# 현재 릴리즈\n");
      writeNote(root, "v1.2.zh-CN.md", " \n");
      expect(loadBundledReleaseNotes({ repoRoot: root })).toMatchObject({
        version: "1.2",
        default: {
          markdown: "# Current release\n",
          images: []
        },
        localized: {
          ko: {
            markdown: "# 현재 릴리즈\n",
            images: []
          }
        }
      });
      expect(
        loadBundledReleaseNotes({ repoRoot: root })?.localized["zh-CN"]
      ).toBeUndefined();
    }
  );

  it("requires a non-empty default note when a translation exists", () => {
    const missingDefaultRoot = createRepository("1.2.0");
    writeNote(missingDefaultRoot, "v1.2.ko.md", "# 번역");

    expect(() =>
      loadBundledReleaseNotes({ repoRoot: missingDefaultRoot })
    ).toThrow(/require a non-empty default/);

    const blankDefaultRoot = createRepository("1.2.0");
    writeNote(blankDefaultRoot, "v1.2.md", " \n");
    writeNote(blankDefaultRoot, "v1.2.ko.md", "# 번역");

    expect(() =>
      loadBundledReleaseNotes({ repoRoot: blankDefaultRoot })
    ).toThrow(/require a non-empty default/);
  });

  it("collects and validates images independently for every language", () => {
    const root = createRepository("1.2.0");
    writeImage(root, "current.webp");
    writeImage(root, "localized.png");
    writeImage(root, "unreferenced.gif");
    writeNote(
      root,
      "v1.2.md",
      [
        "![Current](./assets/current.webp)",
        "",
        "![Reference][screenshot]",
        "",
        "[screenshot]: ./assets/current.webp"
      ].join("\n")
    );
    writeNote(root, "v1.2.ko.md", "![Localized](./assets/localized.png)");

    const releaseNotes = loadBundledReleaseNotes({ repoRoot: root });

    expect(releaseNotes?.default.images).toHaveLength(1);
    expect(releaseNotes?.default.images[0]).toMatchObject({
      source: "./assets/current.webp"
    });
    expect(releaseNotes?.default.images[0]?.absolutePath).toMatch(
      /\/docs\/release-notes\/assets\/current\.webp$/u
    );
    expect(releaseNotes?.localized.ko?.images).toHaveLength(1);
    expect(releaseNotes?.localized.ko?.images[0]).toMatchObject({
      source: "./assets/localized.png"
    });
  });

  it("applies image security validation to localized notes", () => {
    const root = createRepository("1.2.0");
    writeNote(root, "v1.2.md", "# Default");
    writeNote(
      root,
      "v1.2.ko.md",
      "![Invalid](https://example.com/localized.png)"
    );

    expect(() => loadBundledReleaseNotes({ repoRoot: root })).toThrow(
      /Invalid release note image/
    );
  });

  it.each(["assets/current.png", "./assets/current.png"])(
    "resolves document-relative image source %s",
    (source) => {
      const root = createRepository("1.2.0");
      writeImage(root, "current.png");
      writeNote(root, "v1.2.md", `![Current](${source})`);

      expect(
        loadBundledReleaseNotes({ repoRoot: root })?.default.images
      ).toEqual([expect.objectContaining({ source })]);
    }
  );

  it("rejects invalid or duplicate normalized locale suffixes", () => {
    const invalidRoot = createRepository("1.2.0");
    writeNote(invalidRoot, "v1.2.md", "# Default");
    writeNote(invalidRoot, "v1.2.en_US.md", "# Invalid");

    expect(() => loadBundledReleaseNotes({ repoRoot: invalidRoot })).toThrow(
      /Invalid release note locale suffix/
    );

    const duplicateRoot = createRepository("1.2.0");
    writeNote(duplicateRoot, "v1.2.md", "# Default");
    writeNote(duplicateRoot, "v1.2.he.md", "# Hebrew");
    writeNote(duplicateRoot, "v1.2.iw.md", "# Legacy Hebrew");

    expect(() => loadBundledReleaseNotes({ repoRoot: duplicateRoot })).toThrow(
      /both normalize to "he"/
    );
  });

  it.each([
    "https://example.com/image.png",
    "data:image/png;base64,AAAA",
    "file:///tmp/image.png",
    "../outside.png",
    "assets/../escape.png",
    "assets/%2e%2e/escape.png",
    "assets/image.svg"
  ])("rejects unsupported image source %s", (source) => {
    const root = createRepository("1.2.0");
    writeNote(root, "v1.2.md", `![Invalid](${source})`);

    expect(() => loadBundledReleaseNotes({ repoRoot: root })).toThrow(
      /Invalid release note image/
    );
  });

  it("fails when a referenced image is missing", () => {
    const root = createRepository("1.2.0");
    writeNote(root, "v1.2.md", "![Missing](assets/missing.png)");

    expect(() => loadBundledReleaseNotes({ repoRoot: root })).toThrow(
      /does not exist/
    );
  });

  it.each(["v1.2.3", "v1.2.3-beta.1"])(
    "writes GitHub-ready notes for %s from its minor document without changing the source",
    (tag) => {
      const root = createRepository(tag.slice(1));
      const markdown = [
        "# Current",
        "",
        "![Shot](<./assets/current image.png>)",
        "",
        "![Reference][shot]",
        "",
        "[shot]: <./assets/current image.png>",
        "",
        "[Ordinary link](<./assets/current image.png>)",
        "",
        "```markdown",
        "![Example](./assets/current image.png)",
        "```",
        ""
      ].join("\n");
      writeImage(root, "current image.png");
      const sourcePath = writeNote(root, "v1.2.md", markdown);
      writeNote(root, "v1.2.ko.md", "# GitHub에서 사용하지 않는 번역");
      const outputPath = path.join(root, "temporary-notes.md");

      expect(
        prepareGitHubReleaseNotes({
          repoRoot: root,
          repository: "kkd927/kmux",
          tag,
          outputPath
        })
      ).toBe(true);

      expect(readFileSync(sourcePath, "utf8")).toBe(markdown);
      expect(readFileSync(outputPath, "utf8")).toContain(
        `https://raw.githubusercontent.com/kkd927/kmux/${tag}/docs/release-notes/assets/current%20image.png`
      );
      expect(readFileSync(outputPath, "utf8")).toContain(
        "![Example](./assets/current image.png)"
      );
      expect(readFileSync(outputPath, "utf8")).toContain(
        "[Ordinary link](<./assets/current image.png>)"
      );
      expect(readFileSync(outputPath, "utf8")).not.toContain(
        "GitHub에서 사용하지 않는 번역"
      );
    }
  );

  function createRepository(version) {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-release-notes-"));
    roots.push(root);
    mkdirSync(path.join(root, "apps", "desktop"), { recursive: true });
    mkdirSync(path.join(root, "docs", "release-notes"), {
      recursive: true
    });
    writeFileSync(
      path.join(root, "apps", "desktop", "package.json"),
      JSON.stringify({ version }),
      "utf8"
    );
    return root;
  }

  function writeNote(root, name, markdown) {
    const notePath = path.join(root, "docs", "release-notes", name);
    writeFileSync(notePath, markdown, "utf8");
    return notePath;
  }

  function writeImage(root, relativePath) {
    const imagePath = path.join(
      root,
      "docs",
      "release-notes",
      "assets",
      relativePath
    );
    mkdirSync(path.dirname(imagePath), { recursive: true });
    writeFileSync(imagePath, "image", "utf8");
  }
});

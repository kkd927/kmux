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

  it("selects only the exact desktop version and ignores missing or blank notes", () => {
    const root = createRepository("1.2.0");
    writeNote(root, "v1.1.0.md", "# Old release");

    expect(loadBundledReleaseNotes({ repoRoot: root })).toBeNull();

    writeNote(root, "v1.2.0.md", " \n\t");
    expect(loadBundledReleaseNotes({ repoRoot: root })).toBeNull();

    writeNote(root, "v1.2.0.md", "# Current release\n");
    expect(loadBundledReleaseNotes({ repoRoot: root })).toMatchObject({
      version: "1.2.0",
      markdown: "# Current release\n",
      images: []
    });
  });

  it("includes only referenced current-version images", () => {
    const root = createRepository("1.2.0");
    writeImage(root, "v1.1.0/old.png");
    writeImage(root, "v1.2.0/current.webp");
    writeImage(root, "v1.2.0/unreferenced.gif");
    writeNote(
      root,
      "v1.2.0.md",
      [
        "![Current](./assets/v1.2.0/current.webp)",
        "",
        "![Reference][screenshot]",
        "",
        "[screenshot]: ./assets/v1.2.0/current.webp"
      ].join("\n")
    );

    const releaseNotes = loadBundledReleaseNotes({ repoRoot: root });

    expect(releaseNotes?.images).toHaveLength(1);
    expect(releaseNotes?.images[0]).toMatchObject({
      source: "./assets/v1.2.0/current.webp"
    });
    expect(releaseNotes?.images[0]?.absolutePath).toMatch(
      /\/docs\/release-notes\/assets\/v1\.2\.0\/current\.webp$/u
    );
  });

  it.each([
    "https://example.com/image.png",
    "data:image/png;base64,AAAA",
    "file:///tmp/image.png",
    "./assets/v1.1.0/old.png",
    "./assets/v1.2.0/../escape.png",
    "./assets/v1.2.0/%2e%2e/escape.png",
    "./assets/v1.2.0/image.svg"
  ])("rejects unsupported image source %s", (source) => {
    const root = createRepository("1.2.0");
    writeNote(root, "v1.2.0.md", `![Invalid](${source})`);

    expect(() => loadBundledReleaseNotes({ repoRoot: root })).toThrow(
      /Invalid release note image/
    );
  });

  it("fails when a referenced image is missing", () => {
    const root = createRepository("1.2.0");
    writeNote(root, "v1.2.0.md", "![Missing](./assets/v1.2.0/missing.png)");

    expect(() => loadBundledReleaseNotes({ repoRoot: root })).toThrow(
      /does not exist/
    );
  });

  it("writes GitHub-ready temporary notes without changing the source", () => {
    const root = createRepository("1.2.0");
    const markdown = [
      "# Current",
      "",
      "![Shot](<./assets/v1.2.0/current image.png>)",
      "",
      "![Reference][shot]",
      "",
      "[shot]: <./assets/v1.2.0/current image.png>",
      "",
      "[Ordinary link](<./assets/v1.2.0/current image.png>)",
      "",
      "```markdown",
      "![Example](./assets/v1.2.0/current image.png)",
      "```",
      ""
    ].join("\n");
    writeImage(root, "v1.2.0/current image.png");
    const sourcePath = writeNote(root, "v1.2.0.md", markdown);
    const outputPath = path.join(root, "temporary-notes.md");

    expect(
      prepareGitHubReleaseNotes({
        repoRoot: root,
        repository: "kkd927/kmux",
        tag: "v1.2.0",
        outputPath
      })
    ).toBe(true);

    expect(readFileSync(sourcePath, "utf8")).toBe(markdown);
    expect(readFileSync(outputPath, "utf8")).toContain(
      "https://raw.githubusercontent.com/kkd927/kmux/v1.2.0/docs/release-notes/assets/v1.2.0/current%20image.png"
    );
    expect(readFileSync(outputPath, "utf8")).toContain(
      "![Example](./assets/v1.2.0/current image.png)"
    );
    expect(readFileSync(outputPath, "utf8")).toContain(
      "[Ordinary link](<./assets/v1.2.0/current image.png>)"
    );
  });

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

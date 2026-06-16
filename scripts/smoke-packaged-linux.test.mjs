import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertAppImageBlockmapPresent,
  assertLinuxDesktopEnvironment,
  buildAppImageRuntimeEnv,
  buildPackagedSmokeSummary,
  buildPackagedSmokeEnv,
  calculateFileSha512,
  describeAppImageBlockmap,
  expectedLinuxUpdateMetadataNames,
  extractAppImageDesktopEntry,
  extractAppImageDesktopIdentity,
  findExtractedNotificationIconPath,
  findAppImagePath,
  findLinuxUpdateMetadataPath,
  findVersionedLibzPath,
  inferLinuxAppImageArch,
  isKmuxLinuxAppImagePath,
  isLinuxUpdateMetadataName,
  loadLinuxUpdateMetadata,
  linuxUpdateMetadataCandidates,
  normalizeLinuxDesktopEntry,
  parseDesktopEntry,
  parseArgs,
  validateLinuxDesktopEntry,
  validateLinuxUpdateMetadata
} from "./smoke-packaged-linux.mjs";

function createReleaseFixture({ arch = "x64" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-smoke-"));
  const appImageName = `kmux-0.3.12-linux-${arch}.AppImage`;
  const metadataName =
    arch === "x64" ? "latest-linux.yml" : `latest-linux-${arch}.yml`;
  const appImagePath = path.join(root, appImageName);
  const metadataPath = path.join(root, metadataName);
  const appImageContents = "app";
  writeFileSync(appImagePath, appImageContents);
  const appImageSha512 = calculateFileSha512(appImagePath);
  writeFileSync(
    metadataPath,
    [
      "version: 0.3.12",
      "files:",
      `  - url: ${appImageName}`,
      `    sha512: ${appImageSha512}`,
      `    size: ${appImageContents.length}`,
      `path: ${appImageName}`,
      `sha512: ${appImageSha512}`
    ].join("\n")
  );
  return { root, appImagePath, metadataPath };
}

describe("linux packaged smoke wrapper", () => {
  const ubuntuLtsOsRelease = [
    'PRETTY_NAME="Ubuntu 24.04.2 LTS"',
    'VERSION="24.04.2 LTS (Noble Numbat)"',
    "ID=ubuntu"
  ].join("\n");

  it("parses explicit AppImage and metadata arguments", () => {
    const parsed = parseArgs([
      "--appimage",
      "apps/desktop/release/kmux.AppImage",
      "--metadata",
      "apps/desktop/release/latest-linux.yml",
      "--allow-any-linux-desktop"
    ]);

    expect(parsed).toEqual({
      appImagePath: path.resolve("apps/desktop/release/kmux.AppImage"),
      metadataPath: path.resolve("apps/desktop/release/latest-linux.yml"),
      allowAnyLinuxDesktop: true
    });
  });

  it("rejects unknown or incomplete packaged smoke flags", () => {
    expect(() => parseArgs(["--appimage"])).toThrow(
      /--appimage requires a path value/
    );
    expect(() => parseArgs(["--appimage", "--metadata"])).toThrow(
      /--appimage requires a path value/
    );
    expect(() => parseArgs(["--metadata"])).toThrow(
      /--metadata requires a path value/
    );
    expect(() => parseArgs(["--allow-any-platform"])).toThrow(
      /unknown smoke:packaged:linux argument/
    );
  });

  it("finds AppImage and update metadata in release roots", () => {
    const fixture = createReleaseFixture();
    try {
      expect(findAppImagePath({ searchRoots: [fixture.root] })).toBe(
        fixture.appImagePath
      );
      expect(
        findLinuxUpdateMetadataPath({
          appImagePath: fixture.appImagePath,
          searchRoots: [fixture.root]
        })
      ).toBe(fixture.metadataPath);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("only selects packaged kmux Linux AppImage artifacts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-smoke-shape-"));
    try {
      const genericAppImage = path.join(root, "kmux.AppImage");
      const macNamedAppImage = path.join(root, "kmux-0.3.12-mac-x64.AppImage");
      const otherProductAppImage = path.join(
        root,
        "other-tool-0.3.12-linux-x64.AppImage"
      );
      const linuxAppImage = path.join(root, "kmux-0.3.12-linux-x64.AppImage");
      writeFileSync(genericAppImage, "");
      writeFileSync(macNamedAppImage, "");
      writeFileSync(otherProductAppImage, "");
      writeFileSync(linuxAppImage, "");

      expect(isKmuxLinuxAppImagePath(genericAppImage)).toBe(false);
      expect(isKmuxLinuxAppImagePath(macNamedAppImage)).toBe(false);
      expect(isKmuxLinuxAppImagePath(otherProductAppImage)).toBe(false);
      expect(isKmuxLinuxAppImagePath(linuxAppImage)).toBe(true);
      expect(findAppImagePath({ searchRoots: [root] })).toBe(linuxAppImage);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects explicit AppImage paths that are not packaged kmux Linux artifacts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-smoke-explicit-"));
    try {
      const genericAppImage = path.join(root, "kmux.AppImage");
      writeFileSync(genericAppImage, "");

      expect(() => findAppImagePath({ explicitPath: genericAppImage })).toThrow(
        /kmux-<version>-linux-<arch>\.AppImage/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects explicit AppImage paths that are not files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-smoke-appdir-"));
    try {
      const appImageDirectory = path.join(
        root,
        "kmux-0.3.12-linux-x64.AppImage"
      );
      mkdirSync(appImageDirectory);

      expect(() =>
        findAppImagePath({ explicitPath: appImageDirectory })
      ).toThrow(/AppImage .* is not a file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds AppImage and update metadata in nested release artifact directories", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-smoke-nested-"));
    try {
      const artifactDir = path.join(root, "linux-x64-release-assets");
      mkdirSync(artifactDir);
      const appImagePath = path.join(
        artifactDir,
        "kmux-0.3.12-linux-x64.AppImage"
      );
      const metadataPath = path.join(artifactDir, "latest-linux.yml");
      writeFileSync(appImagePath, "app");
      writeFileSync(
        metadataPath,
        [
          "version: 0.3.12",
          "files:",
          "  - url: kmux-0.3.12-linux-x64.AppImage",
          "    sha512: abc123",
          "    size: 3",
          "path: kmux-0.3.12-linux-x64.AppImage",
          "sha512: abc123"
        ].join("\n")
      );

      expect(findAppImagePath({ searchRoots: [root] })).toBe(appImagePath);
      expect(
        findLinuxUpdateMetadataPath({
          appImagePath,
          searchRoots: [root]
        })
      ).toBe(metadataPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers the host architecture when multiple AppImages are present", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "kmux-linux-smoke-multiarch-")
    );
    try {
      const arm64Dir = path.join(root, "linux-arm64-release-assets");
      const x64Dir = path.join(root, "linux-x64-release-assets");
      mkdirSync(arm64Dir);
      mkdirSync(x64Dir);
      const arm64AppImage = path.join(
        arm64Dir,
        "kmux-0.3.12-linux-arm64.AppImage"
      );
      const x64AppImage = path.join(x64Dir, "kmux-0.3.12-linux-x64.AppImage");
      writeFileSync(arm64AppImage, "");
      writeFileSync(x64AppImage, "");

      expect(
        findAppImagePath({ searchRoots: [root], preferredArch: "x64" })
      ).toBe(x64AppImage);
      expect(
        findAppImagePath({ searchRoots: [root], preferredArch: "arm64" })
      ).toBe(arm64AppImage);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("selects the newest AppImage for the preferred architecture", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-smoke-stale-"));
    try {
      const oldX64AppImage = path.join(root, "kmux-0.3.11-linux-x64.AppImage");
      const newX64AppImage = path.join(root, "kmux-0.3.12-linux-x64.AppImage");
      const newerArm64AppImage = path.join(
        root,
        "kmux-0.3.13-linux-arm64.AppImage"
      );
      writeFileSync(oldX64AppImage, "");
      writeFileSync(newX64AppImage, "");
      writeFileSync(newerArm64AppImage, "");

      utimesSync(oldX64AppImage, new Date(1000), new Date(1000));
      utimesSync(newX64AppImage, new Date(2000), new Date(2000));
      utimesSync(newerArm64AppImage, new Date(3000), new Date(3000));

      expect(
        findAppImagePath({ searchRoots: [root], preferredArch: "x64" })
      ).toBe(newX64AppImage);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers the host architecture across all release roots", () => {
    const arm64Root = mkdtempSync(
      path.join(tmpdir(), "kmux-linux-smoke-arm64-")
    );
    const x64Root = mkdtempSync(path.join(tmpdir(), "kmux-linux-smoke-x64-"));
    try {
      const arm64AppImage = path.join(
        arm64Root,
        "kmux-0.3.12-linux-arm64.AppImage"
      );
      const x64AppImage = path.join(x64Root, "kmux-0.3.12-linux-x64.AppImage");
      writeFileSync(arm64AppImage, "");
      writeFileSync(x64AppImage, "");

      expect(
        findAppImagePath({
          searchRoots: [arm64Root, x64Root],
          preferredArch: "x64"
        })
      ).toBe(x64AppImage);
    } finally {
      rmSync(arm64Root, { recursive: true, force: true });
      rmSync(x64Root, { recursive: true, force: true });
    }
  });

  it("finds arch-specific Linux update metadata for non-x64 AppImages", () => {
    const fixture = createReleaseFixture({ arch: "arm64" });
    try {
      expect(inferLinuxAppImageArch(fixture.appImagePath)).toBe("arm64");
      expect(expectedLinuxUpdateMetadataNames(fixture.appImagePath)).toEqual([
        "latest-linux-arm64.yml",
        "latest-linux-arm64.yaml"
      ]);
      expect(linuxUpdateMetadataCandidates(fixture.appImagePath)).toEqual([
        "latest-linux-arm64.yml",
        "latest-linux.yml",
        "latest-linux-arm64.yaml",
        "latest-linux.yaml"
      ]);
      expect(isLinuxUpdateMetadataName("latest-linux-arm64.yml")).toBe(true);
      expect(
        findLinuxUpdateMetadataPath({
          appImagePath: fixture.appImagePath,
          searchRoots: [fixture.root]
        })
      ).toBe(fixture.metadataPath);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects explicit Linux update metadata paths that are not files", () => {
    const fixture = createReleaseFixture();
    try {
      const metadataDirectory = path.join(fixture.root, "metadata-dir.yml");
      mkdirSync(metadataDirectory);

      expect(() =>
        findLinuxUpdateMetadataPath({
          appImagePath: fixture.appImagePath,
          explicitPath: metadataDirectory
        })
      ).toThrow(/Linux update metadata .* is not a file/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("ignores directory-shaped Linux update metadata candidates", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-smoke-metadir-"));
    try {
      const appImagePath = path.join(root, "kmux-0.3.12-linux-x64.AppImage");
      const metadataDirectory = path.join(root, "latest-linux.yml");
      writeFileSync(appImagePath, "");
      mkdirSync(metadataDirectory);

      expect(() =>
        findLinuxUpdateMetadataPath({
          appImagePath,
          searchRoots: [root]
        })
      ).toThrow(/Could not find latest-linux/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates updater metadata against the packaged AppImage", () => {
    const fixture = createReleaseFixture();
    try {
      const metadata = loadLinuxUpdateMetadata(fixture.metadataPath);
      const appImageSha512 = calculateFileSha512(fixture.appImagePath);

      expect(
        validateLinuxUpdateMetadata(metadata, {
          appImagePath: fixture.appImagePath,
          expectedVersion: "0.3.12",
          metadataPath: fixture.metadataPath
        })
      ).toEqual({
        appImageFilePath: path.basename(fixture.appImagePath),
        appImageFileSha512: appImageSha512,
        appImageFileSize: 3,
        appImageSha512,
        appImageSize: 3,
        topLevelSha512: appImageSha512
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects non-x64 metadata with the generic x64 metadata filename", () => {
    const fixture = createReleaseFixture({ arch: "arm64" });
    try {
      const metadata = loadLinuxUpdateMetadata(fixture.metadataPath);
      const genericMetadataPath = path.join(fixture.root, "latest-linux.yml");

      expect(() =>
        validateLinuxUpdateMetadata(metadata, {
          appImagePath: fixture.appImagePath,
          expectedVersion: "0.3.12",
          metadataPath: genericMetadataPath
        })
      ).toThrow(/channel naming/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("parses and validates AppImage desktop-entry identity", () => {
    const parsed = parseDesktopEntry(
      [
        "# generated by electron-builder",
        "[Desktop Entry]",
        "Name=kmux",
        "GenericName=AI Coding Agent Terminal",
        "Comment=Run coding agents side by side without losing terminal output continuity.",
        "Icon=kmux",
        "Categories=Development;TerminalEmulator;Utility;",
        "StartupWMClass=kmux",
        "StartupNotify=true",
        "Terminal=false",
        "Keywords=AI;agent;terminal;developer;coding;"
      ].join("\n")
    );

    expect(parsed["Desktop Entry"].Name).toBe("kmux");
    expect(normalizeLinuxDesktopEntry(parsed).Name).toBe("kmux");
    expect(() =>
      validateLinuxDesktopEntry(parsed, {
        Name: "kmux",
        GenericName: "AI Coding Agent Terminal",
        Comment:
          "Run coding agents side by side without losing terminal output continuity.",
        Icon: "kmux",
        Categories: "Development;TerminalEmulator;Utility;",
        StartupWMClass: "kmux",
        StartupNotify: "true",
        Terminal: "false",
        Keywords: "AI;agent;terminal;developer;coding;"
      })
    ).not.toThrow();
  });

  it("builds a ledger-friendly packaged smoke preflight summary", () => {
    const fixture = createReleaseFixture();
    try {
      const blockmapPath = `${fixture.appImagePath}.blockmap`;
      writeFileSync(blockmapPath, "map");
      const updateMetadata = loadLinuxUpdateMetadata(fixture.metadataPath);
      const updateMetadataValidation = validateLinuxUpdateMetadata(
        updateMetadata,
        {
          appImagePath: fixture.appImagePath,
          expectedVersion: "0.3.12",
          metadataPath: fixture.metadataPath
        }
      );
      const desktopIdentity = {
        desktopEntry: parseDesktopEntry(
          [
            "[Desktop Entry]",
            "Name=kmux",
            "Icon=kmux",
            "Categories=Development;TerminalEmulator;Utility;",
            "StartupWMClass=kmux",
            "StartupNotify=true",
            "Terminal=false"
          ].join("\n")
        ),
        notificationIconResourcePath: path.join(
          "resources",
          "notificationIcon.png"
        )
      };

      const summary = buildPackagedSmokeSummary({
        appImagePath: fixture.appImagePath,
        updateMetadataPath: fixture.metadataPath,
        updateMetadata,
        desktopIdentity,
        updateMetadataValidation,
        env: {
          APPIMAGE_EXTRACT_AND_RUN: "1",
          PATH: "/usr/bin"
        }
      });
      const diagnosticSummary = buildPackagedSmokeSummary({
        appImagePath: fixture.appImagePath,
        updateMetadataPath: fixture.metadataPath,
        updateMetadata,
        desktopIdentity,
        updateMetadataValidation,
        allowAnyLinuxDesktop: true,
        env: {
          APPIMAGE_EXTRACT_AND_RUN: "1",
          PATH: "/usr/bin"
        }
      });

      expect(summary).toContain("Linux packaged smoke preflight:");
      expect(summary).toContain("Smoke mode: Ubuntu Desktop packaged smoke");
      expect(summary).toContain(
        "Linux release scope: packaged smoke component only; manual updater and desktop-integration observations remain separate."
      );
      expect(diagnosticSummary).toContain(
        "Smoke mode: non-RC diagnostics (--allow-any-linux-desktop)"
      );
      expect(summary).toContain(`AppImage artifact: ${fixture.appImagePath}`);
      expect(summary).toContain("AppImage arch: x64");
      expect(summary).toContain(`AppImage blockmap: ${blockmapPath} (3 bytes)`);
      expect(summary).toContain(`Update metadata: ${fixture.metadataPath}`);
      expect(summary).toContain("Update metadata version: 0.3.12");
      expect(summary).toContain(
        "Update metadata AppImage path: kmux-0.3.12-linux-x64.AppImage"
      );
      expect(summary).toContain(
        "Update metadata AppImage file entry: kmux-0.3.12-linux-x64.AppImage"
      );
      expect(summary).toContain(
        "Update metadata AppImage file size: 3 bytes (matches packaged AppImage size 3 bytes)"
      );
      expect(summary).toContain(
        `Update metadata top-level sha512: ${updateMetadataValidation.topLevelSha512}`
      );
      expect(summary).toContain(
        `Update metadata AppImage file sha512: ${updateMetadataValidation.appImageFileSha512}`
      );
      expect(summary).toContain(
        `Packaged AppImage sha512: ${updateMetadataValidation.appImageSha512}`
      );
      expect(summary).toContain(
        "Update metadata checksum match: top-level, file entry, and packaged AppImage sha512 match"
      );
      expect(summary).toContain(
        "Release visibility/updater install: not validated by packaged smoke; validate updater check/download/install separately before a Linux release."
      );
      expect(summary).toContain(
        "Desktop entry: Name=kmux | Icon=kmux | Categories=Development;TerminalEmulator;Utility; | StartupWMClass=kmux | StartupNotify=true | Terminal=false"
      );
      expect(summary).toContain(
        `Notification icon resource: ${path.join("resources", "notificationIcon.png")}`
      );
      expect(summary).toContain(
        "Notification delivery/window grouping: not validated by packaged smoke; validate Ubuntu notification-center attribution and window grouping separately before a Linux release."
      );
      expect(summary).toContain(`APPIMAGE=${fixture.appImagePath}`);
      expect(summary).toContain("| APPIMAGE_EXTRACT_AND_RUN=1 |");
      expect(summary).toContain(
        `KMUX_PACKAGED_EXECUTABLE_PATH=${fixture.appImagePath}`
      );
      expect(summary).toContain("KMUX_APPIMAGE_RUNTIME_LIBRARY_PATH=<missing>");
      expect(summary).toContain(
        "AppImage launch args: <none>; --no-sandbox not added by smoke wrapper"
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("describes AppImage blockmap sidecars for the packaged smoke summary", () => {
    const fixture = createReleaseFixture();
    try {
      expect(describeAppImageBlockmap(fixture.appImagePath)).toEqual({
        status: "missing",
        path: `${fixture.appImagePath}.blockmap`,
        sizeBytes: null
      });

      writeFileSync(`${fixture.appImagePath}.blockmap`, "blockmap");

      expect(describeAppImageBlockmap(fixture.appImagePath)).toEqual({
        status: "present",
        path: `${fixture.appImagePath}.blockmap`,
        sizeBytes: "blockmap".length
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("requires a non-empty AppImage blockmap sidecar for packaged updater smoke", () => {
    const fixture = createReleaseFixture();
    try {
      expect(() => assertAppImageBlockmapPresent(fixture.appImagePath)).toThrow(
        /blockmap sidecar is required/
      );

      writeFileSync(`${fixture.appImagePath}.blockmap`, "");
      expect(() => assertAppImageBlockmapPresent(fixture.appImagePath)).toThrow(
        /blockmap sidecar must be non-empty/
      );

      writeFileSync(`${fixture.appImagePath}.blockmap`, "blockmap");
      expect(assertAppImageBlockmapPresent(fixture.appImagePath)).toEqual({
        status: "present",
        path: `${fixture.appImagePath}.blockmap`,
        sizeBytes: "blockmap".length
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects directory-shaped AppImage blockmap sidecars", () => {
    const fixture = createReleaseFixture();
    try {
      mkdirSync(`${fixture.appImagePath}.blockmap`);

      expect(() => assertAppImageBlockmapPresent(fixture.appImagePath)).toThrow(
        /got not-file/
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects AppImage desktop entries with mismatched identity", () => {
    const parsed = parseDesktopEntry(
      [
        "[Desktop Entry]",
        "Name=kmux",
        "Icon=kmux",
        "Categories=Development;TerminalEmulator;Utility;",
        "StartupWMClass=wrong"
      ].join("\n")
    );

    expect(() =>
      validateLinuxDesktopEntry(parsed, {
        Name: "kmux",
        Icon: "kmux",
        Categories: "Development;TerminalEmulator;Utility;",
        StartupWMClass: "kmux"
      })
    ).toThrow(/StartupWMClass/);
  });

  it("extracts the AppImage desktop entry before packaged smoke", () => {
    const fixture = createReleaseFixture();
    try {
      const extracted = extractAppImageDesktopEntry({
        appImagePath: fixture.appImagePath,
        runCommand: (command, args, options) => {
          expect(command).toBe(fixture.appImagePath);
          expect(args).toEqual(["--appimage-extract"]);

          const applicationsDir = path.join(
            options.cwd,
            "squashfs-root",
            "usr",
            "share",
            "applications"
          );
          mkdirSync(applicationsDir, { recursive: true });
          const resourcesDir = path.join(
            options.cwd,
            "squashfs-root",
            "resources"
          );
          mkdirSync(resourcesDir, { recursive: true });
          writeFileSync(path.join(resourcesDir, "notificationIcon.png"), "");
          writeFileSync(
            path.join(applicationsDir, "kmux.desktop"),
            [
              "[Desktop Entry]",
              "Name=kmux",
              "Icon=kmux",
              "Categories=Development;TerminalEmulator;Utility;",
              "StartupWMClass=kmux"
            ].join("\n")
          );

          return { status: 0, stdout: "", stderr: "" };
        }
      });

      expect(extracted["Desktop Entry"]).toMatchObject({
        Name: "kmux",
        Icon: "kmux",
        Categories: "Development;TerminalEmulator;Utility;",
        StartupWMClass: "kmux"
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("extracts AppImage desktop identity with the packaged notification icon", () => {
    const fixture = createReleaseFixture();
    try {
      const extracted = extractAppImageDesktopIdentity({
        appImagePath: fixture.appImagePath,
        runCommand: (_command, _args, options) => {
          const applicationsDir = path.join(
            options.cwd,
            "squashfs-root",
            "usr",
            "share",
            "applications"
          );
          const resourcesDir = path.join(
            options.cwd,
            "squashfs-root",
            "resources"
          );
          mkdirSync(applicationsDir, { recursive: true });
          mkdirSync(resourcesDir, { recursive: true });
          writeFileSync(path.join(resourcesDir, "notificationIcon.png"), "");
          writeFileSync(
            path.join(applicationsDir, "kmux.desktop"),
            [
              "[Desktop Entry]",
              "Name=kmux",
              "Icon=kmux",
              "Categories=Development;TerminalEmulator;Utility;",
              "StartupWMClass=kmux"
            ].join("\n")
          );

          return { status: 0, stdout: "", stderr: "" };
        }
      });

      expect(extracted.desktopEntry["Desktop Entry"]).toMatchObject({
        Name: "kmux",
        Icon: "kmux",
        StartupWMClass: "kmux"
      });
      expect(extracted.notificationIconResourcePath).toBe(
        path.join("resources", "notificationIcon.png")
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects extracted AppImages without the packaged notification icon", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-appimage-identity-"));
    try {
      const extractedRoot = path.join(root, "squashfs-root");
      mkdirSync(path.join(extractedRoot, "resources"), { recursive: true });

      expect(() => findExtractedNotificationIconPath(extractedRoot)).toThrow(
        /Notification icon resource/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects metadata that points at a different AppImage", () => {
    const fixture = createReleaseFixture();
    try {
      const metadata = {
        version: "0.3.12",
        files: [{ url: "other.AppImage", sha512: "abc123" }],
        path: "other.AppImage",
        sha512: "abc123"
      };

      expect(() =>
        validateLinuxUpdateMetadata(metadata, {
          appImagePath: fixture.appImagePath,
          expectedVersion: "0.3.12"
        })
      ).toThrow(/packaged AppImage/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects arm64 metadata that points at an x64 AppImage", () => {
    const fixture = createReleaseFixture({ arch: "arm64" });
    try {
      const metadata = {
        version: "0.3.12",
        files: [
          {
            url: "kmux-0.3.12-linux-x64.AppImage",
            sha512: "abc123",
            size: 3
          }
        ],
        path: "kmux-0.3.12-linux-x64.AppImage",
        sha512: "abc123"
      };

      expect(() =>
        validateLinuxUpdateMetadata(metadata, {
          appImagePath: fixture.appImagePath,
          expectedVersion: "0.3.12"
        })
      ).toThrow(/packaged AppImage/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects metadata with inconsistent checksums", () => {
    const fixture = createReleaseFixture();
    try {
      const metadata = {
        version: "0.3.12",
        files: [
          {
            url: "kmux-0.3.12-linux-x64.AppImage",
            sha512: "file-checksum",
            size: 3
          }
        ],
        path: "kmux-0.3.12-linux-x64.AppImage",
        sha512: "top-level-checksum"
      };

      expect(() =>
        validateLinuxUpdateMetadata(metadata, {
          appImagePath: fixture.appImagePath,
          expectedVersion: "0.3.12"
        })
      ).toThrow(/top-level sha512/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects metadata with an AppImage checksum mismatch", () => {
    const fixture = createReleaseFixture();
    try {
      const metadata = {
        version: "0.3.12",
        files: [
          {
            url: "kmux-0.3.12-linux-x64.AppImage",
            sha512: "metadata-checksum",
            size: 3
          }
        ],
        path: "kmux-0.3.12-linux-x64.AppImage",
        sha512: "metadata-checksum"
      };

      expect(() =>
        validateLinuxUpdateMetadata(metadata, {
          appImagePath: fixture.appImagePath,
          expectedVersion: "0.3.12"
        })
      ).toThrow(/packaged AppImage sha512/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects metadata with an AppImage size mismatch", () => {
    const fixture = createReleaseFixture();
    try {
      const metadata = {
        version: "0.3.12",
        files: [
          {
            url: "kmux-0.3.12-linux-x64.AppImage",
            sha512: "abc123",
            size: 42
          }
        ],
        path: "kmux-0.3.12-linux-x64.AppImage",
        sha512: "abc123"
      };

      expect(() =>
        validateLinuxUpdateMetadata(metadata, {
          appImagePath: fixture.appImagePath,
          expectedVersion: "0.3.12"
        })
      ).toThrow(/file size/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects metadata without a numeric AppImage size", () => {
    const fixture = createReleaseFixture();
    try {
      const metadata = {
        version: "0.3.12",
        files: [
          {
            url: "kmux-0.3.12-linux-x64.AppImage",
            sha512: "abc123"
          }
        ],
        path: "kmux-0.3.12-linux-x64.AppImage",
        sha512: "abc123"
      };

      expect(() =>
        validateLinuxUpdateMetadata(metadata, {
          appImagePath: fixture.appImagePath,
          expectedVersion: "0.3.12"
        })
      ).toThrow(/numeric AppImage file size/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("requires Ubuntu Desktop LTS by default", () => {
    expect(() =>
      assertLinuxDesktopEnvironment({
        platform: "linux",
        env: { DISPLAY: ":99", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
        osReleaseText: ubuntuLtsOsRelease
      })
    ).not.toThrow();
    expect(() =>
      assertLinuxDesktopEnvironment({
        platform: "linux",
        env: { DISPLAY: ":99", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
        osReleaseText: "ID=fedora"
      })
    ).toThrow(/Ubuntu Desktop LTS/);
    expect(() =>
      assertLinuxDesktopEnvironment({
        platform: "linux",
        env: {},
        osReleaseText: ubuntuLtsOsRelease
      })
    ).toThrow(/Ubuntu Desktop session/);
    expect(() =>
      assertLinuxDesktopEnvironment({
        platform: "darwin",
        env: { DISPLAY: ":99", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
        osReleaseText: ubuntuLtsOsRelease
      })
    ).toThrow(/only runs on Linux/);
    expect(() =>
      assertLinuxDesktopEnvironment({
        platform: "darwin",
        env: { DISPLAY: ":99", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
        osReleaseText: ubuntuLtsOsRelease
      })
    ).toThrow(/Linux desktop target unavailable on this host/);
    expect(() =>
      assertLinuxDesktopEnvironment({
        platform: "linux",
        env: { DISPLAY: ":99" },
        osReleaseText: ubuntuLtsOsRelease
      })
    ).toThrow(/Ubuntu Desktop session/);
  });

  it("allows explicit non-RC smoke diagnostics on other Linux desktops", () => {
    expect(() =>
      assertLinuxDesktopEnvironment({
        platform: "linux",
        env: { DISPLAY: ":99" },
        osReleaseText: "ID=fedora",
        allowAnyLinuxDesktop: true
      })
    ).not.toThrow();
    expect(() =>
      assertLinuxDesktopEnvironment({
        platform: "linux",
        env: {},
        osReleaseText: "ID=fedora",
        allowAnyLinuxDesktop: true
      })
    ).toThrow(/desktop session/);
  });

  it("passes AppImage runtime env to the packaged smoke app launch", () => {
    const env = buildPackagedSmokeEnv({
      appImagePath: "/tmp/kmux-0.3.12-linux-x64.AppImage",
      env: {
        PATH: "/usr/bin",
        APPIMAGE: "/tmp/stale.AppImage"
      }
    });

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      APPIMAGE: "/tmp/kmux-0.3.12-linux-x64.AppImage",
      APPIMAGE_EXTRACT_AND_RUN: "1",
      KMUX_PACKAGED_EXECUTABLE_PATH: "/tmp/kmux-0.3.12-linux-x64.AppImage"
    });
  });

  it("finds a versioned libz runtime candidate for AppImage compatibility", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-libz-"));
    try {
      const libzPath = path.join(root, "libz.so.1");
      writeFileSync(libzPath, "");

      expect(findVersionedLibzPath({ candidatePaths: [libzPath] })).toBe(
        libzPath
      );
      expect(
        findVersionedLibzPath({
          candidatePaths: [path.join(root, "missing-libz.so.1")]
        })
      ).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adds a temporary libz.so compatibility path for AppImage runtime probes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-appimage-env-"));
    try {
      const libzPath = path.join(root, "libz.so.1");
      const compatibilityDir = path.join(root, "compat");
      writeFileSync(libzPath, "");

      const env = buildAppImageRuntimeEnv({
        env: { LD_LIBRARY_PATH: "/existing" },
        compatibilityDir,
        versionedLibzPath: libzPath
      });

      expect(env.LD_LIBRARY_PATH).toBe(`${compatibilityDir}:/existing`);
      expect(env.KMUX_APPIMAGE_RUNTIME_LIBRARY_PATH).toBe(compatibilityDir);
      expect(statSync(path.join(compatibilityDir, "libz.so")).isFile()).toBe(
        true
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves an explicit AppImage extraction mode override", () => {
    expect(
      buildPackagedSmokeEnv({
        appImagePath: "/tmp/kmux.AppImage",
        env: {
          APPIMAGE_EXTRACT_AND_RUN: "0"
        }
      }).APPIMAGE_EXTRACT_AND_RUN
    ).toBe("0");
  });

  it("throws when no AppImage exists in the release roots", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-smoke-empty-"));
    try {
      mkdirSync(path.join(root, "nested"));
      expect(() => findAppImagePath({ searchRoots: [root] })).toThrow(
        /Could not find a packaged AppImage/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

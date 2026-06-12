import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertLinuxReleaseCheckTarget,
  assertLinuxReleaseCandidatePassed,
  assertLinuxPublicPublishingGate,
  currentGitDirtyState,
  extractLinuxReleasePassedRecordedEvidenceEntries,
  extractLinuxReleasePassedRecordedEvidence,
  extractLinuxReleaseMarkdownSection,
  extractLinuxReleaseRecordedEvidence,
  isLinuxReleaseCandidatePassed,
  isLinuxReleaseAssetName,
  listLinuxReleaseAssets,
  linuxReleaseCurrentStatus,
  linuxReleaseIncompleteRequiredEvidenceRows,
  linuxReleaseMissingRequiredEvidenceRows,
  linuxReleaseRequiredEvidenceHasNotYetRun,
  linuxReleaseRequiredEvidenceSectionsPresent,
  linuxReleaseCandidatePlaceholderEvidence,
  linuxReleaseMacCompatibilityEvidenceCaveats,
  linuxReleaseMacCompatibilityEvidenceEntry,
  linuxReleasePrimaryRcEvidenceCaveats,
  linuxReleasePrimaryRcEvidenceEntry,
  linuxReleaseRcEvidenceFieldFailures,
  missingLinuxReleaseCandidateEvidence,
  parseArgs,
  parseLinuxReleaseEvidenceEntryFields,
  parseOsRelease,
  requiredLinuxReleaseCandidateEvidenceLabels,
  requiredLinuxReleaseStatusRowLabels,
  workflowAllowsLinuxPublicUploads,
  workflowRunsLinuxPublicGateBeforeReleasePublish
} from "./release-check-linux.mjs";

function sha512Base64(value) {
  return createHash("sha512").update(value).digest("base64");
}

function writeValidLinuxReleaseAssets(root, options = {}) {
  const appImageName =
    options.appImageName ?? "kmux-0.3.12-linux-x64.AppImage";
  const metadataName = options.metadataName ?? "latest-linux.yml";
  const appImageContent = options.appImageContent ?? "appimage";
  const appImageSha512 = sha512Base64(appImageContent);
  const writeAsset = (assetName, content) => {
    mkdirSync(path.dirname(path.join(root, assetName)), { recursive: true });
    writeFileSync(path.join(root, assetName), content);
  };

  writeAsset(appImageName, appImageContent);
  writeAsset(`${appImageName}.blockmap`, options.blockmapContent ?? "blockmap");
  writeAsset(
    metadataName,
    [
      "version: 0.3.12",
      `path: ${appImageName}`,
      `sha512: ${appImageSha512}`,
      "files:",
      `  - url: ${appImageName}`,
      `    sha512: ${appImageSha512}`,
      `    size: ${Buffer.byteLength(appImageContent)}`
    ].join("\n")
  );
}

describe("linux release check", () => {
  const markerLoopTimeoutMs = 30_000;
  const markerLoopIt = (name, callback) =>
    it(name, callback, markerLoopTimeoutMs);
  const passedRcNotes =
    "Notes: GUI launch opened a normal window from the recorded launch path and screenshot/run log. Terminal launch and GUI launch resolved shell env, and CLI plus desktop used the same POSIX socket. PATH recovery passed for the GUI-launched app shell env with nvm, pyenv, cargo, ~/.local/bin, and installed agent CLIs observed. node-pty spawned shells in dev and packaged AppImage builds through ShellLaunchPolicy with AppImage sandbox env and user-namespace settings recorded. Hook runtime env in pty sessions included KMUX_SOCKET_PATH, KMUX_AGENT_BIN_DIR, and KMUX_NODE_PATH. Codex, Claude, Gemini, and Antigravity hooks notified when installed and configured with per-agent hook logs and UI notification evidence. Codex wrapper worked with shell rc integration disabled in a targeted Codex wrapper run. External session discovery and resume passed for verified vendor roots tied to agent storage roots. Usage history and subscription usage passed with verified credential source, recorded storage-root evidence, and dashboard evidence. Missing credentials showed normal unavailable/disconnected states with recorded missing credential paths. Usage/subscription subprocesses made no macOS security command calls, and Linux subprocess audit recorded platform-specific script probing args, script command availability, parsed ps process-table rows, and bounded lsof listening-socket samples. Filesystem watch/resync passed: missed events still produced eventual usage and external-session refresh, with inotify limit diagnostics recorded. AppImage updater check, download, and install passed with electron-updater using latest-linux.yml metadata; channel naming, release visibility, and the AppImage blockmap sidecar matched intended policy; top-level sha512, AppImage file-entry sha512, actual AppImage sha512, and size consistency matched the packaged AppImage. AppImage provenance recorded Git dirty state, APPIMAGE env behavior, and selected AppImage artifact path. AppImage startup passed with sandbox and user-namespace settings recorded; --no-sandbox was not needed. AppImage extracted desktop entry app name, icon, categories, StartupWMClass=kmux, installed desktop-entry candidate evidence, and resources/notificationIcon.png notification icon resource output matched. Runtime and packaged identity alignment matched app id, app name, executable name, desktop entry Name, and StartupWMClass=kmux. Desktop notification title/body/icon app attribution and Ubuntu notification center/window grouping matched the kmux window, tied to recorded DBus/session and desktop-entry facts. Native window chrome passed on Ubuntu Desktop with X11/Wayland notes tied to recorded desktop shell/display and GPU renderer probes, resize, and compositor observations. Shortcut policy passed against terminal input and GNOME defaults with keyboard smoke notes tied to recorded GNOME keybinding probes. Terminal font loaded and cell metrics stayed stable with fc-list font inventory and xterm observations. IME/input-method smoke passed where ibus or fcitx validation was available with IME environment, input notes, and terminal input unaffected. Split pane, surface switch, restore, foreground resize, and readable agent output continuity passed. User and release docs covered Linux baseline, unsupported scope, AppImage updater behavior, and unavailable credential states. Validation matrix covered Ubuntu Desktop LTS GUI launcher, terminal launch, packaged AppImage, dev build, X11 session where available, and Wayland session where available. macOS compatibility evidence remains green.";
  const passedRcValidation = [
    "# Linux Release Validation",
    "",
    "Current status: passed.",
    "",
    "## Required Evidence",
    "",
    "| Requirement | Evidence to record | Status |",
    "| --- | --- | --- |",
    "| GUI-launched app opens a window on Ubuntu Desktop LTS | release log | Complete |",
    "| Terminal-launched app and GUI-launched app resolve socket and shell env correctly | gate output plus shell env notes | Complete |",
    "| CLI and desktop use the same POSIX socket resolver | gate output | Complete |",
    "| GUI-launched app shell env recovers PATH tools and installed agent CLIs | GUI-launched app shell env PATH recovery for nvm, pyenv, cargo, ~/.local/bin, and installed agent CLIs | Complete |",
    "| `node-pty` spawns shells in dev and packaged AppImage builds | dev gate and packaged smoke output | Complete |",
    "| `KMUX_SOCKET_PATH`, `KMUX_AGENT_BIN_DIR`, and `KMUX_NODE_PATH` are visible in pty sessions | hook env evidence | Complete |",
    "| Codex, Claude, Gemini, and Antigravity hooks notify when installed and configured | per-agent hook logs plus UI notification evidence | Complete |",
    "| Codex wrapper works with shell rc integration disabled | walking-skeleton or targeted Codex wrapper run | Complete |",
    "| External session discovery and resume work for verified vendor roots | vendor fixture/run notes | Complete |",
    "| Usage history works | usage dashboard evidence tied to recorded Linux storage roots | Complete |",
    "| Subscription usage works for authenticated providers whose Linux credential source was verified | provider credential source, recorded storage-root evidence, and dashboard evidence | Complete |",
    "| Missing credentials show normal disconnected/unavailable states | screenshots or logs for signed-out providers plus recorded missing credential paths | Complete |",
    "| Usage/subscription subprocesses do not invoke macOS-only commands on Linux | run logs or targeted tests showing no security usage plus parsed ps rows and bounded lsof listening-socket samples | Complete |",
    "| AppImage updater works with Linux update metadata | visibility, check, download, and install evidence | Complete |",
    "| Generated AppImage desktop entry contains app name, icon, categories, `StartupWMClass=kmux`, notification icon resource, and runtime/packaged identity alignment | smoke output plus runtime identity alignment report | Complete |",
    "| Desktop notifications show correct app name/icon and group with the app window | notification center/window grouping evidence | Complete |",
    "| Native window chrome works on Ubuntu Desktop | X11/Wayland notes | Complete |",
    "| Shortcut policy works against terminal input and GNOME defaults | keyboard smoke notes plus terminal input check tied to recorded GNOME keybinding probes | Complete |",
    "| Terminal font loads and cell metrics remain stable | terminal cell-metric check | Complete |",
    "| Restore, split panes, surface switching, foreground resize, and readable agent output continuity remain stable | walking-skeleton and packaged smoke readable agent output continuity evidence | Complete |",
    "| Linux IME/input-method smoke passes where ibus or fcitx validation is available | IME environment and input notes | Complete |",
    "| Filesystem watches can miss events without breaking eventual usage/external-session refresh | refresh notes and inotify diagnostics | Complete |",
    "| User and release docs describe Linux baseline, unsupported scope, AppImage updater behavior, and unavailable credential states | docs | Complete |",
    "| macOS compatibility tests and packaged smoke remain valid | release:check:mac output | Passed |",
    "",
    "## Recorded Evidence",
    "",
    "Date: 2026-06-10",
    "Commit: abc1234",
    "Git dirty: no",
    "Environment: Ubuntu Desktop 24.04.2 LTS, XDG_CURRENT_DESKTOP=ubuntu:GNOME, XDG_SESSION_TYPE=wayland",
    "Artifact: apps/desktop/release/kmux-0.3.12-linux-x64.AppImage",
    "Commands: npm run gate:walking-skeleton:linux; npm run package:linux; npm run smoke:packaged:linux; npm run release:check:linux; npm run release:evidence:linux -- --output docs/plans/linux-rc-evidence-2026-06-10.md; npm run release:check:mac",
    "Result: Passed.",
    passedRcNotes,
    "Remaining blockers: none",
    "",
    "## Environment Matrix",
    "",
    "| Environment | Required focus | Status |",
    "| --- | --- | --- |",
    "| Ubuntu Desktop LTS, GUI launcher | window launch and desktop integration | Complete |",
    "| Ubuntu Desktop LTS, terminal launch | socket and shell env | Complete |",
    "| Ubuntu Desktop LTS, packaged AppImage | desktop integration | Complete |",
    "| Ubuntu Desktop LTS, dev build | platform runtime and shared resolver | Complete |",
    "| X11 session where available | window frame and resize stability | Complete |",
    "| Wayland session where available | compositor stability and notifications | Complete |"
  ].join("\n");

  it("keeps Linux package scripts non-publishing by default", () => {
    const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
    const desktopPackage = JSON.parse(
      readFileSync("apps/desktop/package.json", "utf8")
    );
    const developmentDocs = readFileSync("docs/development.md", "utf8");
    const linuxDesktopDocs = readFileSync("docs/linux-desktop.md", "utf8");
    const linuxArchitectureDecision = readFileSync(
      "docs/adr/0004-linux-platform-support-and-os-neutral-architecture.md",
      "utf8"
    );

    expect(rootPackage.scripts["package:linux"]).toContain("dist:linux");
    expect(rootPackage.scripts["smoke:packaged:linux"]).toBe(
      "node scripts/smoke-packaged-linux.mjs"
    );
    expect(rootPackage.scripts["release:check:linux"]).toBe(
      "node scripts/release-check-linux.mjs --require-ubuntu-desktop && npm run gate:walking-skeleton:linux && npm run package:linux && npm run smoke:packaged:linux && node scripts/release-check-linux.mjs"
    );
    expect(desktopPackage.scripts["dist:linux"]).toBe(
      "electron-builder --config electron-builder.yml --linux AppImage --publish never"
    );
    for (const docs of [
      developmentDocs,
      linuxDesktopDocs,
      linuxArchitectureDecision
    ]) {
      expect(docs).toContain("release:check:linux");
      expect(docs).toContain("gate:walking-skeleton:linux");
      expect(docs).toContain("package:linux");
      expect(docs).toContain("smoke:packaged:linux");
    }
  });

  it("parses release check preflight arguments", () => {
    expect(parseArgs(["--require-ubuntu-desktop"])).toEqual({
      requireUbuntuDesktop: true
    });
    expect(parseArgs([])).toEqual({
      requireUbuntuDesktop: false
    });
  });

  it("rejects unknown release check preflight arguments", () => {
    expect(() => parseArgs(["--allow-any-platform"])).toThrow(
      /unknown release:check:linux argument/
    );
  });

  it("detects Ubuntu LTS from os-release text", () => {
    expect(
      parseOsRelease(
        [
          'PRETTY_NAME="Ubuntu 24.04.2 LTS"',
          'VERSION="24.04.2 LTS (Noble Numbat)"',
          "ID=ubuntu"
        ].join("\n")
      )
    ).toMatchObject({
      id: "ubuntu",
      prettyName: "Ubuntu 24.04.2 LTS",
      isUbuntuLts: true
    });
    expect(
      parseOsRelease(
        [
          'PRETTY_NAME="Fedora Linux 40 (Workstation Edition)"',
          "ID=fedora"
        ].join("\n")
      )
    ).toMatchObject({
      id: "fedora",
      isUbuntuLts: false
    });
  });

  it("requires Ubuntu Desktop LTS only for the explicit RC preflight mode", () => {
    const ubuntuLts = [
      'PRETTY_NAME="Ubuntu 24.04.2 LTS"',
      'VERSION="24.04.2 LTS (Noble Numbat)"',
      "ID=ubuntu"
    ].join("\n");

    expect(() =>
      assertLinuxReleaseCheckTarget({
        platform: "linux",
        requireUbuntuDesktop: false,
        env: {},
        osReleaseText: ""
      })
    ).not.toThrow();
    expect(() =>
      assertLinuxReleaseCheckTarget({
        platform: "linux",
        requireUbuntuDesktop: true,
        env: { DISPLAY: ":0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
        osReleaseText: ubuntuLts
      })
    ).not.toThrow();
    expect(() =>
      assertLinuxReleaseCheckTarget({
        platform: "linux",
        requireUbuntuDesktop: true,
        env: { DISPLAY: ":0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
        osReleaseText: [
          'PRETTY_NAME="Fedora Linux 40 (Workstation Edition)"',
          "ID=fedora"
        ].join("\n")
      })
    ).toThrow(/Ubuntu Desktop LTS/);
    expect(() =>
      assertLinuxReleaseCheckTarget({
        platform: "linux",
        requireUbuntuDesktop: true,
        env: {},
        osReleaseText: ubuntuLts
      })
    ).toThrow(/DISPLAY or WAYLAND_DISPLAY/);
    expect(() =>
      assertLinuxReleaseCheckTarget({
        platform: "darwin"
      })
    ).toThrow(/must run on Linux/);
    expect(() =>
      assertLinuxReleaseCheckTarget({
        platform: "darwin"
      })
    ).toThrow(/RC evidence: no on this host/);
  });

  it("identifies Linux release artifacts", () => {
    expect(isLinuxReleaseAssetName("kmux-0.3.12-linux-x64.AppImage")).toBe(
      true
    );
    expect(isLinuxReleaseAssetName("kmux.AppImage.blockmap")).toBe(true);
    expect(isLinuxReleaseAssetName("latest.yml")).toBe(true);
    expect(isLinuxReleaseAssetName("latest.yaml")).toBe(true);
    expect(isLinuxReleaseAssetName(path.join("internal-build", "latest.yml")))
      .toBe(true);
    expect(isLinuxReleaseAssetName("latest-linux.yml")).toBe(true);
    expect(isLinuxReleaseAssetName("latest-linux-arm64.yml")).toBe(true);
    expect(isLinuxReleaseAssetName("kmux-0.3.12-mac-arm64.dmg")).toBe(false);
    expect(isLinuxReleaseAssetName("kmux-0.3.12-mac.zip.blockmap")).toBe(
      false
    );
    expect(isLinuxReleaseAssetName("latest-mac.yml")).toBe(false);
  });

  it("checks current source dirtiness without treating release artifacts as source changes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-release-source-"));
    try {
      execFileSync("git", ["init"], {
        cwd: root,
        stdio: ["ignore", "ignore", "ignore"]
      });
      mkdirSync(path.join(root, "release-assets"));
      mkdirSync(path.join(root, "apps", "desktop", "release"), {
        recursive: true
      });
      writeFileSync(path.join(root, "release-assets", "kmux-mac-x64.dmg"), "");
      writeFileSync(
        path.join(root, "apps", "desktop", "release", "kmux-linux.AppImage"),
        ""
      );

      expect(currentGitDirtyState({ cwd: root })).toBe("no");

      writeFileSync(path.join(root, "source-change.ts"), "export {};\n");

      expect(currentGitDirtyState({ cwd: root })).toBe("yes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects Linux assets in the public release upload directory while gated", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-release-gate-"));
    try {
      writeFileSync(path.join(root, "latest-linux.yml"), "");
      writeFileSync(path.join(root, "latest.yml"), "");
      writeFileSync(path.join(root, "kmux-0.3.12-linux-x64.AppImage"), "");
      writeFileSync(path.join(root, "kmux.AppImage.blockmap"), "");
      mkdirSync(path.join(root, "internal-build"));
      mkdirSync(path.join(root, "linux-x64-release-assets"));
      mkdirSync(path.join(root, "macos-x64-release-assets"));
      writeFileSync(path.join(root, "internal-build", "latest.yml"), "");
      writeFileSync(
        path.join(
          root,
          "linux-x64-release-assets",
          "kmux-0.3.12-linux-x64.AppImage"
        ),
        ""
      );
      writeFileSync(
        path.join(root, "linux-x64-release-assets", "latest-linux.yml"),
        ""
      );
      writeFileSync(
        path.join(root, "linux-x64-release-assets", "latest.yml"),
        ""
      );
      writeFileSync(
        path.join(root, "macos-x64-release-assets", "latest-mac.yml"),
        ""
      );

      expect(listLinuxReleaseAssets(root)).toEqual([
        path.join("internal-build", "latest.yml"),
        "kmux-0.3.12-linux-x64.AppImage",
        "kmux.AppImage.blockmap",
        "latest-linux.yml",
        "latest.yml",
        path.join(
          "linux-x64-release-assets",
          "kmux-0.3.12-linux-x64.AppImage"
        ),
        path.join("linux-x64-release-assets", "latest-linux.yml"),
        path.join("linux-x64-release-assets", "latest.yml")
      ]);
      expect(() =>
        assertLinuxPublicPublishingGate({
          env: {},
          assetsDir: root,
          workflowText: ""
        })
      ).toThrow(/Linux public release publishing is gated/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects workflow uploads that include Linux assets while gated", () => {
    expect(
      workflowAllowsLinuxPublicUploads(
        [
          "assets=(",
          "  release-assets/*.dmg",
          "  release-assets/*.AppImage",
          ")"
        ].join("\n")
      )
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads("assets=(release-assets/kmux.AppImage)")
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads(
        "assets=(release-assets/kmux.AppImage.blockmap)"
      )
    ).toBe(true);
    for (const artifactPath of [
      "files: dist/kmux-x64.AppImage",
      "assets=(artifacts/kmux-x64.AppImage.blockmap)",
      "path: build/kmux.deb",
      "files: artifacts/kmux.rpm",
      "assets=(dist/kmux.snap)",
      "path: internal/kmux.flatpak"
    ]) {
      expect(workflowAllowsLinuxPublicUploads(artifactPath)).toBe(true);
    }
    for (const publishCommand of [
      "run: electron-builder --config electron-builder.yml --linux AppImage --publish always",
      "run: electron-builder --config electron-builder.yml --linux AppImage",
      [
        "run: |",
        "  electron-builder \\",
        "    --config electron-builder.yml \\",
        "    --publish=onTagOrDraft \\",
        "    --linux AppImage"
      ].join("\n"),
      [
        "run: |",
        "  electron-builder \\",
        "    --config electron-builder.yml \\",
        "    --linux AppImage"
      ].join("\n"),
      "run: npm run dist:linux --workspace @kmux/desktop -- --publish onTag"
    ]) {
      expect(workflowAllowsLinuxPublicUploads(publishCommand)).toBe(true);
    }
    expect(
      workflowAllowsLinuxPublicUploads(
        "run: electron-builder --config electron-builder.yml --linux AppImage --publish never"
      )
    ).toBe(false);
    expect(
      workflowAllowsLinuxPublicUploads(
        "run: npm run dist:linux --workspace @kmux/desktop -- --publish never"
      )
    ).toBe(false);
    for (const extension of ["deb", "rpm", "snap", "flatpak"]) {
      expect(
        workflowAllowsLinuxPublicUploads(
          `assets=(release-assets/*.${extension})`
        )
      ).toBe(true);
      expect(
        workflowAllowsLinuxPublicUploads(
          `assets=(release-assets/internal-build/kmux.${extension})`
        )
      ).toBe(true);
    }
    expect(
      workflowAllowsLinuxPublicUploads(
        "assets=(release-assets/internal-build/kmux.AppImage)"
      )
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads(
        "assets=(release-assets/internal-build/kmux.AppImage.blockmap)"
      )
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads("assets=(release-assets/*linux*)")
    ).toBe(true);
    expect(workflowAllowsLinuxPublicUploads("assets=(release-assets/*)")).toBe(
      true
    );
    expect(
      workflowAllowsLinuxPublicUploads("assets=(release-assets/*.blockmap)")
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads("assets=(release-assets/*.yml)")
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads("assets=(release-assets/latest.yml)")
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads("assets=(release-assets/latest.yaml)")
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads(
        "assets=(release-assets/internal-build/latest.yml)"
      )
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads(
        "assets=(release-assets/internal-build/latest.yaml)"
      )
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads("assets=(release-assets/latest*.yml)")
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads("assets=(release-assets/latest-*.yml)")
    ).toBe(true);
    expect(workflowAllowsLinuxPublicUploads("name: linux-release-assets")).toBe(
      true
    );
    expect(
      workflowAllowsLinuxPublicUploads("name: linux-x64-release-assets")
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads("name: release-assets-linux-x64")
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads("pattern: linux-*-release-assets")
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads("pattern: release-assets-linux-*")
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads('pattern: "*linux*release-assets"')
    ).toBe(true);
    expect(workflowAllowsLinuxPublicUploads('pattern: "*-release-assets"'))
      .toBe(true);
    expect(workflowAllowsLinuxPublicUploads("pattern: release-assets-*")).toBe(
      true
    );
    expect(
      workflowAllowsLinuxPublicUploads('pattern: "macos-*-release-assets"')
    ).toBe(false);
    expect(
      workflowAllowsLinuxPublicUploads(
        "assets=(release-assets/kmux-0.3.12-mac.zip.blockmap)"
      )
    ).toBe(false);
    expect(
      workflowAllowsLinuxPublicUploads(
        "path: apps/desktop/release/*.AppImage"
      )
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads(
        "path: apps/desktop/release/kmux.AppImage"
      )
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads(
        "path: apps/desktop/release/kmux.AppImage.blockmap"
      )
    ).toBe(true);
    for (const extension of ["deb", "rpm", "snap", "flatpak"]) {
      expect(
        workflowAllowsLinuxPublicUploads(
          `path: apps/desktop/release/*.${extension}`
        )
      ).toBe(true);
      expect(
        workflowAllowsLinuxPublicUploads(
          `path: apps/desktop/release/internal-build/kmux.${extension}`
        )
      ).toBe(true);
    }
    expect(
      workflowAllowsLinuxPublicUploads(
        "path: apps/desktop/release/internal-build/kmux.AppImage.blockmap"
      )
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads(
        "path: apps/desktop/release/kmux-0.3.12-mac.zip.blockmap"
      )
    ).toBe(false);
    expect(
      workflowAllowsLinuxPublicUploads("path: apps/desktop/release/*")
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads("path: apps/desktop/release/*.blockmap")
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads("path: apps/desktop/release/**")
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads("path: apps/desktop/release/**/*")
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads(
        "path: apps/desktop/release/latest-linux.yml"
      )
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads("path: apps/desktop/release/*.yml")
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads("path: apps/desktop/release/latest.yml")
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads("path: apps/desktop/release/latest.yaml")
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads(
        "path: apps/desktop/release/internal-build/latest.yml"
      )
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads(
        "path: apps/desktop/release/internal-build/latest.yaml"
      )
    ).toBe(true);
    expect(
      workflowAllowsLinuxPublicUploads(
        "path: apps/desktop/release/kmux-0.3.12-linux-x64.AppImage"
      )
    ).toBe(true);
    expect(() =>
      assertLinuxPublicPublishingGate({
        env: {},
        assetsDir: "/tmp/kmux-missing-release-assets",
        workflowText: "assets=(release-assets/*.AppImage)"
      })
    ).toThrow(/release workflow appears to upload Linux artifacts/);
  });

  it("allows the current macOS-only public release workflow while gated", () => {
    expect(
      assertLinuxPublicPublishingGate({
        env: {},
        assetsDir: "/tmp/kmux-missing-release-assets",
        workflowText: [
          "assets=(",
          "  name: macos-${{ matrix.arch }}-release-assets",
          "  pattern: macos-*-release-assets",
          "  release-assets/*.dmg",
          "  release-assets/*.zip",
          "  release-assets/latest*-mac.yml",
          "  release-assets/kmux-*-mac-${arch}.dmg",
          "  apps/desktop/release/*.dmg",
          "  apps/desktop/release/*.zip",
          "  apps/desktop/release/latest*-mac.yml",
          ")"
        ].join("\n")
      })
    ).toEqual({
      enabled: false,
      linuxAssets: []
    });
  });

  it("requires the Linux public release gate before GitHub release publishing", () => {
    expect(
      workflowRunsLinuxPublicGateBeforeReleasePublish(
        [
          "- name: Verify Linux public release gate",
          "  run: node scripts/release-check-linux.mjs",
          "- name: Publish GitHub release",
          "  run: gh release create \"$GITHUB_REF_NAME\" release-assets/*.dmg"
        ].join("\n")
      )
    ).toBe(true);
    expect(
      workflowRunsLinuxPublicGateBeforeReleasePublish(
        [
          "- name: Verify Linux public release gate",
          "  run: node scripts/release-check-linux.mjs",
          "- name: Publish GitHub release draft",
          "  run: gh release edit \"$GITHUB_REF_NAME\" --draft=false"
        ].join("\n")
      )
    ).toBe(true);
    expect(
      workflowRunsLinuxPublicGateBeforeReleasePublish(
        [
          "- name: Publish GitHub release",
          "  run: gh release upload \"$GITHUB_REF_NAME\" release-assets/*.dmg",
          "- name: Verify Linux public release gate",
          "  run: node scripts/release-check-linux.mjs"
        ].join("\n")
      )
    ).toBe(false);
    expect(
      workflowRunsLinuxPublicGateBeforeReleasePublish(
        [
          "- name: Publish GitHub release draft",
          "  run: gh release edit \"$GITHUB_REF_NAME\" --draft=false",
          "- name: Verify Linux public release gate",
          "  run: node scripts/release-check-linux.mjs"
        ].join("\n")
      )
    ).toBe(false);
    expect(
      workflowRunsLinuxPublicGateBeforeReleasePublish(
        [
          "- name: Verify Linux public release gate",
          "  run: node scripts/release-check-linux.mjs",
          "- name: Publish GitHub release",
          "  uses: softprops/action-gh-release@v2",
          "  with:",
          "    files: release-assets/*.dmg"
        ].join("\n")
      )
    ).toBe(true);
    for (const releaseAction of [
      "softprops/action-gh-release@v2",
      "ncipollo/release-action@v1",
      "actions/upload-release-asset@v1",
      "actions/create-release@v1"
    ]) {
      expect(
        workflowRunsLinuxPublicGateBeforeReleasePublish(
          [
            "- name: Publish GitHub release",
            `  uses: ${releaseAction}`,
            "  with:",
            "    files: release-assets/*.dmg",
            "- name: Verify Linux public release gate",
            "  run: node scripts/release-check-linux.mjs"
          ].join("\n")
        )
      ).toBe(false);
    }
    expect(
      workflowRunsLinuxPublicGateBeforeReleasePublish(
        "- name: Publish GitHub release\n  run: gh release create \"$GITHUB_REF_NAME\" release-assets/*.dmg"
      )
    ).toBe(false);
    expect(
      workflowRunsLinuxPublicGateBeforeReleasePublish(
        "- name: Publish GitHub release draft\n  run: gh release edit \"$GITHUB_REF_NAME\" --draft=false"
      )
    ).toBe(false);
    expect(workflowRunsLinuxPublicGateBeforeReleasePublish("npm run lint")).toBe(
      true
    );

    expect(() =>
      assertLinuxPublicPublishingGate({
        env: {},
        assetsDir: "/tmp/kmux-missing-release-assets",
        workflowText: [
          "- name: Publish GitHub release",
          "  run: gh release create \"$GITHUB_REF_NAME\" release-assets/*.dmg",
          "- name: Verify Linux public release gate",
          "  run: node scripts/release-check-linux.mjs"
        ].join("\n")
      })
    ).toThrow(/does not run the Linux public release gate before publishing/);
    expect(() =>
      assertLinuxPublicPublishingGate({
        env: {},
        assetsDir: "/tmp/kmux-missing-release-assets",
        workflowText: [
          "- name: Publish GitHub release",
          "  uses: softprops/action-gh-release@v2",
          "  with:",
          "    files: release-assets/*.dmg",
          "- name: Verify Linux public release gate",
          "  run: node scripts/release-check-linux.mjs"
        ].join("\n")
      })
    ).toThrow(/does not run the Linux public release gate before publishing/);
  });

  it("keeps the checked-in release workflow macOS-only while Linux is gated", () => {
    const workflowText = readFileSync(
      ".github/workflows/release-desktop.yml",
      "utf8"
    );

    expect(workflowText).toContain("node scripts/release-check-linux.mjs");
    expect(workflowRunsLinuxPublicGateBeforeReleasePublish(workflowText)).toBe(
      true
    );
    expect(
      assertLinuxPublicPublishingGate({
        env: {},
        assetsDir: "/tmp/kmux-missing-release-assets",
        workflowText
      })
    ).toEqual({
      enabled: false,
      linuxAssets: []
    });
  });

  it("requires the stable RC ledger before public Linux publishing can be enabled", () => {
    const currentRcValidation = readFileSync(
      "docs/linux-release-validation.md",
      "utf8"
    );

    expect(isLinuxReleaseCandidatePassed(currentRcValidation)).toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(currentRcValidation)
    ).toThrow(/stable RC ledger has not passed/);
    expect(
      missingLinuxReleaseCandidateEvidence(currentRcValidation)
    ).toContain("Ubuntu Desktop environment");
    expect(isLinuxReleaseCandidatePassed(passedRcValidation)).toBe(true);
    expect(() =>
      assertLinuxReleaseCandidatePassed(passedRcValidation)
    ).not.toThrow();
  });

  it("requires AppImage blockmap sidecar evidence for the updater marker", () => {
    const ledgerWithoutBlockmapEvidence = passedRcValidation.replace(
      "channel naming, release visibility, and the AppImage blockmap sidecar matched intended policy",
      "channel naming and release visibility matched intended policy"
    );

    expect(
      missingLinuxReleaseCandidateEvidence(ledgerWithoutBlockmapEvidence)
    ).toContain("AppImage updater evidence");
    expect(linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutBlockmapEvidence))
      .toBe("");
    expect(isLinuxReleaseCandidatePassed(ledgerWithoutBlockmapEvidence))
      .toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithoutBlockmapEvidence)
    ).toThrow(/AppImage updater evidence/);
  });

  it("rejects passed updater evidence that says the AppImage blockmap sidecar was missing", () => {
    const ledgerWithMissingBlockmapEvidence = passedRcValidation.replace(
      "channel naming, release visibility, and the AppImage blockmap sidecar matched intended policy",
      "channel naming, release visibility, and the AppImage blockmap sidecar was missing"
    );

    expect(
      missingLinuxReleaseCandidateEvidence(ledgerWithMissingBlockmapEvidence)
    ).not.toContain("AppImage updater evidence");
    expect(
      linuxReleasePrimaryRcEvidenceCaveats(ledgerWithMissingBlockmapEvidence)
    ).toEqual([
      "Notes: GUI launch opened a normal window from the recorded launch path and screenshot/run log. Terminal launch and GUI launch resolved shell env, and CLI plus desktop used the same POSIX socket. PATH recovery passed for the GUI-launched app shell env with nvm, pyenv, cargo, ~/.local/bin, and installed agent CLIs observed. node-pty spawned shells in dev and packaged AppImage builds through ShellLaunchPolicy with AppImage sandbox env and user-namespace settings recorded. Hook runtime env in pty sessions included KMUX_SOCKET_PATH, KMUX_AGENT_BIN_DIR, and KMUX_NODE_PATH. Codex, Claude, Gemini, and Antigravity hooks notified when installed and configured with per-agent hook logs and UI notification evidence. Codex wrapper worked with shell rc integration disabled in a targeted Codex wrapper run. External session discovery and resume passed for verified vendor roots tied to agent storage roots. Usage history and subscription usage passed with verified credential source, recorded storage-root evidence, and dashboard evidence. Missing credentials showed normal unavailable/disconnected states with recorded missing credential paths. Usage/subscription subprocesses made no macOS security command calls, and Linux subprocess audit recorded platform-specific script probing args, script command availability, parsed ps process-table rows, and bounded lsof listening-socket samples. Filesystem watch/resync passed: missed events still produced eventual usage and external-session refresh, with inotify limit diagnostics recorded. AppImage updater check, download, and install passed with electron-updater using latest-linux.yml metadata; channel naming, release visibility, and the AppImage blockmap sidecar was missing; top-level sha512, AppImage file-entry sha512, actual AppImage sha512, and size consistency matched the packaged AppImage. AppImage provenance recorded Git dirty state, APPIMAGE env behavior, and selected AppImage artifact path. AppImage startup passed with sandbox and user-namespace settings recorded; --no-sandbox was not needed. AppImage extracted desktop entry app name, icon, categories, StartupWMClass=kmux, installed desktop-entry candidate evidence, and resources/notificationIcon.png notification icon resource output matched. Runtime and packaged identity alignment matched app id, app name, executable name, desktop entry Name, and StartupWMClass=kmux. Desktop notification title/body/icon app attribution and Ubuntu notification center/window grouping matched the kmux window, tied to recorded DBus/session and desktop-entry facts. Native window chrome passed on Ubuntu Desktop with X11/Wayland notes tied to recorded desktop shell/display and GPU renderer probes, resize, and compositor observations. Shortcut policy passed against terminal input and GNOME defaults with keyboard smoke notes tied to recorded GNOME keybinding probes. Terminal font loaded and cell metrics stayed stable with fc-list font inventory and xterm observations. IME/input-method smoke passed where ibus or fcitx validation was available with IME environment, input notes, and terminal input unaffected. Split pane, surface switch, restore, foreground resize, and readable agent output continuity passed. User and release docs covered Linux baseline, unsupported scope, AppImage updater behavior, and unavailable credential states. Validation matrix covered Ubuntu Desktop LTS GUI launcher, terminal launch, packaged AppImage, dev build, X11 session where available, and Wayland session where available. macOS compatibility evidence remains green."
    ]);
    expect(isLinuxReleaseCandidatePassed(ledgerWithMissingBlockmapEvidence))
      .toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithMissingBlockmapEvidence)
    ).toThrow(/incomplete, failed, unconfirmed, mismatched/);
  });

  it("requires the RC environment marker to include Ubuntu Desktop LTS", () => {
    const ledgerWithoutLtsEnvironment = passedRcValidation.replace(
      "Environment: Ubuntu Desktop 24.04.2 LTS, XDG_CURRENT_DESKTOP=ubuntu:GNOME, XDG_SESSION_TYPE=wayland",
      "Environment: Ubuntu Desktop 24.04.2, XDG_CURRENT_DESKTOP=ubuntu:GNOME, XDG_SESSION_TYPE=wayland"
    );

    expect(
      missingLinuxReleaseCandidateEvidence(ledgerWithoutLtsEnvironment)
    ).toContain("Ubuntu Desktop environment");
    expect(
      linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutLtsEnvironment)
    ).toBe("");
    expect(isLinuxReleaseCandidatePassed(ledgerWithoutLtsEnvironment)).toBe(
      false
    );
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithoutLtsEnvironment)
    ).toThrow(/Ubuntu Desktop environment/);
  });

  it("requires the RC environment marker to include Ubuntu Desktop session env", () => {
    const ledgerWithoutSessionEnvironment = passedRcValidation.replace(
      "Environment: Ubuntu Desktop 24.04.2 LTS, XDG_CURRENT_DESKTOP=ubuntu:GNOME, XDG_SESSION_TYPE=wayland",
      "Environment: Ubuntu Desktop 24.04.2 LTS, GNOME Wayland"
    );

    expect(
      missingLinuxReleaseCandidateEvidence(ledgerWithoutSessionEnvironment)
    ).toContain("Ubuntu Desktop environment");
    expect(
      linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutSessionEnvironment)
    ).toBe("");
    expect(isLinuxReleaseCandidatePassed(ledgerWithoutSessionEnvironment)).toBe(
      false
    );
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithoutSessionEnvironment)
    ).toThrow(/Ubuntu Desktop environment/);
  });

  it("rejects negated Ubuntu Desktop LTS environment evidence", () => {
    const ledgerWithNegatedLtsEnvironment = passedRcValidation.replace(
      "Environment: Ubuntu Desktop 24.04.2 LTS, XDG_CURRENT_DESKTOP=ubuntu:GNOME, XDG_SESSION_TYPE=wayland",
      "Environment: Ubuntu Desktop 24.04.2, not LTS, XDG_CURRENT_DESKTOP=ubuntu:GNOME, XDG_SESSION_TYPE=wayland"
    );

    expect(
      missingLinuxReleaseCandidateEvidence(ledgerWithNegatedLtsEnvironment)
    ).not.toContain("Ubuntu Desktop environment");
    expect(
      linuxReleasePrimaryRcEvidenceCaveats(ledgerWithNegatedLtsEnvironment)
    ).toEqual([
      "Environment: Ubuntu Desktop 24.04.2, not LTS, XDG_CURRENT_DESKTOP=ubuntu:GNOME, XDG_SESSION_TYPE=wayland"
    ]);
    expect(isLinuxReleaseCandidatePassed(ledgerWithNegatedLtsEnvironment)).toBe(
      false
    );
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithNegatedLtsEnvironment)
    ).toThrow(
      /incomplete, failed, unconfirmed, mismatched, target-negating, non-RC, or script-development-only evidence text/
    );
  });

  it("rejects suffixed Linux command markers in passed RC evidence", () => {
    const ledgerWithSuffixedLinuxCommands = passedRcValidation
      .replace(
        "npm run gate:walking-skeleton:linux",
        "npm run gate:walking-skeleton:linux-old"
      )
      .replace(
        "npm run smoke:packaged:linux",
        "npm run smoke:packaged:linux-old"
      )
      .replace(
        "npm run release:check:linux",
        "npm run release:check:linux-old"
      )
      .replace(
        "npm run release:evidence:linux -- --output",
        "npm run release:evidence:linux-old -- --output"
      );

    expect(
      missingLinuxReleaseCandidateEvidence(ledgerWithSuffixedLinuxCommands)
    ).toEqual([
      "walking skeleton Linux gate command",
      "packaged Linux smoke command",
      "Linux release check command",
      "Linux evidence command"
    ]);
    expect(
      linuxReleasePrimaryRcEvidenceEntry(ledgerWithSuffixedLinuxCommands)
    ).toBe("");
    expect(
      isLinuxReleaseCandidatePassed(ledgerWithSuffixedLinuxCommands)
    ).toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithSuffixedLinuxCommands)
    ).toThrow(/walking skeleton Linux gate command/);
  });

  it("requires passed RC evidence to record the Linux package command", () => {
    const ledgerWithoutPackageCommand = passedRcValidation.replace(
      "npm run package:linux",
      "npm run package:linux-old"
    );

    expect(
      missingLinuxReleaseCandidateEvidence(ledgerWithoutPackageCommand)
    ).toEqual(["Linux package command"]);
    expect(linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutPackageCommand))
      .toBe("");
    expect(isLinuxReleaseCandidatePassed(ledgerWithoutPackageCommand))
      .toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithoutPackageCommand)
    ).toThrow(/Linux package command/);
  });

  it("rejects bare script-name command markers in passed RC evidence", () => {
    const ledgerWithBareCommandNames = passedRcValidation.replace(
      "Commands: npm run gate:walking-skeleton:linux; npm run package:linux; npm run smoke:packaged:linux; npm run release:check:linux; npm run release:evidence:linux -- --output docs/plans/linux-rc-evidence-2026-06-10.md; npm run release:check:mac",
      "Commands: gate:walking-skeleton:linux; package:linux; smoke:packaged:linux; release:check:linux; release:evidence:linux; release:check:mac"
    );

    expect(
      missingLinuxReleaseCandidateEvidence(ledgerWithBareCommandNames)
    ).toEqual([
      "walking skeleton Linux gate command",
      "Linux package command",
      "packaged Linux smoke command",
      "Linux release check command",
      "Linux evidence command",
      "macOS release check command"
    ]);
    expect(
      linuxReleasePrimaryRcEvidenceEntry(ledgerWithBareCommandNames)
    ).toBe("");
    expect(
      linuxReleaseMacCompatibilityEvidenceEntry(ledgerWithBareCommandNames)
    ).toBe("");
    expect(isLinuxReleaseCandidatePassed(ledgerWithBareCommandNames))
      .toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithBareCommandNames)
    ).toThrow(/walking skeleton Linux gate command/);
  });

  it("requires macOS compatibility evidence to include the release check command", () => {
    const ledgerWithMacCompatibilityNoteOnly = passedRcValidation.replace(
      "npm run release:check:mac",
      "npm run test:mac-compatibility"
    );

    expect(
      linuxReleasePrimaryRcEvidenceEntry(ledgerWithMacCompatibilityNoteOnly)
    )
      .toContain("Environment: Ubuntu Desktop");
    expect(
      missingLinuxReleaseCandidateEvidence(ledgerWithMacCompatibilityNoteOnly)
    )
      .toEqual(["macOS release check command"]);
    expect(isLinuxReleaseCandidatePassed(ledgerWithMacCompatibilityNoteOnly))
      .toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithMacCompatibilityNoteOnly)
    ).toThrow(/macOS release check command/);
  });

  it("rejects suffixed macOS release-check command markers", () => {
    const ledgerWithSuffixedMacCommand = passedRcValidation.replace(
      "npm run release:check:mac",
      "npm run release:check:mac-old"
    );

    expect(linuxReleasePrimaryRcEvidenceEntry(ledgerWithSuffixedMacCommand))
      .toContain("Environment: Ubuntu Desktop");
    expect(
      missingLinuxReleaseCandidateEvidence(ledgerWithSuffixedMacCommand)
    ).toEqual(["macOS release check command"]);
    expect(
      linuxReleaseMacCompatibilityEvidenceEntry(ledgerWithSuffixedMacCommand)
    ).toBe("");
    expect(isLinuxReleaseCandidatePassed(ledgerWithSuffixedMacCommand))
      .toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithSuffixedMacCommand)
    ).toThrow(/macOS release check command/);
  });

  it("requires macOS compatibility note and release check command in one passed entry", () => {
    const ledgerWithScatteredMacCompatibility = passedRcValidation
      .replace("npm run release:check:mac", "npm run test:mac-compatibility")
      .replace(
        "\n## Environment Matrix",
        [
          "",
          "Date: 2026-06-10",
          "Environment: macOS Darwin 25.5.0",
          "Commands: npm run release:check:mac",
          "Result: Passed.",
          "Notes: Darwin package smoke remained green.",
          "",
          "## Environment Matrix"
        ].join("\n")
      );

    expect(
      missingLinuxReleaseCandidateEvidence(ledgerWithScatteredMacCompatibility)
    ).toEqual([]);
    expect(
      linuxReleaseMacCompatibilityEvidenceEntry(
        ledgerWithScatteredMacCompatibility
      )
    ).toBe("");
    expect(isLinuxReleaseCandidatePassed(ledgerWithScatteredMacCompatibility))
      .toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithScatteredMacCompatibility)
    ).toThrow(/must include both `release:check:mac`/);
  });

  it("rejects macOS compatibility evidence with failed or unverified observations", () => {
    const ledgerWithCaveatedMacCompatibility = passedRcValidation
      .replace("npm run release:check:mac", "npm run test:mac-compatibility")
      .replace(
        "macOS compatibility evidence remains green.",
        "Darwin package smoke reference is recorded separately."
      )
      .replace(
        "\n## Environment Matrix",
        [
          "",
          "Date: 2026-06-10",
          "Environment: macOS Darwin 25.5.0",
          "Commands: npm run release:check:mac",
          "Result: Passed.",
          "Notes: macOS compatibility failed and remains unverified.",
          "",
          "## Environment Matrix"
        ].join("\n")
      );

    expect(
      missingLinuxReleaseCandidateEvidence(ledgerWithCaveatedMacCompatibility)
    ).toEqual([]);
    expect(
      linuxReleaseMacCompatibilityEvidenceEntry(
        ledgerWithCaveatedMacCompatibility
      )
    ).toContain("Commands: npm run release:check:mac");
    expect(
      linuxReleaseMacCompatibilityEvidenceCaveats(
        ledgerWithCaveatedMacCompatibility
      )
    ).toEqual([
      "Notes: macOS compatibility failed and remains unverified."
    ]);
    expect(isLinuxReleaseCandidatePassed(ledgerWithCaveatedMacCompatibility))
      .toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithCaveatedMacCompatibility)
    ).toThrow(/macOS compatibility RC evidence/);
  });

  it("uses the first current status line as the RC status", () => {
    const ledgerWithStaleTopStatus = passedRcValidation
      .replace("Current status: passed.", "Current status: not passed.")
      .replace(
        "\n## Environment Matrix",
        "\nCurrent status: passed.\n\n## Environment Matrix"
      );

    expect(linuxReleaseCurrentStatus(ledgerWithStaleTopStatus)).toBe(
      "not passed."
    );
    expect(missingLinuxReleaseCandidateEvidence(ledgerWithStaleTopStatus))
      .toEqual([]);
    expect(linuxReleasePrimaryRcEvidenceEntry(ledgerWithStaleTopStatus))
      .toContain("Environment: Ubuntu Desktop");
    expect(isLinuxReleaseCandidatePassed(ledgerWithStaleTopStatus)).toBe(
      false
    );
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithStaleTopStatus)
    ).toThrow(/stable RC ledger has not passed/);
  });

  it("checks required RC evidence only inside the Recorded Evidence section", () => {
    const ledgerWithInstructionalMarkers = [
      "# Linux Release Validation",
      "",
      "Current status: passed.",
      "",
      "## Recorded Evidence",
      "",
      "Date: 2026-06-10",
      "Result: Passed.",
      "",
      "## Evidence Entry Template",
      "",
      "Environment: Ubuntu Desktop 24.04.2 LTS, XDG_CURRENT_DESKTOP=ubuntu:GNOME, XDG_SESSION_TYPE=wayland",
      "Artifact: apps/desktop/release/kmux-0.3.12-linux-x64.AppImage",
      "Commands: npm run gate:walking-skeleton:linux; npm run smoke:packaged:linux; npm run release:check:linux; npm run release:evidence:linux",
      "Notes: AppImage updater download and install passed. Desktop notification window grouping passed. Output continuity passed. macOS compatibility evidence remains green."
    ].join("\n");

    expect(
      extractLinuxReleaseRecordedEvidence(ledgerWithInstructionalMarkers)
    ).not.toContain("Environment: Ubuntu Desktop");
    expect(isLinuxReleaseCandidatePassed(ledgerWithInstructionalMarkers)).toBe(
      false
    );
    expect(
      missingLinuxReleaseCandidateEvidence(ledgerWithInstructionalMarkers)
    ).toEqual([
      "Ubuntu Desktop environment",
      "AppImage artifact",
      "walking skeleton Linux gate command",
      "Linux package command",
      "packaged Linux smoke command",
      "Linux release check command",
      "Linux evidence command",
      "launch/socket shell env evidence",
      "PATH recovery evidence",
      "node-pty spawn evidence",
      "hook runtime env evidence",
      "agent hook notification evidence",
      "Codex wrapper evidence",
      "agent workflow evidence",
      "filesystem watch/resync evidence",
      "AppImage updater evidence",
      "AppImage provenance/env evidence",
      "AppImage startup/sandbox evidence",
      "AppImage desktop entry evidence",
      "notification/window grouping evidence",
      "native window chrome evidence",
      "shortcut policy evidence",
      "terminal font/cell metrics evidence",
      "IME/input-method evidence",
      "output continuity evidence",
      "Linux docs evidence",
      "validation matrix evidence",
      "macOS compatibility evidence",
      "macOS release check command"
    ]);
  });

  it("checks required RC markers against the intended evidence fields", () => {
    const ledgerWithWrongFieldMarkers = [
      "# Linux Release Validation",
      "",
      "Current status: passed.",
      "",
      "## Required Evidence",
      "",
      "| Requirement | Evidence to record | Status |",
      "| --- | --- | --- |",
      "| GUI-launched app opens a window on Ubuntu Desktop LTS | release log | Complete |",
      "",
      "## Recorded Evidence",
      "",
      "Date: 2026-06-10",
      "Environment: AppImage artifact and gate:walking-skeleton:linux command were mentioned here, not in the command field.",
      "Artifact: Ubuntu Desktop 24.04.2 LTS was mentioned here, not in the environment field.",
      "Commands: AppImage updater download install; notification window grouping; output continuity; macOS compatibility",
      "Result: Passed.",
      "Notes: npm run gate:walking-skeleton:linux; npm run smoke:packaged:linux; npm run release:check:linux; npm run release:evidence:linux; apps/desktop/release/kmux-0.3.12-linux-x64.AppImage",
      "",
      "## Environment Matrix",
      "",
      "| Environment | Required focus | Status |",
      "| --- | --- | --- |",
      "| Ubuntu Desktop LTS, packaged AppImage | desktop integration | Complete |"
    ].join("\n");

    expect(
      parseLinuxReleaseEvidenceEntryFields(
        extractLinuxReleasePassedRecordedEvidenceEntries(
          ledgerWithWrongFieldMarkers
        )[0]
      )
    ).toMatchObject({
      Commands:
        "AppImage updater download install; notification window grouping; output continuity; macOS compatibility"
    });
    expect(missingLinuxReleaseCandidateEvidence(ledgerWithWrongFieldMarkers))
      .toEqual([
        "Ubuntu Desktop environment",
        "AppImage artifact",
        "walking skeleton Linux gate command",
        "Linux package command",
        "packaged Linux smoke command",
        "Linux release check command",
        "Linux evidence command",
        "launch/socket shell env evidence",
        "PATH recovery evidence",
        "node-pty spawn evidence",
        "hook runtime env evidence",
        "agent hook notification evidence",
        "Codex wrapper evidence",
        "agent workflow evidence",
        "filesystem watch/resync evidence",
        "AppImage updater evidence",
        "AppImage provenance/env evidence",
        "AppImage startup/sandbox evidence",
        "AppImage desktop entry evidence",
        "notification/window grouping evidence",
        "native window chrome evidence",
        "shortcut policy evidence",
        "terminal font/cell metrics evidence",
        "IME/input-method evidence",
        "output continuity evidence",
        "Linux docs evidence",
        "validation matrix evidence",
        "macOS compatibility evidence",
        "macOS release check command"
      ]);
  });

  it("requires Linux RC markers to be tied to one passed Ubuntu AppImage entry", () => {
    const ledgerWithScatteredLinuxEvidence = [
      "# Linux Release Validation",
      "",
      "Current status: passed.",
      "",
      "## Required Evidence",
      "",
      "| Requirement | Evidence to record | Status |",
      "| --- | --- | --- |",
      "| GUI-launched app opens a window on Ubuntu Desktop LTS | release log | Complete |",
      "",
      "## Recorded Evidence",
      "",
      "Date: 2026-06-10",
      "Environment: Ubuntu Desktop 24.04.2 LTS, XDG_CURRENT_DESKTOP=ubuntu:GNOME, XDG_SESSION_TYPE=wayland",
      "Artifact: apps/desktop/release/kmux-0.3.12-linux-x64.AppImage",
      "Commands: npm run gate:walking-skeleton:linux; npm run package:linux; npm run smoke:packaged:linux; npm run release:check:linux; npm run release:evidence:linux",
      "Result: Passed.",
      "Notes: AppImage artifact and command collection passed, but updater and notification observations are not in this entry.",
      "",
      "Date: 2026-06-10",
      "Environment: Ubuntu Desktop 24.04.2 LTS, XDG_CURRENT_DESKTOP=ubuntu:GNOME, XDG_SESSION_TYPE=wayland",
      "Artifact: apps/desktop/release/kmux-0.3.12-linux-x64.AppImage",
      "Commands: npm run smoke:packaged:linux",
      "Result: Passed.",
      "Notes: GUI launch opened a normal window from the recorded launch path and screenshot/run log. Terminal launch and GUI launch resolved shell env, and CLI plus desktop used the same POSIX socket. PATH recovery passed for the GUI-launched app shell env with nvm, pyenv, cargo, ~/.local/bin, and installed agent CLIs observed. node-pty spawned shells in dev and packaged AppImage builds through ShellLaunchPolicy with AppImage sandbox env and user-namespace settings recorded. Hook runtime env in pty sessions included KMUX_SOCKET_PATH, KMUX_AGENT_BIN_DIR, and KMUX_NODE_PATH. Codex, Claude, Gemini, and Antigravity hooks notified when installed and configured with per-agent hook logs and UI notification evidence. Codex wrapper worked with shell rc integration disabled in a targeted Codex wrapper run. External session discovery and resume passed for verified vendor roots tied to agent storage roots. Usage history and subscription usage passed with verified credential source, recorded storage-root evidence, and dashboard evidence. Missing credentials showed normal unavailable/disconnected states with recorded missing credential paths. Usage/subscription subprocesses made no macOS security command calls, and Linux subprocess audit recorded platform-specific script probing args, script command availability, parsed ps process-table rows, and bounded lsof listening-socket samples. Filesystem watch/resync passed: missed events still produced eventual usage and external-session refresh, with inotify limit diagnostics recorded. AppImage updater check/download/install passed with latest-linux.yml metadata, channel naming, release visibility, AppImage blockmap sidecar, top-level sha512, AppImage file-entry sha512, actual AppImage sha512, and size consistency. AppImage provenance recorded Git dirty state, APPIMAGE env behavior, and selected AppImage artifact path. AppImage startup passed with sandbox and user-namespace settings recorded; --no-sandbox was not needed. AppImage extracted desktop entry app name, icon, categories, StartupWMClass=kmux, installed desktop-entry candidate evidence, and resources/notificationIcon.png notification icon resource output matched. Runtime and packaged identity alignment matched app id, app name, executable name, desktop entry Name, and StartupWMClass=kmux. Desktop notification title/body/icon app attribution and Ubuntu notification center/window grouping passed, tied to recorded DBus/session and desktop-entry facts. Native window chrome passed on Ubuntu Desktop with X11/Wayland notes tied to recorded desktop shell/display and GPU renderer probes, resize, and compositor observations. Shortcut policy passed against terminal input and GNOME defaults with keyboard smoke notes tied to recorded GNOME keybinding probes. Terminal font loaded and cell metrics stayed stable with fc-list font inventory and xterm observations. IME/input-method smoke passed where ibus or fcitx validation was available with IME environment, input notes, and terminal input unaffected. Split pane, surface switch, restore, foreground resize, and readable agent output continuity passed. User and release docs covered Linux baseline, unsupported scope, AppImage updater behavior, and unavailable credential states. Validation matrix covered Ubuntu Desktop LTS GUI launcher, terminal launch, packaged AppImage, dev build, X11 session where available, and Wayland session where available.",
      "",
      "Date: 2026-06-10",
      "Environment: macOS Darwin 25.5.0",
      "Commands: npm run release:check:mac",
      "Result: Passed.",
      "Notes: macOS compatibility evidence remains green.",
      "",
      "## Environment Matrix",
      "",
      "| Environment | Required focus | Status |",
      "| --- | --- | --- |",
      "| Ubuntu Desktop LTS, packaged AppImage | desktop integration | Complete |"
    ].join("\n");

    expect(missingLinuxReleaseCandidateEvidence(ledgerWithScatteredLinuxEvidence))
      .toEqual([]);
    expect(linuxReleasePrimaryRcEvidenceEntry(ledgerWithScatteredLinuxEvidence))
      .toBe("");
    expect(isLinuxReleaseCandidatePassed(ledgerWithScatteredLinuxEvidence)).toBe(
      false
    );
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithScatteredLinuxEvidence)
    ).toThrow(/one passed Ubuntu Desktop\/AppImage evidence entry/i);
  });

  it("keeps required not-yet-run status scoped to requirement sections", () => {
    const ledgerWithHistoricalFailedAttempt = passedRcValidation.replace(
      "\n## Environment Matrix",
      [
        "",
        "Date: 2026-06-09",
        "Environment: Ubuntu Desktop 24.04.2 LTS, XDG_CURRENT_DESKTOP=ubuntu:GNOME, XDG_SESSION_TYPE=wayland",
        "Artifact: apps/desktop/release/kmux-0.3.12-linux-x64.AppImage",
        "Commands: npm run smoke:packaged:linux",
        "Result: Failed.",
        "Notes: Historical failed attempt was not passed and follow-up was not yet run at that time.",
        "",
        "## Environment Matrix"
      ].join("\n")
    );

    expect(
      linuxReleaseRequiredEvidenceHasNotYetRun(
        ledgerWithHistoricalFailedAttempt
      )
    ).toBe(false);
    expect(isLinuxReleaseCandidatePassed(ledgerWithHistoricalFailedAttempt)).toBe(
      true
    );
  });

  it("rejects RC ledgers whose required evidence rows still say not yet run", () => {
    const ledgerWithRequiredGap = [
      "# Linux Release Validation",
      "",
      "Current status: passed.",
      "",
      "## Required Evidence",
      "",
      "| Requirement | Evidence to record | Status |",
      "| --- | --- | --- |",
      "| GUI-launched app opens a window on Ubuntu Desktop LTS | release log | Manual, not yet run |",
      "",
      "## Recorded Evidence",
      "",
      passedRcValidation.split("## Recorded Evidence\n\n")[1]
    ].join("\n");

    expect(
      extractLinuxReleaseMarkdownSection(
        ledgerWithRequiredGap,
        "Required Evidence"
      )
    ).toContain("not yet run");
    expect(linuxReleaseRequiredEvidenceHasNotYetRun(ledgerWithRequiredGap)).toBe(
      true
    );
    expect(isLinuxReleaseCandidatePassed(ledgerWithRequiredGap)).toBe(false);
    expect(() => assertLinuxReleaseCandidatePassed(ledgerWithRequiredGap)).toThrow(
      /not yet run/
    );
  });

  it("rejects RC ledgers whose current requirement rows are not complete or passed", () => {
    const ledgerWithSkippedCurrentRows = passedRcValidation
      .replace(
        "| GUI-launched app opens a window on Ubuntu Desktop LTS | release log | Complete |",
        "| GUI-launched app opens a window on Ubuntu Desktop LTS | release log | Not complete |"
      )
      .replace(
        "| CLI and desktop use the same POSIX socket resolver | gate output | Complete |",
        "| CLI and desktop use the same POSIX socket resolver | gate output | Almost complete |"
      )
      .replace(
        "| Ubuntu Desktop LTS, packaged AppImage | desktop integration | Complete |",
        "| Ubuntu Desktop LTS, packaged AppImage | desktop integration | Pending follow-up |"
      );

    expect(
      linuxReleaseRequiredEvidenceHasNotYetRun(ledgerWithSkippedCurrentRows)
    ).toBe(false);
    expect(missingLinuxReleaseCandidateEvidence(ledgerWithSkippedCurrentRows))
      .toEqual([]);
    expect(
      linuxReleaseIncompleteRequiredEvidenceRows(ledgerWithSkippedCurrentRows)
    ).toEqual([
      "Required Evidence: GUI-launched app opens a window on Ubuntu Desktop LTS -> Not complete",
      "Required Evidence: CLI and desktop use the same POSIX socket resolver -> Almost complete",
      "Environment Matrix: Ubuntu Desktop LTS, packaged AppImage -> Pending follow-up"
    ]);
    expect(isLinuxReleaseCandidatePassed(ledgerWithSkippedCurrentRows)).toBe(
      false
    );
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithSkippedCurrentRows)
    ).toThrow(/must be marked complete or passed/);
  });

  it("rejects RC ledgers whose complete or passed rows still have caveats", () => {
    const ledgerWithCaveatedRows = passedRcValidation
      .replace(
        "| Terminal-launched app and GUI-launched app resolve socket and shell env correctly | gate output plus shell env notes | Complete |",
        "| Terminal-launched app and GUI-launched app resolve socket and shell env correctly | gate output plus shell env notes | Complete, but GUI launch evidence missing |"
      )
      .replace(
        "| Subscription usage works for authenticated providers whose Linux credential source was verified | provider credential source, recorded storage-root evidence, and dashboard evidence | Complete |",
        "| Subscription usage works for authenticated providers whose Linux credential source was verified | provider credential source, recorded storage-root evidence, and dashboard evidence | Passed, unknown credential source |"
      )
      .replace(
        "| Wayland session where available | compositor stability and notifications | Complete |",
        "| Wayland session where available | compositor stability and notifications | Complete except notification grouping |"
      );

    expect(
      linuxReleaseRequiredEvidenceHasNotYetRun(ledgerWithCaveatedRows)
    ).toBe(false);
    expect(
      linuxReleaseIncompleteRequiredEvidenceRows(ledgerWithCaveatedRows)
    ).toEqual([
      "Required Evidence: Terminal-launched app and GUI-launched app resolve socket and shell env correctly -> Complete, but GUI launch evidence missing",
      "Required Evidence: Subscription usage works for authenticated providers whose Linux credential source was verified -> Passed, unknown credential source",
      "Environment Matrix: Wayland session where available -> Complete except notification grouping"
    ]);
    expect(isLinuxReleaseCandidatePassed(ledgerWithCaveatedRows)).toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithCaveatedRows)
    ).toThrow(/without incomplete caveats/);
  });

  it("rejects complete or passed row statuses that still contain placeholders", () => {
    const currentRcValidation = readFileSync(
      "docs/linux-release-validation.md",
      "utf8"
    );
    const ledgerWithPlaceholderRows = passedRcValidation
      .replace(
        "| AppImage updater works with Linux update metadata | visibility, check, download, and install evidence | Complete |",
        "| AppImage updater works with Linux update metadata | visibility, check, download, and install evidence | Complete <fill after updater validation> |"
      )
      .replace(
        "| Ubuntu Desktop LTS, terminal launch | socket and shell env | Complete |",
        "| Ubuntu Desktop LTS, terminal launch | socket and shell env | Passed placeholder |"
      );

    expect(
      linuxReleaseIncompleteRequiredEvidenceRows(ledgerWithPlaceholderRows)
    ).toEqual([
      "Required Evidence: AppImage updater works with Linux update metadata -> Complete <fill after updater validation>",
      "Environment Matrix: Ubuntu Desktop LTS, terminal launch -> Passed placeholder"
    ]);
    expect(isLinuxReleaseCandidatePassed(ledgerWithPlaceholderRows)).toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithPlaceholderRows)
    ).toThrow(/without incomplete caveats/);
    expect(currentRcValidation).toContain("placeholder, `<...>`");
  });

  it("rejects complete or passed row statuses that describe non-RC diagnostics", () => {
    const caveatedStatuses = [
      "Complete, non-RC diagnostics",
      "Passed, diagnostics only",
      "Passed, diagnostics-only",
      "Complete, script-development report-shape",
      "Passed, simulated updater validation",
      "Complete, mocked notification validation",
      "Passed, stubbed output continuity validation",
      "Complete, dry-run updater validation",
      "Passed, xvfb startup smoke",
      "Complete, headless AppImage smoke",
      "Passed, fixture-only evidence",
      "Complete, checksum mismatch",
      "Passed, size inconsistent",
      "Complete, file-entry sha512 did not match actual AppImage sha512",
      "Passed, checksum differs",
      "Complete, sha512 not equal",
      "Passed, sha512 not-equal",
      "Complete, release visibility not checked",
      "Passed, channel naming unconfirmed",
      "Complete, window grouping not observed"
    ];

    for (const caveatedStatus of caveatedStatuses) {
      const ledgerWithCaveatedStatus = passedRcValidation.replace(
        "| AppImage updater works with Linux update metadata | visibility, check, download, and install evidence | Complete |",
        `| AppImage updater works with Linux update metadata | visibility, check, download, and install evidence | ${caveatedStatus} |`
      );

      expect(
        linuxReleaseIncompleteRequiredEvidenceRows(ledgerWithCaveatedStatus)
      ).toEqual([
        `Required Evidence: AppImage updater works with Linux update metadata -> ${caveatedStatus}`
      ]);
      expect(isLinuxReleaseCandidatePassed(ledgerWithCaveatedStatus)).toBe(
        false
      );
      expect(() =>
        assertLinuxReleaseCandidatePassed(ledgerWithCaveatedStatus)
      ).toThrow(/without incomplete caveats/);
    }
  });

  it("rejects RC ledgers with deleted required evidence rows", () => {
    const ledgerWithDeletedRows = passedRcValidation
      .replace(
        "| GUI-launched app shell env recovers PATH tools and installed agent CLIs | GUI-launched app shell env PATH recovery for nvm, pyenv, cargo, ~/.local/bin, and installed agent CLIs | Complete |\n",
        ""
      )
      .replace(
        "| Wayland session where available | compositor stability and notifications | Complete |",
        ""
      );

    expect(
      linuxReleaseIncompleteRequiredEvidenceRows(ledgerWithDeletedRows)
    ).toEqual([]);
    expect(missingLinuxReleaseCandidateEvidence(ledgerWithDeletedRows)).toEqual(
      []
    );
    expect(linuxReleaseMissingRequiredEvidenceRows(ledgerWithDeletedRows))
      .toEqual([
        "Required Evidence: GUI-launched app shell env recovers PATH tools and installed agent CLIs",
        "Environment Matrix: Wayland session where available"
      ]);
    expect(isLinuxReleaseCandidatePassed(ledgerWithDeletedRows)).toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithDeletedRows)
    ).toThrow(/rows are missing/);
  });

  it("rejects RC ledgers missing required validation sections", () => {
    const ledgerWithoutRequiredSections = passedRcValidation.replace(
      /## Required Evidence[\s\S]*?## Recorded Evidence\n\n/,
      "## Recorded Evidence\n\n"
    );

    expect(
      linuxReleaseRequiredEvidenceSectionsPresent(
        ledgerWithoutRequiredSections
      )
    ).toBe(false);
    expect(isLinuxReleaseCandidatePassed(ledgerWithoutRequiredSections)).toBe(
      false
    );
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithoutRequiredSections)
    ).toThrow(/Required Evidence/);
  });

  it("ignores failed Recorded Evidence entries when checking RC markers", () => {
    const ledgerWithFailedLinuxEvidence = [
      "# Linux Release Validation",
      "",
      "Current status: passed.",
      "",
      "## Recorded Evidence",
      "",
      "Date: 2026-06-10",
      "Environment: Ubuntu Desktop 24.04.2 LTS, XDG_CURRENT_DESKTOP=ubuntu:GNOME, XDG_SESSION_TYPE=wayland",
      "Artifact: apps/desktop/release/kmux-0.3.12-linux-x64.AppImage",
      "Commands: npm run gate:walking-skeleton:linux; npm run smoke:packaged:linux; npm run release:check:linux; npm run release:evidence:linux",
      "Result: Failed.",
      "Notes: AppImage updater download and install failed. Desktop notification window grouping failed. Output continuity failed.",
      "",
      "Date: 2026-06-10",
      "Environment: macOS Darwin 25.5.0",
      "Commands: npm run release:check:mac",
      "Result: Passed.",
      "Notes: macOS compatibility evidence remains green.",
      "",
      "## Environment Matrix"
    ].join("\n");

    expect(
      extractLinuxReleaseRecordedEvidence(ledgerWithFailedLinuxEvidence)
    ).toContain("Environment: Ubuntu Desktop");
    expect(
      extractLinuxReleasePassedRecordedEvidence(ledgerWithFailedLinuxEvidence)
    ).not.toContain("Environment: Ubuntu Desktop");
    expect(isLinuxReleaseCandidatePassed(ledgerWithFailedLinuxEvidence)).toBe(
      false
    );
    expect(
      missingLinuxReleaseCandidateEvidence(ledgerWithFailedLinuxEvidence)
    ).toEqual([
      "Ubuntu Desktop environment",
      "AppImage artifact",
      "walking skeleton Linux gate command",
      "Linux package command",
      "packaged Linux smoke command",
      "Linux release check command",
      "Linux evidence command",
      "launch/socket shell env evidence",
      "PATH recovery evidence",
      "node-pty spawn evidence",
      "hook runtime env evidence",
      "agent hook notification evidence",
      "Codex wrapper evidence",
      "agent workflow evidence",
      "filesystem watch/resync evidence",
      "AppImage updater evidence",
      "AppImage provenance/env evidence",
      "AppImage startup/sandbox evidence",
      "AppImage desktop entry evidence",
      "notification/window grouping evidence",
      "native window chrome evidence",
      "shortcut policy evidence",
      "terminal font/cell metrics evidence",
      "IME/input-method evidence",
      "output continuity evidence",
      "Linux docs evidence",
      "validation matrix evidence"
    ]);
  });

  it("requires the Recorded Evidence Result field to be exactly passed", () => {
    const ledgerWithCaveatedPassedResult = passedRcValidation.replace(
      "Result: Passed.",
      "Result: Passed with failures."
    );

    expect(
      extractLinuxReleasePassedRecordedEvidence(
        ledgerWithCaveatedPassedResult
      )
    ).not.toContain("Environment: Ubuntu Desktop");
    expect(missingLinuxReleaseCandidateEvidence(ledgerWithCaveatedPassedResult))
      .toContain("Ubuntu Desktop environment");
    expect(isLinuxReleaseCandidatePassed(ledgerWithCaveatedPassedResult))
      .toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithCaveatedPassedResult)
    ).toThrow(/Result.*Passed/);
  });

  markerLoopIt("requires AppImage updater check, download, and install evidence together", () => {
    const ledgerWithoutUpdaterCheck = passedRcValidation.replace(
      passedRcNotes,
      "Notes: GUI launch opened a normal window from the recorded launch path and screenshot/run log. Terminal launch and GUI launch resolved shell env, and CLI plus desktop used the same POSIX socket. PATH recovery passed for the GUI-launched app shell env with nvm, pyenv, cargo, ~/.local/bin, and installed agent CLIs observed. node-pty spawned shells in dev and packaged AppImage builds through ShellLaunchPolicy with AppImage sandbox env and user-namespace settings recorded. Hook runtime env in pty sessions included KMUX_SOCKET_PATH, KMUX_AGENT_BIN_DIR, and KMUX_NODE_PATH. Codex, Claude, Gemini, and Antigravity hooks notified when installed and configured with per-agent hook logs and UI notification evidence. Codex wrapper worked with shell rc integration disabled in a targeted Codex wrapper run. External session discovery and resume passed for verified vendor roots tied to agent storage roots. Usage history and subscription usage passed with verified credential source, recorded storage-root evidence, and dashboard evidence. Missing credentials showed normal unavailable/disconnected states with recorded missing credential paths. Usage/subscription subprocesses made no macOS security command calls, and Linux subprocess audit recorded platform-specific script probing args, script command availability, parsed ps process-table rows, and bounded lsof listening-socket samples. Filesystem watch/resync passed: missed events still produced eventual usage and external-session refresh, with inotify limit diagnostics recorded. AppImage updater download and install passed with electron-updater using latest-linux.yml metadata; channel naming, release visibility, and the AppImage blockmap sidecar matched intended policy; top-level sha512, AppImage file-entry sha512, actual AppImage sha512, and size consistency matched the packaged AppImage. AppImage provenance recorded Git dirty state, APPIMAGE env behavior, and selected AppImage artifact path. AppImage startup passed with sandbox and user-namespace settings recorded; --no-sandbox was not needed. AppImage extracted desktop entry app name, icon, categories, StartupWMClass=kmux, installed desktop-entry candidate evidence, and resources/notificationIcon.png notification icon resource output matched. Runtime and packaged identity alignment matched app id, app name, executable name, desktop entry Name, and StartupWMClass=kmux. Desktop notification title/body/icon app attribution and Ubuntu notification center/window grouping matched the kmux window, tied to recorded DBus/session and desktop-entry facts. Native window chrome passed on Ubuntu Desktop with X11/Wayland notes tied to recorded desktop shell/display and GPU renderer probes, resize, and compositor observations. Shortcut policy passed against terminal input and GNOME defaults with keyboard smoke notes tied to recorded GNOME keybinding probes. Terminal font loaded and cell metrics stayed stable with fc-list font inventory and xterm observations. IME/input-method smoke passed where ibus or fcitx validation was available with IME environment, input notes, and terminal input unaffected. Split pane, surface switch, restore, foreground resize, and readable agent output continuity passed. User and release docs covered Linux baseline, unsupported scope, AppImage updater behavior, and unavailable credential states. Validation matrix covered Ubuntu Desktop LTS GUI launcher, terminal launch, packaged AppImage, dev build, X11 session where available, and Wayland session where available. macOS compatibility evidence remains green."
    );

    expect(missingLinuxReleaseCandidateEvidence(ledgerWithoutUpdaterCheck))
      .toContain("AppImage updater evidence");
    expect(linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutUpdaterCheck)).toBe(
      ""
    );
    expect(isLinuxReleaseCandidatePassed(ledgerWithoutUpdaterCheck)).toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithoutUpdaterCheck)
    ).toThrow(/AppImage updater evidence/);
  });

  it(
    "requires AppImage updater metadata checksum and size evidence",
    () => {
      const caveatedUpdaterNotes = [
        "Notes: GUI launch opened a normal window from the recorded launch path and screenshot/run log. Terminal launch and GUI launch resolved shell env, and CLI plus desktop used the same POSIX socket. PATH recovery passed for the GUI-launched app shell env with nvm, pyenv, cargo, ~/.local/bin, and installed agent CLIs observed. node-pty spawned shells in dev and packaged AppImage builds through ShellLaunchPolicy with AppImage sandbox env and user-namespace settings recorded. Hook runtime env in pty sessions included KMUX_SOCKET_PATH, KMUX_AGENT_BIN_DIR, and KMUX_NODE_PATH. Codex, Claude, Gemini, and Antigravity hooks notified when installed and configured with per-agent hook logs and UI notification evidence. Codex wrapper worked with shell rc integration disabled in a targeted Codex wrapper run. External session discovery and resume passed for verified vendor roots tied to agent storage roots. Usage history and subscription usage passed with verified credential source, recorded storage-root evidence, and dashboard evidence. Missing credentials showed normal unavailable/disconnected states with recorded missing credential paths. Usage/subscription subprocesses made no macOS security command calls, and Linux subprocess audit recorded platform-specific script probing args, script command availability, parsed ps process-table rows, and bounded lsof listening-socket samples. Filesystem watch/resync passed: missed events still produced eventual usage and external-session refresh, with inotify limit diagnostics recorded. AppImage updater check, download, and install passed with electron-updater metadata. AppImage provenance recorded Git dirty state, APPIMAGE env behavior, and selected AppImage artifact path. AppImage startup passed with sandbox and user-namespace settings recorded; --no-sandbox was not needed. AppImage extracted desktop entry app name, icon, categories, StartupWMClass=kmux, installed desktop-entry candidate evidence, and resources/notificationIcon.png notification icon resource output matched. Runtime and packaged identity alignment matched app id, app name, executable name, desktop entry Name, and StartupWMClass=kmux. Desktop notification title/body/icon app attribution and Ubuntu notification center/window grouping matched the kmux window, tied to recorded DBus/session and desktop-entry facts. Native window chrome passed on Ubuntu Desktop with X11/Wayland notes tied to recorded desktop shell/display and GPU renderer probes, resize, and compositor observations. Shortcut policy passed against terminal input and GNOME defaults with keyboard smoke notes tied to recorded GNOME keybinding probes. Terminal font loaded and cell metrics stayed stable with fc-list font inventory and xterm observations. IME/input-method smoke passed where ibus or fcitx validation was available with IME environment, input notes, and terminal input unaffected. Split pane, surface switch, restore, foreground resize, and readable agent output continuity passed. User and release docs covered Linux baseline, unsupported scope, AppImage updater behavior, and unavailable credential states. Validation matrix covered Ubuntu Desktop LTS GUI launcher, terminal launch, packaged AppImage, dev build, X11 session where available, and Wayland session where available. macOS compatibility evidence remains green.",
        passedRcNotes.replace("top-level sha512, ", ""),
        passedRcNotes.replace("AppImage file-entry sha512, ", ""),
        passedRcNotes.replace("actual AppImage sha512, ", ""),
        passedRcNotes.replace("and size consistency ", ""),
        passedRcNotes.replace(
          "and size consistency matched the packaged AppImage",
          "and size recorded for the packaged AppImage"
        )
      ];

      for (const updaterNotes of caveatedUpdaterNotes) {
        const ledgerWithoutUpdaterMetadataFacts = passedRcValidation.replace(
          passedRcNotes,
          updaterNotes
        );

        expect(
          missingLinuxReleaseCandidateEvidence(ledgerWithoutUpdaterMetadataFacts)
        ).toContain("AppImage updater evidence");
        expect(isLinuxReleaseCandidatePassed(ledgerWithoutUpdaterMetadataFacts))
          .toBe(false);
        expect(() =>
          assertLinuxReleaseCandidatePassed(ledgerWithoutUpdaterMetadataFacts)
        ).toThrow(/AppImage updater evidence/);
      }
    },
    markerLoopTimeoutMs
  );

  markerLoopIt("requires AppImage updater channel naming and release visibility evidence", () => {
    const incompleteUpdaterPolicyNotes = [
      passedRcNotes.replace("channel naming, ", ""),
      passedRcNotes.replace("release visibility, ", "")
    ];

    for (const updaterNotes of incompleteUpdaterPolicyNotes) {
      const ledgerWithoutUpdaterPolicyFacts = passedRcValidation.replace(
        passedRcNotes,
        updaterNotes
      );

      expect(
        missingLinuxReleaseCandidateEvidence(ledgerWithoutUpdaterPolicyFacts)
      ).toContain("AppImage updater evidence");
      expect(isLinuxReleaseCandidatePassed(ledgerWithoutUpdaterPolicyFacts))
        .toBe(false);
      expect(() =>
        assertLinuxReleaseCandidatePassed(ledgerWithoutUpdaterPolicyFacts)
      ).toThrow(/AppImage updater evidence/);
    }
  });

  markerLoopIt("requires AppImage provenance, Git dirty, APPIMAGE env, and selected artifact evidence together", () => {
    const incompleteProvenanceNotes = [
      passedRcNotes.replace("AppImage provenance ", ""),
      passedRcNotes.replace("Git dirty state, ", ""),
      passedRcNotes.replace("APPIMAGE env behavior, ", ""),
      passedRcNotes.replace("selected AppImage artifact path. ", "")
    ];

    for (const provenanceNotes of incompleteProvenanceNotes) {
      const ledgerWithoutProvenanceFacts = passedRcValidation.replace(
        passedRcNotes,
        provenanceNotes
      );

      expect(
        missingLinuxReleaseCandidateEvidence(ledgerWithoutProvenanceFacts)
      ).toContain("AppImage provenance/env evidence");
      expect(
        linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutProvenanceFacts)
      ).toBe("");
      expect(isLinuxReleaseCandidatePassed(ledgerWithoutProvenanceFacts))
        .toBe(false);
      expect(() =>
        assertLinuxReleaseCandidatePassed(ledgerWithoutProvenanceFacts)
      ).toThrow(/AppImage provenance\/env evidence/);
    }
  });

  markerLoopIt("rejects AppImage updater metadata evidence that says checksums or sizes mismatched", () => {
    const mismatchedUpdaterNotes = [
      passedRcNotes.replace(
        "top-level sha512, AppImage file-entry sha512, actual AppImage sha512, and size consistency matched",
        "top-level sha512 mismatch, AppImage file-entry sha512, actual AppImage sha512, and size consistency matched"
      ),
      passedRcNotes.replace(
        "AppImage file-entry sha512, actual AppImage sha512, and size consistency matched the packaged AppImage",
        "AppImage file-entry sha512 does not match actual AppImage sha512, and size consistency matched the packaged AppImage"
      ),
      passedRcNotes.replace(
        "actual AppImage sha512, and size consistency matched the packaged AppImage",
        "actual AppImage sha512 inconsistent, and size consistency matched the packaged AppImage"
      ),
      passedRcNotes.replace(
        "and size consistency matched the packaged AppImage",
        "and size consistency mismatch for the packaged AppImage"
      ),
      passedRcNotes.replace(
        "and size consistency matched the packaged AppImage",
        "and size consistency did not match the packaged AppImage"
      ),
      passedRcNotes.replace(
        "top-level sha512, AppImage file-entry sha512, actual AppImage sha512, and size consistency matched",
        "top-level sha512 differs from AppImage file-entry sha512, actual AppImage sha512, and size consistency matched"
      ),
      passedRcNotes.replace(
        "AppImage file-entry sha512, actual AppImage sha512, and size consistency matched the packaged AppImage",
        "AppImage file-entry sha512 is not equal to actual AppImage sha512, and size consistency matched the packaged AppImage"
      ),
      passedRcNotes.replace(
        "AppImage file-entry sha512, actual AppImage sha512, and size consistency matched the packaged AppImage",
        "AppImage file-entry sha512 is not-equal to actual AppImage sha512, and size consistency matched the packaged AppImage"
      )
    ];

    for (const updaterNotes of mismatchedUpdaterNotes) {
      const ledgerWithMismatchedUpdaterFacts = passedRcValidation.replace(
        passedRcNotes,
        updaterNotes
      );

      expect(
        missingLinuxReleaseCandidateEvidence(ledgerWithMismatchedUpdaterFacts)
      ).toEqual([]);
      expect(
        linuxReleasePrimaryRcEvidenceEntry(ledgerWithMismatchedUpdaterFacts)
      ).toContain("Environment: Ubuntu Desktop");
      expect(
        linuxReleasePrimaryRcEvidenceCaveats(
          ledgerWithMismatchedUpdaterFacts
        )
      ).toEqual([updaterNotes]);
      expect(isLinuxReleaseCandidatePassed(ledgerWithMismatchedUpdaterFacts))
        .toBe(false);
      expect(() =>
        assertLinuxReleaseCandidatePassed(ledgerWithMismatchedUpdaterFacts)
      ).toThrow(
        /incomplete, failed, unconfirmed, mismatched, target-negating, non-RC, or script-development-only evidence text/
      );
    }
  });

  markerLoopIt("rejects passed RC evidence that says marker-bearing observations were not confirmed", () => {
    const unconfirmedObservationNotes = [
      passedRcNotes.replace(
        "release visibility, and the AppImage blockmap sidecar matched intended policy",
        "release visibility not checked, and the AppImage blockmap sidecar matched intended policy"
      ),
      passedRcNotes.replace(
        "channel naming, release visibility, and the AppImage blockmap sidecar matched intended policy",
        "channel naming unconfirmed, release visibility, and the AppImage blockmap sidecar matched intended policy"
      ),
      passedRcNotes.replace(
        "AppImage updater check, download, and install passed",
        "AppImage updater check, download, and install not validated"
      ),
      passedRcNotes.replace(
        "window grouping matched the kmux window",
        "window grouping not observed on the kmux window"
      )
    ];

    for (const updaterNotes of unconfirmedObservationNotes) {
      const ledgerWithUnconfirmedObservations = passedRcValidation.replace(
        passedRcNotes,
        updaterNotes
      );

      expect(
        missingLinuxReleaseCandidateEvidence(ledgerWithUnconfirmedObservations)
      ).toEqual([]);
      expect(
        linuxReleasePrimaryRcEvidenceEntry(ledgerWithUnconfirmedObservations)
      ).toContain("Environment: Ubuntu Desktop");
      expect(
        linuxReleasePrimaryRcEvidenceCaveats(
          ledgerWithUnconfirmedObservations
        )
      ).toEqual([updaterNotes]);
      expect(isLinuxReleaseCandidatePassed(ledgerWithUnconfirmedObservations))
        .toBe(false);
      expect(() =>
        assertLinuxReleaseCandidatePassed(ledgerWithUnconfirmedObservations)
      ).toThrow(
        /incomplete, failed, unconfirmed, mismatched, target-negating, non-RC, or script-development-only evidence text/
      );
    }
  });

  markerLoopIt("requires GUI launch path, terminal launch, shell env, and same socket evidence together", () => {
    const incompleteLaunchSocketNotes = [
      passedRcNotes.replace("GUI launch ", ""),
      passedRcNotes.replace("normal window ", ""),
      passedRcNotes.replace("launch path ", ""),
      passedRcNotes.replace("screenshot/run log. ", ""),
      passedRcNotes.replace("Terminal launch ", ""),
      passedRcNotes.replace("shell env, ", ""),
      passedRcNotes.replace("CLI plus ", ""),
      passedRcNotes.replace("desktop used ", ""),
      passedRcNotes.replace("the same POSIX socket. ", "")
    ];

    for (const launchSocketNotes of incompleteLaunchSocketNotes) {
      const ledgerWithoutLaunchSocketFacts = passedRcValidation.replace(
        passedRcNotes,
        launchSocketNotes
      );

      expect(
        missingLinuxReleaseCandidateEvidence(ledgerWithoutLaunchSocketFacts)
      ).toContain("launch/socket shell env evidence");
      expect(
        linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutLaunchSocketFacts)
      ).toBe("");
      expect(isLinuxReleaseCandidatePassed(ledgerWithoutLaunchSocketFacts))
        .toBe(false);
      expect(() =>
        assertLinuxReleaseCandidatePassed(ledgerWithoutLaunchSocketFacts)
      ).toThrow(/launch\/socket shell env evidence/);
    }
  });

  markerLoopIt("requires GUI-launched PATH recovery evidence for shell tools and agent CLIs", () => {
    const incompletePathRecoveryNotes = [
      passedRcNotes.replace("PATH recovery ", ""),
      passedRcNotes.replace("GUI-launched app ", ""),
      passedRcNotes.replace("shell env ", ""),
      passedRcNotes.replace("nvm, ", ""),
      passedRcNotes.replace("pyenv, ", ""),
      passedRcNotes.replace("cargo, ", ""),
      passedRcNotes.replace("~/.local/bin, ", ""),
      passedRcNotes.replace("installed agent CLIs ", "")
    ];

    for (const pathRecoveryNotes of incompletePathRecoveryNotes) {
      const ledgerWithoutPathRecoveryFacts = passedRcValidation.replace(
        passedRcNotes,
        pathRecoveryNotes
      );

      expect(
        missingLinuxReleaseCandidateEvidence(ledgerWithoutPathRecoveryFacts)
      ).toContain("PATH recovery evidence");
      expect(
        linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutPathRecoveryFacts)
      ).toBe("");
      expect(isLinuxReleaseCandidatePassed(ledgerWithoutPathRecoveryFacts))
        .toBe(false);
      expect(() =>
        assertLinuxReleaseCandidatePassed(ledgerWithoutPathRecoveryFacts)
      ).toThrow(/PATH recovery evidence/);
    }
  });

  markerLoopIt("requires node-pty shell spawning evidence for dev and packaged AppImage builds", () => {
    const incompleteNodePtyNotes = [
      passedRcNotes.replace("node-pty ", ""),
      passedRcNotes.replace("spawned shells ", ""),
      passedRcNotes.replace("dev and ", ""),
      passedRcNotes.replace("packaged AppImage ", ""),
      passedRcNotes.replace("ShellLaunchPolicy ", ""),
      passedRcNotes.replace("AppImage sandbox env ", ""),
      passedRcNotes.replace("user-namespace settings ", "")
    ];

    for (const nodePtyNotes of incompleteNodePtyNotes) {
      const ledgerWithoutNodePtyFacts = passedRcValidation.replace(
        passedRcNotes,
        nodePtyNotes
      );

      expect(
        missingLinuxReleaseCandidateEvidence(ledgerWithoutNodePtyFacts)
      ).toContain("node-pty spawn evidence");
      expect(
        linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutNodePtyFacts)
      ).toBe("");
      expect(isLinuxReleaseCandidatePassed(ledgerWithoutNodePtyFacts))
        .toBe(false);
      expect(() =>
        assertLinuxReleaseCandidatePassed(ledgerWithoutNodePtyFacts)
      ).toThrow(/node-pty spawn evidence/);
    }
  });

  markerLoopIt("requires hook runtime env evidence for pty sessions", () => {
    const incompleteHookEnvNotes = [
      passedRcNotes.replace("Hook runtime env ", ""),
      passedRcNotes.replace("pty sessions ", ""),
      passedRcNotes.replace("KMUX_SOCKET_PATH, ", ""),
      passedRcNotes.replace("KMUX_AGENT_BIN_DIR, ", ""),
      passedRcNotes.replace("and KMUX_NODE_PATH. ", "")
    ];

    for (const hookEnvNotes of incompleteHookEnvNotes) {
      const ledgerWithoutHookEnvFacts = passedRcValidation.replace(
        passedRcNotes,
        hookEnvNotes
      );

      expect(missingLinuxReleaseCandidateEvidence(ledgerWithoutHookEnvFacts))
        .toContain("hook runtime env evidence");
      expect(linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutHookEnvFacts))
        .toBe("");
      expect(isLinuxReleaseCandidatePassed(ledgerWithoutHookEnvFacts)).toBe(
        false
      );
      expect(() =>
        assertLinuxReleaseCandidatePassed(ledgerWithoutHookEnvFacts)
      ).toThrow(/hook runtime env evidence/);
    }
  });

  it(
    "requires per-agent hook notification evidence when hooks are installed and configured",
    () => {
      const incompleteHookNotificationNotes = [
        passedRcNotes.replace("Codex, ", ""),
        passedRcNotes.replace("Claude, ", ""),
        passedRcNotes.replace("Gemini, ", ""),
        passedRcNotes.replace("and Antigravity ", ""),
        passedRcNotes.replace("hooks notified ", ""),
        passedRcNotes.replace("installed and ", ""),
        passedRcNotes.replace("configured ", ""),
        passedRcNotes.replace("per-agent hook logs ", ""),
        passedRcNotes.replace("UI notification evidence. ", "")
      ];

      for (const hookNotificationNotes of incompleteHookNotificationNotes) {
        const ledgerWithoutHookNotificationFacts = passedRcValidation.replace(
          passedRcNotes,
          hookNotificationNotes
        );

        expect(
          missingLinuxReleaseCandidateEvidence(
            ledgerWithoutHookNotificationFacts
          )
        ).toContain("agent hook notification evidence");
        expect(
          linuxReleasePrimaryRcEvidenceEntry(
            ledgerWithoutHookNotificationFacts
          )
        ).toBe("");
        expect(
          isLinuxReleaseCandidatePassed(ledgerWithoutHookNotificationFacts)
        ).toBe(false);
        expect(() =>
          assertLinuxReleaseCandidatePassed(
            ledgerWithoutHookNotificationFacts
          )
        ).toThrow(/agent hook notification evidence/);
      }
    },
    markerLoopTimeoutMs
  );

  markerLoopIt("requires Codex wrapper evidence with shell rc integration disabled", () => {
    const incompleteCodexWrapperNotes = [
      passedRcNotes.replace("Codex wrapper ", ""),
      passedRcNotes.replace("worked ", ""),
      passedRcNotes.replace("shell rc integration ", ""),
      passedRcNotes.replace("disabled ", ""),
      passedRcNotes.replace("targeted Codex wrapper run. ", "")
    ];

    for (const codexWrapperNotes of incompleteCodexWrapperNotes) {
      const ledgerWithoutCodexWrapperFacts = passedRcValidation.replace(
        passedRcNotes,
        codexWrapperNotes
      );

      expect(
        missingLinuxReleaseCandidateEvidence(ledgerWithoutCodexWrapperFacts)
      ).toContain("Codex wrapper evidence");
      expect(
        linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutCodexWrapperFacts)
      ).toBe("");
      expect(isLinuxReleaseCandidatePassed(ledgerWithoutCodexWrapperFacts))
        .toBe(false);
      expect(() =>
        assertLinuxReleaseCandidatePassed(ledgerWithoutCodexWrapperFacts)
      ).toThrow(/Codex wrapper evidence/);
    }
  });

  it(
    "requires external session, usage, credential storage/dashboard, missing credential paths, and Linux subprocess evidence together",
    () => {
      const incompleteAgentWorkflowNotes = [
        ["external session", passedRcNotes.replace("External session ", "")],
        ["discovery", passedRcNotes.replace("discovery and ", "")],
        ["resume", passedRcNotes.replace("resume ", "")],
        [
          "verified vendor roots",
          passedRcNotes.replace("verified vendor roots ", "")
        ],
        ["agent storage roots", passedRcNotes.replace("agent storage roots. ", "")],
        ["usage history", passedRcNotes.replace("Usage history and ", "")],
        ["subscription usage", passedRcNotes.replace("subscription usage ", "")],
        [
          "verified credential source",
          passedRcNotes.replace("verified credential source, ", "")
        ],
        [
          "recorded storage-root evidence",
          passedRcNotes.replace("recorded storage-root evidence, and ", "")
        ],
        ["dashboard evidence", passedRcNotes.replace("dashboard evidence. ", "")],
        ["missing credentials", passedRcNotes.replace("Missing credentials ", "")],
        [
          "unavailable/disconnected",
          passedRcNotes.replace("unavailable/disconnected ", "")
        ],
        [
          "recorded missing credential paths",
          passedRcNotes.replace("recorded missing credential paths. ", "")
        ],
        [
          "no macOS security command",
          passedRcNotes.replace("no macOS security command ", "")
        ],
        [
          "platform-specific script probing args",
          passedRcNotes.replace("platform-specific script probing args, ", "")
        ],
        [
          "script command availability",
          passedRcNotes.replace("script command availability, ", "")
        ],
        [
          "parsed ps process-table rows",
          passedRcNotes.replace("parsed ps process-table rows, ", "")
        ],
        [
          "bounded lsof listening-socket samples",
          passedRcNotes.replace("bounded lsof listening-socket samples", "")
        ]
      ];

      for (const [missingAgentWorkflowFact, agentWorkflowNotes] of
        incompleteAgentWorkflowNotes) {
        expect(agentWorkflowNotes, missingAgentWorkflowFact).not.toBe(
          passedRcNotes
        );

        const ledgerWithoutAgentWorkflowFacts = passedRcValidation.replace(
          passedRcNotes,
          agentWorkflowNotes
        );

        expect(
          missingLinuxReleaseCandidateEvidence(ledgerWithoutAgentWorkflowFacts),
          missingAgentWorkflowFact
        ).toContain("agent workflow evidence");
        expect(
          linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutAgentWorkflowFacts)
        ).toBe("");
        expect(isLinuxReleaseCandidatePassed(ledgerWithoutAgentWorkflowFacts))
          .toBe(false);
        expect(() =>
          assertLinuxReleaseCandidatePassed(ledgerWithoutAgentWorkflowFacts)
        ).toThrow(/agent workflow evidence/);
      }
    },
    markerLoopTimeoutMs
  );

  markerLoopIt("requires filesystem watch, resync, and inotify evidence together", () => {
    const incompleteWatchResyncNotes = [
      passedRcNotes.replace("Filesystem watch/resync ", ""),
      passedRcNotes.replace("missed events ", ""),
      passedRcNotes.replace("eventual ", ""),
      passedRcNotes.replace("usage and ", ""),
      passedRcNotes.replace("external-session ", ""),
      passedRcNotes.replace("refresh, ", ""),
      passedRcNotes.replace("inotify limit diagnostics ", "")
    ];

    for (const watchResyncNotes of incompleteWatchResyncNotes) {
      const ledgerWithoutWatchResyncFacts = passedRcValidation.replace(
        passedRcNotes,
        watchResyncNotes
      );

      expect(
        missingLinuxReleaseCandidateEvidence(ledgerWithoutWatchResyncFacts)
      ).toContain("filesystem watch/resync evidence");
      expect(
        linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutWatchResyncFacts)
      ).toBe("");
      expect(isLinuxReleaseCandidatePassed(ledgerWithoutWatchResyncFacts))
        .toBe(false);
      expect(() =>
        assertLinuxReleaseCandidatePassed(ledgerWithoutWatchResyncFacts)
      ).toThrow(/filesystem watch\/resync evidence/);
    }
  });

  markerLoopIt("requires AppImage startup, sandbox, no-sandbox, and user-namespace evidence together", () => {
    const incompleteStartupNotes = [
      passedRcNotes.replace("AppImage startup ", ""),
      passedRcNotes.replace("sandbox and ", ""),
      passedRcNotes.replace("user-namespace settings recorded; ", ""),
      passedRcNotes.replace("--no-sandbox was not needed. ", "")
    ];

    for (const startupNotes of incompleteStartupNotes) {
      const ledgerWithoutStartupFacts = passedRcValidation.replace(
        passedRcNotes,
        startupNotes
      );

      expect(missingLinuxReleaseCandidateEvidence(ledgerWithoutStartupFacts))
        .toContain("AppImage startup/sandbox evidence");
      expect(linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutStartupFacts))
        .toBe("");
      expect(isLinuxReleaseCandidatePassed(ledgerWithoutStartupFacts)).toBe(
        false
      );
      expect(() =>
        assertLinuxReleaseCandidatePassed(ledgerWithoutStartupFacts)
      ).toThrow(/AppImage startup\/sandbox evidence/);
    }
  });

  it(
    "requires AppImage extracted desktop-entry identity, installed candidate, and notification resource evidence together",
    () => {
      const incompleteDesktopEntryNotes = [
      ["AppImage", passedRcNotes.replace("AppImage extracted ", "extracted ")],
      ["extracted", passedRcNotes.replace("extracted ", "")],
      ["desktop entry", passedRcNotes.replace("desktop entry ", "")],
      ["app name", passedRcNotes.replace("app name, ", "")],
      ["icon", passedRcNotes.replace("icon, ", "")],
      ["categories", passedRcNotes.replace("categories, ", "")],
      ["StartupWMClass", passedRcNotes.replace("StartupWMClass=kmux, ", "")],
      [
        "installed desktop-entry candidate",
        passedRcNotes.replace("installed desktop-entry candidate evidence, ", "")
      ],
      [
        "resources notification icon",
        passedRcNotes.replace("resources/notificationIcon.png ", "")
      ],
      [
        "notification icon resource",
        passedRcNotes.replace("notification icon resource ", "")
      ],
      [
        "runtime packaged identity alignment",
        passedRcNotes.replace(
          "Runtime and packaged identity alignment matched app id, app name, executable name, desktop entry Name, and StartupWMClass=kmux. ",
          ""
        )
      ],
      [
        "app id",
        passedRcNotes.replace("app id, ", "")
      ],
      [
        "runtime app name",
        passedRcNotes.replace("app id, app name, executable name", "app id, executable name")
      ],
      [
        "executable name",
        passedRcNotes.replace("executable name, ", "")
      ],
      [
        "desktop entry Name",
        passedRcNotes.replace("desktop entry Name, ", "")
      ]
      ];

      for (const [missingDesktopEntryFact, desktopEntryNotes] of
        incompleteDesktopEntryNotes) {
        expect(desktopEntryNotes, missingDesktopEntryFact).not.toBe(
          passedRcNotes
        );

        const ledgerWithoutDesktopEntryFacts = passedRcValidation.replace(
          passedRcNotes,
          desktopEntryNotes
        );

        expect(
          missingLinuxReleaseCandidateEvidence(ledgerWithoutDesktopEntryFacts),
          missingDesktopEntryFact
        ).toContain("AppImage desktop entry evidence");
        expect(
          linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutDesktopEntryFacts)
        ).toBe("");
        expect(isLinuxReleaseCandidatePassed(ledgerWithoutDesktopEntryFacts))
          .toBe(false);
        expect(() =>
          assertLinuxReleaseCandidatePassed(ledgerWithoutDesktopEntryFacts)
        ).toThrow(/AppImage desktop entry evidence/);
      }
    },
    markerLoopTimeoutMs
  );

  markerLoopIt("requires split, surface switch, restore, resize, readable agent output continuity evidence together", () => {
    const incompleteOutputContinuityNotes = [
      passedRcNotes.replace(
        "Split pane, surface switch, restore, foreground resize, and readable agent output continuity passed.",
        "Split pane, surface switch, restore, and readable agent output continuity passed."
      ),
      passedRcNotes.replace("readable agent output continuity", "agent output continuity"),
      passedRcNotes.replace("readable agent output continuity", "readable output continuity")
    ];

    for (const outputContinuityNotes of incompleteOutputContinuityNotes) {
      const ledgerWithoutOutputContinuityFacts = passedRcValidation.replace(
        passedRcNotes,
        outputContinuityNotes
      );

      expect(
        missingLinuxReleaseCandidateEvidence(
          ledgerWithoutOutputContinuityFacts
        )
      ).toContain("output continuity evidence");
      expect(
        linuxReleasePrimaryRcEvidenceEntry(
          ledgerWithoutOutputContinuityFacts
        )
      ).toBe("");
      expect(isLinuxReleaseCandidatePassed(ledgerWithoutOutputContinuityFacts))
        .toBe(false);
      expect(() =>
        assertLinuxReleaseCandidatePassed(ledgerWithoutOutputContinuityFacts)
      ).toThrow(/output continuity evidence/);
    }
  });

  markerLoopIt("requires Linux baseline, unsupported scope, updater behavior, and credential-state docs evidence together", () => {
    const incompleteDocsNotes = [
      passedRcNotes.replace("User and release docs ", ""),
      passedRcNotes.replace("Linux baseline, ", ""),
      passedRcNotes.replace("unsupported scope, ", ""),
      passedRcNotes.replace("AppImage updater behavior, ", ""),
      passedRcNotes.replace("unavailable credential states. ", "")
    ];

    for (const docsNotes of incompleteDocsNotes) {
      const ledgerWithoutDocsFacts = passedRcValidation.replace(
        passedRcNotes,
        docsNotes
      );

      expect(
        missingLinuxReleaseCandidateEvidence(ledgerWithoutDocsFacts)
      ).toContain("Linux docs evidence");
      expect(
        linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutDocsFacts)
      ).toBe("");
      expect(isLinuxReleaseCandidatePassed(ledgerWithoutDocsFacts)).toBe(
        false
      );
      expect(() =>
        assertLinuxReleaseCandidatePassed(ledgerWithoutDocsFacts)
      ).toThrow(/Linux docs evidence/);
    }
  });

  markerLoopIt("requires Ubuntu GUI, terminal, packaged, dev, X11, and Wayland validation matrix evidence together", () => {
    const incompleteMatrixNotes = [
      passedRcNotes.replace("Validation matrix ", ""),
      passedRcNotes.replace("Ubuntu Desktop LTS ", ""),
      passedRcNotes.replace("GUI launcher, ", ""),
      passedRcNotes.replace("terminal launch, ", ""),
      passedRcNotes.replace("packaged AppImage, ", ""),
      passedRcNotes.replace("dev build, ", ""),
      passedRcNotes.replace("X11 session where available, ", ""),
      passedRcNotes.replace("Wayland session where available. ", "")
    ];

    for (const matrixNotes of incompleteMatrixNotes) {
      const ledgerWithoutMatrixFacts = passedRcValidation.replace(
        passedRcNotes,
        matrixNotes
      );

      expect(
        missingLinuxReleaseCandidateEvidence(ledgerWithoutMatrixFacts)
      ).toContain("validation matrix evidence");
      expect(
        linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutMatrixFacts)
      ).toBe("");
      expect(isLinuxReleaseCandidatePassed(ledgerWithoutMatrixFacts)).toBe(
        false
      );
      expect(() =>
        assertLinuxReleaseCandidatePassed(ledgerWithoutMatrixFacts)
      ).toThrow(/validation matrix evidence/);
    }
  });

  it(
    "requires terminal font, stable cell metrics, font inventory, and xterm evidence together",
    () => {
      const incompleteTerminalFontNotes = [
        passedRcNotes.replace("Terminal font ", ""),
        passedRcNotes.replace("loaded ", ""),
        passedRcNotes.replace("cell metrics ", ""),
        passedRcNotes.replace("stable ", ""),
        passedRcNotes.replace("fc-list ", ""),
        passedRcNotes.replace("font inventory ", ""),
        passedRcNotes.replace("xterm observations. ", "")
      ];

      for (const terminalFontNotes of incompleteTerminalFontNotes) {
        const ledgerWithoutTerminalFontFacts = passedRcValidation.replace(
          passedRcNotes,
          terminalFontNotes
        );

        expect(
          missingLinuxReleaseCandidateEvidence(ledgerWithoutTerminalFontFacts)
        ).toContain("terminal font/cell metrics evidence");
        expect(
          linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutTerminalFontFacts)
        ).toBe("");
        expect(isLinuxReleaseCandidatePassed(ledgerWithoutTerminalFontFacts))
          .toBe(false);
        expect(() =>
          assertLinuxReleaseCandidatePassed(ledgerWithoutTerminalFontFacts)
        ).toThrow(/terminal font\/cell metrics evidence/);
      }
    },
    markerLoopTimeoutMs
  );

  markerLoopIt("requires IME smoke, ibus/fcitx, environment, input notes, and terminal input evidence together", () => {
    const incompleteImeNotes = [
      passedRcNotes.replace("IME/input-method smoke ", ""),
      passedRcNotes.replace("smoke passed ", "smoke "),
      passedRcNotes.replace("ibus or fcitx ", ""),
      passedRcNotes.replace("IME environment, ", ""),
      passedRcNotes.replace("input notes, ", ""),
      passedRcNotes.replace("terminal input unaffected", "unaffected")
    ];

    for (const imeNotes of incompleteImeNotes) {
      const ledgerWithoutImeFacts = passedRcValidation.replace(
        passedRcNotes,
        imeNotes
      );

      expect(
        missingLinuxReleaseCandidateEvidence(ledgerWithoutImeFacts)
      ).toContain("IME/input-method evidence");
      expect(
        linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutImeFacts)
      ).toBe("");
      expect(isLinuxReleaseCandidatePassed(ledgerWithoutImeFacts))
        .toBe(false);
      expect(() =>
        assertLinuxReleaseCandidatePassed(ledgerWithoutImeFacts)
      ).toThrow(/IME\/input-method evidence/);
    }
  });

  markerLoopIt("requires notification identity, Ubuntu notification center, DBus/session, desktop-entry facts, and window grouping evidence together", () => {
    const incompleteNotificationNotes = [
      [
        "notification identity",
        passedRcNotes.replace(
          "Desktop notification title/body/icon app attribution and Ubuntu notification center/window grouping matched the kmux window, tied to recorded DBus/session and desktop-entry facts.",
          "Desktop notification window grouping matched the kmux window."
        )
      ],
      [
        "Ubuntu notification center",
        passedRcNotes.replace("Ubuntu notification center/", "")
      ],
      ["DBus/session", passedRcNotes.replace("recorded DBus/session and ", "")],
      [
        "desktop-entry facts",
        passedRcNotes.replace("and desktop-entry facts.", "")
      ],
      [
        "successful notification observation",
        passedRcNotes.replace(
          "Desktop notification title/body/icon app attribution and Ubuntu notification center/window grouping matched the kmux window, tied to recorded DBus/session and desktop-entry facts.",
          "Desktop notification title/body/icon app attribution and Ubuntu notification center/window grouping evidence tied to recorded DBus/session and desktop-entry facts."
        )
      ]
    ];

    for (const [missingNotificationFact, notificationNotes] of
      incompleteNotificationNotes) {
      expect(notificationNotes, missingNotificationFact).not.toBe(passedRcNotes);

      const ledgerWithoutNotificationIdentity = passedRcValidation.replace(
        passedRcNotes,
        notificationNotes
      );

      expect(
        missingLinuxReleaseCandidateEvidence(ledgerWithoutNotificationIdentity),
        missingNotificationFact
      ).toContain("notification/window grouping evidence");
      expect(linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutNotificationIdentity))
        .toBe("");
      expect(isLinuxReleaseCandidatePassed(ledgerWithoutNotificationIdentity))
        .toBe(false);
      expect(() =>
        assertLinuxReleaseCandidatePassed(ledgerWithoutNotificationIdentity)
      ).toThrow(/notification\/window grouping evidence/);
    }
  });

  markerLoopIt("requires native window chrome, desktop shell, GPU, resize, and compositor evidence together", () => {
    const incompleteNativeChromeNotes = [
      passedRcNotes.replace("Native window chrome ", ""),
      passedRcNotes.replace("Ubuntu Desktop ", ""),
      passedRcNotes.replace("X11/Wayland notes ", ""),
      passedRcNotes.replace("desktop shell/display and GPU renderer probes, ", ""),
      passedRcNotes.replace("GPU renderer probes, ", ""),
      passedRcNotes.replace("resize, ", ""),
      passedRcNotes.replace("compositor observations. ", "")
    ];

    for (const nativeChromeNotes of incompleteNativeChromeNotes) {
      const ledgerWithoutNativeChromeFacts = passedRcValidation.replace(
        passedRcNotes,
        nativeChromeNotes
      );

      expect(
        missingLinuxReleaseCandidateEvidence(ledgerWithoutNativeChromeFacts)
      ).toContain("native window chrome evidence");
      expect(
        linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutNativeChromeFacts)
      ).toBe("");
      expect(isLinuxReleaseCandidatePassed(ledgerWithoutNativeChromeFacts))
        .toBe(false);
      expect(() =>
        assertLinuxReleaseCandidatePassed(ledgerWithoutNativeChromeFacts)
      ).toThrow(/native window chrome evidence/);
    }
  });

  markerLoopIt("requires shortcut policy, terminal input, GNOME defaults, keyboard smoke, and keybinding probe evidence together", () => {
    const incompleteShortcutNotes = [
      passedRcNotes.replace("Shortcut policy ", ""),
      passedRcNotes.replace("terminal input ", ""),
      passedRcNotes.replace("GNOME defaults ", ""),
      passedRcNotes.replace("keyboard smoke notes ", ""),
      passedRcNotes.replace("GNOME keybinding probes. ", "")
    ];

    for (const shortcutNotes of incompleteShortcutNotes) {
      const ledgerWithoutShortcutFacts = passedRcValidation.replace(
        passedRcNotes,
        shortcutNotes
      );

      expect(
        missingLinuxReleaseCandidateEvidence(ledgerWithoutShortcutFacts)
      ).toContain("shortcut policy evidence");
      expect(
        linuxReleasePrimaryRcEvidenceEntry(ledgerWithoutShortcutFacts)
      ).toBe("");
      expect(isLinuxReleaseCandidatePassed(ledgerWithoutShortcutFacts))
        .toBe(false);
      expect(() =>
        assertLinuxReleaseCandidatePassed(ledgerWithoutShortcutFacts)
      ).toThrow(/shortcut policy evidence/);
    }
  });

  it("requires the RC artifact marker to reference the kmux Linux AppImage", () => {
    const invalidArtifactLedgers = [
      passedRcValidation.replace(
        "Artifact: apps/desktop/release/kmux-0.3.12-linux-x64.AppImage",
        "Artifact: apps/desktop/release/kmux-0.3.12-linux-x64.AppImage.blockmap"
      ),
      passedRcValidation.replace(
        "Artifact: apps/desktop/release/kmux-0.3.12-linux-x64.AppImage",
        "Artifact: apps/desktop/release/other-tool-0.3.12-linux-x64.AppImage"
      ),
      passedRcValidation.replace(
        "Artifact: apps/desktop/release/kmux-0.3.12-linux-x64.AppImage",
        "Artifact: apps/desktop/release/kmux-0.3.12-mac-x64.AppImage"
      )
    ];

    for (const invalidArtifactLedger of invalidArtifactLedgers) {
      expect(missingLinuxReleaseCandidateEvidence(invalidArtifactLedger))
        .toContain("AppImage artifact");
      expect(linuxReleasePrimaryRcEvidenceEntry(invalidArtifactLedger)).toBe("");
      expect(isLinuxReleaseCandidatePassed(invalidArtifactLedger)).toBe(false);
      expect(() =>
        assertLinuxReleaseCandidatePassed(invalidArtifactLedger)
      ).toThrow(/AppImage artifact/);
    }
  });

  it("documents every required RC evidence marker used by the release gate", () => {
    const currentRcValidation = readFileSync(
      "docs/linux-release-validation.md",
      "utf8"
    );

    for (const marker of requiredLinuxReleaseCandidateEvidenceLabels()) {
      expect(currentRcValidation).toContain(`- ${marker}`);
    }
    for (const rowLabel of requiredLinuxReleaseStatusRowLabels()) {
      expect(currentRcValidation).toContain(rowLabel);
    }
    expect(linuxReleaseMissingRequiredEvidenceRows(currentRcValidation))
      .toEqual([]);
  });

  it("documents rejected updater metadata mismatch caveats", () => {
    const currentRcValidation = readFileSync(
      "docs/linux-release-validation.md",
      "utf8"
    );

    for (const rejectedPhrase of [
      "checksum mismatch",
      "checksums differ",
      "sha512 not equal",
      "not-equal",
      "size did not match",
      "inconsistent"
    ]) {
      expect(currentRcValidation).toContain(rejectedPhrase);
    }
  });

  it("documents required updater channel and release visibility evidence", () => {
    const currentRcValidation = readFileSync(
      "docs/linux-release-validation.md",
      "utf8"
    );

    expect(currentRcValidation).toContain("channel naming");
    expect(currentRcValidation).toContain("release visibility");
  });

  it("documents that the workflow gate must run before publishing", () => {
    const currentRcValidation = readFileSync(
      "docs/linux-release-validation.md",
      "utf8"
    );

    expect(currentRcValidation).toContain(
      "before any `gh release upload`, `gh release create`, `gh release edit`, or GitHub release action publishing step"
    );
  });

  it("documents rejected unconfirmed observation caveats", () => {
    const currentRcValidation = readFileSync(
      "docs/linux-release-validation.md",
      "utf8"
    );

    for (const rejectedPhrase of [
      "not checked",
      "not confirmed",
      "not observed",
      "not proven",
      "not validated",
      "unconfirmed"
    ]) {
      expect(currentRcValidation).toContain(rejectedPhrase);
    }
  });

  it("documents rejected non-RC report mode caveats", () => {
    const currentRcValidation = readFileSync(
      "docs/linux-release-validation.md",
      "utf8"
    );

    for (const rejectedPhrase of [
      "RC evidence: no",
      "RC evidence: no on this host",
      "Passing RC evidence: no automatic pass",
      "Report mode:",
      "ledger input",
      "portable preflight",
      "walking-skeleton component only"
    ]) {
      expect(currentRcValidation).toContain(rejectedPhrase);
    }
  });

  it("documents required RC evidence provenance and blocker fields", () => {
    const currentRcValidation = readFileSync(
      "docs/linux-release-validation.md",
      "utf8"
    );

    for (const requiredPhrase of [
      "`Date: YYYY-MM-DD`",
      "short or full hex `Commit:`",
      "matches the current git HEAD",
      "current source git worktree is clean",
      "generated release artifact directories",
      "`Report mode`",
      "`Passing RC evidence: no`",
      "`Git dirty: no`",
      "`Remaining blockers: none`"
    ]) {
      expect(currentRcValidation).toContain(requiredPhrase);
    }
  });

  it("keeps local macOS compatibility history non-marker-bearing while the RC has not passed", () => {
    const currentRcValidation = readFileSync(
      "docs/linux-release-validation.md",
      "utf8"
    );
    const currentStatus = linuxReleaseCurrentStatus(currentRcValidation);

    if (/^passed\.?$/i.test(currentStatus)) {
      expect(currentStatus).toMatch(/^passed\.?$/i);
      return;
    }

    const localMacOnlyPassedEntries =
      extractLinuxReleasePassedRecordedEvidenceEntries(
        currentRcValidation
      ).filter(
        (entry) =>
          /Environment:\s*macOS\b/i.test(entry) &&
          /local unsigned\/unnotarized package check/i.test(entry)
      );

    expect(currentRcValidation).toContain(
      "Result: Passed on macOS compatibility only; not Linux RC evidence."
    );
    expect(localMacOnlyPassedEntries).toEqual([]);
  });

  it("keeps the evidence entry template fields compatible with the release parser", () => {
    const currentRcValidation = readFileSync(
      "docs/linux-release-validation.md",
      "utf8"
    );
    const templateSection = extractLinuxReleaseMarkdownSection(
      currentRcValidation,
      "Evidence Entry Template"
    );
    const templateEntry = templateSection.match(
      /```text\n([\s\S]*?)\n```/
    )?.[1];

    expect(templateEntry).toBeTruthy();
    expect(
      parseLinuxReleaseEvidenceEntryFields(templateEntry)["Git dirty"]
    ).toBe("no");
  });

  it("documents the required kmux Linux AppImage artifact shape", () => {
    const currentRcValidation = readFileSync(
      "docs/linux-release-validation.md",
      "utf8"
    );

    expect(currentRcValidation).toContain(
      "`kmux-<version>-linux-<arch>.AppImage`"
    );
  });

  it("does not treat status-only RC ledger edits as passed evidence", () => {
    const statusOnlyLedger = "Current status: passed.";

    expect(isLinuxReleaseCandidatePassed(statusOnlyLedger)).toBe(false);
    expect(missingLinuxReleaseCandidateEvidence(statusOnlyLedger)).toEqual([
      "Ubuntu Desktop environment",
      "AppImage artifact",
      "walking skeleton Linux gate command",
      "Linux package command",
      "packaged Linux smoke command",
      "Linux release check command",
      "Linux evidence command",
      "launch/socket shell env evidence",
      "PATH recovery evidence",
      "node-pty spawn evidence",
      "hook runtime env evidence",
      "agent hook notification evidence",
      "Codex wrapper evidence",
      "agent workflow evidence",
      "filesystem watch/resync evidence",
      "AppImage updater evidence",
      "AppImage provenance/env evidence",
      "AppImage startup/sandbox evidence",
      "AppImage desktop entry evidence",
      "notification/window grouping evidence",
      "native window chrome evidence",
      "shortcut policy evidence",
      "terminal font/cell metrics evidence",
      "IME/input-method evidence",
      "output continuity evidence",
      "Linux docs evidence",
      "validation matrix evidence",
      "macOS compatibility evidence",
      "macOS release check command"
    ]);
    expect(() => assertLinuxReleaseCandidatePassed(statusOnlyLedger)).toThrow(
      /Missing required RC evidence markers/
    );
    expect(() => assertLinuxReleaseCandidatePassed(statusOnlyLedger)).toThrow(
      /Result.*Passed/
    );
  });

  it("rejects passed RC evidence entries that still contain placeholders", () => {
    const placeholderLedger = passedRcValidation.replace(
      "\n## Environment Matrix",
      "\nRemaining blockers: <fill after manual validation>\n\n## Environment Matrix"
    );

    expect(missingLinuxReleaseCandidateEvidence(placeholderLedger)).toEqual([]);
    expect(linuxReleaseCandidatePlaceholderEvidence(placeholderLedger)).toEqual([
      "Remaining blockers: <fill after manual validation>"
    ]);
    expect(isLinuxReleaseCandidatePassed(placeholderLedger)).toBe(false);
    expect(() => assertLinuxReleaseCandidatePassed(placeholderLedger)).toThrow(
      /placeholder text/
    );
  });

  it("requires passed RC evidence entries to include release provenance and blocker fields", () => {
    const missingOrInvalidFieldLedgers = [
      {
        ledger: passedRcValidation.replace("Date: 2026-06-10\n", ""),
        failure: "Primary Ubuntu Desktop/AppImage RC evidence: Date is missing"
      },
      {
        ledger: passedRcValidation.replace(
          "Date: 2026-06-10",
          "Date: June 10, 2026"
        ),
        failure:
          "Primary Ubuntu Desktop/AppImage RC evidence: Date must be YYYY-MM-DD; got June 10, 2026"
      },
      {
        ledger: passedRcValidation.replace(
          "Commit: abc1234",
          "Commit: local working tree"
        ),
        failure:
          "Primary Ubuntu Desktop/AppImage RC evidence: Commit must be short or full git SHA; got local working tree"
      },
      {
        ledger: passedRcValidation.replace("Git dirty: no", "Git dirty: yes"),
        failure:
          "Primary Ubuntu Desktop/AppImage RC evidence: Git dirty must be no; got yes"
      },
      {
        ledger: passedRcValidation.replace(
          "Remaining blockers: none",
          "Remaining blockers: manual validation needed"
        ),
        failure:
          "Primary Ubuntu Desktop/AppImage RC evidence: Remaining blockers must be none; got manual validation needed"
      }
    ];

    for (const { ledger, failure } of missingOrInvalidFieldLedgers) {
      expect(linuxReleaseRcEvidenceFieldFailures(ledger)).toContain(failure);
      expect(isLinuxReleaseCandidatePassed(ledger)).toBe(false);
      expect(() => assertLinuxReleaseCandidatePassed(ledger)).toThrow(
        /release provenance and blocker fields/
      );
    }
  });

  it("rejects stale passed RC evidence when current commit comparison is required", () => {
    const staleCommitLedger = passedRcValidation.replace(
      "Commit: abc1234",
      "Commit: def5678"
    );

    expect(
      linuxReleaseRcEvidenceFieldFailures(staleCommitLedger, {
        currentCommit: "abc1234567890abcdef"
      })
    ).toContain(
      "Primary Ubuntu Desktop/AppImage RC evidence: Commit must match current HEAD abc1234567890abcdef; got def5678"
    );
    expect(() =>
      assertLinuxReleaseCandidatePassed(staleCommitLedger, {
        currentCommit: "abc1234567890abcdef"
      })
    ).toThrow(/current source commit/);
    expect(() =>
      assertLinuxPublicPublishingGate({
        env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
        assetsDir: "/tmp/kmux-missing-release-assets",
        rcValidationText: staleCommitLedger,
        currentCommit: "abc1234567890abcdef"
      })
    ).toThrow(/Commit must match current HEAD/);
  });

  it("rejects enabled public publishing when the current git commit is unavailable", () => {
    expect(() =>
      assertLinuxPublicPublishingGate({
        env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
        assetsDir: "/tmp/kmux-missing-release-assets",
        rcValidationText: passedRcValidation,
        currentCommit: ""
      })
    ).toThrow(/current git commit is unavailable/);
  });

  it("rejects enabled public publishing when the current source git worktree is dirty", () => {
    for (const currentGitDirty of ["yes", "unknown"]) {
      expect(() =>
        assertLinuxPublicPublishingGate({
          env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
          assetsDir: "/tmp/kmux-missing-release-assets",
          rcValidationText: passedRcValidation,
          currentCommit: "abc1234567890abcdef",
          currentGitDirty
        })
      ).toThrow(/requires a clean current source git worktree/);
    }
  });

  it("requires Linux release assets after public publishing is enabled", () => {
    expect(() =>
      assertLinuxPublicPublishingGate({
        env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
        assetsDir: "/tmp/kmux-missing-release-assets",
        rcValidationText: passedRcValidation,
        workflowText: "assets=(release-assets/*.AppImage)",
        currentCommit: "abc1234567890abcdef",
        currentGitDirty: "no"
      })
    ).toThrow(/no Linux release assets were found/);
  });

  it("requires an AppImage artifact after public publishing is enabled", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-release-metadata-"));
    try {
      writeFileSync(path.join(root, "latest-linux.yml"), "metadata");

      expect(() =>
        assertLinuxPublicPublishingGate({
          env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
          assetsDir: root,
          rcValidationText: passedRcValidation,
          workflowText: "assets=(release-assets/*.AppImage)",
          currentCommit: "abc1234567890abcdef",
          currentGitDirty: "no"
        })
      ).toThrow(/no AppImage artifact was found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects generic AppImage artifact names after public publishing is enabled", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "kmux-linux-release-appimage-name-")
    );
    try {
      writeValidLinuxReleaseAssets(root, { appImageName: "custom.AppImage" });

      expect(() =>
        assertLinuxPublicPublishingGate({
          env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
          assetsDir: root,
          rcValidationText: passedRcValidation,
          workflowText: [
            "- name: Verify Linux public release gate",
            "  run: node scripts/release-check-linux.mjs",
            "- name: Publish GitHub release",
            "  run: gh release upload \"$GITHUB_REF_NAME\" release-assets/*.AppImage release-assets/*.AppImage.blockmap release-assets/latest-linux.yml"
          ].join("\n"),
          currentCommit: "abc1234567890abcdef",
          currentGitDirty: "no"
        })
      ).toThrow(/kmux-<version>-linux-<arch>\.AppImage/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires AppImage blockmap sidecars after public publishing is enabled", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-release-blockmap-"));
    try {
      writeFileSync(
        path.join(root, "kmux-0.3.12-linux-x64.AppImage"),
        "appimage"
      );
      writeFileSync(path.join(root, "latest-linux.yml"), "metadata");

      expect(() =>
        assertLinuxPublicPublishingGate({
          env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
          assetsDir: root,
          rcValidationText: passedRcValidation,
          workflowText: "assets=(release-assets/*.AppImage)",
          currentCommit: "abc1234567890abcdef",
          currentGitDirty: "no"
        })
      ).toThrow(/AppImage blockmap sidecars are missing/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires non-empty AppImage blockmap sidecars after public publishing is enabled", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "kmux-linux-release-empty-blockmap-")
    );
    try {
      writeValidLinuxReleaseAssets(root, { blockmapContent: "" });

      expect(() =>
        assertLinuxPublicPublishingGate({
          env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
          assetsDir: root,
          rcValidationText: passedRcValidation,
          workflowText: "assets=(release-assets/*.AppImage)",
          currentCommit: "abc1234567890abcdef",
          currentGitDirty: "no"
        })
      ).toThrow(/AppImage blockmap sidecars are missing or empty/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires latest-linux update metadata after public publishing is enabled", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-release-metadata-"));
    try {
      writeFileSync(
        path.join(root, "kmux-0.3.12-linux-x64.AppImage"),
        "appimage"
      );
      writeFileSync(
        path.join(root, "kmux-0.3.12-linux-x64.AppImage.blockmap"),
        "blockmap"
      );

      expect(() =>
        assertLinuxPublicPublishingGate({
          env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
          assetsDir: root,
          rcValidationText: passedRcValidation,
          workflowText: "assets=(release-assets/*.AppImage)",
          currentCommit: "abc1234567890abcdef",
          currentGitDirty: "no"
        })
      ).toThrow(/no latest-linux update metadata was found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires latest-linux update metadata to match AppImage checksum and size after public publishing is enabled", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "kmux-linux-release-stale-metadata-")
    );
    try {
      writeValidLinuxReleaseAssets(root);
      writeFileSync(
        path.join(root, "latest-linux.yml"),
        [
          "version: 0.3.12",
          "path: kmux-0.3.12-linux-x64.AppImage",
          "sha512: stale",
          "files:",
          "  - url: kmux-0.3.12-linux-x64.AppImage",
          "    sha512: stale",
          "    size: 1"
        ].join("\n")
      );

      expect(() =>
        assertLinuxPublicPublishingGate({
          env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
          assetsDir: root,
          rcValidationText: passedRcValidation,
          workflowText: "assets=(release-assets/*.AppImage)",
          currentCommit: "abc1234567890abcdef",
          currentGitDirty: "no"
        })
      ).toThrow(/latest-linux update metadata does not match/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires every matching latest-linux update metadata asset to match after public publishing is enabled", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "kmux-linux-release-duplicate-metadata-")
    );
    try {
      writeValidLinuxReleaseAssets(root);
      writeFileSync(
        path.join(root, "latest-linux.yaml"),
        readFileSync(path.join(root, "latest-linux.yml"), "utf8")
      );
      writeFileSync(
        path.join(root, "latest-linux.yml"),
        [
          "version: 0.3.12",
          "path: kmux-0.3.12-linux-x64.AppImage",
          "sha512: stale",
          "files:",
          "  - url: kmux-0.3.12-linux-x64.AppImage",
          "    sha512: stale",
          "    size: 1"
        ].join("\n")
      );

      expect(() =>
        assertLinuxPublicPublishingGate({
          env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
          assetsDir: root,
          rcValidationText: passedRcValidation,
          workflowText: "assets=(release-assets/*.AppImage)",
          currentCommit: "abc1234567890abcdef",
          currentGitDirty: "no"
        })
      ).toThrow(/kmux-0\.3\.12-linux-x64\.AppImage with latest-linux\.yml/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires latest-linux update metadata to be colocated with nested AppImage assets after public publishing is enabled", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "kmux-linux-release-nested-metadata-")
    );
    try {
      writeValidLinuxReleaseAssets(root, {
        appImageName: "linux-x64-release-assets/kmux-0.3.12-linux-x64.AppImage"
      });

      expect(() =>
        assertLinuxPublicPublishingGate({
          env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
          assetsDir: root,
          rcValidationText: passedRcValidation,
          workflowText:
            "assets=(release-assets/linux-x64-release-assets/*.AppImage)",
          currentCommit: "abc1234567890abcdef",
          currentGitDirty: "no"
        })
      ).toThrow(
        /missing expected linux-x64-release-assets\/latest-linux\.yml/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts colocated latest-linux update metadata for nested AppImage assets after public publishing is enabled", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "kmux-linux-release-nested-colocated-metadata-")
    );
    try {
      writeValidLinuxReleaseAssets(root, {
        appImageName: "linux-x64-release-assets/kmux-0.3.12-linux-x64.AppImage",
        metadataName: "linux-x64-release-assets/latest-linux.yml"
      });

      const result = assertLinuxPublicPublishingGate({
        env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
        assetsDir: root,
        rcValidationText: passedRcValidation,
        workflowText: [
          "- name: Verify Linux public release gate",
          "  run: node scripts/release-check-linux.mjs",
          "- name: Publish GitHub release",
          "  run: gh release upload \"$GITHUB_REF_NAME\" release-assets/linux-x64-release-assets/*.AppImage release-assets/linux-x64-release-assets/*.AppImage.blockmap release-assets/linux-x64-release-assets/latest-linux.yml"
        ].join("\n"),
        currentCommit: "abc1234567890abcdef",
        currentGitDirty: "no"
      });

      expect(result.enabled).toBe(true);
      expect(result.linuxAssets).toEqual([
        "linux-x64-release-assets/kmux-0.3.12-linux-x64.AppImage",
        "linux-x64-release-assets/kmux-0.3.12-linux-x64.AppImage.blockmap",
        "linux-x64-release-assets/latest-linux.yml"
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires latest-linux update metadata version to match the AppImage version after public publishing is enabled", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "kmux-linux-release-stale-version-")
    );
    try {
      writeValidLinuxReleaseAssets(root);
      const appImageContent = "appimage";
      const appImageSha512 = sha512Base64(appImageContent);
      writeFileSync(
        path.join(root, "latest-linux.yml"),
        [
          "version: 0.3.11",
          "path: kmux-0.3.12-linux-x64.AppImage",
          `sha512: ${appImageSha512}`,
          "files:",
          "  - url: kmux-0.3.12-linux-x64.AppImage",
          `    sha512: ${appImageSha512}`,
          `    size: ${Buffer.byteLength(appImageContent)}`
        ].join("\n")
      );

      expect(() =>
        assertLinuxPublicPublishingGate({
          env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
          assetsDir: root,
          rcValidationText: passedRcValidation,
          workflowText: "assets=(release-assets/*.AppImage)",
          currentCommit: "abc1234567890abcdef",
          currentGitDirty: "no"
        })
      ).toThrow(/latest-linux update metadata does not match/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts matching arch-specific update metadata after public publishing is enabled", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "kmux-linux-release-arch-metadata-")
    );
    try {
      writeValidLinuxReleaseAssets(root);
      writeValidLinuxReleaseAssets(root, {
        appImageName: "kmux-0.3.12-linux-arm64.AppImage",
        appImageContent: "arm64 appimage",
        metadataName: "latest-linux-arm64.yml"
      });

      const result = assertLinuxPublicPublishingGate({
        env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
        assetsDir: root,
        rcValidationText: passedRcValidation,
        workflowText: [
          "- name: Verify Linux public release gate",
          "  run: node scripts/release-check-linux.mjs",
          "- name: Publish GitHub release",
          "  run: gh release upload \"$GITHUB_REF_NAME\" release-assets/*.AppImage release-assets/*.AppImage.blockmap release-assets/latest-linux.yml release-assets/latest-linux-arm64.yml"
        ].join("\n"),
        currentCommit: "abc1234567890abcdef",
        currentGitDirty: "no"
      });

      expect(result.enabled).toBe(true);
      expect(result.linuxAssets).toHaveLength(6);
      expect(result.linuxAssets).toEqual(
        expect.arrayContaining([
          "kmux-0.3.12-linux-x64.AppImage",
          "kmux-0.3.12-linux-x64.AppImage.blockmap",
          "latest-linux.yml",
          "kmux-0.3.12-linux-arm64.AppImage",
          "kmux-0.3.12-linux-arm64.AppImage.blockmap",
          "latest-linux-arm64.yml"
        ])
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unexpected Linux release assets after public publishing is enabled", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "kmux-linux-release-unexpected-assets-")
    );
    try {
      writeValidLinuxReleaseAssets(root);
      writeFileSync(path.join(root, "custom.AppImage.blockmap"), "blockmap");
      writeFileSync(path.join(root, "latest-linux-arm64.yml"), "metadata");
      writeFileSync(path.join(root, "kmux-0.3.12-linux-x64.deb"), "deb");
      writeFileSync(path.join(root, "linux-release-notes.txt"), "notes");

      let failure;
      try {
        assertLinuxPublicPublishingGate({
          env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
          assetsDir: root,
          rcValidationText: passedRcValidation,
          workflowText: [
            "- name: Verify Linux public release gate",
            "  run: node scripts/release-check-linux.mjs",
            "- name: Publish GitHub release",
            "  run: gh release upload \"$GITHUB_REF_NAME\" release-assets/*.AppImage release-assets/*.AppImage.blockmap release-assets/latest-linux.yml"
          ].join("\n"),
          currentCommit: "abc1234567890abcdef",
          currentGitDirty: "no"
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain("unexpected Linux release assets");
      expect(failure.message).toContain("- custom.AppImage.blockmap");
      expect(failure.message).toContain("- latest-linux-arm64.yml");
      expect(failure.message).toContain("- kmux-0.3.12-linux-x64.deb");
      expect(failure.message).toContain("- linux-release-notes.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires the release workflow to upload Linux artifacts after public publishing is enabled", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-release-enabled-"));
    try {
      writeValidLinuxReleaseAssets(root);

      expect(() =>
        assertLinuxPublicPublishingGate({
          env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
          assetsDir: root,
          rcValidationText: passedRcValidation,
          workflowText: [
            "- name: Verify Linux public release gate",
            "  run: node scripts/release-check-linux.mjs",
            "- name: Publish GitHub release",
            "  run: gh release upload \"$GITHUB_REF_NAME\" release-assets/*.dmg"
          ].join("\n"),
          currentCommit: "abc1234567890abcdef",
          currentGitDirty: "no"
        })
      ).toThrow(/release workflow does not upload Linux artifacts/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires the release workflow to upload AppImage artifacts after public publishing is enabled", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-release-appimage-"));
    try {
      writeValidLinuxReleaseAssets(root);

      expect(() =>
        assertLinuxPublicPublishingGate({
          env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
          assetsDir: root,
          rcValidationText: passedRcValidation,
          workflowText: [
            "- name: Verify Linux public release gate",
            "  run: node scripts/release-check-linux.mjs",
            "- name: Publish GitHub release",
            "  run: gh release upload \"$GITHUB_REF_NAME\" release-assets/latest-linux.yml"
          ].join("\n"),
          currentCommit: "abc1234567890abcdef",
          currentGitDirty: "no"
        })
      ).toThrow(/release workflow does not upload AppImage artifacts/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires the public release gate before publishing after Linux uploads are enabled", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-release-order-"));
    try {
      writeValidLinuxReleaseAssets(root);

      expect(() =>
        assertLinuxPublicPublishingGate({
          env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
          assetsDir: root,
          rcValidationText: passedRcValidation,
          workflowText: [
            "- name: Publish GitHub release",
            "  run: gh release upload \"$GITHUB_REF_NAME\" release-assets/*.AppImage",
            "- name: Verify Linux public release gate",
            "  run: node scripts/release-check-linux.mjs"
          ].join("\n"),
          currentCommit: "abc1234567890abcdef",
          currentGitDirty: "no"
        })
      ).toThrow(/does not run the Linux public release gate before publishing/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires separate macOS compatibility evidence to include release provenance and blocker fields", () => {
    const ledgerWithSeparateMacEvidence = passedRcValidation
      .replace("; npm run release:check:mac", "")
      .replace(" macOS compatibility evidence remains green.", "")
      .replace(
        "\n## Environment Matrix",
        [
          "",
          "Date: 2026-06-10",
          "Commit: local working tree",
          "Git dirty: no",
          "Environment: macOS Darwin 25.5.0",
          "Commands: npm run release:check:mac",
          "Result: Passed.",
          "Notes: macOS compatibility evidence remains green.",
          "Remaining blockers: none",
          "",
          "## Environment Matrix"
        ].join("\n")
      );

    expect(linuxReleasePrimaryRcEvidenceEntry(ledgerWithSeparateMacEvidence))
      .not.toBe("");
    expect(linuxReleaseMacCompatibilityEvidenceEntry(ledgerWithSeparateMacEvidence))
      .not.toBe("");
    expect(linuxReleaseRcEvidenceFieldFailures(ledgerWithSeparateMacEvidence))
      .toContain(
        "macOS compatibility RC evidence: Commit must be short or full git SHA; got local working tree"
      );
    expect(isLinuxReleaseCandidatePassed(ledgerWithSeparateMacEvidence)).toBe(
      false
    );
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithSeparateMacEvidence)
    ).toThrow(/release provenance and blocker fields/);
  });

  it("rejects stale separate macOS compatibility evidence when current commit comparison is required", () => {
    const ledgerWithStaleSeparateMacEvidence = passedRcValidation
      .replace("; npm run release:check:mac", "")
      .replace(" macOS compatibility evidence remains green.", "")
      .replace(
        "\n## Environment Matrix",
        [
          "",
          "Date: 2026-06-10",
          "Commit: def5678",
          "Git dirty: no",
          "Environment: macOS Darwin 25.5.0",
          "Commands: npm run release:check:mac",
          "Result: Passed.",
          "Notes: macOS compatibility evidence remains green.",
          "Remaining blockers: none",
          "",
          "## Environment Matrix"
        ].join("\n")
      );

    expect(
      linuxReleaseRcEvidenceFieldFailures(ledgerWithStaleSeparateMacEvidence, {
        currentCommit: "abc1234567890abcdef"
      })
    ).toContain(
      "macOS compatibility RC evidence: Commit must match current HEAD abc1234567890abcdef; got def5678"
    );
    expect(() =>
      assertLinuxReleaseCandidatePassed(ledgerWithStaleSeparateMacEvidence, {
        currentCommit: "abc1234567890abcdef"
      })
    ).toThrow(/current source commit/);
  });

  it("rejects primary Ubuntu AppImage evidence with failed or unverified observations", () => {
    const failedObservationNotes = passedRcNotes.replace(
      "AppImage updater check, download, and install passed",
      "AppImage updater check, download, and install failed"
    );
    const failedObservationLedger = passedRcValidation.replace(
      passedRcNotes,
      failedObservationNotes
    );

    expect(missingLinuxReleaseCandidateEvidence(failedObservationLedger))
      .toEqual([]);
    expect(linuxReleasePrimaryRcEvidenceEntry(failedObservationLedger))
      .toContain("Environment: Ubuntu Desktop");
    expect(linuxReleasePrimaryRcEvidenceCaveats(failedObservationLedger))
      .toEqual([failedObservationNotes]);
    expect(isLinuxReleaseCandidatePassed(failedObservationLedger)).toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(failedObservationLedger)
    ).toThrow(
      /incomplete, failed, unconfirmed, mismatched, target-negating, non-RC, or script-development-only evidence text/
    );

    const negatedNotificationNotes = passedRcNotes.replace(
      "Desktop notification title/body/icon app attribution and Ubuntu notification center/window grouping matched the kmux window, tied to recorded DBus/session and desktop-entry facts.",
      "Desktop notification title/body/icon app attribution and Ubuntu notification center/window grouping not matched the kmux window, tied to recorded DBus/session and desktop-entry facts."
    );
    const negatedNotificationLedger = passedRcValidation.replace(
      passedRcNotes,
      negatedNotificationNotes
    );

    expect(missingLinuxReleaseCandidateEvidence(negatedNotificationLedger))
      .toEqual([]);
    expect(linuxReleasePrimaryRcEvidenceEntry(negatedNotificationLedger))
      .toContain("Environment: Ubuntu Desktop");
    expect(linuxReleasePrimaryRcEvidenceCaveats(negatedNotificationLedger))
      .toEqual([negatedNotificationNotes]);
    expect(isLinuxReleaseCandidatePassed(negatedNotificationLedger)).toBe(
      false
    );
    expect(() =>
      assertLinuxReleaseCandidatePassed(negatedNotificationLedger)
    ).toThrow(
      /incomplete, failed, unconfirmed, mismatched, target-negating, non-RC, or script-development-only evidence text/
    );

    const unverifiedNotificationNotes = passedRcNotes.replace(
      "Desktop notification title/body/icon app attribution and Ubuntu notification center/window grouping matched the kmux window, tied to recorded DBus/session and desktop-entry facts.",
      "Desktop notification title/body/icon app attribution and Ubuntu notification center/window grouping unverified, tied to recorded DBus/session and desktop-entry facts."
    );
    const unverifiedNotificationLedger = passedRcValidation.replace(
      passedRcNotes,
      unverifiedNotificationNotes
    );

    expect(
      missingLinuxReleaseCandidateEvidence(unverifiedNotificationLedger)
    ).toEqual([
      "notification/window grouping evidence"
    ]);
    expect(linuxReleasePrimaryRcEvidenceEntry(unverifiedNotificationLedger))
      .toBe("");
    expect(isLinuxReleaseCandidatePassed(unverifiedNotificationLedger)).toBe(
      false
    );
    expect(() =>
      assertLinuxReleaseCandidatePassed(unverifiedNotificationLedger)
    ).toThrow(/Missing required RC evidence markers/);
  });

  it("rejects passed RC evidence collected with script-development platform bypass", () => {
    const allowAnyPlatformLedger = passedRcValidation.replace(
      "npm run release:evidence:linux -- --output docs/plans/linux-rc-evidence-2026-06-10.md",
      "npm run release:evidence:linux -- --allow-any-platform --output docs/plans/linux-rc-evidence-2026-06-10.md"
    );

    expect(missingLinuxReleaseCandidateEvidence(allowAnyPlatformLedger))
      .toEqual([]);
    expect(linuxReleasePrimaryRcEvidenceEntry(allowAnyPlatformLedger))
      .toContain("Environment: Ubuntu Desktop");
    expect(linuxReleasePrimaryRcEvidenceCaveats(allowAnyPlatformLedger))
      .toEqual([
        "Commands: npm run gate:walking-skeleton:linux; npm run package:linux; npm run smoke:packaged:linux; npm run release:check:linux; npm run release:evidence:linux -- --allow-any-platform --output docs/plans/linux-rc-evidence-2026-06-10.md; npm run release:check:mac"
      ]);
    expect(isLinuxReleaseCandidatePassed(allowAnyPlatformLedger)).toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(allowAnyPlatformLedger)
    ).toThrow(/script-development-only evidence text/);
  });

  it("rejects passed RC evidence collected with non-RC packaged smoke diagnostics", () => {
    const allowAnyLinuxDesktopLedger = passedRcValidation.replace(
      "npm run smoke:packaged:linux",
      "npm run smoke:packaged:linux -- --allow-any-linux-desktop"
    );

    expect(missingLinuxReleaseCandidateEvidence(allowAnyLinuxDesktopLedger))
      .toEqual([]);
    expect(linuxReleasePrimaryRcEvidenceEntry(allowAnyLinuxDesktopLedger))
      .toContain("Environment: Ubuntu Desktop");
    expect(linuxReleasePrimaryRcEvidenceCaveats(allowAnyLinuxDesktopLedger))
      .toEqual([
        "Commands: npm run gate:walking-skeleton:linux; npm run package:linux; npm run smoke:packaged:linux -- --allow-any-linux-desktop; npm run release:check:linux; npm run release:evidence:linux -- --output docs/plans/linux-rc-evidence-2026-06-10.md; npm run release:check:mac"
      ]);
    expect(isLinuxReleaseCandidatePassed(allowAnyLinuxDesktopLedger))
      .toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(allowAnyLinuxDesktopLedger)
    ).toThrow(/script-development-only evidence text/);
  });

  it("rejects passed RC evidence collected with skipped walking-skeleton checks", () => {
    const skippedGateLedger = passedRcValidation.replace(
      "npm run gate:walking-skeleton:linux",
      "npm run gate:walking-skeleton:linux -- --skip-e2e --skip-build"
    );

    expect(missingLinuxReleaseCandidateEvidence(skippedGateLedger))
      .toEqual([]);
    expect(linuxReleasePrimaryRcEvidenceEntry(skippedGateLedger))
      .toContain("Environment: Ubuntu Desktop");
    expect(linuxReleasePrimaryRcEvidenceCaveats(skippedGateLedger))
      .toEqual([
        "Commands: npm run gate:walking-skeleton:linux -- --skip-e2e --skip-build; npm run package:linux; npm run smoke:packaged:linux; npm run release:check:linux; npm run release:evidence:linux -- --output docs/plans/linux-rc-evidence-2026-06-10.md; npm run release:check:mac"
      ]);
    expect(isLinuxReleaseCandidatePassed(skippedGateLedger)).toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(skippedGateLedger)
    ).toThrow(/script-development-only evidence text/);
  });

  it("rejects passed RC evidence that describes itself as non-RC or script-development output", () => {
    const caveatPhrases = [
      "non-RC diagnostics",
      "RC evidence: no",
      "Passing RC evidence: no automatic pass",
      "Report mode: script-development/non-RC",
      "Report mode: Ubuntu Desktop ledger input",
      "Gate mode: portable preflight on darwin",
      "RC evidence: walking-skeleton component only",
      "Release visibility/updater install: not validated by packaged smoke",
      "Notification delivery/window grouping: not validated by packaged smoke; record notification title/body/icon app attribution observed in the Ubuntu notification center and window grouping matched the app window separately in the RC ledger",
      "needs manual validation",
      "requires manual observations",
      "still requires manual Ubuntu Desktop validation",
      "manual validation required",
      "manual Ubuntu Desktop/AppImage RC validation required",
      "manual notification/window grouping validation needed",
      "diagnostics only",
      "diagnostics-only",
      "script-development report-shape",
      "simulated updater validation",
      "mocked notification validation",
      "stubbed output continuity validation",
      "dry-run updater validation",
      "xvfb startup smoke",
      "headless AppImage smoke",
      "fixture-only evidence"
    ];

    for (const caveatPhrase of caveatPhrases) {
      const caveatedObservationLine =
        `Notes: GUI launch opened a normal window from the recorded launch path and screenshot/run log. Terminal launch and GUI launch resolved shell env, and CLI plus desktop used the same POSIX socket. PATH recovery passed for the GUI-launched app shell env with nvm, pyenv, cargo, ~/.local/bin, and installed agent CLIs observed. node-pty spawned shells in dev and packaged AppImage builds through ShellLaunchPolicy with AppImage sandbox env and user-namespace settings recorded. Hook runtime env in pty sessions included KMUX_SOCKET_PATH, KMUX_AGENT_BIN_DIR, and KMUX_NODE_PATH. Codex, Claude, Gemini, and Antigravity hooks notified when installed and configured with per-agent hook logs and UI notification evidence. Codex wrapper worked with shell rc integration disabled in a targeted Codex wrapper run. External session discovery and resume passed for verified vendor roots tied to agent storage roots. Usage history and subscription usage passed with verified credential source, recorded storage-root evidence, and dashboard evidence. Missing credentials showed normal unavailable/disconnected states with recorded missing credential paths. Usage/subscription subprocesses made no macOS security command calls, and Linux subprocess audit recorded platform-specific script probing args, script command availability, parsed ps process-table rows, and bounded lsof listening-socket samples. Filesystem watch/resync passed: missed events still produced eventual usage and external-session refresh, with inotify limit diagnostics recorded. AppImage updater check, download, and install passed with electron-updater using latest-linux.yml metadata; channel naming, release visibility, and the AppImage blockmap sidecar matched intended policy; top-level sha512, AppImage file-entry sha512, actual AppImage sha512, and size consistency matched the packaged AppImage during ${caveatPhrase}. ` +
        "AppImage provenance recorded Git dirty state, APPIMAGE env behavior, and selected AppImage artifact path. " +
        "AppImage startup passed with sandbox and user-namespace settings recorded; --no-sandbox was not needed. " +
        "AppImage extracted desktop entry app name, icon, categories, StartupWMClass=kmux, installed desktop-entry candidate evidence, and resources/notificationIcon.png notification icon resource output matched. Runtime and packaged identity alignment matched app id, app name, executable name, desktop entry Name, and StartupWMClass=kmux. " +
        "Desktop notification title/body/icon app attribution and Ubuntu notification center/window grouping matched the kmux window, tied to recorded DBus/session and desktop-entry facts. " +
        "Native window chrome passed on Ubuntu Desktop with X11/Wayland notes tied to recorded desktop shell/display and GPU renderer probes, resize, and compositor observations. " +
        "Shortcut policy passed against terminal input and GNOME defaults with keyboard smoke notes tied to recorded GNOME keybinding probes. " +
        "Terminal font loaded and cell metrics stayed stable with fc-list font inventory and xterm observations. " +
        "IME/input-method smoke passed where ibus or fcitx validation was available with IME environment, input notes, and terminal input unaffected. " +
        "Split pane, surface switch, restore, foreground resize, and readable agent output continuity passed. " +
        "User and release docs covered Linux baseline, unsupported scope, AppImage updater behavior, and unavailable credential states. " +
        "Validation matrix covered Ubuntu Desktop LTS GUI launcher, terminal launch, packaged AppImage, dev build, X11 session where available, and Wayland session where available. " +
        "macOS compatibility evidence remains green.";
      const caveatedObservationLedger = passedRcValidation.replace(
        passedRcNotes,
        caveatedObservationLine
      );

      expect(
        missingLinuxReleaseCandidateEvidence(caveatedObservationLedger)
      ).toEqual([]);
      expect(
        linuxReleasePrimaryRcEvidenceEntry(caveatedObservationLedger)
      ).toContain("Environment: Ubuntu Desktop");
      expect(
        linuxReleasePrimaryRcEvidenceCaveats(caveatedObservationLedger)
      ).toEqual([caveatedObservationLine]);
      expect(isLinuxReleaseCandidatePassed(caveatedObservationLedger)).toBe(
        false
      );
      expect(() =>
        assertLinuxReleaseCandidatePassed(caveatedObservationLedger)
      ).toThrow(/script-development-only evidence text/);
    }
  });

  it("rejects the generated handoff if only Result is changed to Passed", () => {
    const generatedHandoffNotes =
      "Notes: TODO replace after manual validation with GUI launch normal window launch path screenshot/run-log evidence; terminal launch shell env; CLI and desktop same POSIX socket; PATH recovery for GUI-launched app shell env with nvm, pyenv, cargo, ~/.local/bin, and installed agent CLIs; node-pty spawned shells in dev and packaged AppImage builds through ShellLaunchPolicy with AppImage sandbox env and user-namespace settings recorded; hook runtime env in pty sessions containing KMUX_SOCKET_PATH, KMUX_AGENT_BIN_DIR, and KMUX_NODE_PATH; Codex, Claude, Gemini, and Antigravity hooks notify when installed and configured with per-agent hook logs and UI notification evidence; Codex wrapper works with shell rc integration disabled in a walking-skeleton or targeted Codex wrapper run; external session discovery/resume for verified vendor roots tied to agent storage roots; usage history; subscription usage with verified credential source, recorded storage-root evidence, and dashboard evidence; missing credentials unavailable/disconnected states with recorded missing credential paths; no macOS security command calls plus platform-specific script probing args, script command availability, parsed ps process-table rows, and bounded lsof listening-socket samples; filesystem watch/resync evidence for missed events with eventual usage/external-session refresh and inotify limit diagnostics; AppImage startup/sandbox/no-sandbox/user-namespace evidence; AppImage updater check/download/install, latest-linux*.yml metadata, channel naming, release visibility, AppImage blockmap sidecar, top-level sha512, AppImage file-entry sha512, actual AppImage sha512, and size consistency; AppImage provenance recorded Git dirty state, APPIMAGE env behavior, and selected AppImage artifact path; AppImage extracted desktop entry app name/icon/categories/StartupWMClass=kmux, installed desktop-entry candidate evidence, and resources/notificationIcon.png notification icon resource output; Runtime and packaged identity alignment matched app id, app name, executable name, desktop entry Name, and StartupWMClass=kmux; notification title/body/icon app attribution observed in the Ubuntu notification center and window grouping matched the app window, tied to recorded DBus/session and desktop-entry facts; native window chrome evidence on Ubuntu Desktop with X11/Wayland notes tied to recorded desktop shell/display and GPU renderer probes, resize, and compositor observations; shortcut policy evidence against terminal input and GNOME defaults with keyboard smoke notes tied to GNOME keybinding probes; terminal font loaded and stable cell metrics evidence with fc-list font inventory and xterm observations; IME/input-method smoke passed where ibus or fcitx validation was available with IME environment, input notes, and terminal input unaffected; split panes, surface switching, restore, foreground resize, and readable agent output continuity evidence; User and release docs covered Linux baseline, unsupported scope, AppImage updater behavior, and unavailable credential states; validation matrix covered Ubuntu Desktop LTS GUI launcher, terminal launch, packaged AppImage, dev build, X11 session where available, and Wayland session where available; and macOS compatibility evidence.";
    const handoffOnlyChangedToPassed = passedRcValidation.replace(
      passedRcNotes,
      generatedHandoffNotes
    );

    expect(
      linuxReleaseCandidatePlaceholderEvidence(handoffOnlyChangedToPassed)
    ).toContain(generatedHandoffNotes);
    expect(isLinuxReleaseCandidatePassed(handoffOnlyChangedToPassed)).toBe(false);
    expect(() =>
      assertLinuxReleaseCandidatePassed(handoffOnlyChangedToPassed)
    ).toThrow(/placeholder text/);
  });

  it("does not allow the environment flag to bypass missing RC evidence", () => {
    expect(() =>
      assertLinuxPublicPublishingGate({
        env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
        assetsDir: "/tmp/kmux-missing-release-assets",
        rcValidationText: "Current status: not passed."
      })
    ).toThrow(/stable RC ledger has not passed/);
  });

  it("uses the checked-in RC ledger when public publishing is enabled without a test override", () => {
    let thrown;

    try {
      assertLinuxPublicPublishingGate({
        env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
        assetsDir: "/tmp/kmux-missing-release-assets"
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain("stable RC ledger has not passed");
    expect(thrown.message).toContain("- macOS compatibility evidence");
    expect(thrown.message).toContain("- macOS release check command");
  });

  it("allows public Linux publishing only after the stable RC ledger passes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-release-pass-"));
    try {
      writeValidLinuxReleaseAssets(root);

      expect(
        assertLinuxPublicPublishingGate({
          env: { KMUX_ENABLE_LINUX_PUBLIC_RELEASE: "1" },
          assetsDir: root,
          rcValidationText: passedRcValidation,
          workflowText: [
            "- name: Verify Linux public release gate",
            "  run: node scripts/release-check-linux.mjs",
            "- name: Publish GitHub release",
            "  run: gh release upload \"$GITHUB_REF_NAME\" release-assets/*.AppImage release-assets/*.AppImage.blockmap release-assets/latest-linux.yml"
          ].join("\n"),
          currentCommit: "abc1234567890abcdef",
          currentGitDirty: "no"
        })
      ).toEqual({
        enabled: true,
        linuxAssets: [
          "kmux-0.3.12-linux-x64.AppImage",
          "kmux-0.3.12-linux-x64.AppImage.blockmap",
          "latest-linux.yml"
        ]
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

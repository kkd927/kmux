import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentStorageRoots } from "@kmux/metadata";

import {
  AGENT_COMMANDS,
  assertLinuxHost,
  assertLinuxEvidenceTarget,
  buildEvidenceReport,
  collectAgentStorageSnapshot,
  collectCommandAvailability,
  collectDesktopIntegrationSnapshot,
  collectDesktopShellSnapshot,
  collectEvidence,
  collectEnvironmentSnapshot,
  collectGitProvenance,
  collectImeSnapshot,
  collectPackagingConfiguration,
  collectPackagedArtifactDiagnostics,
  collectReleaseArtifacts,
  collectReleaseWorkflowConfiguration,
  collectRuntimeIdentityConfiguration,
  collectSandboxSnapshot,
  collectShellPathSnapshot,
  collectSystemSamples,
  collectWatchSnapshot,
  detectDesktopSession,
  parseDesktopEntrySubset,
  parseOsRelease,
  parsePsProcessTable,
  parseArgs,
  summarizeLinuxUpdateMetadata
} from "./collect-linux-release-evidence.mjs";
import {
  parseLinuxReleaseEvidenceEntryFields
} from "./release-check-linux.mjs";
import {
  RELEASE_BUILD_OUTPUT_STATUS_EXCLUDES,
  linuxReleaseSourceStatusArgs
} from "./linux-release-git.mjs";
import { calculateFileSha512 } from "./smoke-packaged-linux.mjs";

describe("linux release evidence collector", () => {
  const ubuntuLtsOsRelease = [
    'PRETTY_NAME="Ubuntu 24.04.2 LTS"',
    'NAME="Ubuntu"',
    'VERSION="24.04.2 LTS (Noble Numbat)"',
    "ID=ubuntu",
    'VERSION_ID="24.04"'
  ].join("\n");

  it("exposes the Linux evidence collection npm script", () => {
    const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));

    expect(rootPackage.scripts["release:evidence:linux"]).toBe(
      "node scripts/collect-linux-release-evidence.mjs"
    );
  });

  it("keeps Linux desktop docs aligned with pre-RC evidence diagnostics", () => {
    const linuxDesktopDocs = readFileSync("docs/linux-desktop.md", "utf8");
    const developmentDocs = readFileSync("docs/development.md", "utf8");
    const releaseValidationDocs = readFileSync(
      "docs/linux-release-validation.md",
      "utf8"
    );

    for (const expectedPhrase of [
      "--allow-any-platform` flag is only for script-development output",
      "DBus notification service owner/server probes",
      "GNOME number-row keybinding probes",
      "X11 window-manager root properties",
      "IME env plus `ibus`/`fcitx` command probes",
      "`script` command availability",
      "bounded `lsof` listening-socket samples",
      "packaging and publishing configuration facts",
      "`dist:linux --publish never`",
      "Linux package artifact files such as `.deb`, `.rpm`, `.snap`, and `.flatpak`",
      "script-development handoff commands keep `--allow-any-platform`",
      "release workflow public-gate facts",
      "runtime and packaged identity alignment facts",
      "Generated reports include a `Report mode` line",
      "Passing RC evidence: no",
      "Use that report as ledger input, not as a substitute",
      "successful desktop notification/window grouping observations",
      "agent workflow, output continuity, or updater check/download/install evidence"
    ]) {
      expect(linuxDesktopDocs).toContain(expectedPhrase);
    }

    for (const expectedPhrase of [
      "--allow-any-platform` flag is only for script-development output",
      "`script` command availability",
      "`ps` and bounded `lsof` subprocess samples",
      "Linux package artifact files such as `.deb`, `.rpm`, `.snap`, and `.flatpak`",
      "script-development handoff commands keep `--allow-any-platform`",
      "packaging and publishing configuration facts",
      "runtime and packaged identity alignment facts",
      "release workflow public-gate facts",
      "generated reports include `Report mode`",
      "Passing RC evidence: no"
    ]) {
      expect(developmentDocs).toContain(expectedPhrase);
    }

    for (const expectedPhrase of [
      "and the `Subprocess And Font Samples` section records",
      "`System Tool Availability` section records `script` command availability",
      "bounded `lsof -Pan -iTCP -sTCP:LISTEN` sample",
      "listening-port metadata assumptions",
      "Linux subprocess audit",
      "Linux package artifact files such as `.deb`, `.rpm`, `.snap`, and `.flatpak`",
      "script-development handoff commands keep `--allow-any-platform`",
      "packaging and publishing configuration facts including `package:linux`, `dist:linux --publish never`, electron-builder publish provider, Linux target, and artifact naming",
      "runtime and packaged identity alignment facts including app id, app name, executable name, desktop entry `Name`, and `StartupWMClass`",
      "The AppImage desktop entry marker must mention AppImage, extracted desktop entry, app name, icon, categories, `StartupWMClass=kmux`, installed desktop-entry candidate evidence, `resources/notificationIcon.png`, notification icon resource output, runtime and packaged identity alignment, app id, executable name, and desktop entry `Name` together.",
      "release workflow public-gate facts including gate-before-publish and Linux public-upload detection",
      "colocated `latest-linux*.yml` update metadata",
      "manual-validation-needed observation text",
      "`needs manual validation`, `requires manual observations`",
      "notification title/body/icon app attribution observed in the Ubuntu notification center and window grouping matched the app window",
      "split panes, surface switching, restore, foreground resize, and readable agent output continuity evidence"
    ]) {
      expect(releaseValidationDocs).toContain(expectedPhrase);
    }
  });

  it("parses output and host override arguments", () => {
    expect(
      parseArgs(["--allow-any-platform", "--output", "tmp/evidence.md"])
    ).toEqual({
      allowAnyPlatform: true,
      outputPath: path.resolve("tmp/evidence.md")
    });
  });

  it("rejects unknown or incomplete release evidence flags", () => {
    expect(() => parseArgs(["--output"])).toThrow(
      /--output requires a path value/
    );
    expect(() => parseArgs(["--output", "--allow-any-platform"])).toThrow(
      /--output requires a path value/
    );
    expect(() => parseArgs(["--allow-any-linux-desktop"])).toThrow(
      /unknown release:evidence:linux argument/
    );
  });

  it("requires Linux unless explicitly allowed for script development", () => {
    expect(() => assertLinuxHost({ platform: "linux" })).not.toThrow();
    expect(() =>
      assertLinuxHost({ platform: "darwin", allowAnyPlatform: true })
    ).not.toThrow();
    expect(() => assertLinuxHost({ platform: "darwin" })).toThrow(
      /Ubuntu Desktop/
    );
    expect(() => assertLinuxHost({ platform: "darwin" })).toThrow(
      /RC evidence: no on this host/
    );
  });

  it("requires Ubuntu Desktop LTS for release evidence collection", () => {
    expect(() =>
      assertLinuxEvidenceTarget({
        platform: "linux",
        osReleaseText: ubuntuLtsOsRelease,
        env: {
          DISPLAY: ":0",
          XDG_CURRENT_DESKTOP: "ubuntu:GNOME"
        }
      })
    ).not.toThrow();
    expect(() =>
      assertLinuxEvidenceTarget({
        platform: "linux",
        osReleaseText: [
          'PRETTY_NAME="Fedora Linux 40 (Workstation Edition)"',
          "ID=fedora"
        ].join("\n"),
        env: {
          DISPLAY: ":0",
          XDG_CURRENT_DESKTOP: "ubuntu:GNOME"
        }
      })
    ).toThrow(/Ubuntu Desktop LTS/);
    expect(() =>
      assertLinuxEvidenceTarget({
        platform: "linux",
        osReleaseText: ubuntuLtsOsRelease,
        env: {}
      })
    ).toThrow(/desktop session/);
    expect(() =>
      assertLinuxEvidenceTarget({
        platform: "linux",
        osReleaseText: ubuntuLtsOsRelease,
        env: {
          DISPLAY: ":0"
        }
      })
    ).toThrow(/Ubuntu Desktop session/);
    expect(() =>
      assertLinuxEvidenceTarget({
        platform: "darwin",
        osReleaseText: "",
        env: {}
      })
    ).toThrow(/RC evidence: no on this host/);
    expect(() =>
      assertLinuxEvidenceTarget({
        platform: "darwin",
        osReleaseText: "",
        env: {},
        allowAnyPlatform: true
      })
    ).not.toThrow();
  });

  it("parses Ubuntu LTS distro identity from os-release", () => {
    expect(parseOsRelease(ubuntuLtsOsRelease)).toEqual({
      id: "ubuntu",
      name: "Ubuntu",
      prettyName: "Ubuntu 24.04.2 LTS",
      version: "24.04.2 LTS (Noble Numbat)",
      versionId: "24.04",
      isUbuntu: true,
      isUbuntuLts: true
    });
  });

  it("detects X11, Wayland, and missing desktop display state", () => {
    expect(
      detectDesktopSession({
        WAYLAND_DISPLAY: "wayland-0",
        XDG_SESSION_TYPE: "wayland",
        XDG_CURRENT_DESKTOP: "GNOME"
      })
    ).toMatchObject({
      displayServer: "wayland",
      hasDisplay: true,
      hasUbuntuDesktopSession: true
    });

    expect(detectDesktopSession({ DISPLAY: ":0" })).toMatchObject({
      displayServer: "x11",
      hasDisplay: true,
      hasUbuntuDesktopSession: false
    });

    expect(detectDesktopSession({})).toMatchObject({
      displayServer: "none",
      hasDisplay: false,
      hasUbuntuDesktopSession: false
    });
  });

  it("parses desktop entry identity fields from the Desktop Entry section", () => {
    expect(
      parseDesktopEntrySubset(
        [
          "[Desktop Action NewWindow]",
          "Name=Ignored",
          "",
          "[Desktop Entry]",
          "Name=kmux",
          "Icon=kmux",
          "Categories=Development;TerminalEmulator;Utility;",
          "StartupWMClass=kmux",
          "StartupNotify=true",
          "Terminal=false",
          "Exec=/opt/kmux/kmux %U"
        ].join("\n")
      )
    ).toEqual({
      Name: "kmux",
      Icon: "kmux",
      Categories: "Development;TerminalEmulator;Utility;",
      StartupWMClass: "kmux",
      StartupNotify: "true",
      Terminal: "false"
    });
  });

  it("records DBus and installed desktop entry candidates for desktop integration evidence", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-desktop-entry-"));
    try {
      const dataHome = path.join(root, "data-home");
      const dataDir = path.join(root, "system-share");
      mkdirSync(path.join(dataHome, "applications"), { recursive: true });
      mkdirSync(path.join(dataDir, "applications"), { recursive: true });
      writeFileSync(
        path.join(dataHome, "applications", "kmux.desktop"),
        [
          "[Desktop Entry]",
          "Name=kmux",
          "Icon=kmux",
          "Categories=Development;TerminalEmulator;Utility;",
          "StartupWMClass=kmux",
          "StartupNotify=true",
          "Terminal=false"
        ].join("\n")
      );
      writeFileSync(
        path.join(dataDir, "applications", "appimagekit-kmux.desktop"),
        [
          "[Desktop Entry]",
          "Name=kmux",
          "Icon=kmux",
          "StartupWMClass=kmux",
          "StartupNotify=true",
          "Terminal=false"
        ].join("\n")
      );

      const calls = [];
      const snapshot = collectDesktopIntegrationSnapshot({
        homeDir: root,
        env: {
          HOME: root,
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
          XDG_DATA_HOME: dataHome,
          XDG_DATA_DIRS: [dataDir, dataHome].join(path.delimiter),
          XDG_CURRENT_DESKTOP: "GNOME",
          XDG_SESSION_TYPE: "wayland",
          XDG_MENU_PREFIX: "gnome-"
        },
        runner: (command, args) => {
          calls.push([command, args]);
          if (args.includes("org.freedesktop.DBus.NameHasOwner")) {
            return {
              status: 0,
              stdout: "method return time=1.0\n   boolean true\n",
              stderr: ""
            };
          }
          if (
            args.includes(
              "org.freedesktop.Notifications.GetServerInformation"
            )
          ) {
            return {
              status: 0,
              stdout: [
                "method return time=1.0",
                '   string "GNOME Shell"',
                '   string "GNOME"',
                '   string "46.0"',
                '   string "1.2"'
              ].join("\n"),
              stderr: ""
            };
          }
          return {
            status: 127,
            stdout: "",
            stderr: "not found",
            error: "not found"
          };
        }
      });

      expect(snapshot.env).toMatchObject({
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        XDG_DATA_HOME: dataHome,
        XDG_DATA_DIRS: [dataDir, dataHome].join(path.delimiter),
        XDG_CURRENT_DESKTOP: "GNOME",
        XDG_SESSION_TYPE: "wayland",
        XDG_MENU_PREFIX: "gnome-"
      });
      expect(calls).toEqual(
        expect.arrayContaining([
          [
            "dbus-send",
            expect.arrayContaining([
              "org.freedesktop.DBus.NameHasOwner",
              "string:org.freedesktop.Notifications"
            ])
          ],
          [
            "dbus-send",
            expect.arrayContaining([
              "org.freedesktop.Notifications.GetServerInformation"
            ])
          ]
        ])
      );
      expect(snapshot.notificationProbes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: "DBus notification service owner",
            status: 0,
            sample: "method return time=1.0\n   boolean true"
          }),
          expect.objectContaining({
            label: "DBus notification server information",
            status: 0,
            sample: expect.stringContaining('string "GNOME Shell"')
          })
        ])
      );
      expect(snapshot.applicationEntryCandidates).toEqual([
        expect.objectContaining({
          path: path.join(dataHome, "applications", "kmux.desktop"),
          status: "file",
          sizeBytes: expect.any(Number),
          desktopEntry: {
            Name: "kmux",
            Icon: "kmux",
            Categories: "Development;TerminalEmulator;Utility;",
            StartupWMClass: "kmux",
            StartupNotify: "true",
            Terminal: "false"
          }
        }),
        {
          path: path.join(dataDir, "applications", "kmux.desktop"),
          status: "missing"
        },
        expect.objectContaining({
          path: path.join(
            dataDir,
            "applications",
            "appimagekit-kmux.desktop"
          ),
          status: "file",
          desktopEntry: expect.objectContaining({
            Name: "kmux",
            StartupWMClass: "kmux"
          })
        })
      ]);

      const skippedCalls = [];
      const skipped = collectDesktopIntegrationSnapshot({
        homeDir: root,
        env: { HOME: root },
        runner: (command, args) => {
          skippedCalls.push([command, args]);
          return {
            status: 127,
            stdout: "",
            stderr: "not found"
          };
        }
      });
      expect(skippedCalls).toEqual([]);
      expect(skipped.notificationProbes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: "DBus notification service owner",
            skipped: true,
            reason: "DBUS_SESSION_BUS_ADDRESS is unset"
          }),
          expect.objectContaining({
            label: "DBus notification server information",
            skipped: true,
            reason: "DBUS_SESSION_BUS_ADDRESS is unset"
          })
        ])
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores relative XDG data roots for desktop-entry evidence", () => {
    const cwdRoot = mkdtempSync(path.join(tmpdir(), "kmux-xdg-cwd-"));
    const fallbackHome = mkdtempSync(path.join(tmpdir(), "kmux-xdg-home-"));
    const dataDir = mkdtempSync(path.join(tmpdir(), "kmux-xdg-data-"));
    try {
      mkdirSync(path.join(cwdRoot, "relative-data", "applications"), {
        recursive: true
      });
      writeFileSync(
        path.join(cwdRoot, "relative-data", "applications", "kmux.desktop"),
        [
          "[Desktop Entry]",
          "Name=relative kmux",
          "StartupWMClass=relative"
        ].join("\n")
      );

      const previousCwd = process.cwd();
      process.chdir(cwdRoot);
      try {
        const snapshot = collectDesktopIntegrationSnapshot({
          homeDir: "relative-home",
          env: {
            HOME: fallbackHome,
            XDG_DATA_HOME: "relative-data",
            XDG_DATA_DIRS: ["relative-dir", dataDir].join(path.delimiter)
          },
          runner: () => ({
            status: 127,
            stdout: "",
            stderr: "not found"
          })
        });
        const candidatePaths = snapshot.applicationEntryCandidates.map(
          (candidate) => candidate.path
        );

        expect(candidatePaths).toContain(
          path.join(
            fallbackHome,
            ".local",
            "share",
            "applications",
            "kmux.desktop"
          )
        );
        expect(candidatePaths).toContain(
          path.join(dataDir, "applications", "kmux.desktop")
        );
        expect(
          candidatePaths.every((candidatePath) =>
            path.isAbsolute(candidatePath)
          )
        ).toBe(true);
        expect(candidatePaths).not.toContain(
          path.join("relative-data", "applications", "kmux.desktop")
        );
        expect(candidatePaths).not.toContain(
          path.join("relative-dir", "applications", "kmux.desktop")
        );
      } finally {
        process.chdir(previousCwd);
      }
    } finally {
      rmSync(cwdRoot, { recursive: true, force: true });
      rmSync(fallbackHome, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("records desktop shell and display probes for compositor evidence", () => {
    const calls = [];
    const snapshot = collectDesktopShellSnapshot({
      env: {
        XDG_SESSION_ID: "3",
        XDG_SESSION_TYPE: "wayland",
        XDG_CURRENT_DESKTOP: "GNOME",
        XDG_SESSION_DESKTOP: "ubuntu",
        DISPLAY: ":0",
        WAYLAND_DISPLAY: "wayland-0",
        ELECTRON_OZONE_PLATFORM_HINT: "auto"
      },
      runner: (command, args) => {
        calls.push([command, args]);
        if (command === "loginctl") {
          return {
            status: 0,
            stdout: "Type=wayland\nDesktop=ubuntu\nState=active\n",
            stderr: ""
          };
        }
        if (command === "gnome-shell") {
          return {
            status: 0,
            stdout: "GNOME Shell 46.0\n",
            stderr: ""
          };
        }
        if (command === "gsettings") {
          const samples = new Map([
            ["switch-to-application-4", "['<Super>4']\n"],
            ["switch-to-workspace-1", "@as []\n"],
            ["move-to-workspace-1", "['<Shift><Super>1']\n"]
          ]);
          return {
            status: 0,
            stdout: samples.get(args[2]) ?? "['<Super>1']\n",
            stderr: ""
          };
        }
        if (command === "xrandr") {
          return {
            status: 0,
            stdout: "Screen 0: minimum 16 x 16, current 1920 x 1080\n",
            stderr: ""
          };
        }
        if (command === "xdpyinfo") {
          return {
            status: 1,
            stdout: "",
            stderr: "xdpyinfo: unable to open display\n"
          };
        }
        if (command === "xprop") {
          return {
            status: 0,
            stdout: [
              "_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x200001",
              "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x400001",
              "_NET_CLIENT_LIST(WINDOW): window id # 0x400001, 0x400002"
            ].join("\n"),
            stderr: ""
          };
        }
        if (command === "wayland-info") {
          return {
            status: 0,
            stdout: "interface: 'wl_compositor', version: 6\n",
            stderr: ""
          };
        }
        if (command === "glxinfo") {
          return {
            status: 0,
            stdout: "OpenGL renderer string: Mesa Intel(R) Graphics\n",
            stderr: ""
          };
        }
        if (command === "vulkaninfo") {
          return {
            status: 0,
            stdout: "GPU id = 0 (Intel(R) Graphics)\n",
            stderr: ""
          };
        }
        return {
          status: 127,
          stdout: "",
          stderr: "not found",
          error: "not found"
        };
      }
    });

    expect(snapshot.env).toMatchObject({
      XDG_SESSION_ID: "3",
      XDG_SESSION_TYPE: "wayland",
      XDG_CURRENT_DESKTOP: "GNOME",
      XDG_SESSION_DESKTOP: "ubuntu",
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-0",
      ELECTRON_OZONE_PLATFORM_HINT: "auto"
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        [
          "loginctl",
          [
            "show-session",
            "3",
            "-p",
            "Type",
            "-p",
            "Desktop",
            "-p",
            "Display",
            "-p",
            "Remote",
            "-p",
            "State",
            "-p",
            "Class"
          ]
        ],
        ["gnome-shell", ["--version"]],
        [
          "gsettings",
          [
            "get",
            "org.gnome.shell.keybindings",
            "switch-to-application-1"
          ]
        ],
        [
          "gsettings",
          [
            "get",
            "org.gnome.shell.keybindings",
            "switch-to-application-4"
          ]
        ],
        [
          "gsettings",
          [
            "get",
            "org.gnome.desktop.wm.keybindings",
            "switch-to-workspace-1"
          ]
        ],
        [
          "gsettings",
          [
            "get",
            "org.gnome.desktop.wm.keybindings",
            "move-to-workspace-1"
          ]
        ],
        ["xrandr", ["--query"]],
        ["xdpyinfo", []],
        [
          "xprop",
          [
            "-root",
            "_NET_SUPPORTING_WM_CHECK",
            "_NET_ACTIVE_WINDOW",
            "_NET_CLIENT_LIST"
          ]
        ],
        ["wayland-info", []],
        ["glxinfo", ["-B"]],
        ["vulkaninfo", ["--summary"]]
      ])
    );
    expect(snapshot.probes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "loginctl session",
          skipped: false,
          status: 0,
          sample: "Type=wayland\nDesktop=ubuntu\nState=active"
        }),
        expect.objectContaining({
          label: "GNOME Shell version",
          status: 0,
          sample: "GNOME Shell 46.0"
        }),
        expect.objectContaining({
          label: "GNOME switch application shortcut 4",
          status: 0,
          sample: "['<Super>4']"
        }),
        expect.objectContaining({
          label: "GNOME switch workspace shortcut 1",
          status: 0,
          sample: "@as []"
        }),
        expect.objectContaining({
          label: "GNOME move to workspace shortcut 1",
          status: 0,
          sample: "['<Shift><Super>1']"
        }),
        expect.objectContaining({
          label: "X11 display info",
          status: 1,
          sample: "xdpyinfo: unable to open display"
        }),
        expect.objectContaining({
          label: "X11 window manager root properties",
          status: 0,
          sample: expect.stringContaining("_NET_ACTIVE_WINDOW")
        }),
        expect.objectContaining({
          label: "Wayland display info",
          status: 0,
          sample: "interface: 'wl_compositor', version: 6"
        }),
        expect.objectContaining({
          label: "OpenGL renderer info",
          status: 0,
          sample: "OpenGL renderer string: Mesa Intel(R) Graphics"
        }),
        expect.objectContaining({
          label: "Vulkan device summary",
          status: 0,
          sample: "GPU id = 0 (Intel(R) Graphics)"
        })
      ])
    );

    const skippedCalls = [];
    const skipped = collectDesktopShellSnapshot({
      env: {},
      runner: (command, args) => {
        skippedCalls.push([command, args]);
        return {
          status: 127,
          stdout: "",
          stderr: "not found",
          error: "not found"
        };
      }
    }).probes;
    expect(skippedCalls).toEqual([]);
    expect(skipped.find((probe) => probe.label === "loginctl session")).toEqual(
      expect.objectContaining({
        skipped: true,
        reason: "XDG_SESSION_ID is unset"
      })
    );
    expect(skipped.find((probe) => probe.label === "GNOME Shell version")).toEqual(
      expect.objectContaining({
        skipped: true,
        reason: "GNOME desktop env is not detected"
      })
    );
    expect(skipped.find((probe) => probe.label === "X11 display query")).toEqual(
      expect.objectContaining({
        skipped: true,
        reason: "DISPLAY is unset"
      })
    );
    expect(
      skipped.find(
        (probe) => probe.label === "X11 window manager root properties"
      )
    ).toEqual(
      expect.objectContaining({
        skipped: true,
        reason: "DISPLAY is unset"
      })
    );
    expect(skipped.find((probe) => probe.label === "Wayland display info"))
      .toEqual(
        expect.objectContaining({
          skipped: true,
          reason: "WAYLAND_DISPLAY is unset"
        })
      );
    expect(skipped.find((probe) => probe.label === "OpenGL renderer info"))
      .toEqual(
        expect.objectContaining({
          skipped: true,
          reason: "DISPLAY and WAYLAND_DISPLAY are unset"
        })
      );
    expect(skipped.find((probe) => probe.label === "Vulkan device summary"))
      .toEqual(
        expect.objectContaining({
          skipped: true,
          reason: "DISPLAY and WAYLAND_DISPLAY are unset"
        })
      );
  });

  it("records IME input-method environment and ibus/fcitx probes", () => {
    const calls = [];
    const snapshot = collectImeSnapshot({
      env: {
        GTK_IM_MODULE: "ibus",
        QT_IM_MODULE: "ibus",
        XMODIFIERS: "@im=ibus",
        INPUT_METHOD: "ibus"
      },
      runner: (command, args) => {
        calls.push([command, args]);
        if (command === "ibus" && args[0] === "engine") {
          return {
            status: 0,
            stdout: "xkb:us::eng\n",
            stderr: ""
          };
        }
        if (command === "ibus" && args[0] === "version") {
          return {
            status: 0,
            stdout: "IBus 1.5.29\n",
            stderr: ""
          };
        }
        if (command === "fcitx5-remote") {
          return {
            status: 1,
            stdout: "",
            stderr: "Not available"
          };
        }
        return {
          status: 127,
          stdout: "",
          stderr: "not found",
          error: "not found"
        };
      }
    });

    expect(snapshot.env).toEqual({
      GTK_IM_MODULE: "ibus",
      QT_IM_MODULE: "ibus",
      XMODIFIERS: "@im=ibus",
      INPUT_METHOD: "ibus"
    });
    expect(calls).toEqual([
      ["ibus", ["engine"]],
      ["ibus", ["version"]],
      ["fcitx5-remote", ["-n"]],
      ["fcitx-remote", ["-n"]]
    ]);
    expect(snapshot.probes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "ibus current engine",
          status: 0,
          sample: "xkb:us::eng"
        }),
        expect.objectContaining({
          label: "ibus version",
          status: 0,
          sample: "IBus 1.5.29"
        }),
        expect.objectContaining({
          label: "fcitx5 current input method",
          status: 1,
          sample: "Not available"
        }),
        expect.objectContaining({
          label: "fcitx current input method",
          status: 127,
          sample: "not found"
        })
      ])
    );
  });

  it("records git source provenance and dirty status", () => {
    const calls = [];
    const provenance = collectGitProvenance((command, args) => {
      calls.push([command, args]);
      if (args[0] === "rev-parse") {
        return {
          status: 0,
          stdout: "abc1234\n",
          stderr: ""
        };
      }
      if (args[0] === "status") {
        return {
          status: 0,
          stdout: " M package.json\n?? docs/linux-release-validation.md\n",
          stderr: ""
        };
      }
      return {
        status: 1,
        stdout: "",
        stderr: "unexpected"
      };
    });

    expect(calls).toEqual([
      ["git", ["rev-parse", "--short", "HEAD"]],
      ["git", linuxReleaseSourceStatusArgs()]
    ]);
    expect(provenance).toEqual({
      commit: "abc1234",
      dirty: true,
      statusScope:
        "source worktree, ignoring generated release artifact directories",
      statusIgnoredPaths: RELEASE_BUILD_OUTPUT_STATUS_EXCLUDES,
      statusEntryCount: 2,
      statusSample: " M package.json\n?? docs/linux-release-validation.md",
      statusError: ""
    });
  });

  it("ignores generated release artifacts when collecting git source provenance", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-release-evidence-git-"));
    const runner = (command, args) => {
      if (args[0] === "rev-parse") {
        return {
          status: 0,
          stdout: "abc1234\n",
          stderr: ""
        };
      }

      try {
        return {
          status: 0,
          stdout: execFileSync(command, args, {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
          }),
          stderr: ""
        };
      } catch (error) {
        return {
          status: error.status ?? 1,
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? String(error)
        };
      }
    };

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

      expect(collectGitProvenance(runner)).toMatchObject({
        commit: "abc1234",
        dirty: false,
        statusEntryCount: 0,
        statusSample: ""
      });

      writeFileSync(path.join(root, "source-change.ts"), "export {};\n");

      const dirtyProvenance = collectGitProvenance(runner);
      expect(dirtyProvenance).toMatchObject({
        commit: "abc1234",
        dirty: true,
        statusEntryCount: 1
      });
      expect(dirtyProvenance.statusSample).toContain("source-change.ts");
      expect(dirtyProvenance.statusSample).not.toContain("release-assets");
      expect(dirtyProvenance.statusSample).not.toContain("apps/desktop/release");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("collects AppImage and Linux update metadata artifacts from release roots", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-evidence-"));
    try {
      mkdirSync(path.join(root, "nested"));
      writeFileSync(path.join(root, "kmux-0.3.12-linux-x64.AppImage"), "app");
      writeFileSync(
        path.join(root, "kmux-0.3.12-linux-x64.AppImage.blockmap"),
        "map"
      );
      writeFileSync(path.join(root, "latest-linux.yml"), "version: 0.3.12");
      writeFileSync(
        path.join(root, "nested", "kmux-0.3.12-linux-arm64.AppImage"),
        "app-arm64"
      );
      writeFileSync(
        path.join(root, "nested", "latest-linux-arm64.yml"),
        "version: 0.3.12"
      );
      writeFileSync(path.join(root, "kmux-0.3.12-linux-x64.deb"), "deb");
      writeFileSync(path.join(root, "kmux-0.3.12-linux-x64.rpm"), "rpm");
      writeFileSync(path.join(root, "kmux-0.3.12-linux-x64.snap"), "snap");
      writeFileSync(
        path.join(root, "kmux-0.3.12-linux-x64.flatpak"),
        "flatpak"
      );
      writeFileSync(path.join(root, "latest-mac.yml"), "version: 0.3.12");
      writeFileSync(path.join(root, "builder-debug.yml"), "debug: true");
      writeFileSync(path.join(root, "kmux-0.3.12-mac-x64.dmg"), "mac");

      expect(collectReleaseArtifacts([root])).toEqual([
        expect.objectContaining({
          name: "kmux-0.3.12-linux-x64.AppImage",
          sizeBytes: 3
        }),
        expect.objectContaining({
          name: "kmux-0.3.12-linux-x64.AppImage.blockmap",
          sizeBytes: 3
        }),
        expect.objectContaining({
          name: "kmux-0.3.12-linux-x64.deb",
          sizeBytes: 3
        }),
        expect.objectContaining({
          name: "kmux-0.3.12-linux-x64.flatpak",
          sizeBytes: 7
        }),
        expect.objectContaining({
          name: "kmux-0.3.12-linux-x64.rpm",
          sizeBytes: 3
        }),
        expect.objectContaining({
          name: "kmux-0.3.12-linux-x64.snap",
          sizeBytes: 4
        }),
        expect.objectContaining({
          name: "latest-linux.yml",
          sizeBytes: 15
        }),
        expect.objectContaining({
          name: "kmux-0.3.12-linux-arm64.AppImage",
          sizeBytes: 9
        }),
        expect.objectContaining({
          name: "latest-linux-arm64.yml",
          sizeBytes: 15
        })
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("collects Linux packaging and publishing configuration facts", () => {
    expect(collectPackagingConfiguration()).toMatchObject({
      rootPackageLinuxScript:
        "npm run build && npm run rebuild:electron && npm run dist:linux --workspace @kmux/desktop",
      rootPackageUsesDistLinux: true,
      desktopDistLinuxScript:
        "electron-builder --config electron-builder.yml --linux AppImage --publish never",
      desktopDistLinuxUsesPublishNever: true,
      publishProvider: "github",
      publishOwner: "kkd927",
      publishRepo: "kmux",
      publishReleaseType: "release",
      linuxTarget: ["AppImage"],
      linuxArtifactName: "${productName}-${version}-linux-${arch}.${ext}",
      linuxExecutableName: "kmux"
    });
  });

  it("collects runtime and packaged desktop identity alignment facts", () => {
    expect(collectRuntimeIdentityConfiguration()).toMatchObject({
      status: "read",
      appId: "dev.kmux.desktop",
      appName: "kmux",
      startupWmClass: "kmux",
      builderAppId: "dev.kmux.desktop",
      builderProductName: "kmux",
      builderLinuxExecutableName: "kmux",
      builderDesktopName: "kmux",
      builderDesktopStartupWmClass: "kmux",
      appIdMatchesBuilder: true,
      appNameMatchesProductName: true,
      executableNameMatchesAppName: true,
      desktopNameMatchesAppName: true,
      startupWmClassMatchesDesktopEntry: true
    });
  });

  it("parses runtime identity constants with TypeScript const assertions", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-runtime-identity-"));
    try {
      const appIdentityPath = path.join(root, "appIdentity.ts");
      const builderConfigPath = path.join(root, "electron-builder.yml");
      writeFileSync(
        appIdentityPath,
        [
          'export const KMUX_APP_ID = "dev.kmux.desktop" as const;',
          'export const KMUX_APP_NAME = "kmux" as const;',
          "export const LINUX_STARTUP_WM_CLASS = KMUX_APP_NAME;"
        ].join("\n")
      );
      writeFileSync(
        builderConfigPath,
        [
          "appId: dev.kmux.desktop",
          "productName: kmux",
          "linux:",
          "  executableName: kmux",
          "  desktop:",
          "    entry:",
          "      Name: kmux",
          "      StartupWMClass: kmux"
        ].join("\n")
      );

      expect(
        collectRuntimeIdentityConfiguration({
          appIdentityPath,
          builderConfigPath
        })
      ).toMatchObject({
        appId: "dev.kmux.desktop",
        appName: "kmux",
        startupWmClass: "kmux",
        startupWmClassMatchesDesktopEntry: true
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("collects checked-in release workflow public gate facts", () => {
    expect(collectReleaseWorkflowConfiguration()).toMatchObject({
      status: "read",
      hasLinuxPublicGateCommand: true,
      linuxPublicGateBeforePublish: true,
      linuxPublicUploadsAllowed: false,
      linuxPublicPublishingGated: true,
      error: ""
    });
  });

  it("summarizes Linux update metadata and extracted AppImage identity", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-evidence-"));
    try {
      const appImagePath = path.join(root, "kmux-0.3.12-linux-x64.AppImage");
      const metadataPath = path.join(root, "latest-linux.yml");
      writeFileSync(appImagePath, "app");
      writeFileSync(`${appImagePath}.blockmap`, "map");
      const appImageSha512 = calculateFileSha512(appImagePath);
      writeFileSync(
        metadataPath,
        [
          "version: 0.3.12",
          "files:",
          "  - url: kmux-0.3.12-linux-x64.AppImage",
          `    sha512: ${appImageSha512}`,
          "    size: 3",
          "path: kmux-0.3.12-linux-x64.AppImage",
          `sha512: ${appImageSha512}`
        ].join("\n")
      );

      const metadata = summarizeLinuxUpdateMetadata(metadataPath, {
        appImagePath
      });
      const diagnostics = collectPackagedArtifactDiagnostics({
        artifacts: collectReleaseArtifacts([root]),
        identityExtractor: ({ appImagePath: extractedAppImagePath }) => {
          expect(extractedAppImagePath).toBe(appImagePath);
          return {
            desktopEntry: {
              "Desktop Entry": {
                Name: "kmux",
                Icon: "kmux",
                Categories: "Development;TerminalEmulator;Utility;",
                StartupWMClass: "kmux",
                StartupNotify: "true",
                Terminal: "false"
              }
            },
            notificationIconResourcePath: path.join(
              "resources",
              "notificationIcon.png"
            )
          };
        }
      });

      expect(metadata).toMatchObject({
        status: "parsed",
        metadataFileName: "latest-linux.yml",
        expectedMetadataNames: ["latest-linux.yml", "latest-linux.yaml"],
        metadataNameMatchesAppImage: true,
        metadataColocatedWithAppImage: true,
        version: "0.3.12",
        updatePath: "kmux-0.3.12-linux-x64.AppImage",
        appImageFilePath: "kmux-0.3.12-linux-x64.AppImage",
        updatePathMatchesAppImage: true,
        fileEntryMatchesUpdatePath: true,
        fileEntryMatchesAppImage: true,
        hasTopLevelSha512: true,
        topLevelSha512: appImageSha512,
        hasAppImageFileSha512: true,
        appImageFileSha512: appImageSha512,
        checksumMatches: true,
        hasActualAppImageSha512: true,
        actualAppImageSha512: appImageSha512,
        appImageSha512MatchesActual: true,
        hasAppImageFileSize: true,
        appImageFileSize: 3,
        actualAppImageSize: 3,
        sizeMatches: true
      });
      expect(diagnostics).toMatchObject({
        selectedAppImagePath: appImagePath,
        selectedAppImageBlockmap: {
          status: "present",
          path: `${appImagePath}.blockmap`,
          sizeBytes: 3
        },
        selectedMetadataPath: metadataPath,
        appImageIdentity: {
          status: "extracted",
          desktopEntry: {
            Name: "kmux",
            Icon: "kmux",
            StartupWMClass: "kmux"
          },
          notificationIconResourcePath: path.join(
            "resources",
            "notificationIcon.png"
          )
        }
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records when update metadata points at a different AppImage than the selected artifact", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-evidence-"));
    try {
      const appImagePath = path.join(root, "kmux-0.3.12-linux-arm64.AppImage");
      const metadataPath = path.join(root, "latest-linux-arm64.yml");
      writeFileSync(appImagePath, "app");
      writeFileSync(
        metadataPath,
        [
          "version: 0.3.12",
          "files:",
          "  - url: kmux-0.3.12-linux-x64.AppImage",
          "    sha512: x64-checksum",
          "    size: 7",
          "  - url: kmux-0.3.12-linux-arm64.AppImage",
          "    sha512: arm64-checksum",
          "    size: 3",
          "path: kmux-0.3.12-linux-x64.AppImage",
          "sha512: arm64-checksum"
        ].join("\n")
      );

      expect(
        summarizeLinuxUpdateMetadata(metadataPath, {
          appImagePath
        })
      ).toMatchObject({
        status: "parsed",
        metadataFileName: "latest-linux-arm64.yml",
        expectedMetadataNames: [
          "latest-linux-arm64.yml",
          "latest-linux-arm64.yaml"
        ],
        metadataNameMatchesAppImage: true,
        metadataColocatedWithAppImage: true,
        updatePath: "kmux-0.3.12-linux-x64.AppImage",
        appImageFilePath: "kmux-0.3.12-linux-arm64.AppImage",
        updatePathMatchesAppImage: false,
        fileEntryMatchesUpdatePath: false,
        fileEntryMatchesAppImage: true,
        checksumMatches: true,
        appImageSha512MatchesActual: false,
        sizeMatches: true
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records when update metadata filename does not match the selected AppImage architecture", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-evidence-"));
    try {
      const appImagePath = path.join(root, "kmux-0.3.12-linux-arm64.AppImage");
      const metadataPath = path.join(root, "latest-linux.yml");
      writeFileSync(appImagePath, "app");
      const appImageSha512 = calculateFileSha512(appImagePath);
      writeFileSync(
        metadataPath,
        [
          "version: 0.3.12",
          "files:",
          "  - url: kmux-0.3.12-linux-arm64.AppImage",
          `    sha512: ${appImageSha512}`,
          "    size: 3",
          "path: kmux-0.3.12-linux-arm64.AppImage",
          `sha512: ${appImageSha512}`
        ].join("\n")
      );

      expect(
        summarizeLinuxUpdateMetadata(metadataPath, {
          appImagePath
        })
      ).toMatchObject({
        status: "parsed",
        metadataFileName: "latest-linux.yml",
        expectedMetadataNames: [
          "latest-linux-arm64.yml",
          "latest-linux-arm64.yaml"
        ],
        metadataNameMatchesAppImage: false,
        metadataColocatedWithAppImage: true,
        updatePathMatchesAppImage: true,
        fileEntryMatchesAppImage: true,
        appImageSha512MatchesActual: true
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records when update metadata is not colocated with the selected AppImage", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-evidence-"));
    try {
      const appImageDir = path.join(root, "linux-x64-release-assets");
      mkdirSync(appImageDir);
      const appImagePath = path.join(
        appImageDir,
        "kmux-0.3.12-linux-x64.AppImage"
      );
      const metadataPath = path.join(root, "latest-linux.yml");
      writeFileSync(appImagePath, "app");
      const appImageSha512 = calculateFileSha512(appImagePath);
      writeFileSync(
        metadataPath,
        [
          "version: 0.3.12",
          "files:",
          "  - url: kmux-0.3.12-linux-x64.AppImage",
          `    sha512: ${appImageSha512}`,
          "    size: 3",
          "path: kmux-0.3.12-linux-x64.AppImage",
          `sha512: ${appImageSha512}`
        ].join("\n")
      );

      expect(
        summarizeLinuxUpdateMetadata(metadataPath, {
          appImagePath
        })
      ).toMatchObject({
        status: "parsed",
        metadataFileName: "latest-linux.yml",
        metadataNameMatchesAppImage: true,
        metadataColocatedWithAppImage: false,
        updatePathMatchesAppImage: true,
        fileEntryMatchesAppImage: true,
        appImageSha512MatchesActual: true
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers arch-specific Linux update metadata for non-x64 AppImages", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-evidence-"));
    try {
      const appImagePath = path.join(root, "kmux-0.3.12-linux-arm64.AppImage");
      const x64MetadataPath = path.join(root, "latest-linux.yml");
      const arm64MetadataPath = path.join(root, "latest-linux-arm64.yml");
      writeFileSync(appImagePath, "app");
      writeFileSync(
        x64MetadataPath,
        [
          "version: 0.3.12",
          "files:",
          "  - url: kmux-0.3.12-linux-x64.AppImage",
          "    sha512: x64-checksum",
          "    size: 7",
          "path: kmux-0.3.12-linux-x64.AppImage",
          "sha512: x64-checksum"
        ].join("\n")
      );
      writeFileSync(
        arm64MetadataPath,
        [
          "version: 0.3.12",
          "files:",
          "  - url: kmux-0.3.12-linux-arm64.AppImage",
          "    sha512: arm64-checksum",
          "    size: 3",
          "path: kmux-0.3.12-linux-arm64.AppImage",
          "sha512: arm64-checksum"
        ].join("\n")
      );

      expect(
        collectPackagedArtifactDiagnostics({
          artifacts: collectReleaseArtifacts([root]),
          identityExtractor: () => ({
            desktopEntry: {
              Name: "kmux",
              Icon: "kmux"
            },
            notificationIconResourcePath: path.join(
              "resources",
              "notificationIcon.png"
            )
          })
        }).updateMetadata
      ).toMatchObject({
        path: arm64MetadataPath,
        updatePath: "kmux-0.3.12-linux-arm64.AppImage",
        checksumMatches: true
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers update metadata next to a nested selected AppImage", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-evidence-"));
    try {
      const artifactDir = path.join(root, "linux-arm64-release-assets");
      mkdirSync(artifactDir);
      const appImagePath = path.join(
        artifactDir,
        "kmux-0.3.12-linux-arm64.AppImage"
      );
      const topLevelMetadataPath = path.join(root, "latest-linux.yml");
      const arm64MetadataPath = path.join(artifactDir, "latest-linux-arm64.yml");
      writeFileSync(appImagePath, "app");
      writeFileSync(
        topLevelMetadataPath,
        [
          "version: 0.3.12",
          "files:",
          "  - url: kmux-0.3.12-linux-x64.AppImage",
          "    sha512: x64-checksum",
          "    size: 7",
          "path: kmux-0.3.12-linux-x64.AppImage",
          "sha512: x64-checksum"
        ].join("\n")
      );
      writeFileSync(
        arm64MetadataPath,
        [
          "version: 0.3.12",
          "files:",
          "  - url: kmux-0.3.12-linux-arm64.AppImage",
          "    sha512: arm64-checksum",
          "    size: 3",
          "path: kmux-0.3.12-linux-arm64.AppImage",
          "sha512: arm64-checksum"
        ].join("\n")
      );

      expect(
        collectPackagedArtifactDiagnostics({
          artifacts: collectReleaseArtifacts([root]),
          identityExtractor: () => ({
            desktopEntry: {
              Name: "kmux",
              Icon: "kmux"
            },
            notificationIconResourcePath: path.join(
              "resources",
              "notificationIcon.png"
            )
          })
        }).updateMetadata
      ).toMatchObject({
        path: arm64MetadataPath,
        updatePath: "kmux-0.3.12-linux-arm64.AppImage",
        checksumMatches: true
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers host-arch AppImage diagnostics when multiple architectures are present", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-evidence-"));
    try {
      const arm64Dir = path.join(root, "linux-arm64-release-assets");
      const x64Dir = path.join(root, "linux-x64-release-assets");
      mkdirSync(arm64Dir);
      mkdirSync(x64Dir);
      const arm64AppImagePath = path.join(
        arm64Dir,
        "kmux-0.3.12-linux-arm64.AppImage"
      );
      const x64AppImagePath = path.join(
        x64Dir,
        "kmux-0.3.12-linux-x64.AppImage"
      );
      const arm64MetadataPath = path.join(arm64Dir, "latest-linux-arm64.yml");
      const x64MetadataPath = path.join(x64Dir, "latest-linux.yml");
      writeFileSync(arm64AppImagePath, "arm64-app");
      writeFileSync(x64AppImagePath, "x64-app");
      writeFileSync(
        arm64MetadataPath,
        [
          "version: 0.3.12",
          "files:",
          "  - url: kmux-0.3.12-linux-arm64.AppImage",
          "    sha512: arm64-checksum",
          "    size: 9",
          "path: kmux-0.3.12-linux-arm64.AppImage",
          "sha512: arm64-checksum"
        ].join("\n")
      );
      writeFileSync(
        x64MetadataPath,
        [
          "version: 0.3.12",
          "files:",
          "  - url: kmux-0.3.12-linux-x64.AppImage",
          "    sha512: x64-checksum",
          "    size: 7",
          "path: kmux-0.3.12-linux-x64.AppImage",
          "sha512: x64-checksum"
        ].join("\n")
      );

      const artifacts = collectReleaseArtifacts([root]);
      const x64Diagnostics = collectPackagedArtifactDiagnostics({
        artifacts,
        preferredArch: "x64",
        identityExtractor: () => ({
          desktopEntry: {
            Name: "kmux",
            Icon: "kmux"
          },
          notificationIconResourcePath: path.join(
            "resources",
            "notificationIcon.png"
          )
        })
      });
      const arm64Diagnostics = collectPackagedArtifactDiagnostics({
        artifacts,
        preferredArch: "arm64",
        identityExtractor: () => ({
          desktopEntry: {
            Name: "kmux",
            Icon: "kmux"
          },
          notificationIconResourcePath: path.join(
            "resources",
            "notificationIcon.png"
          )
        })
      });

      expect(x64Diagnostics).toMatchObject({
        selectedAppImagePath: x64AppImagePath,
        selectedMetadataPath: x64MetadataPath
      });
      expect(arm64Diagnostics).toMatchObject({
        selectedAppImagePath: arm64AppImagePath,
        selectedMetadataPath: arm64MetadataPath
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("selects the newest host-arch AppImage diagnostics when stale artifacts remain", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-evidence-stale-"));
    try {
      const oldX64Dir = path.join(root, "linux-x64-old-release-assets");
      const newX64Dir = path.join(root, "linux-x64-new-release-assets");
      const arm64Dir = path.join(root, "linux-arm64-release-assets");
      mkdirSync(oldX64Dir);
      mkdirSync(newX64Dir);
      mkdirSync(arm64Dir);

      const oldX64AppImagePath = path.join(
        oldX64Dir,
        "kmux-0.3.11-linux-x64.AppImage"
      );
      const newX64AppImagePath = path.join(
        newX64Dir,
        "kmux-0.3.12-linux-x64.AppImage"
      );
      const newerArm64AppImagePath = path.join(
        arm64Dir,
        "kmux-0.3.13-linux-arm64.AppImage"
      );
      const oldX64MetadataPath = path.join(oldX64Dir, "latest-linux.yml");
      const newX64MetadataPath = path.join(newX64Dir, "latest-linux.yml");
      const arm64MetadataPath = path.join(arm64Dir, "latest-linux-arm64.yml");

      writeFileSync(oldX64AppImagePath, "old-x64");
      writeFileSync(newX64AppImagePath, "new-x64");
      writeFileSync(newerArm64AppImagePath, "newer-arm64");
      writeFileSync(
        oldX64MetadataPath,
        [
          "version: 0.3.11",
          "files:",
          "  - url: kmux-0.3.11-linux-x64.AppImage",
          "    sha512: old-x64-checksum",
          "    size: 7",
          "path: kmux-0.3.11-linux-x64.AppImage",
          "sha512: old-x64-checksum"
        ].join("\n")
      );
      writeFileSync(
        newX64MetadataPath,
        [
          "version: 0.3.12",
          "files:",
          "  - url: kmux-0.3.12-linux-x64.AppImage",
          "    sha512: new-x64-checksum",
          "    size: 7",
          "path: kmux-0.3.12-linux-x64.AppImage",
          "sha512: new-x64-checksum"
        ].join("\n")
      );
      writeFileSync(
        arm64MetadataPath,
        [
          "version: 0.3.13",
          "files:",
          "  - url: kmux-0.3.13-linux-arm64.AppImage",
          "    sha512: newer-arm64-checksum",
          "    size: 11",
          "path: kmux-0.3.13-linux-arm64.AppImage",
          "sha512: newer-arm64-checksum"
        ].join("\n")
      );

      utimesSync(oldX64AppImagePath, new Date(1000), new Date(1000));
      utimesSync(newX64AppImagePath, new Date(2000), new Date(2000));
      utimesSync(newerArm64AppImagePath, new Date(3000), new Date(3000));

      expect(
        collectPackagedArtifactDiagnostics({
          artifacts: collectReleaseArtifacts([root]),
          preferredArch: "x64",
          identityExtractor: () => ({
            desktopEntry: {
              Name: "kmux",
              Icon: "kmux"
            },
            notificationIconResourcePath: path.join(
              "resources",
              "notificationIcon.png"
            )
          })
        })
      ).toMatchObject({
        selectedAppImagePath: newX64AppImagePath,
        selectedMetadataPath: newX64MetadataPath
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("selects only packaged kmux Linux AppImages for diagnostics", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-evidence-shape-"));
    try {
      const genericAppImagePath = path.join(root, "kmux.AppImage");
      const macNamedAppImagePath = path.join(
        root,
        "kmux-0.3.12-mac-x64.AppImage"
      );
      const linuxAppImagePath = path.join(
        root,
        "kmux-0.3.12-linux-x64.AppImage"
      );
      writeFileSync(genericAppImagePath, "generic-app");
      writeFileSync(macNamedAppImagePath, "mac-app");
      writeFileSync(linuxAppImagePath, "linux-app");

      const artifacts = collectReleaseArtifacts([root]);
      const diagnostics = collectPackagedArtifactDiagnostics({
        artifacts,
        preferredArch: "x64",
        identityExtractor: ({ appImagePath }) => {
          expect(appImagePath).toBe(linuxAppImagePath);
          return {
            desktopEntry: {
              Name: "kmux",
              Icon: "kmux"
            },
            notificationIconResourcePath: path.join(
              "resources",
              "notificationIcon.png"
            )
          };
        }
      });

      expect(artifacts.map((artifact) => artifact.name)).toEqual(
        expect.arrayContaining([
          "kmux-0.3.12-linux-x64.AppImage",
          "kmux-0.3.12-mac-x64.AppImage",
          "kmux.AppImage"
        ])
      );
      expect(diagnostics).toMatchObject({
        selectedAppImagePath: linuxAppImagePath
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records packaged diagnostic gaps without throwing", () => {
    expect(
      collectPackagedArtifactDiagnostics({
        artifacts: [],
        identityExtractor: () => {
          throw new Error("should not run");
        }
      })
    ).toMatchObject({
      selectedAppImagePath: "",
      selectedMetadataPath: "",
      updateMetadata: {
        status: "missing"
      },
      appImageIdentity: {
        status: "missing"
      }
    });
  });

  it("checks command availability without executing agent CLIs", () => {
    const calls = [];
    const availability = collectCommandAvailability(
      ["codex", "claude"],
      (command, args) => {
        calls.push([command, args]);
        const shellCommand = args[1];
        return {
          status: shellCommand.includes("codex") ? 0 : 1,
          stdout: shellCommand.includes("codex") ? "/usr/bin/codex\n" : "",
          stderr: ""
        };
      }
    );

    expect(calls).toEqual([
      ["sh", ["-lc", "command -v 'codex'"]],
      ["sh", ["-lc", "command -v 'claude'"]]
    ]);
    expect(availability).toEqual([
      {
        command: "codex",
        path: "/usr/bin/codex",
        available: true
      },
      {
        command: "claude",
        path: "",
        available: false
      }
    ]);
  });

  it("collects script command availability for the Linux subprocess audit", () => {
    const calls = [];
    const evidence = collectEvidence({
      env: {
        HOME: "/home/test",
        PATH: "/usr/bin"
      },
      platform: "linux",
      now: new Date("2026-06-10T10:00:00.000Z"),
      searchRoots: [],
      identityExtractor: () => {
        throw new Error("should not extract AppImage identity without artifacts");
      },
      runner: (command, args) => {
        calls.push([command, args]);
        if (command === "git") {
          return {
            status: 0,
            stdout: args[0] === "rev-parse" ? "abc1234\n" : "",
            stderr: ""
          };
        }
        if (command === "sh" && args[1] === "command -v 'script'") {
          return {
            status: 0,
            stdout: "/usr/bin/script\n",
            stderr: ""
          };
        }
        return {
          status: 1,
          stdout: "",
          stderr: ""
        };
      }
    });

    expect(calls).toContainEqual(["sh", ["-lc", "command -v 'script'"]]);
    expect(evidence.systemCommands).toContainEqual({
      command: "script",
      path: "/usr/bin/script",
      available: true
    });
  });

  it("tracks common installed agent CLI command aliases for RC evidence", () => {
    const calls = [];
    const availability = collectCommandAvailability(AGENT_COMMANDS, (
      command,
      args
    ) => {
      calls.push([command, args]);
      return {
        status: 1,
        stdout: "",
        stderr: ""
      };
    });

    expect(AGENT_COMMANDS).toEqual([
      "codex",
      "claude",
      "claude-code",
      "gemini",
      "gemini-cli",
      "antigravity",
      "antigravity-cli",
      "agy"
    ]);
    expect(calls).toEqual(
      AGENT_COMMANDS.map((command) => [
        "sh",
        ["-lc", `command -v '${command}'`]
      ])
    );
    expect(availability.every((entry) => entry.available === false)).toBe(
      true
    );
  });

  it("records shell PATH context for manual GUI PATH recovery evidence", () => {
    const snapshot = collectShellPathSnapshot({
      env: {
        HOME: "/home/test",
        SHELL: "/bin/bash",
        NVM_DIR: "/home/test/.nvm",
        PYENV_ROOT: "/home/test/.pyenv",
        CARGO_HOME: "/home/test/.cargo",
        PATH: [
          "/home/test/.nvm/versions/node/v22.16.0/bin",
          "/home/test/.pyenv/shims",
          "/home/test/.cargo/bin",
          "/home/test/.local/bin",
          "/usr/bin"
        ].join(":")
      }
    });

    expect(snapshot.env).toMatchObject({
      HOME: "/home/test",
      SHELL: "/bin/bash",
      NVM_DIR: "/home/test/.nvm",
      PYENV_ROOT: "/home/test/.pyenv",
      CARGO_HOME: "/home/test/.cargo"
    });
    expect(snapshot.pathSegments).toEqual([
      "/home/test/.nvm/versions/node/v22.16.0/bin",
      "/home/test/.pyenv/shims",
      "/home/test/.cargo/bin",
      "/home/test/.local/bin",
      "/usr/bin"
    ]);
    expect(snapshot.expectedPathSegments).toEqual([
      {
        label: "~/.local/bin",
        path: "/home/test/.local/bin",
        present: true
      },
      {
        label: "cargo bin",
        path: "/home/test/.cargo/bin",
        present: true
      },
      {
        label: "pyenv bin",
        path: "/home/test/.pyenv/bin",
        present: false
      },
      {
        label: "pyenv shims",
        path: "/home/test/.pyenv/shims",
        present: true
      },
      {
        label: "nvm-managed bin",
        path: "/home/test/.nvm",
        present: true
      }
    ]);
  });

  it("ignores relative shell PATH root env values when deriving expected paths", () => {
    const snapshot = collectShellPathSnapshot({
      env: {
        HOME: "relative-home",
        NVM_DIR: "relative-nvm",
        PYENV_ROOT: " /home/test/.pyenv ",
        CARGO_HOME: "relative-cargo",
        PATH: [
          "relative-home/.local/bin",
          "relative-nvm/versions/node/v22.16.0/bin",
          "/home/test/.pyenv/shims",
          "/usr/bin"
        ].join(":")
      }
    });

    expect(snapshot.expectedPathSegments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "pyenv shims",
          path: "/home/test/.pyenv/shims",
          present: true
        }),
        expect.objectContaining({
          label: "nvm-managed bin",
          present: false
        }),
        expect.objectContaining({
          label: "cargo bin",
          present: false
        })
      ])
    );
    expect(
      snapshot.expectedPathSegments.every((entry) => path.isAbsolute(entry.path))
    ).toBe(true);
    expect(snapshot.expectedPathSegments.map((entry) => entry.path)).not.toEqual(
      expect.arrayContaining([
        "relative-home/.local/bin",
        "relative-nvm",
        "relative-cargo/bin"
      ])
    );
  });

  it("records parseable Linux ps diagnostics", () => {
    const psOutput = [
      "    1     0 /sbin/init splash",
      " 1200     1 /usr/bin/bash",
      " 1201  1200 /usr/bin/node /usr/local/bin/codex -s read-only"
    ].join("\n");

    expect(parsePsProcessTable(psOutput)).toEqual([
      {
        pid: 1,
        parentPid: 0,
        commandLine: "/sbin/init splash"
      },
      {
        pid: 1200,
        parentPid: 1,
        commandLine: "/usr/bin/bash"
      },
      {
        pid: 1201,
        parentPid: 1200,
        commandLine: "/usr/bin/node /usr/local/bin/codex -s read-only"
      }
    ]);

    const samples = collectSystemSamples((command) => {
      if (command === "ps") {
        return {
          status: 0,
          stdout: psOutput,
          stderr: ""
        };
      }
      if (command === "lsof") {
        return {
          status: 0,
          stdout: [
            "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
            "node 1201 test 21u IPv4 0x0 0t0 TCP 127.0.0.1:5173 (LISTEN)"
          ].join("\n"),
          stderr: ""
        };
      }
      if (command === "fc-list") {
        return {
          status: 0,
          stdout: "JetBrains Mono\nFira Code,Fira Code Retina\n",
          stderr: ""
        };
      }
      return {
        status: 1,
        stdout: "",
        stderr: ""
      };
    });

    expect(samples.ps).toMatchObject({
      status: 0,
      parseStatus: "parsed",
      parsedRows: 3
    });
    expect(samples.lsof).toMatchObject({
      status: 0,
      sample: expect.stringContaining("127.0.0.1:5173 (LISTEN)")
    });
    expect(samples.fontFamilies).toBe(3);
  });

  it("records AppImage sandbox environment and Linux user namespace settings", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-sandbox-"));
    try {
      mkdirSync(path.join(root, "sys", "kernel"), { recursive: true });
      mkdirSync(path.join(root, "sys", "user"), { recursive: true });
      writeFileSync(
        path.join(root, "sys", "kernel", "unprivileged_userns_clone"),
        "1\n"
      );
      writeFileSync(
        path.join(root, "sys", "user", "max_user_namespaces"),
        "515199\n"
      );

      expect(
        collectSandboxSnapshot({
          procRoot: root,
          env: {
            APPIMAGE: "/tmp/kmux.AppImage",
            APPIMAGE_EXTRACT_AND_RUN: "1",
            ELECTRON_DISABLE_SANDBOX: "0"
          }
        })
      ).toEqual({
        appImageEnv: {
          APPIMAGE: "/tmp/kmux.AppImage",
          APPIMAGE_EXTRACT_AND_RUN: "1",
          ELECTRON_DISABLE_SANDBOX: "0",
          ELECTRON_NO_SANDBOX: "",
          CHROME_DEVEL_SANDBOX: ""
        },
        linuxUserNamespace: [
          {
            key: "kernel.unprivileged_userns_clone",
            path: path.join(
              root,
              "sys",
              "kernel",
              "unprivileged_userns_clone"
            ),
            status: "read",
            value: "1"
          },
          {
            key: "user.max_user_namespaces",
            path: path.join(root, "sys", "user", "max_user_namespaces"),
            status: "read",
            value: "515199"
          }
        ]
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records shallow agent storage root diagnostics without reading contents", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-agent-storage-"));
    try {
      mkdirSync(path.join(root, ".codex", "sessions"), { recursive: true });
      mkdirSync(path.join(root, ".claude", "projects"), { recursive: true });
      mkdirSync(path.join(root, ".gemini", "history"), { recursive: true });
      mkdirSync(path.join(root, ".gemini", "antigravity-cli", "brain"), {
        recursive: true
      });
      writeFileSync(path.join(root, ".codex", "auth.json"), "{}");
      writeFileSync(path.join(root, ".claude", ".credentials.json"), "{}");
      writeFileSync(
        path.join(root, ".gemini", "antigravity-cli", "history.jsonl"),
        "{}\n"
      );

      const snapshot = collectAgentStorageSnapshot({
        homeDir: root
      });

      expect(snapshot.homeDir).toBe(root);
      expect(
        snapshot.entries.find(
          (entry) =>
            entry.provider === "codex" && entry.label === "sessionsDir"
        )
      ).toMatchObject({
        status: "directory",
        entryCount: 0
      });
      expect(
        snapshot.entries.find(
          (entry) => entry.provider === "codex" && entry.label === "authPath"
        )
      ).toMatchObject({
        status: "file",
        entryCount: null
      });
      expect(
        snapshot.entries.find(
          (entry) =>
            entry.provider === "gemini" &&
            entry.label === "oauthCredentialsPath"
        )
      ).toMatchObject({
        status: "missing",
        entryCount: null
      });
      expect(
        snapshot.entries.find(
          (entry) =>
            entry.provider === "antigravity" &&
            entry.label === "historyPath"
        )
      ).toMatchObject({
        status: "file",
        entryCount: null
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not sample cwd-relative agent storage when HOME is relative", () => {
    const cwdRoot = mkdtempSync(path.join(tmpdir(), "kmux-agent-cwd-"));
    const fallbackHome = mkdtempSync(path.join(tmpdir(), "kmux-agent-home-"));
    try {
      mkdirSync(path.join(cwdRoot, "relative-home", ".codex"), {
        recursive: true
      });
      writeFileSync(
        path.join(cwdRoot, "relative-home", ".codex", "auth.json"),
        "{}"
      );

      const previousCwd = process.cwd();
      process.chdir(cwdRoot);
      try {
        const snapshot = collectAgentStorageSnapshot({
          homeDir: "relative-home",
          env: {
            HOME: fallbackHome
          }
        });
        const codexAuth = snapshot.entries.find(
          (entry) => entry.provider === "codex" && entry.label === "authPath"
        );

        expect(snapshot.homeDir).toBe(fallbackHome);
        expect(codexAuth).toMatchObject({
          path: path.join(fallbackHome, ".codex", "auth.json"),
          status: "missing"
        });
      } finally {
        process.chdir(previousCwd);
      }
    } finally {
      rmSync(cwdRoot, { recursive: true, force: true });
      rmSync(fallbackHome, { recursive: true, force: true });
    }
  });

  it("keeps evidence storage paths aligned with AgentStorageRoots", () => {
    const homeDir = "/home/test";
    const roots = resolveAgentStorageRoots({ homeDir });
    const snapshot = collectAgentStorageSnapshot({ homeDir });
    const pathByKey = new Map(
      snapshot.entries.map((entry) => [
        `${entry.provider}.${entry.label}`,
        entry.path
      ])
    );

    expect(pathByKey).toEqual(
      new Map([
        ["codex.root", roots.codex.root],
        ["codex.sessionsDir", roots.codex.sessionsDir],
        ["codex.authPath", roots.codex.authPath],
        ["claude.root", roots.claude.root],
        ["claude.projectsDir", roots.claude.projectsDir],
        ["claude.credentialsPath", roots.claude.credentialsPath],
        ["claude.settingsPath", roots.claude.settingsPath],
        ["gemini.root", roots.gemini.root],
        ["gemini.tmpDir", roots.gemini.tmpDir],
        ["gemini.historyDir", roots.gemini.historyDir],
        ["gemini.oauthCredentialsPath", roots.gemini.oauthCredentialsPath],
        ["gemini.settingsPath", roots.gemini.settingsPath],
        ["antigravity.root", roots.antigravity.root],
        ["antigravity.brainDir", roots.antigravity.brainDir],
        ["antigravity.historyPath", roots.antigravity.historyPath],
        ["antigravity.cacheProjectsPath", roots.antigravity.cacheProjectsPath],
        ["antigravity.conversationsDir", roots.antigravity.conversationsDir],
        ["antigravity.hooksPath", roots.antigravity.hooksPath]
      ])
    );
  });

  it("records Linux inotify settings for watch and resync diagnostics", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-linux-inotify-"));
    try {
      mkdirSync(path.join(root, "sys", "fs", "inotify"), {
        recursive: true
      });
      writeFileSync(
        path.join(root, "sys", "fs", "inotify", "max_user_watches"),
        "1048576\n"
      );
      writeFileSync(
        path.join(root, "sys", "fs", "inotify", "max_user_instances"),
        "1024\n"
      );
      writeFileSync(
        path.join(root, "sys", "fs", "inotify", "max_queued_events"),
        "16384\n"
      );

      expect(collectWatchSnapshot({ procRoot: root })).toEqual({
        inotify: [
          {
            key: "fs.inotify.max_user_watches",
            path: path.join(
              root,
              "sys",
              "fs",
              "inotify",
              "max_user_watches"
            ),
            status: "read",
            value: "1048576"
          },
          {
            key: "fs.inotify.max_user_instances",
            path: path.join(
              root,
              "sys",
              "fs",
              "inotify",
              "max_user_instances"
            ),
            status: "read",
            value: "1024"
          },
          {
            key: "fs.inotify.max_queued_events",
            path: path.join(
              root,
              "sys",
              "fs",
              "inotify",
              "max_queued_events"
            ),
            status: "read",
            value: "16384"
          }
        ]
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("formats a release-ledger-ready evidence report", () => {
    const reportInput = {
      date: "2026-06-10T00:00:00.000Z",
      commit: "abc1234",
      packageVersion: "0.3.12",
      packaging: {
        rootPackageLinuxScript:
          "npm run build && npm run rebuild:electron && npm run dist:linux --workspace @kmux/desktop",
        rootReleaseCheckLinuxScript:
          "node scripts/release-check-linux.mjs --require-ubuntu-desktop && npm run gate:walking-skeleton:linux && npm run package:linux && npm run smoke:packaged:linux && node scripts/release-check-linux.mjs",
        desktopDistLinuxScript:
          "electron-builder --config electron-builder.yml --linux AppImage --publish never",
        rootPackageUsesDistLinux: true,
        desktopDistLinuxUsesPublishNever: true,
        publishProvider: "github",
        publishOwner: "kkd927",
        publishRepo: "kmux",
        publishReleaseType: "release",
        linuxTarget: ["AppImage"],
        linuxArtifactName: "${productName}-${version}-linux-${arch}.${ext}",
        linuxExecutableName: "kmux"
      },
      runtimeIdentity: {
        status: "read",
        appIdentityPath: "/repo/apps/desktop/src/main/appIdentity.ts",
        builderConfigPath: "/repo/apps/desktop/electron-builder.yml",
        appId: "dev.kmux.desktop",
        appName: "kmux",
        startupWmClass: "kmux",
        builderAppId: "dev.kmux.desktop",
        builderProductName: "kmux",
        builderLinuxExecutableName: "kmux",
        builderDesktopName: "kmux",
        builderDesktopStartupWmClass: "kmux",
        appIdMatchesBuilder: true,
        appNameMatchesProductName: true,
        executableNameMatchesAppName: true,
        desktopNameMatchesAppName: true,
        startupWmClassMatchesDesktopEntry: true,
        error: ""
      },
      releaseWorkflow: {
        workflowPath: "/repo/.github/workflows/release-desktop.yml",
        status: "read",
        hasLinuxPublicGateCommand: true,
        linuxPublicGateBeforePublish: true,
        linuxPublicUploadsAllowed: false,
        linuxPublicPublishingGated: true,
        error: ""
      },
      environment: collectEnvironmentSnapshot({
        platform: "linux",
        arch: "x64",
        release: "6.8.0",
        nodeVersion: "v22.0.0",
        osReleaseText: [
          'PRETTY_NAME="Ubuntu 24.04.2 LTS"',
          'NAME="Ubuntu"',
          'VERSION="24.04.2 LTS (Noble Numbat)"',
          "ID=ubuntu",
          'VERSION_ID="24.04"'
        ].join("\n"),
        env: {
          DISPLAY: ":0",
          XDG_CURRENT_DESKTOP: "GNOME",
          GTK_IM_MODULE: "ibus",
          XDG_RUNTIME_DIR: "/run/user/1000",
          APPIMAGE: "/tmp/kmux.AppImage"
        }
      }),
      git: {
        commit: "abc1234",
        dirty: true,
        statusScope:
          "source worktree, ignoring generated release artifact directories",
        statusIgnoredPaths: RELEASE_BUILD_OUTPUT_STATUS_EXCLUDES,
        statusEntryCount: 2,
        statusSample: " M package.json\n?? docs/linux-release-validation.md",
        statusError: ""
      },
      desktopIntegration: {
        env: {
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
          XDG_DATA_HOME: "/home/test/.local/share",
          XDG_DATA_DIRS: "/usr/local/share:/usr/share",
          XDG_CURRENT_DESKTOP: "GNOME",
          XDG_SESSION_TYPE: "wayland",
          DESKTOP_SESSION: "ubuntu",
          GDMSESSION: "ubuntu",
          XDG_MENU_PREFIX: "gnome-"
        },
        notificationProbes: [
          {
            label: "DBus notification service owner",
            command: "dbus-send",
            args: [
              "--session",
              "--dest=org.freedesktop.DBus",
              "--type=method_call",
              "--print-reply",
              "/org/freedesktop/DBus",
              "org.freedesktop.DBus.NameHasOwner",
              "string:org.freedesktop.Notifications"
            ],
            skipped: false,
            status: 0,
            signal: null,
            error: "",
            sample: "method return time=1.0\n   boolean true"
          },
          {
            label: "DBus notification server information",
            command: "dbus-send",
            args: [
              "--session",
              "--dest=org.freedesktop.Notifications",
              "--type=method_call",
              "--print-reply",
              "/org/freedesktop/Notifications",
              "org.freedesktop.Notifications.GetServerInformation"
            ],
            skipped: false,
            status: 0,
            signal: null,
            error: "",
            sample: [
              "method return time=1.0",
              '   string "GNOME Shell"',
              '   string "GNOME"',
              '   string "46.0"',
              '   string "1.2"'
            ].join("\n")
          }
        ],
        applicationEntryCandidates: [
          {
            path: "/home/test/.local/share/applications/kmux.desktop",
            status: "file",
            sizeBytes: 164,
            desktopEntry: {
              Name: "kmux",
              Icon: "kmux",
              Categories: "Development;TerminalEmulator;Utility;",
              StartupWMClass: "kmux",
              StartupNotify: "true",
              Terminal: "false"
            }
          },
          {
            path: "/usr/share/applications/kmux.desktop",
            status: "missing"
          }
        ]
      },
      desktopShell: {
        env: {
          XDG_SESSION_ID: "3",
          XDG_SESSION_CLASS: "user",
          XDG_SESSION_DESKTOP: "ubuntu",
          XDG_SESSION_TYPE: "wayland",
          XDG_CURRENT_DESKTOP: "GNOME",
          DESKTOP_SESSION: "ubuntu",
          GDMSESSION: "ubuntu",
          DISPLAY: ":0",
          WAYLAND_DISPLAY: "wayland-0",
          ELECTRON_OZONE_PLATFORM_HINT: "auto",
          GDK_BACKEND: "",
          QT_QPA_PLATFORM: ""
        },
        probes: [
          {
            label: "loginctl session",
            command: "loginctl",
            args: [
              "show-session",
              "3",
              "-p",
              "Type",
              "-p",
              "Desktop"
            ],
            skipped: false,
            status: 0,
            signal: null,
            error: "",
            sample: "Type=wayland\nDesktop=ubuntu"
          },
          {
            label: "GNOME Shell version",
            command: "gnome-shell",
            args: ["--version"],
            skipped: false,
            status: 0,
            signal: null,
            error: "",
            sample: "GNOME Shell 46.0"
          },
          {
            label: "GNOME switch application shortcut 4",
            command: "gsettings",
            args: [
              "get",
              "org.gnome.shell.keybindings",
              "switch-to-application-4"
            ],
            skipped: false,
            status: 0,
            signal: null,
            error: "",
            sample: "['<Super>4']"
          },
          {
            label: "GNOME switch workspace shortcut 1",
            command: "gsettings",
            args: [
              "get",
              "org.gnome.desktop.wm.keybindings",
              "switch-to-workspace-1"
            ],
            skipped: false,
            status: 0,
            signal: null,
            error: "",
            sample: "@as []"
          },
          {
            label: "X11 display query",
            command: "xrandr",
            args: ["--query"],
            skipped: false,
            status: 0,
            signal: null,
            error: "",
            sample: "Screen 0: current 1920 x 1080"
          },
          {
            label: "X11 window manager root properties",
            command: "xprop",
            args: [
              "-root",
              "_NET_SUPPORTING_WM_CHECK",
              "_NET_ACTIVE_WINDOW",
              "_NET_CLIENT_LIST"
            ],
            skipped: false,
            status: 0,
            signal: null,
            error: "",
            sample: [
              "_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x200001",
              "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x400001",
              "_NET_CLIENT_LIST(WINDOW): window id # 0x400001, 0x400002"
            ].join("\n")
          }
        ]
      },
      ime: {
        env: {
          GTK_IM_MODULE: "ibus",
          QT_IM_MODULE: "ibus",
          XMODIFIERS: "@im=ibus",
          INPUT_METHOD: "ibus"
        },
        probes: [
          {
            label: "ibus current engine",
            command: "ibus",
            args: ["engine"],
            skipped: false,
            status: 0,
            signal: null,
            error: "",
            sample: "xkb:us::eng"
          },
          {
            label: "fcitx5 current input method",
            command: "fcitx5-remote",
            args: ["-n"],
            skipped: false,
            status: 1,
            signal: null,
            error: "",
            sample: "Not available"
          }
        ]
      },
      sandbox: {
        appImageEnv: {
          APPIMAGE: "/tmp/kmux.AppImage",
          APPIMAGE_EXTRACT_AND_RUN: "1",
          ELECTRON_DISABLE_SANDBOX: "",
          ELECTRON_NO_SANDBOX: "",
          CHROME_DEVEL_SANDBOX: ""
        },
        linuxUserNamespace: [
          {
            key: "kernel.unprivileged_userns_clone",
            path: "/proc/sys/kernel/unprivileged_userns_clone",
            status: "read",
            value: "1"
          },
          {
            key: "user.max_user_namespaces",
            path: "/proc/sys/user/max_user_namespaces",
            status: "read",
            value: "515199"
          }
        ]
      },
      watch: {
        inotify: [
          {
            key: "fs.inotify.max_user_watches",
            path: "/proc/sys/fs/inotify/max_user_watches",
            status: "read",
            value: "1048576"
          },
          {
            key: "fs.inotify.max_user_instances",
            path: "/proc/sys/fs/inotify/max_user_instances",
            status: "read",
            value: "1024"
          },
          {
            key: "fs.inotify.max_queued_events",
            path: "/proc/sys/fs/inotify/max_queued_events",
            status: "read",
            value: "16384"
          }
        ]
      },
      agentStorage: {
        homeDir: "/home/test",
        entries: [
          {
            provider: "codex",
            label: "sessionsDir",
            path: "/home/test/.codex/sessions",
            status: "directory",
            entryCount: 3
          },
          {
            provider: "claude",
            label: "credentialsPath",
            path: "/home/test/.claude/.credentials.json",
            status: "missing",
            entryCount: null
          },
          {
            provider: "gemini",
            label: "historyDir",
            path: "/home/test/.gemini/history",
            status: "directory",
            entryCount: 1
          },
          {
            provider: "antigravity",
            label: "historyPath",
            path: "/home/test/.gemini/antigravity-cli/history.jsonl",
            status: "file",
            entryCount: null
          }
        ]
      },
      artifacts: [
        {
          path: "/repo/apps/desktop/release/kmux-0.3.12-linux-x64.AppImage",
          sizeBytes: 42
        },
        {
          path: "/repo/apps/desktop/release/kmux-0.3.12-linux-x64.deb",
          sizeBytes: 11
        }
      ],
      packagedDiagnostics: {
        selectedAppImagePath:
          "/repo/apps/desktop/release/kmux-0.3.12-linux-x64.AppImage",
        selectedAppImageBlockmap: {
          status: "present",
          path: "/repo/apps/desktop/release/kmux-0.3.12-linux-x64.AppImage.blockmap",
          sizeBytes: 7
        },
        selectedMetadataPath: "/repo/apps/desktop/release/latest-linux.yml",
        updateMetadata: {
          status: "parsed",
          path: "/repo/apps/desktop/release/latest-linux.yml",
          metadataFileName: "latest-linux.yml",
          expectedMetadataNames: ["latest-linux.yml", "latest-linux.yaml"],
          metadataNameMatchesAppImage: true,
          metadataColocatedWithAppImage: true,
          version: "0.3.12",
          updatePath: "kmux-0.3.12-linux-x64.AppImage",
          fileCount: 1,
          appImageFilePath: "kmux-0.3.12-linux-x64.AppImage",
          updatePathMatchesAppImage: true,
          fileEntryMatchesUpdatePath: true,
          fileEntryMatchesAppImage: true,
          hasTopLevelSha512: true,
          topLevelSha512: "actual-sha512",
          hasAppImageFileSha512: true,
          appImageFileSha512: "actual-sha512",
          checksumMatches: true,
          hasActualAppImageSha512: true,
          actualAppImageSha512: "actual-sha512",
          appImageSha512MatchesActual: true,
          hasAppImageFileSize: true,
          appImageFileSize: 42,
          actualAppImageSize: 42,
          sizeMatches: true
        },
        appImageIdentity: {
          status: "extracted",
          appImagePath:
            "/repo/apps/desktop/release/kmux-0.3.12-linux-x64.AppImage",
          desktopEntry: {
            Name: "kmux",
            Icon: "kmux",
            Categories: "Development;TerminalEmulator;Utility;",
            StartupWMClass: "kmux",
            StartupNotify: "true",
            Terminal: "false"
          },
          notificationIconResourcePath: path.join(
            "resources",
            "notificationIcon.png"
          )
        }
      },
      agentCommands: [
        { command: "codex", path: "/usr/bin/codex", available: true }
      ],
      shellPath: collectShellPathSnapshot({
        env: {
          HOME: "/home/test",
          SHELL: "/bin/bash",
          PATH: [
            "/home/test/.nvm/versions/node/v22.16.0/bin",
            "/home/test/.pyenv/shims",
            "/home/test/.cargo/bin",
            "/home/test/.local/bin",
            "/usr/bin"
          ].join(":"),
          NVM_DIR: "/home/test/.nvm",
          PYENV_ROOT: "/home/test/.pyenv",
          CARGO_HOME: "/home/test/.cargo"
        }
      }),
      systemCommands: [
        { command: "fc-list", path: "/usr/bin/fc-list", available: true }
      ],
      systemSamples: {
        ps: {
          status: 0,
          parseStatus: "parsed",
          parsedRows: 1,
          sample: "1 0 /sbin/init"
        },
        lsof: {
          status: 0,
          sample:
            "node 1201 test 21u IPv4 0x0 0t0 TCP 127.0.0.1:5173 (LISTEN)"
        },
        fontStatus: 0,
        fontFamilies: 12,
        fontSample: "JetBrains Mono"
      }
    };
    const report = buildEvidenceReport(reportInput);
    const scriptDevelopmentReport = buildEvidenceReport({
      ...reportInput,
      allowAnyPlatform: true
    });
    const scriptDevelopmentHandoff = scriptDevelopmentReport.match(
      /## RC Ledger Field Handoff[\s\S]*?```text\n([\s\S]*?)\n```/
    )?.[1];

    expect(report).toContain("# Linux Release Evidence Report");
    expect(report).toContain("Report mode: Ubuntu Desktop ledger input");
    expect(report).toContain(
      "Passing RC evidence: no; keep the handoff Result non-passing until manual Ubuntu Desktop/AppImage observations pass."
    );
    expect(scriptDevelopmentReport).toContain(
      "Report mode: script-development/non-RC (--allow-any-platform)"
    );
    expect(scriptDevelopmentHandoff).toContain(
      "npm run release:evidence:linux -- --allow-any-platform --output docs/plans/linux-rc-evidence-2026-06-10.md"
    );
    expect(report).toContain("Git dirty: yes");
    expect(report).toContain(
      "Git status scope: source worktree, ignoring generated release artifact directories"
    );
    expect(report).toContain(
      "Git status ignored paths: release-assets, apps/desktop/release"
    );
    expect(report).toContain("Git status entries: 2");
    expect(report).toContain("?? docs/linux-release-validation.md");
    expect(report).toContain("distro: Ubuntu 24.04.2 LTS");
    expect(report).toContain("distro id: ubuntu");
    expect(report).toContain("Ubuntu LTS detected: yes");
    expect(report).toContain("desktop display detected: yes");
    expect(report).toContain("Ubuntu Desktop session env detected: yes");
    expect(report).toContain("APPIMAGE: /tmp/kmux.AppImage");
    expect(report).toContain("Desktop Integration Context");
    expect(report).toContain(
      "DBUS_SESSION_BUS_ADDRESS: unix:path=/run/user/1000/bus"
    );
    expect(report).toContain("Notification DBus probes:");
    expect(report).toContain("DBus notification service owner");
    expect(report).toContain("org.freedesktop.DBus.NameHasOwner");
    expect(report).toContain("DBus notification server information");
    expect(report).toContain("GNOME Shell");
    expect(report).toContain(
      "/home/test/.local/share/applications/kmux.desktop: file"
    );
    expect(report).toContain("StartupWMClass=kmux");
    expect(report).toContain("/usr/share/applications/kmux.desktop: missing");
    expect(report).toContain("Desktop Shell And Display Probes");
    expect(report).toContain("XDG_SESSION_ID: 3");
    expect(report).toContain("GNOME Shell version");
    expect(report).toContain("GNOME Shell 46.0");
    expect(report).toContain("GNOME switch application shortcut 4");
    expect(report).toContain("switch-to-application-4");
    expect(report).toContain("GNOME switch workspace shortcut 1");
    expect(report).toContain("switch-to-workspace-1");
    expect(report).toContain("X11 display query");
    expect(report).toContain("Screen 0: current 1920 x 1080");
    expect(report).toContain("X11 window manager root properties");
    expect(report).toContain("_NET_ACTIVE_WINDOW");
    expect(report).toContain("_NET_CLIENT_LIST");
    expect(report).toContain("AppImage Sandbox Context");
    expect(report.match(/^## AppImage Sandbox Context$/gm)).toHaveLength(1);
    expect(report).toContain("APPIMAGE_EXTRACT_AND_RUN: 1");
    expect(report).toContain("kernel.unprivileged_userns_clone: read");
    expect(report).toContain("user.max_user_namespaces: read");
    expect(report).toContain("Filesystem Watch Context");
    expect(report).toContain("fs.inotify.max_user_watches: read");
    expect(report).toContain("fs.inotify.max_user_instances: read");
    expect(report).toContain("fs.inotify.max_queued_events: read");
    expect(report).toContain("Shell PATH Context");
    expect(report).toContain("SHELL: /bin/bash");
    expect(report).toContain("~/.local/bin: present (/home/test/.local/bin)");
    expect(report).toContain("cargo bin: present (/home/test/.cargo/bin)");
    expect(report).toContain("pyenv bin: missing (/home/test/.pyenv/bin)");
    expect(report).toContain("pyenv shims: present (/home/test/.pyenv/shims)");
    expect(report).toContain("nvm-managed bin: present (/home/test/.nvm)");
    expect(report).toContain("/home/test/.nvm/versions/node/v22.16.0/bin");
    expect(report).toContain("Agent Storage Roots");
    expect(report).toContain("HOME: /home/test");
    expect(report).toContain("codex");
    expect(report).toContain(
      "sessionsDir: directory (/home/test/.codex/sessions), entries=3"
    );
    expect(report).toContain(
      "credentialsPath: missing (/home/test/.claude/.credentials.json)"
    );
    expect(report).toContain(
      "historyPath: file (/home/test/.gemini/antigravity-cli/history.jsonl)"
    );
    expect(report).toContain("IME/input-method env:");
    expect(report).toContain("GTK_IM_MODULE: ibus");
    expect(report).toContain("ibus current engine");
    expect(report).toContain("xkb:us::eng");
    expect(report).toContain("fcitx5 current input method");
    expect(report).toContain("Not available");
    expect(report).toContain("Release Artifacts");
    expect(report).toContain(
      "/repo/apps/desktop/release/kmux-0.3.12-linux-x64.AppImage (42 bytes)"
    );
    expect(report).toContain(
      "/repo/apps/desktop/release/kmux-0.3.12-linux-x64.deb (11 bytes)"
    );
    expect(report).toContain("Packaging And Publishing Configuration");
    expect(report).toContain(
      "root package:linux: npm run build && npm run rebuild:electron && npm run dist:linux --workspace @kmux/desktop"
    );
    expect(report).toContain(
      "root release:check:linux: node scripts/release-check-linux.mjs --require-ubuntu-desktop && npm run gate:walking-skeleton:linux && npm run package:linux && npm run smoke:packaged:linux && node scripts/release-check-linux.mjs"
    );
    expect(report).toContain(
      "desktop dist:linux: electron-builder --config electron-builder.yml --linux AppImage --publish never"
    );
    expect(report).toContain("root package:linux uses dist:linux: yes");
    expect(report).toContain("desktop dist:linux uses --publish never: yes");
    expect(report).toContain("electron-builder publish provider: github");
    expect(report).toContain("electron-builder publish owner/repo: kkd927/kmux");
    expect(report).toContain("electron-builder publish releaseType: release");
    expect(report).toContain("electron-builder linux target: AppImage");
    expect(report).toContain(
      "electron-builder linux artifactName: ${productName}-${version}-linux-${arch}.${ext}"
    );
    expect(report).toContain("electron-builder linux executableName: kmux");
    expect(report).toContain("Runtime And Packaged Identity Alignment");
    expect(report).toContain(
      "app identity source: /repo/apps/desktop/src/main/appIdentity.ts"
    );
    expect(report).toContain("runtime app id: dev.kmux.desktop");
    expect(report).toContain("electron-builder appId: dev.kmux.desktop");
    expect(report).toContain("app id matches builder appId: yes");
    expect(report).toContain("runtime app name: kmux");
    expect(report).toContain("productName matches runtime app name: yes");
    expect(report).toContain(
      "linux executableName matches runtime app name: yes"
    );
    expect(report).toContain("runtime StartupWMClass: kmux");
    expect(report).toContain(
      "StartupWMClass matches desktop entry: yes"
    );
    expect(report).toContain("Release Workflow Public Gate");
    expect(report).toContain(
      "release workflow path: /repo/.github/workflows/release-desktop.yml"
    );
    expect(report).toContain("release workflow status: read");
    expect(report).toContain("Linux public gate command present: yes");
    expect(report).toContain("Linux public gate runs before publishing: yes");
    expect(report).toContain(
      "workflow appears to upload Linux public artifacts while gated: no"
    );
    expect(report).toContain("Linux public publishing gated in workflow: yes");
    expect(report).toContain("release workflow error: <none>");
    expect(report).toContain("Packaged AppImage Diagnostics");
    expect(report).toContain(
      "selected AppImage blockmap: /repo/apps/desktop/release/kmux-0.3.12-linux-x64.AppImage.blockmap (7 bytes)"
    );
    expect(report).toContain("metadata filename: latest-linux.yml");
    expect(report).toContain(
      "expected metadata filename: latest-linux.yml or latest-linux.yaml"
    );
    expect(report).toContain("metadata filename matches selected AppImage: yes");
    expect(report).toContain("metadata colocated with selected AppImage: yes");
    expect(report).toContain("channel naming match: yes");
    expect(report).toContain("update path matches selected AppImage: yes");
    expect(report).toContain("file entry matches update path: yes");
    expect(report).toContain("file entry matches selected AppImage: yes");
    expect(report).toContain("top-level sha512: actual-sha512");
    expect(report).toContain("AppImage file sha512: actual-sha512");
    expect(report).toContain("checksum match: yes");
    expect(report).toContain("actual AppImage sha512 present: yes");
    expect(report).toContain("actual AppImage sha512: actual-sha512");
    expect(report).toContain("AppImage sha512 matches actual file: yes");
    expect(report).toContain("AppImage metadata size: 42");
    expect(report).toContain("actual AppImage size: 42");
    expect(report).toContain("size match: yes");
    expect(report).toContain("ps parse status: parsed");
    expect(report).toContain("ps parsed rows: 1");
    expect(report).toContain("lsof status: 0");
    expect(report).toContain("127.0.0.1:5173 (LISTEN)");
    expect(report).toContain("desktop StartupWMClass: kmux");
    expect(report).toContain("notification icon resource: resources");
    expect(report).toContain("RC Ledger Field Handoff");
    const handoff = report.match(
      /## RC Ledger Field Handoff[\s\S]*?```text\n([\s\S]*?)\n```/
    )?.[1];
    expect(handoff).toBeTruthy();
    const handoffFields = parseLinuxReleaseEvidenceEntryFields(handoff);
    expect(handoffFields.Date).toBe("2026-06-10");
    expect(handoffFields.Commit).toBe("abc1234");
    expect(handoffFields["Git dirty"]).toBe("yes");
    expect(handoffFields.Result).toBe(
      "Not passed until Ubuntu Desktop manual RC validation is complete."
    );
    expect(handoffFields.Notes).toMatch(
      /^TODO replace after manual validation/
    );
    expect(handoffFields["Remaining blockers"]).toMatch(/^TODO replace/);
    expect(report).toContain(
      "Environment: Ubuntu Desktop 24.04.2 LTS, XDG_CURRENT_DESKTOP=GNOME"
    );
    expect(report).toContain(
      "Artifact: /repo/apps/desktop/release/kmux-0.3.12-linux-x64.AppImage"
    );
    expect(report).toContain("Commands: npm run gate:walking-skeleton:linux");
    expect(report).toContain("npm run smoke:packaged:linux");
    expect(report).toContain(
      "npm run release:evidence:linux -- --output docs/plans/linux-rc-evidence-2026-06-10.md"
    );
    expect(report).toContain(
      "Result: Not passed until Ubuntu Desktop manual RC validation is complete."
    );
    expect(report).toContain(
      "GUI launch normal window launch path screenshot/run-log evidence"
    );
    expect(report).toContain("terminal launch shell env");
    expect(report).toContain("CLI and desktop same POSIX socket");
    expect(report).toContain(
      "PATH recovery for GUI-launched app shell env with nvm, pyenv, cargo, ~/.local/bin, and installed agent CLIs"
    );
    expect(report).toContain(
      "hook runtime env in pty sessions containing KMUX_SOCKET_PATH, KMUX_AGENT_BIN_DIR, and KMUX_NODE_PATH"
    );
    expect(report).toContain(
      "Codex, Claude, Gemini, and Antigravity hooks notify when installed and configured with per-agent hook logs and UI notification evidence"
    );
    expect(report).toContain(
      "Codex wrapper works with shell rc integration disabled in a walking-skeleton or targeted Codex wrapper run"
    );
    expect(report).toContain(
      "external session discovery/resume for verified vendor roots tied to agent storage roots"
    );
    expect(report).toContain("usage history");
    expect(report).toContain(
      "subscription usage with verified credential source, recorded storage-root evidence, and dashboard evidence"
    );
    expect(report).toContain(
      "missing credentials unavailable/disconnected states with recorded missing credential paths"
    );
    expect(report).toContain(
      "no macOS security command calls plus platform-specific script probing args, script command availability, parsed ps process-table rows, and bounded lsof listening-socket samples"
    );
    expect(report).toContain(
      "filesystem watch/resync evidence for missed events with eventual usage/external-session refresh and inotify limit diagnostics"
    );
    expect(report).toContain(
      "AppImage startup/sandbox/no-sandbox/user-namespace evidence"
    );
    expect(report).toContain(
      "AppImage updater check/download/install, latest-linux*.yml metadata, channel naming, release visibility, AppImage blockmap sidecar, top-level sha512, AppImage file-entry sha512, actual AppImage sha512, and size consistency"
    );
    expect(report).toContain(
      "AppImage provenance recorded Git dirty state, APPIMAGE env behavior, and selected AppImage artifact path"
    );
    expect(report).toContain(
      "AppImage extracted desktop entry app name/icon/categories/StartupWMClass=kmux, installed desktop-entry candidate evidence, and resources/notificationIcon.png notification icon resource output"
    );
    expect(report).toContain(
      "notification title/body/icon app attribution observed in the Ubuntu notification center and window grouping matched the app window, tied to recorded DBus/session and desktop-entry facts"
    );
    expect(report).toContain(
      "native window chrome evidence on Ubuntu Desktop with X11/Wayland notes tied to recorded desktop shell/display and GPU renderer probes, resize, and compositor observations"
    );
    expect(report).toContain(
      "shortcut policy evidence against terminal input and GNOME defaults with keyboard smoke notes tied to GNOME keybinding probes"
    );
    expect(report).toContain(
      "terminal font loaded and stable cell metrics evidence with fc-list font inventory and xterm observations"
    );
    expect(report).toContain(
      "IME/input-method smoke passed where ibus or fcitx validation was available with IME environment, input notes, and terminal input unaffected"
    );
    expect(report).toContain(
      "split panes, surface switching, restore, foreground resize, and readable agent output continuity evidence"
    );
    expect(report).toContain(
      "User and release docs covered Linux baseline, unsupported scope, AppImage updater behavior, and unavailable credential states"
    );
    expect(report).toContain(
      "validation matrix covered Ubuntu Desktop LTS GUI launcher, terminal launch, packaged AppImage, dev build, X11 session where available, and Wayland session where available"
    );
    expect(report).toContain("macOS compatibility evidence");
    expect(report).toContain("Notes: TODO replace after manual validation");
    expect(report).toContain("Remaining blockers: TODO replace");
    expect(report).toContain("Required Manual Observations To Add");
    expect(report).toContain(
      "GUI launch path, screenshot or run log, and whether a normal window opens"
    );
    expect(report).toContain(
      "Terminal launch command, shell/PATH notes, and CLI/desktop same POSIX socket evidence"
    );
    expect(report).toContain(
      "PATH recovery observations from GUI-launched app shell env for nvm, pyenv, cargo, ~/.local/bin, and installed agent CLIs"
    );
    expect(report).toContain(
      "node-pty spawned shells in dev and packaged AppImage builds through ShellLaunchPolicy with AppImage sandbox env and user-namespace settings recorded"
    );
    expect(report).toContain(
      "node-pty shell spawning evidence in dev and packaged AppImage builds through ShellLaunchPolicy, including AppImage sandbox env and user-namespace settings"
    );
    expect(report).toContain(
      "Hook runtime env in pty sessions, including KMUX_SOCKET_PATH, KMUX_AGENT_BIN_DIR, and KMUX_NODE_PATH"
    );
    expect(report).toContain(
      "Codex, Claude, Gemini, and Antigravity hook notification observations when hooks are installed and configured, including per-agent hook logs and UI notification evidence"
    );
    expect(report).toContain(
      "Codex wrapper evidence with shell rc integration disabled from walking-skeleton or targeted Codex wrapper run output"
    );
    expect(report).toContain(
      "External session discovery/resume for verified vendor roots, usage history, subscription usage with verified credential source, recorded storage-root evidence, and dashboard evidence, missing-credential unavailable/disconnected states with recorded missing credential paths, no macOS security command calls, platform-specific script probing args, script command availability, parsed ps process-table rows, and bounded lsof listening-socket samples"
    );
    expect(report).toContain(
      "AppImage startup/sandbox notes, user-namespace settings, and whether `--no-sandbox` was needed"
    );
    expect(report).toContain(
      "`npm run release:check:linux` output, including its nested `gate:walking-skeleton:linux`, `package:linux`, and `smoke:packaged:linux` stages"
    );
    expect(report).toContain(
      "AppImage updater check/download/install notes plus latest-linux*.yml metadata, channel naming, release visibility, AppImage blockmap sidecar, top-level sha512, AppImage file-entry sha512, actual AppImage sha512, and size consistency"
    );
    expect(report).toContain(
      "AppImage provenance evidence covering Git dirty state, APPIMAGE env behavior, and selected AppImage artifact path"
    );
    expect(report).toContain(
      "AppImage extracted desktop-entry app name, icon, categories, StartupWMClass=kmux, installed desktop-entry candidate evidence, resources/notificationIcon.png notification icon resource output from the packaged diagnostics, and runtime/packaged identity alignment with app id, app name, executable name, desktop entry Name, and StartupWMClass=kmux"
    );
    expect(report).toContain(
      "Notification title/body/icon/app attribution observed in the Ubuntu notification center and window grouping matched the app window, tied to recorded DBus/session and desktop-entry facts"
    );
    expect(report).toContain(
      "Native window chrome observations on Ubuntu Desktop with X11/Wayland notes tied to recorded desktop shell/display and GPU renderer probes, resize, compositor, and output-continuity behavior"
    );
    expect(report).toContain(
      "Shortcut policy observations against terminal input and GNOME defaults, including keyboard smoke notes tied to recorded GNOME keybinding probes"
    );
    expect(report).toContain(
      "Terminal font loaded and stable cell metrics evidence, including fc-list font inventory and xterm observations"
    );
    expect(report).toContain(
      "IME/input-method smoke notes for ibus or fcitx validation where available, including IME environment, input notes, and terminal input behavior"
    );
    expect(report).toContain("agent storage roots above");
    expect(report).toContain(
      "Filesystem watch/resync observations for missed events with eventual usage/external-session refresh and inotify limit diagnostics"
    );
    expect(report).toContain(
      "User and release docs evidence covering Linux baseline, unsupported scope, AppImage updater behavior, and unavailable credential states"
    );
    expect(report).toContain(
      "Validation matrix evidence covering Ubuntu Desktop LTS GUI launcher, terminal launch, packaged AppImage, dev build, X11 session where available, and Wayland session where available"
    );
    expect(report).toContain(
      "macOS compatibility evidence from `npm run release:check:mac` for the same release commit"
    );
  });
});

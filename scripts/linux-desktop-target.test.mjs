import { describe, expect, it } from "vitest";

import {
  UBUNTU_DESKTOP_RC_TARGET_HINT,
  assertUbuntuDesktopLtsTarget,
  hasDesktopDisplay,
  hasUbuntuDesktopSession,
  parseOsRelease
} from "./linux-desktop-target.mjs";

const ubuntuLts = [
  'PRETTY_NAME="Ubuntu 24.04.2 LTS"',
  'NAME="Ubuntu"',
  'VERSION="24.04.2 LTS (Noble Numbat)"',
  "ID=ubuntu",
  'VERSION_ID="24.04"'
].join("\n");

describe("Linux desktop target helper", () => {
  it("parses Ubuntu LTS os-release identity", () => {
    expect(parseOsRelease(ubuntuLts)).toEqual({
      id: "ubuntu",
      name: "Ubuntu",
      prettyName: "Ubuntu 24.04.2 LTS",
      version: "24.04.2 LTS (Noble Numbat)",
      versionId: "24.04",
      isUbuntu: true,
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
      isUbuntu: false,
      isUbuntuLts: false
    });
  });

  it("detects X11 and Wayland display env", () => {
    expect(hasDesktopDisplay({ DISPLAY: ":0" })).toBe(true);
    expect(hasDesktopDisplay({ WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
    expect(hasDesktopDisplay({})).toBe(false);
  });

  it("detects Ubuntu Desktop session env", () => {
    expect(hasUbuntuDesktopSession({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }))
      .toBe(true);
    expect(hasUbuntuDesktopSession({ XDG_SESSION_DESKTOP: "ubuntu" })).toBe(
      true
    );
    expect(hasUbuntuDesktopSession({ DESKTOP_SESSION: "gnome" })).toBe(true);
    expect(hasUbuntuDesktopSession({ GDMSESSION: "ubuntu-xorg" })).toBe(true);
    expect(hasUbuntuDesktopSession({ XDG_CURRENT_DESKTOP: "KDE" })).toBe(
      false
    );
    expect(hasUbuntuDesktopSession({ DISPLAY: ":0" })).toBe(false);
  });

  it("requires Linux, Ubuntu LTS, display, and Ubuntu Desktop session env unless explicitly bypassed", () => {
    expect(() =>
      assertUbuntuDesktopLtsTarget({
        platform: "linux",
        env: { DISPLAY: ":0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
        osReleaseText: ubuntuLts
      })
    ).not.toThrow();
    expect(() =>
      assertUbuntuDesktopLtsTarget({
        platform: "darwin",
        env: { DISPLAY: ":0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
        osReleaseText: ubuntuLts
      })
    ).toThrow(/must run on Linux/);
    expect(() =>
      assertUbuntuDesktopLtsTarget({
        platform: "linux",
        env: { DISPLAY: ":0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
        osReleaseText: "ID=fedora"
      })
    ).toThrow(/Ubuntu Desktop LTS/);
    expect(() =>
      assertUbuntuDesktopLtsTarget({
        platform: "linux",
        env: {},
        osReleaseText: ubuntuLts
      })
    ).toThrow(/DISPLAY or WAYLAND_DISPLAY/);
    expect(() =>
      assertUbuntuDesktopLtsTarget({
        platform: "linux",
        env: { DISPLAY: ":0" },
        osReleaseText: ubuntuLts
      })
    ).toThrow(/Ubuntu Desktop session/);
    expect(() =>
      assertUbuntuDesktopLtsTarget({
        platform: "darwin",
        env: {},
        osReleaseText: "",
        allowAnyPlatform: true
      })
    ).not.toThrow();
  });

  it("marks target preflight failures as non-RC host evidence with handoff guidance", () => {
    for (const target of [
      {
        platform: "darwin",
        env: { DISPLAY: ":0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
        osReleaseText: ubuntuLts
      },
      {
        platform: "linux",
        env: { DISPLAY: ":0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
        osReleaseText: "ID=fedora"
      },
      {
        platform: "linux",
        env: {},
        osReleaseText: ubuntuLts
      },
      {
        platform: "linux",
        env: { DISPLAY: ":0" },
        osReleaseText: ubuntuLts
      }
    ]) {
      expect(() => assertUbuntuDesktopLtsTarget(target)).toThrow(
        UBUNTU_DESKTOP_RC_TARGET_HINT
      );
    }
  });
});

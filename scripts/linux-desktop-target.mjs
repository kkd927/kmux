import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

export const DEFAULT_OS_RELEASE_PATH = "/etc/os-release";
export const UBUNTU_DESKTOP_RC_TARGET_HINT =
  "Linux desktop target unavailable on this host; run the command on Ubuntu Desktop LTS with a real desktop session.";

function withUbuntuDesktopRcTargetHint(message) {
  return message.includes(UBUNTU_DESKTOP_RC_TARGET_HINT)
    ? message
    : `${message}\n${UBUNTU_DESKTOP_RC_TARGET_HINT}`;
}

function unquoteOsReleaseValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\'", "'");
  }
  return trimmed;
}

export function readOsRelease(osReleasePath = DEFAULT_OS_RELEASE_PATH) {
  return existsSync(osReleasePath) ? readFileSync(osReleasePath, "utf8") : "";
}

export function parseOsRelease(source = "") {
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    values[line.slice(0, separatorIndex)] = unquoteOsReleaseValue(
      line.slice(separatorIndex + 1)
    );
  }

  const id = values.ID ?? "";
  const prettyName = values.PRETTY_NAME ?? "";
  const version = values.VERSION ?? "";
  return {
    id,
    name: values.NAME ?? "",
    prettyName,
    version,
    versionId: values.VERSION_ID ?? "",
    isUbuntu: id === "ubuntu",
    isUbuntuLts: id === "ubuntu" && /\bLTS\b/i.test(`${version} ${prettyName}`)
  };
}

export function hasDesktopDisplay(env = process.env) {
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export function hasUbuntuDesktopSession(env = process.env) {
  return [
    env.XDG_CURRENT_DESKTOP,
    env.XDG_SESSION_DESKTOP,
    env.DESKTOP_SESSION,
    env.GDMSESSION
  ]
    .filter((value) => typeof value === "string")
    .some((value) => /\b(?:ubuntu|gnome|unity)\b/i.test(value));
}

export function assertUbuntuDesktopLtsTarget({
  platform = process.platform,
  env = process.env,
  osReleaseText = readOsRelease(),
  allowAnyPlatform = false,
  platformMessage,
  distributionMessage,
  displayMessage,
  desktopSessionMessage
} = {}) {
  if (allowAnyPlatform) {
    return;
  }

  if (platform !== "linux") {
    throw new Error(
      withUbuntuDesktopRcTargetHint(
        platformMessage ??
          `Ubuntu Desktop validation must run on Linux; current platform is ${platform}.`
      )
    );
  }

  const distribution = parseOsRelease(osReleaseText);
  if (!distribution.isUbuntuLts) {
    throw new Error(
      withUbuntuDesktopRcTargetHint(
        distributionMessage ??
          [
            "Ubuntu Desktop validation must run on Ubuntu Desktop LTS.",
            `Detected distro: ${distribution.prettyName || distribution.id || "<unknown>"}.`
          ].join("\n")
      )
    );
  }

  if (!hasDesktopDisplay(env)) {
    throw new Error(
      withUbuntuDesktopRcTargetHint(
        displayMessage ??
          "Ubuntu Desktop validation must run inside a desktop session (DISPLAY or WAYLAND_DISPLAY)."
      )
    );
  }

  if (!hasUbuntuDesktopSession(env)) {
    throw new Error(
      withUbuntuDesktopRcTargetHint(
        desktopSessionMessage ??
          [
            "Ubuntu Desktop validation must run from an Ubuntu Desktop session.",
            "Expected XDG_CURRENT_DESKTOP, XDG_SESSION_DESKTOP, DESKTOP_SESSION, or GDMSESSION to identify Ubuntu, GNOME, or Unity."
          ].join("\n")
      )
    );
  }
}

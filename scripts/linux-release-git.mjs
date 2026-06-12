import { execFileSync } from "node:child_process";
import process from "node:process";

export const RELEASE_BUILD_OUTPUT_STATUS_EXCLUDES = [
  "release-assets",
  "apps/desktop/release"
];

export function linuxReleaseSourceStatusArgs() {
  return [
    "status",
    "--porcelain",
    "--",
    ".",
    ...RELEASE_BUILD_OUTPUT_STATUS_EXCLUDES.map(
      (exclude) => `:(exclude)${exclude}`
    )
  ];
}

export function currentGitDirtyState({ cwd = process.cwd() } = {}) {
  try {
    return execFileSync("git", linuxReleaseSourceStatusArgs(), {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim().length === 0
      ? "no"
      : "yes";
  } catch {
    return "unknown";
  }
}

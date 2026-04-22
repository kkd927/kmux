import type { UpdaterState } from "@kmux/proto";

export interface TitlebarUpdaterAction {
  action: "download" | "install";
  label: string;
  ariaLabel: string;
  title: string;
  disabled: boolean;
  prominent?: boolean;
  progress?: "indefinite" | "percent";
}

export function getUpdaterMenuLabel(state: UpdaterState): string {
  switch (state.status) {
    case "checking":
      return "Checking for Updates…";
    case "available":
      return formatUpdaterMenuLabel("Download Update", state.version);
    case "downloading":
      return formatUpdaterMenuLabel("Downloading Update", state.version);
    case "downloaded":
      return formatUpdaterMenuLabel(
        "Install Update",
        state.version,
        " and Relaunch"
      );
    case "disabled":
    case "error":
    case "idle":
    default:
      return "Check for Updates…";
  }
}

export function getTitlebarUpdaterAction(
  state: UpdaterState
): TitlebarUpdaterAction | null {
  switch (state.status) {
    case "available":
      return {
        action: "download",
        label: "Update",
        disabled: false,
        title: withVersion("Update to", state.version),
        ariaLabel: withVersion("Update to", state.version),
        prominent: true
      };
    case "downloading":
      return {
        action: "download",
        label: "Downloading...",
        disabled: true,
        title: withVersion("Downloading update", state.version, false),
        ariaLabel: withVersion("Downloading update", state.version, false),
        progress: "indefinite"
      };
    case "downloaded":
      return {
        action: "install",
        label: "Update",
        disabled: false,
        title: withVersion("Restart to install", state.version),
        ariaLabel: withVersion("Restart to install", state.version),
        prominent: true
      };
    case "disabled":
    case "idle":
    case "checking":
    case "error":
    default:
      return null;
  }
}

export function isUpdaterBusy(state: UpdaterState): boolean {
  return state.status === "checking" || state.status === "downloading";
}

function formatUpdaterMenuLabel(
  prefix: string,
  version?: string,
  suffix = ""
): string {
  if (version) {
    return `${prefix} ${version}${suffix}…`;
  }
  return `${prefix}${suffix}…`;
}

function withVersion(
  prefix: string,
  version?: string,
  includeWordVersion = true
): string {
  if (version) {
    return includeWordVersion
      ? `${prefix} version ${version}`
      : `${prefix} ${version}`;
  }
  return prefix;
}

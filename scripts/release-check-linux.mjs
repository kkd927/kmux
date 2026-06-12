import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  UBUNTU_DESKTOP_RC_TARGET_HINT,
  assertUbuntuDesktopLtsTarget,
  parseOsRelease,
  readOsRelease
} from "./linux-desktop-target.mjs";
import { currentGitDirtyState } from "./linux-release-git.mjs";
import {
  expectedLinuxUpdateMetadataNames,
  isKmuxLinuxAppImagePath,
  loadLinuxUpdateMetadata,
  validateLinuxUpdateMetadata
} from "./smoke-packaged-linux.mjs";

export { parseOsRelease };
export { currentGitDirtyState } from "./linux-release-git.mjs";

const DEFAULT_RELEASE_ASSETS_DIR = path.resolve("release-assets");
const DEFAULT_WORKFLOW_PATH = path.resolve(
  ".github/workflows/release-desktop.yml"
);
const DEFAULT_RC_VALIDATION_PATH = path.resolve(
  "docs/linux-release-validation.md"
);
const LINUX_RELEASE_PATTERNS = [
  /\.AppImage(?:\.blockmap)?$/i,
  /\.deb$/i,
  /\.rpm$/i,
  /\.snap$/i,
  /\.flatpak$/i,
  /(?:^|[/\\])latest\.ya?ml$/i,
  /^latest(?:-[\w-]+)?-linux(?:-[\w-]+)?\.ya?ml$/i,
  /linux/i
];
const LINUX_RELEASE_ARTIFACT_WORKFLOW_KEY_PATTERN =
  /\b(?:name|pattern):\s*["']?(?=[^"'\n]*linux)(?=[^"'\n]*release-assets)[^"'\n]*/i;
const BROAD_RELEASE_ARTIFACT_DOWNLOAD_PATTERN =
  /\bpattern:\s*["']?(?=[^"'\n]*\*)(?=[^"'\n]*release-assets)(?![^"'\n]*(?:macos|mac-))[^"'\n]*/i;
const LINUX_PACKAGE_ARTIFACT_WORKFLOW_PATH_PATTERN =
  /(?:release-assets|apps\/desktop\/release)\/(?:[^\s'"]+|\*)\.(?:deb|rpm|snap|flatpak)(?:[\s'")]|$)/i;
const LINUX_BINARY_ARTIFACT_WORKFLOW_PATH_PATTERN =
  /(?:^|[\s("'=])(?:[^\s'"]*\/)?[^\s'"]*\.(?:AppImage(?:\.blockmap)?|deb|rpm|snap|flatpak)(?:[\s'")]|$)/i;
const LINUX_ELECTRON_BUILDER_UNSAFE_PUBLISH_PATTERN =
  /\belectron-builder\b(?=[\s\S]{0,500}(?:^|\s)--linux\b)(?![\s\S]{0,500}(?:^|\s)--publish(?:=|\s+)["']?never\b)/i;
const LINUX_DIST_SCRIPT_PUBLIC_PUBLISH_PATTERN =
  /\bnpm\s+run\s+dist:linux\b(?=[\s\S]{0,500}(?:^|\s)--publish(?:=|\s+)["']?(?!never\b)[^\s'"\\]+)/i;
const LINUX_PUBLIC_RELEASE_GATE_PATTERN =
  /\bnode\s+scripts\/release-check-linux\.mjs\b/;
const GITHUB_RELEASE_PUBLISH_PATTERN = new RegExp(
  [
    String.raw`\bgh\s+release\s+(?:upload|create|edit)\b`,
    String.raw`^\s*uses:\s*(?:softprops\/action-gh-release|ncipollo\/release-action|actions\/upload-release-asset|actions\/create-release)(?:@|\s|$)`
  ].join("|"),
  "im"
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function currentGitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

function normalizedGitCommit(value = "") {
  const commit = value.trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(commit) ? commit : "";
}

function gitCommitMatches(recordedCommit, expectedCommit) {
  const recorded = normalizedGitCommit(recordedCommit);
  const expected = normalizedGitCommit(expectedCommit);
  if (!recorded || !expected) {
    return false;
  }
  return recorded.startsWith(expected) || expected.startsWith(recorded);
}

function npmRunCommandPattern(scriptName) {
  const boundaryBefore = "(?:^|[\\s;`'\",(])";
  const boundaryAfter = "(?:$|[\\s;`'\",)])";

  return new RegExp(
    `${boundaryBefore}npm\\s+run\\s+${escapeRegExp(scriptName)}${boundaryAfter}`,
    "i"
  );
}

const REQUIRED_RC_LEDGER_EVIDENCE = [
  {
    label: "Ubuntu Desktop environment",
    field: "Environment",
    pattern:
      /(?=[\s\S]*\bUbuntu\b)(?=[\s\S]*\bDesktop\b)(?=[\s\S]*\bLTS\b)(?=[\s\S]*(?:XDG_CURRENT_DESKTOP|XDG_SESSION_DESKTOP|DESKTOP_SESSION|GDMSESSION)\s*=\s*[^,\n;]*(?:\b(?:GNOME|Unity|ubuntu)\b))/i
  },
  {
    label: "AppImage artifact",
    field: "Artifact",
    pattern:
      /(?:^|[/\\])kmux-\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?-linux-[A-Za-z0-9_-]+\.AppImage(?:$|[\s`'"),;])/i
  },
  {
    label: "walking skeleton Linux gate command",
    field: "Commands",
    pattern: npmRunCommandPattern("gate:walking-skeleton:linux")
  },
  {
    label: "Linux package command",
    field: "Commands",
    pattern: npmRunCommandPattern("package:linux")
  },
  {
    label: "packaged Linux smoke command",
    field: "Commands",
    pattern: npmRunCommandPattern("smoke:packaged:linux")
  },
  {
    label: "Linux release check command",
    field: "Commands",
    pattern: npmRunCommandPattern("release:check:linux")
  },
  {
    label: "Linux evidence command",
    field: "Commands",
    pattern: npmRunCommandPattern("release:evidence:linux")
  },
  {
    label: "launch/socket shell env evidence",
    field: "Notes",
    pattern:
      /(?=[\s\S]*\bGUI launch\b[^\n.;]*\bnormal window\b[^\n.;]*\blaunch path\b[^\n.;]*(?:\bscreenshot\b|\brun log\b))(?=[\s\S]*\bterminal launch\b[^\n.;]*\bshell env\b)(?=[\s\S]*\bCLI\b[^\n.;]*\bdesktop\b[^\n.;]*\bsame POSIX socket\b)/i
  },
  {
    label: "PATH recovery evidence",
    field: "Notes",
    pattern:
      /\bPATH recovery\b[^\n.;]*\bGUI[-\s]+launched app\b[^\n.;]*\bshell env\b[^\n.;]*\bnvm\b[^\n.;]*\bpyenv\b[^\n.;]*\bcargo\b[^\n.;]*~\/\.local\/bin\b[^\n.;]*\binstalled agent CLIs\b/i
  },
  {
    label: "node-pty spawn evidence",
    field: "Notes",
    pattern:
      /\bnode-pty\b[^\n.;]*\bspawn(?:ed|s)?\b[^\n.;]*\bshells?\b[^\n.;]*\bdev\b[^\n.;]*\bpackaged AppImage\b[^\n.;]*\bShellLaunchPolicy\b[^\n.;]*\bsandbox env\b[^\n.;]*\buser[-\s]+namespaces?\b/i
  },
  {
    label: "hook runtime env evidence",
    field: "Notes",
    pattern:
      /(?=[\s\S]*\bhook(?:\s+runtime)?\s+env\b)(?=[\s\S]*\bpty sessions?\b)(?=[\s\S]*\bKMUX_SOCKET_PATH\b)(?=[\s\S]*\bKMUX_AGENT_BIN_DIR\b)(?=[\s\S]*\bKMUX_NODE_PATH\b)/i
  },
  {
    label: "agent hook notification evidence",
    field: "Notes",
    pattern:
      /(?=[\s\S]*\bCodex\b[^\n.;]*\bClaude\b[^\n.;]*\bGemini\b[^\n.;]*\bAntigravity\b[^\n.;]*\bhooks?\s+(?:notify|notified)\b)(?=[\s\S]*\binstalled\b[^\n.;]*\bconfigured\b)(?=[\s\S]*\bper-agent hook logs\b)(?=[\s\S]*\bUI notification evidence\b)/i
  },
  {
    label: "Codex wrapper evidence",
    field: "Notes",
    pattern:
      /(?=[\s\S]*\bCodex wrapper\b[^\n.;]*\bwork(?:ed|s)?\b)(?=[\s\S]*\bshell rc integration\b[^\n.;]*\bdisabled\b)(?=[\s\S]*(?:\bwalking-skeleton\b|\btargeted Codex wrapper run\b|\btargeted\b[^\n.;]*\bCodex wrapper\b[^\n.;]*\brun\b))/i
  },
  {
    label: "agent workflow evidence",
    field: "Notes",
    pattern:
      /(?=[\s\S]*\bexternal session\b[^\n.;]*\bdiscovery\b[^\n.;]*\bresume\b[^\n.;]*\bverified vendor roots\b)(?=[\s\S]*\bagent storage roots\b)(?=[\s\S]*\busage history\b)(?=[\s\S]*\bsubscription usage\b)(?=[\s\S]*\bverified credential source\b)(?=[\s\S]*\brecorded storage[-\s]+root evidence\b)(?=[\s\S]*\bdashboard evidence\b)(?=[\s\S]*\bmissing credentials\b[^\n.;]*(?:\bunavailable\b|\bdisconnected\b))(?=[\s\S]*\bmissing credential paths\b)(?=[\s\S]*(?:\bno\s+macOS\s+security\s+command\b|\bwithout\s+spawning\s+macOS\s+security\b))(?=[\s\S]*\bscript\b[^\n.;]*\bprobing\b[^\n.;]*\bargs?\b)(?=[\s\S]*\bscript command availability\b)(?=[\s\S]*\bps\b[^\n.;]*(?:\bprocess-table\b|\bparsed\b|\brows?\b))(?=[\s\S]*\blsof\b[^\n.;]*\blistening[-\s]+socket\b[^\n.;]*\bsamples?\b)/i
  },
  {
    label: "filesystem watch/resync evidence",
    field: "Notes",
    pattern:
      /(?=[\s\S]*\bfilesystem watch(?:es)?\b[^\n.;]*\bmiss(?:ed)? events\b[^\n.;]*\beventual\b[^\n.;]*\brefresh\b)(?=[\s\S]*\busage\b[^\n.;]*\bexternal[-\s]+session\b[^\n.;]*\brefresh\b)(?=[\s\S]*\binotify\b[^\n.;]*\blimit(?:s)?\b)/i
  },
  {
    label: "AppImage updater evidence",
    field: "Notes",
    pattern:
      /(?=[\s\S]*(?:updater|electron-updater))(?=[\s\S]*\bcheck(?:ed|s|ing)?\b)(?=[\s\S]*\bdownload(?:ed|s|ing)?\b)(?=[\s\S]*\binstall(?:ed|s|ing)?\b)(?=[\s\S]*\blatest-linux(?:-[\w-]+)?\.ya?ml\b)(?=[\s\S]*\bmetadata\b)(?=[\s\S]*\bchannel(?:\s+naming)?\b)(?=[\s\S]*\brelease\s+visibility\b)(?=[\s\S]*\bAppImage\s+blockmap\b)(?=[\s\S]*\btop[-\s]+level\s+sha512\b)(?=[\s\S]*\bfile[-\s]+entry\s+sha512\b)(?=[\s\S]*\bactual\s+AppImage\s+sha512\b)(?=[\s\S]*(?:\bsize\s+consistency\b|\bsize\s+match(?:es|ed)?\b|\bsize\b[^\n.;]*\bmatch(?:es|ed)?\b))/i
  },
  {
    label: "AppImage provenance/env evidence",
    field: "Notes",
    pattern:
      /\bAppImage provenance\b[^\n.;]*\bGit dirty state\b[^\n.;]*\bAPPIMAGE env behavior\b[^\n.;]*\bselected AppImage artifact path\b/i
  },
  {
    label: "AppImage startup/sandbox evidence",
    field: "Notes",
    pattern:
      /(?=[\s\S]*\bAppImage startup\b[^\n.;]*\bsandbox\b[^\n.;]*\buser[-\s]+namespaces?\b)(?=[\s\S]*--no-sandbox\b)/i
  },
  {
    label: "AppImage desktop entry evidence",
    field: "Notes",
    pattern:
      /(?=[\s\S]*\bAppImage\b[^\n.;]*\bextracted\b[^\n.;]*\bdesktop entry\b[^\n.;]*\bapp name\b[^\n.;]*\bicon\b[^\n.;]*\bcategories\b[^\n.;]*\bStartupWMClass\s*=?\s*kmux\b)(?=[\s\S]*\binstalled desktop[-\s]+entry candidate evidence\b)(?=[\s\S]*\bresources\/notificationIcon\.png\b)(?=[\s\S]*\bnotification icon resource\b)(?=[\s\S]*\bruntime\b[^\n.;]*\bpackaged identity alignment\b[^\n.;]*\bapp id\b[^\n.;]*\bapp name\b[^\n.;]*\bexecutable name\b[^\n.;]*\bdesktop entry Name\b[^\n.;]*\bStartupWMClass\s*=?\s*kmux\b)/i
  },
  {
    label: "notification/window grouping evidence",
    field: "Notes",
    pattern:
      /(?=[\s\S]*(?:\bUbuntu notification center\b[^\n.;]*(?:\bobserved\b|\bconfirmed\b|\bmatched\b|\bdisplayed\b|\bshowed\b|\bpassed\b|\bgrouped with the app window\b)|(?:\bobserved\b|\bconfirmed\b|\bmatched\b|\bdisplayed\b|\bshowed\b|\bpassed\b|\bgrouped with the app window\b)[^\n.;]*\bUbuntu notification center\b))(?=[\s\S]*\bnotification\b)(?=[\s\S]*\btitle\b)(?=[\s\S]*\bbody\b)(?=[\s\S]*\bicon\b)(?=[\s\S]*\bapp attribution\b)(?=[\s\S]*\bUbuntu notification center\b)(?=[\s\S]*(?:\bwindow grouping\b|\bgroup with the app window\b|\bgrouped with the app window\b|\bgrouping\b))(?=[\s\S]*(?:\bDBus\/session\b|\bDBus\b[^\n.;]*\bsession\b))(?=[\s\S]*\bdesktop[-\s]+entry facts?\b)/i
  },
  {
    label: "native window chrome evidence",
    field: "Notes",
    pattern:
      /\bnative window chrome\b[^\n.;]*\bUbuntu Desktop\b[^\n.;]*(?:\bX11\/Wayland notes\b|\bX11\b[^\n.;]*\bWayland\b|\bWayland\b[^\n.;]*\bX11\b)[^\n.;]*\bdesktop shell\/display\b[^\n.;]*\bGPU renderer probes\b[^\n.;]*\bresize\b[^\n.;]*\bcompositor\b/i
  },
  {
    label: "shortcut policy evidence",
    field: "Notes",
    pattern:
      /\bshortcut policy\b[^\n.;]*\bterminal input\b[^\n.;]*\bGNOME defaults\b[^\n.;]*(?:\bkeyboard smoke notes\b|\bkeyboard smoke\b)[^\n.;]*\bGNOME keybinding probes\b/i
  },
  {
    label: "terminal font/cell metrics evidence",
    field: "Notes",
    pattern:
      /(?=[\s\S]*\bterminal font\b[^\n.;]*\bload(?:ed|s)?\b)(?=[\s\S]*\bcell metrics\b[^\n.;]*\bstable\b)(?=[\s\S]*\bfc-list\b)(?=[\s\S]*\bfont inventory\b)(?=[\s\S]*\bxterm\b[^\n.;]*\bobservations?\b)/i
  },
  {
    label: "IME/input-method evidence",
    field: "Notes",
    pattern:
      /\bIME\/input-method smoke\b[^\n.;]*\bpass(?:ed|es)?\b[^\n.;]*(?:\bibus\b[^\n.;]*\bfcitx\b|\bfcitx\b[^\n.;]*\bibus\b)[^\n.;]*\bIME environment\b[^\n.;]*\binput notes\b[^\n.;]*\bterminal input\b/i
  },
  {
    label: "output continuity evidence",
    field: "Notes",
    pattern:
      /(?=[\s\S]*\breadable\s+agent\s+output continuity\b)(?=[\s\S]*\bsplit(?: pane| panes)?\b)(?=[\s\S]*\bsurface switch(?:ing)?\b)(?=[\s\S]*\brestore\b)(?=[\s\S]*\bforeground resize\b)/i
  },
  {
    label: "Linux docs evidence",
    field: "Notes",
    pattern:
      /\buser and release docs\b[^\n.;]*\bLinux baseline\b[^\n.;]*\bunsupported scope\b[^\n.;]*\bAppImage updater behavior\b[^\n.;]*\bunavailable credential states\b/i
  },
  {
    label: "validation matrix evidence",
    field: "Notes",
    pattern:
      /\bvalidation matrix\b[^\n.;]*\bUbuntu Desktop LTS\b[^\n.;]*\bGUI launcher\b[^\n.;]*\bterminal launch\b[^\n.;]*\bpackaged AppImage\b[^\n.;]*\bdev build\b[^\n.;]*\bX11\b[^\n.;]*\bWayland\b/i
  },
  {
    label: "macOS compatibility evidence",
    field: "Notes",
    pattern: /macOS compatibility/i
  },
  {
    label: "macOS release check command",
    field: "Commands",
    pattern: npmRunCommandPattern("release:check:mac")
  }
];
const MACOS_COMPATIBILITY_EVIDENCE_LABELS = new Set([
  "macOS compatibility evidence",
  "macOS release check command"
]);
const REQUIRED_MACOS_COMPATIBILITY_RC_LEDGER_EVIDENCE =
  REQUIRED_RC_LEDGER_EVIDENCE.filter((requirement) =>
    MACOS_COMPATIBILITY_EVIDENCE_LABELS.has(requirement.label)
  );
const REQUIRED_PRIMARY_LINUX_RC_LEDGER_EVIDENCE =
  REQUIRED_RC_LEDGER_EVIDENCE.filter(
    (requirement) => !MACOS_COMPATIBILITY_EVIDENCE_LABELS.has(requirement.label)
  );
const RC_LEDGER_PLACEHOLDER_PATTERNS = [
  /<[^>\n]+>/,
  /\bTODO\b/i,
  /\bTBD\b/i,
  /\bplaceholder\b/i,
  /\bfill(?:ed)?\s+(?:in|after|with)\b/i,
  /\breplace\s+(?:me|with)\b/i
];
const RC_LEDGER_EVIDENCE_CAVEAT_PATTERNS = [
  /\bblocked\b/i,
  /\bfailed\b/i,
  /\bnot\s+(?:complete|passed|run|verified)\b/i,
  /\bnot\s+(?:checked|confirmed|observed|proven|validated)\b/i,
  /\bun(?:checked|confirmed|observed|proven|validated)\b/i,
  /\bnot\s+(?:Ubuntu|Desktop|LTS)\b/i,
  /\bnon[-\s]+(?:Ubuntu|Desktop|LTS)\b/i,
  /\bnot yet run\b/i,
  /\bpending\b/i,
  /\bskipped\b/i,
  /\bunknown\b/i,
  /\bunverified\b/i,
  /\bwaived\b/i,
  /\bmis[-\s]?match(?:ed|es|ing)?\b/i,
  /\bnot\s+match(?:ed|es|ing)?\b/i,
  /\bdiffer(?:ed|s|ing)?\b/i,
  /\binconsisten(?:t|cy|cies)\b/i,
  /\bnot\s+consistent\b/i,
  /\bnot[-\s]+equal\b/i,
  /\bunequal\b/i,
  /\b(?:does|do|did)\s+not\s+(?:match|equal)\b/i,
  /\bAppImage\s+blockmap\b[^\n.;]*(?:\bmissing\b|\babsent\b|\bnot\s+found\b|\bzero[-\s]+byte\b|\b0\s+bytes\b|\bdirectory[-\s]+shaped\b)/i,
  /(?:\bmissing\b|\babsent\b|\bnot\s+found\b|\bzero[-\s]+byte\b|\b0\s+bytes\b|\bdirectory[-\s]+shaped\b)[^\n.;]*\bAppImage\s+blockmap\b/i,
  /\bnon[-\s]?RC\b/i,
  /\b(?:passing\s+)?RC evidence:\s*no\b/i,
  /\bno automatic pass\b/i,
  /\bdiagnostics?[-\s]+only\b/i,
  /\bscript[-\s]+development(?:[-\s]+only)?\b/i,
  /\breport mode:\b/i,
  /\breport[-\s]+shape\b/i,
  /\bledger input\b/i,
  /\bportable preflight\b/i,
  /\bwalking[-\s]+skeleton component only\b/i,
  /\b(?:simulated|simulation|mocked?|stubbed?)\b/i,
  /\bdry[-\s]?run\b/i,
  /\bxvfb\b/i,
  /\bheadless\b/i,
  /\bfixture[-\s]+(?:only|data|evidence)\b/i,
  /--allow-any-platform\b/i,
  /--allow-any-linux-desktop\b/i,
  /--skip-(?:build|e2e)\b/i,
  /\b(?:needs?|requires?)\b[^\n.;]*\bmanual\b[^\n.;]*(?:validation|observations?)\b/i,
  /\bmanual\b[^\n.;]*(?:validation|observations?)\b[^\n.;]*(?:needed|required|not\s+(?:complete|done|passed|run|verified|checked|confirmed|observed|proven|validated))\b/i,
  /\bremaining blockers?:(?!\s*none\.?\s*$).+/i
];
const REQUIRED_RC_LEDGER_ENTRY_FIELDS = [
  {
    field: "Date",
    pattern: /^\d{4}-\d{2}-\d{2}$/,
    expectation: "YYYY-MM-DD"
  },
  {
    field: "Commit",
    pattern: /^[0-9a-f]{7,40}$/i,
    expectation: "short or full git SHA"
  },
  {
    field: "Git dirty",
    pattern: /^no$/i,
    expectation: "no"
  },
  {
    field: "Remaining blockers",
    pattern: /^none\.?$/i,
    expectation: "none"
  }
];
const RC_LEDGER_COMPLETE_STATUS_PATTERN = /^(?:complete|passed)\b/i;
const RC_LEDGER_INCOMPLETE_STATUS_PATTERN =
  /(?:\b(?:blocked|but|except|failed|incomplete|missing|needs?|not complete|not passed|not yet run|partial(?:ly)?|pending|skipped|tbd|todo|unknown|unverified|waived)\b|\bfollow[- ]?up\b|\bnot\s+(?:checked|confirmed|observed|proven|validated)\b|\bun(?:checked|confirmed|observed|proven|validated)\b|\bmis[-\s]?match(?:ed|es|ing)?\b|\bnot\s+match(?:ed|es|ing)?\b|\bdiffer(?:ed|s|ing)?\b|\binconsisten(?:t|cy|cies)\b|\bnot\s+consistent\b|\bnot[-\s]+equal\b|\bunequal\b|\b(?:does|do|did)\s+not\s+(?:match|equal)\b|\bnon[-\s]?RC\b|\bdiagnostics?[-\s]+only\b|\bscript[-\s]+development(?:[-\s]+only)?\b|\breport[-\s]+shape\b|\b(?:simulated|simulation|mocked?|stubbed?)\b|\bdry[-\s]?run\b|\bxvfb\b|\bheadless\b|\bfixture[-\s]+(?:only|data|evidence)\b)/i;
const RC_LEDGER_REQUIRED_STATUS_SECTIONS = [
  "Required Evidence",
  "Environment Matrix"
];
const REQUIRED_RC_LEDGER_STATUS_ROWS = {
  "Required Evidence": [
    "GUI-launched app opens a window on Ubuntu Desktop LTS",
    "Terminal-launched app and GUI-launched app resolve socket and shell env correctly",
    "CLI and desktop use the same POSIX socket resolver",
    "GUI-launched app shell env recovers PATH tools and installed agent CLIs",
    "`node-pty` spawns shells in dev and packaged AppImage builds",
    "`KMUX_SOCKET_PATH`, `KMUX_AGENT_BIN_DIR`, and `KMUX_NODE_PATH` are visible in pty sessions",
    "Codex, Claude, Gemini, and Antigravity hooks notify when installed and configured",
    "Codex wrapper works with shell rc integration disabled",
    "External session discovery and resume work for verified vendor roots",
    "Usage history works",
    "Subscription usage works for authenticated providers whose Linux credential source was verified",
    "Missing credentials show normal disconnected/unavailable states",
    "Usage/subscription subprocesses do not invoke macOS-only commands on Linux",
    "AppImage updater works with Linux update metadata",
    "Generated AppImage desktop entry contains app name, icon, categories, `StartupWMClass=kmux`, notification icon resource, and runtime/packaged identity alignment",
    "Desktop notifications show correct app name/icon and group with the app window",
    "Native window chrome works on Ubuntu Desktop",
    "Shortcut policy works against terminal input and GNOME defaults",
    "Terminal font loads and cell metrics remain stable",
    "Restore, split panes, surface switching, foreground resize, and readable agent output continuity remain stable",
    "Linux IME/input-method smoke passes where ibus or fcitx validation is available",
    "Filesystem watches can miss events without breaking eventual usage/external-session refresh",
    "User and release docs describe Linux baseline, unsupported scope, AppImage updater behavior, and unavailable credential states",
    "macOS compatibility tests and packaged smoke remain valid"
  ],
  "Environment Matrix": [
    "Ubuntu Desktop LTS, GUI launcher",
    "Ubuntu Desktop LTS, terminal launch",
    "Ubuntu Desktop LTS, packaged AppImage",
    "Ubuntu Desktop LTS, dev build",
    "X11 session where available",
    "Wayland session where available"
  ]
};
const parsedEvidenceEntryFieldsCache = new Map();
const evidenceRequirementResultCache = new Map();
const KNOWN_ARGS = new Set(["--require-ubuntu-desktop"]);

export function parseArgs(argv) {
  const unknownArgs = argv.filter((arg) => !KNOWN_ARGS.has(arg));
  if (unknownArgs.length > 0) {
    throw new Error(
      `unknown release:check:linux argument(s): ${unknownArgs.join(", ")}`
    );
  }

  return {
    requireUbuntuDesktop: argv.includes("--require-ubuntu-desktop")
  };
}

export function assertLinuxReleaseCheckTarget({
  platform = process.platform,
  env = process.env,
  osReleaseText = readOsRelease(),
  requireUbuntuDesktop = false
} = {}) {
  if (platform !== "linux") {
    throw new Error(
      [
        `release:check:linux must run on Linux so AppImage packaging is meaningful; current platform is ${platform}.`,
        UBUNTU_DESKTOP_RC_TARGET_HINT
      ].join("\n")
    );
  }

  if (!requireUbuntuDesktop) {
    return;
  }

  const distribution = parseOsRelease(osReleaseText);
  assertUbuntuDesktopLtsTarget({
    platform,
    env,
    osReleaseText,
    distributionMessage: [
      "release:check:linux must run on Ubuntu Desktop LTS for RC validation.",
      `Detected distro: ${distribution.prettyName || distribution.id || "<unknown>"}.`
    ].join("\n"),
    displayMessage:
      "release:check:linux must run inside an Ubuntu Desktop session (DISPLAY or WAYLAND_DISPLAY)."
  });
}

export function isLinuxPublicReleaseEnabled(env = process.env) {
  return env.KMUX_ENABLE_LINUX_PUBLIC_RELEASE === "1";
}

export function isLinuxReleaseAssetName(fileName) {
  return LINUX_RELEASE_PATTERNS.some((pattern) => pattern.test(fileName));
}

export function listLinuxReleaseAssets(assetsDir = DEFAULT_RELEASE_ASSETS_DIR) {
  if (!existsSync(assetsDir)) {
    return [];
  }
  return listReleaseAssetFiles(assetsDir)
    .filter((assetPath) => isLinuxReleaseAssetName(assetPath))
    .sort();
}

function listReleaseAssetFiles(root, currentDir = root) {
  return readdirSync(currentDir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      return listReleaseAssetFiles(root, entryPath);
    }
    if (!entry.isFile()) {
      return [];
    }
    return [path.relative(root, entryPath)];
  });
}

function isLinuxAppImageReleaseAssetName(fileName) {
  return /\.AppImage$/i.test(fileName);
}

function isLinuxUpdateMetadataReleaseAssetName(fileName) {
  return /^latest(?:-[\w-]+)?-linux(?:-[\w-]+)?\.ya?ml$/i.test(
    path.basename(fileName)
  );
}

function appImageBlockmapSidecar(appImageAsset) {
  return `${appImageAsset}.blockmap`;
}

function appImageVersionFromAssetName(appImageAsset) {
  const match =
    /^kmux-((?:\d+\.\d+\.\d+)(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?)-linux-/i.exec(
      path.basename(appImageAsset)
    );
  return match?.[1];
}

function appImageNamingFailures(appImageAssets) {
  return appImageAssets
    .filter((appImageAsset) => !isKmuxLinuxAppImagePath(appImageAsset))
    .map((appImageAsset) => `- ${appImageAsset}`);
}

function appImageBlockmapSidecarFailures({
  appImageAssets,
  linuxAssets,
  assetsDir
}) {
  const linuxAssetSet = new Set(linuxAssets);
  return appImageAssets.flatMap((appImageAsset) => {
    const blockmapAsset = appImageBlockmapSidecar(appImageAsset);
    if (!linuxAssetSet.has(blockmapAsset)) {
      return [`- ${blockmapAsset}: missing`];
    }
    const blockmapPath = path.join(assetsDir, blockmapAsset);
    const stats = statSync(blockmapPath);
    if (stats.size <= 0) {
      return [`- ${blockmapAsset}: empty (${stats.size} bytes)`];
    }
    return [];
  });
}

function expectedLinuxUpdateMetadataAssets(appImageAsset) {
  const appImageDir = path.dirname(appImageAsset);
  return expectedLinuxUpdateMetadataNames(appImageAsset).map((metadataName) =>
    path.join(appImageDir, metadataName)
  );
}

function matchingUpdateMetadataAssets(appImageAsset, metadataAssets) {
  const expectedAssets = expectedLinuxUpdateMetadataAssets(appImageAsset);
  return metadataAssets.filter((metadataAsset) =>
    expectedAssets.includes(metadataAsset)
  );
}

function isExpectedLinuxUpdateMetadataAsset(asset, appImageAssets) {
  if (!isLinuxUpdateMetadataReleaseAssetName(asset)) {
    return false;
  }
  return appImageAssets.some((appImageAsset) =>
    expectedLinuxUpdateMetadataAssets(appImageAsset).includes(asset)
  );
}

function unexpectedLinuxPublicAssetFailures({ linuxAssets, appImageAssets }) {
  const expectedAppImageAssets = new Set(appImageAssets);
  const expectedBlockmapAssets = new Set(
    appImageAssets.map((appImageAsset) => appImageBlockmapSidecar(appImageAsset))
  );
  return linuxAssets
    .filter(
      (asset) =>
        !expectedAppImageAssets.has(asset) &&
        !expectedBlockmapAssets.has(asset) &&
        !isExpectedLinuxUpdateMetadataAsset(asset, appImageAssets)
    )
    .map((asset) => `- ${asset}`);
}

function linuxUpdateMetadataValidationFailures({
  appImageAssets,
  metadataAssets,
  assetsDir
}) {
  return appImageAssets.flatMap((appImageAsset) => {
    const expectedAssets = expectedLinuxUpdateMetadataAssets(appImageAsset);
    const metadataAssetsForAppImage = matchingUpdateMetadataAssets(
      appImageAsset,
      metadataAssets
    );
    if (metadataAssetsForAppImage.length === 0) {
      return [
        `- ${appImageAsset}: missing expected ${expectedAssets.join(" or ")}`
      ];
    }

    const appImagePath = path.join(assetsDir, appImageAsset);
    return metadataAssetsForAppImage.flatMap((matchingMetadataAsset) => {
      const metadataPath = path.join(assetsDir, matchingMetadataAsset);
      try {
        validateLinuxUpdateMetadata(loadLinuxUpdateMetadata(metadataPath), {
          appImagePath,
          expectedVersion: appImageVersionFromAssetName(appImageAsset),
          metadataPath
        });
        return [];
      } catch (error) {
        return [
          `- ${appImageAsset} with ${matchingMetadataAsset}: ${
            error instanceof Error ? error.message : String(error)
          }`
        ];
      }
    });
  });
}

function workflowUploadsLinuxAppImageArtifacts(
  workflowText = readFileSync(DEFAULT_WORKFLOW_PATH, "utf8")
) {
  return (
    /linux-\$\{\{\s*matrix\.arch\s*\}\}-release-assets/.test(workflowText) ||
    LINUX_RELEASE_ARTIFACT_WORKFLOW_KEY_PATTERN.test(workflowText) ||
    BROAD_RELEASE_ARTIFACT_DOWNLOAD_PATTERN.test(workflowText) ||
    /(?:release-assets|apps\/desktop\/release)\/(?:[^\s'"]+|\*)\.AppImage(?:[\s'")]|$)/i.test(
      workflowText
    ) ||
    /(?:^|[\s("'=])(?:[^\s'"]*\/)?[^\s'"]*\.AppImage(?:[\s'")]|$)/i.test(
      workflowText
    ) ||
    /release-assets\/\*(?:[\s'")]|$)/.test(workflowText) ||
    /release-assets\/\*\*\/\*/.test(workflowText) ||
    /apps\/desktop\/release\/\*(?:[\s'")]|$)/.test(workflowText) ||
    /apps\/desktop\/release\/\*\*(?:[\s'")]|\/\*|$)/.test(workflowText)
  );
}

export function workflowAllowsLinuxPublicUploads(
  workflowText = readFileSync(DEFAULT_WORKFLOW_PATH, "utf8")
) {
  return (
    /linux-\$\{\{\s*matrix\.arch\s*\}\}-release-assets/.test(workflowText) ||
    LINUX_RELEASE_ARTIFACT_WORKFLOW_KEY_PATTERN.test(workflowText) ||
    BROAD_RELEASE_ARTIFACT_DOWNLOAD_PATTERN.test(workflowText) ||
    LINUX_PACKAGE_ARTIFACT_WORKFLOW_PATH_PATTERN.test(workflowText) ||
    LINUX_BINARY_ARTIFACT_WORKFLOW_PATH_PATTERN.test(workflowText) ||
    LINUX_ELECTRON_BUILDER_UNSAFE_PUBLISH_PATTERN.test(workflowText) ||
    LINUX_DIST_SCRIPT_PUBLIC_PUBLISH_PATTERN.test(workflowText) ||
    /release-assets\/\*\.AppImage/.test(workflowText) ||
    /release-assets\/\*\.blockmap(?:[\s'")]|$)/i.test(workflowText) ||
    /release-assets\/[^\s'"]+\.AppImage\.blockmap(?:[\s'")]|$)/i.test(
      workflowText
    ) ||
    /release-assets\/[^\s'"]+\.AppImage(?:[\s'")]|$)/i.test(workflowText) ||
    /release-assets\/\*(?:[\s'")]|$)/.test(workflowText) ||
    /release-assets\/\*\*\/\*/.test(workflowText) ||
    /release-assets\/\*\.ya?ml/.test(workflowText) ||
    /release-assets\/latest\.ya?ml(?:[\s'")]|$)/.test(workflowText) ||
    /release-assets\/[^\s'"]+\/latest\.ya?ml(?:[\s'")]|$)/.test(
      workflowText
    ) ||
    /release-assets\/latest\*\.ya?ml/.test(workflowText) ||
    /release-assets\/latest-\*\.ya?ml/.test(workflowText) ||
    /release-assets\/latest\*-linux\.ya?ml/.test(workflowText) ||
    /release-assets\/[^\s'"]*linux[^\s'"]*/i.test(workflowText) ||
    /apps\/desktop\/release\/\*\.AppImage/.test(workflowText) ||
    /apps\/desktop\/release\/\*\.blockmap(?:[\s'")]|$)/i.test(workflowText) ||
    /apps\/desktop\/release\/[^\s'"]+\.AppImage\.blockmap(?:[\s'")]|$)/i.test(
      workflowText
    ) ||
    /apps\/desktop\/release\/[^\s'"]+\.AppImage(?:[\s'")]|$)/i.test(
      workflowText
    ) ||
    /apps\/desktop\/release\/\*(?:[\s'")]|$)/.test(workflowText) ||
    /apps\/desktop\/release\/\*\*(?:[\s'")]|\/\*|$)/.test(workflowText) ||
    /apps\/desktop\/release\/\*\.ya?ml/.test(workflowText) ||
    /apps\/desktop\/release\/latest\.ya?ml(?:[\s'")]|$)/.test(workflowText) ||
    /apps\/desktop\/release\/[^\s'"]+\/latest\.ya?ml(?:[\s'")]|$)/.test(
      workflowText
    ) ||
    /apps\/desktop\/release\/latest\*\.ya?ml/.test(workflowText) ||
    /apps\/desktop\/release\/latest-\*\.ya?ml/.test(workflowText) ||
    /apps\/desktop\/release\/latest\*-linux\.ya?ml/.test(workflowText) ||
    /apps\/desktop\/release\/[^\s'"]*linux[^\s'"]*/i.test(workflowText)
  );
}

export function workflowRunsLinuxPublicGateBeforeReleasePublish(
  workflowText = readFileSync(DEFAULT_WORKFLOW_PATH, "utf8")
) {
  const publishCommandIndex = workflowText.search(GITHUB_RELEASE_PUBLISH_PATTERN);
  if (publishCommandIndex === -1) {
    return true;
  }

  const gateCommandIndex = workflowText.search(LINUX_PUBLIC_RELEASE_GATE_PATTERN);
  return gateCommandIndex >= 0 && gateCommandIndex < publishCommandIndex;
}

export function isLinuxReleaseCandidatePassed(
  validationText = readFileSync(DEFAULT_RC_VALIDATION_PATH, "utf8")
) {
  return (
    linuxReleaseCurrentStatusPassed(validationText) &&
    linuxReleaseRequiredEvidenceSectionsPresent(validationText) &&
    !linuxReleaseRequiredEvidenceHasNotYetRun(validationText) &&
    linuxReleaseIncompleteRequiredEvidenceRows(validationText).length === 0 &&
    linuxReleaseMissingRequiredEvidenceRows(validationText).length === 0 &&
    linuxReleasePrimaryRcEvidenceEntry(validationText).length > 0 &&
    linuxReleaseMacCompatibilityEvidenceEntry(validationText).length > 0 &&
    linuxReleasePrimaryRcEvidenceCaveats(validationText).length === 0 &&
    linuxReleaseMacCompatibilityEvidenceCaveats(validationText).length === 0 &&
    linuxReleaseRcEvidenceFieldFailures(validationText).length === 0 &&
    missingLinuxReleaseCandidateEvidence(validationText).length === 0 &&
    linuxReleaseCandidatePlaceholderEvidence(validationText).length === 0
  );
}

function escapeMarkdownHeadingPattern(heading) {
  return heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractLinuxReleaseMarkdownSection(
  validationText = "",
  heading
) {
  const sectionMatch = new RegExp(
    `^## ${escapeMarkdownHeadingPattern(heading)}[^\\S\\r\\n]*$`,
    "im"
  ).exec(validationText);
  if (!sectionMatch) {
    return "";
  }

  const sectionStart = sectionMatch.index + sectionMatch[0].length;
  const sectionText = validationText.slice(sectionStart);
  const nextSectionMatch = /^##\s+/m.exec(sectionText);
  return nextSectionMatch
    ? sectionText.slice(0, nextSectionMatch.index)
    : sectionText;
}

export function linuxReleaseCurrentStatus(validationText = "") {
  const statusMatch = /^Current status:\s*(.+?)\s*$/im.exec(validationText);
  return statusMatch?.[1]?.trim() ?? "";
}

export function linuxReleaseCurrentStatusPassed(validationText = "") {
  return /^passed\.?$/i.test(linuxReleaseCurrentStatus(validationText));
}

export function linuxReleaseRequiredEvidenceHasNotYetRun(
  validationText = ""
) {
  return /\bnot yet run\b/i.test(
    RC_LEDGER_REQUIRED_STATUS_SECTIONS.map((heading) =>
      extractLinuxReleaseMarkdownSection(validationText, heading)
    ).join("\n")
  );
}

export function linuxReleaseRequiredEvidenceSectionsPresent(
  validationText = ""
) {
  return RC_LEDGER_REQUIRED_STATUS_SECTIONS.every(
    (heading) =>
      extractLinuxReleaseMarkdownSection(validationText, heading).trim()
        .length > 0
  );
}

function parseLinuxReleaseMarkdownTableRows(sectionText = "") {
  return sectionText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim())
    )
    .filter(
      (cells) =>
        cells.length >= 2 &&
        !cells.every((cell) => /^:?-{3,}:?$/.test(cell)) &&
        !/^status$/i.test(cells[cells.length - 1] ?? "")
    );
}

function linuxReleaseStatusCellIsComplete(status = "") {
  return (
    RC_LEDGER_COMPLETE_STATUS_PATTERN.test(status) &&
    !RC_LEDGER_INCOMPLETE_STATUS_PATTERN.test(status) &&
    !RC_LEDGER_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(status))
  );
}

function normalizeLinuxReleaseTableLabel(label = "") {
  return label.replace(/\s+/g, " ").trim();
}

function linuxReleaseTableRowLabels(validationText = "", heading) {
  return parseLinuxReleaseMarkdownTableRows(
    extractLinuxReleaseMarkdownSection(validationText, heading)
  ).map((cells) => normalizeLinuxReleaseTableLabel(cells[0] ?? ""));
}

export function linuxReleaseIncompleteRequiredEvidenceRows(
  validationText = ""
) {
  return RC_LEDGER_REQUIRED_STATUS_SECTIONS.flatMap((heading) =>
    parseLinuxReleaseMarkdownTableRows(
      extractLinuxReleaseMarkdownSection(validationText, heading)
    )
      .filter((cells) => !linuxReleaseStatusCellIsComplete(cells.at(-1) ?? ""))
      .map((cells) => {
        const requirement = cells[0] ?? "<unknown>";
        const status = cells.at(-1) ?? "";
        return `${heading}: ${requirement} -> ${status || "<missing status>"}`;
      })
  );
}

export function linuxReleaseMissingRequiredEvidenceRows(validationText = "") {
  return Object.entries(REQUIRED_RC_LEDGER_STATUS_ROWS).flatMap(
    ([heading, requiredRows]) => {
      const actualRows = new Set(
        linuxReleaseTableRowLabels(validationText, heading)
      );
      return requiredRows
        .filter((row) => !actualRows.has(normalizeLinuxReleaseTableLabel(row)))
        .map((row) => `${heading}: ${row}`);
    }
  );
}

export function extractLinuxReleaseRecordedEvidence(validationText = "") {
  return extractLinuxReleaseMarkdownSection(
    validationText,
    "Recorded Evidence"
  );
}

function splitLinuxReleaseEvidenceEntries(recordedEvidence = "") {
  const entryMatches = [...recordedEvidence.matchAll(/^Date:/gim)];
  if (entryMatches.length === 0) {
    return recordedEvidence.trim().length > 0 ? [recordedEvidence] : [];
  }

  return entryMatches.map((match, index) => {
    const nextMatch = entryMatches[index + 1];
    return recordedEvidence.slice(match.index, nextMatch?.index);
  });
}

export function extractLinuxReleasePassedRecordedEvidenceEntries(
  validationText = ""
) {
  return splitLinuxReleaseEvidenceEntries(
    extractLinuxReleaseRecordedEvidence(validationText)
  ).filter((entry) => /^Result:\s*Passed\.?\s*$/im.test(entry));
}

export function extractLinuxReleasePassedRecordedEvidence(validationText = "") {
  return extractLinuxReleasePassedRecordedEvidenceEntries(validationText).join(
    "\n\n"
  );
}

export function parseLinuxReleaseEvidenceEntryFields(entry = "") {
  const cachedFields = parsedEvidenceEntryFieldsCache.get(entry);
  if (cachedFields) {
    return cachedFields;
  }

  const fields = {};
  let currentField = "";

  for (const rawLine of entry.split(/\r?\n/)) {
    const fieldMatch = /^([A-Za-z][A-Za-z ]*):\s*(.*)$/.exec(rawLine);
    if (fieldMatch) {
      currentField = fieldMatch[1].trim();
      fields[currentField] = [fields[currentField], fieldMatch[2]]
        .filter(Boolean)
        .join("\n");
      continue;
    }

    if (currentField && rawLine.trim().length > 0) {
      fields[currentField] = [fields[currentField], rawLine.trim()]
        .filter(Boolean)
        .join("\n");
    }
  }

  parsedEvidenceEntryFieldsCache.set(entry, fields);
  return fields;
}

function evidenceEntryHasRequirement(entry, requirement) {
  const fieldValue =
    parseLinuxReleaseEvidenceEntryFields(entry)[requirement.field] ?? "";
  const cacheKey = `${requirement.label}\0${requirement.field}\0${fieldValue}`;
  if (evidenceRequirementResultCache.has(cacheKey)) {
    return evidenceRequirementResultCache.get(cacheKey);
  }

  const result = requirement.pattern.test(fieldValue);
  evidenceRequirementResultCache.set(cacheKey, result);
  return result;
}

function evidenceEntryHasAllRequirements(entry, requirements) {
  return requirements.every((requirement) =>
    evidenceEntryHasRequirement(entry, requirement)
  );
}

function passedEvidenceEntriesHaveRequirement(validationText, requirement) {
  return extractLinuxReleasePassedRecordedEvidenceEntries(validationText).some(
    (entry) => evidenceEntryHasRequirement(entry, requirement)
  );
}

export function linuxReleasePrimaryRcEvidenceEntry(validationText = "") {
  return (
    extractLinuxReleasePassedRecordedEvidenceEntries(validationText).find(
      (entry) =>
        evidenceEntryHasAllRequirements(
          entry,
          REQUIRED_PRIMARY_LINUX_RC_LEDGER_EVIDENCE
        )
    ) ?? ""
  );
}

export function linuxReleaseMacCompatibilityEvidenceEntry(
  validationText = ""
) {
  return (
    extractLinuxReleasePassedRecordedEvidenceEntries(validationText).find(
      (entry) =>
        evidenceEntryHasAllRequirements(
          entry,
          REQUIRED_MACOS_COMPATIBILITY_RC_LEDGER_EVIDENCE
        )
    ) ?? ""
  );
}

export function missingLinuxReleaseCandidateEvidence(validationText = "") {
  return REQUIRED_RC_LEDGER_EVIDENCE.filter(
    (requirement) =>
      !passedEvidenceEntriesHaveRequirement(validationText, requirement)
  ).map((requirement) => requirement.label);
}

export function linuxReleaseCandidatePlaceholderEvidence(validationText = "") {
  const recordedEvidence =
    extractLinuxReleasePassedRecordedEvidence(validationText);
  return recordedEvidence
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      RC_LEDGER_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(line))
    );
}

export function linuxReleasePrimaryRcEvidenceCaveats(validationText = "") {
  return linuxReleasePrimaryRcEvidenceEntry(validationText)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      RC_LEDGER_EVIDENCE_CAVEAT_PATTERNS.some((pattern) =>
        pattern.test(line)
      )
    );
}

export function linuxReleaseMacCompatibilityEvidenceCaveats(
  validationText = ""
) {
  return linuxReleaseMacCompatibilityEvidenceEntry(validationText)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      RC_LEDGER_EVIDENCE_CAVEAT_PATTERNS.some((pattern) =>
        pattern.test(line)
      )
    );
}

function linuxReleaseEvidenceEntryFieldFailures(
  entry = "",
  label,
  { currentCommit: expectedCurrentCommit } = {}
) {
  const fields = parseLinuxReleaseEvidenceEntryFields(entry);
  const fieldFailures = REQUIRED_RC_LEDGER_ENTRY_FIELDS.flatMap(
    (requirement) => {
      const value = (fields[requirement.field] ?? "").trim();
      if (!value) {
        return [`${label}: ${requirement.field} is missing`];
      }
      if (!requirement.pattern.test(value)) {
        return [
          `${label}: ${requirement.field} must be ${requirement.expectation}; got ${value}`
        ];
      }
      return [];
    }
  );

  if (expectedCurrentCommit === undefined) {
    return fieldFailures;
  }

  const currentCommitForComparison = normalizedGitCommit(expectedCurrentCommit);
  if (!currentCommitForComparison) {
    return [
      ...fieldFailures,
      `${label}: current git commit is unavailable for RC evidence comparison`
    ];
  }

  const recordedCommit = (fields.Commit ?? "").trim();
  if (
    normalizedGitCommit(recordedCommit) &&
    !gitCommitMatches(recordedCommit, currentCommitForComparison)
  ) {
    return [
      ...fieldFailures,
      `${label}: Commit must match current HEAD ${currentCommitForComparison}; got ${recordedCommit}`
    ];
  }

  return fieldFailures;
}

export function linuxReleaseRcEvidenceFieldFailures(
  validationText = "",
  options = {}
) {
  const primaryRcEvidence = linuxReleasePrimaryRcEvidenceEntry(validationText);
  const macCompatibilityEvidence =
    linuxReleaseMacCompatibilityEvidenceEntry(validationText);
  return [
    ...(primaryRcEvidence
      ? linuxReleaseEvidenceEntryFieldFailures(
          primaryRcEvidence,
          "Primary Ubuntu Desktop/AppImage RC evidence",
          options
        )
      : []),
    ...(macCompatibilityEvidence &&
    macCompatibilityEvidence !== primaryRcEvidence
      ? linuxReleaseEvidenceEntryFieldFailures(
          macCompatibilityEvidence,
          "macOS compatibility RC evidence",
          options
        )
      : [])
  ];
}

export function requiredLinuxReleaseCandidateEvidenceLabels() {
  return REQUIRED_RC_LEDGER_EVIDENCE.map((requirement) => requirement.label);
}

export function requiredLinuxReleaseStatusRowLabels() {
  return Object.values(REQUIRED_RC_LEDGER_STATUS_ROWS).flat();
}

export function assertLinuxReleaseCandidatePassed(
  validationText = readFileSync(DEFAULT_RC_VALIDATION_PATH, "utf8"),
  options = {}
) {
  const missingEvidence = missingLinuxReleaseCandidateEvidence(validationText);
  const placeholderEvidence =
    linuxReleaseCandidatePlaceholderEvidence(validationText);
  const requiredSectionsPresent =
    linuxReleaseRequiredEvidenceSectionsPresent(validationText);
  const incompleteRequiredRows =
    linuxReleaseIncompleteRequiredEvidenceRows(validationText);
  const missingRequiredRows =
    linuxReleaseMissingRequiredEvidenceRows(validationText);
  const primaryRcEvidencePresent =
    linuxReleasePrimaryRcEvidenceEntry(validationText).length > 0;
  const macCompatibilityEvidencePresent =
    linuxReleaseMacCompatibilityEvidenceEntry(validationText).length > 0;
  const primaryRcEvidenceCaveats =
    linuxReleasePrimaryRcEvidenceCaveats(validationText);
  const macCompatibilityEvidenceCaveats =
    linuxReleaseMacCompatibilityEvidenceCaveats(validationText);
  const rcEvidenceFieldFailures = linuxReleaseRcEvidenceFieldFailures(
    validationText,
    options
  );
  if (
    linuxReleaseCurrentStatusPassed(validationText) &&
    requiredSectionsPresent &&
    !linuxReleaseRequiredEvidenceHasNotYetRun(validationText) &&
    incompleteRequiredRows.length === 0 &&
    missingRequiredRows.length === 0 &&
    primaryRcEvidencePresent &&
    macCompatibilityEvidencePresent &&
    primaryRcEvidenceCaveats.length === 0 &&
    macCompatibilityEvidenceCaveats.length === 0 &&
    rcEvidenceFieldFailures.length === 0 &&
    missingEvidence.length === 0 &&
    placeholderEvidence.length === 0
  ) {
    return;
  }

  throw new Error(
    [
      "Linux public release publishing is enabled, but the Linux stable RC ledger has not passed.",
      "Before setting KMUX_ENABLE_LINUX_PUBLIC_RELEASE=1, update docs/linux-release-validation.md so the first `Current status:` line is `passed.`, required rows remain present, required row statuses are complete/passed without incomplete caveats, and passed recorded evidence contains the required RC markers.",
      "Required RC evidence markers are evaluated only inside `## Recorded Evidence` entries whose `Result:` is `Passed.`.",
      ...(primaryRcEvidencePresent
        ? []
        : [
            "One passed Ubuntu Desktop/AppImage evidence entry must contain all Linux RC markers together; macOS compatibility evidence may be a separate passed entry."
          ]),
      ...(macCompatibilityEvidencePresent
        ? []
        : [
            "One passed macOS compatibility evidence entry must include both `release:check:mac` and the macOS compatibility note."
          ]),
      ...(requiredSectionsPresent
        ? []
        : [
            "The RC ledger must keep non-empty `## Required Evidence` and `## Environment Matrix` sections."
          ]),
      ...(linuxReleaseRequiredEvidenceHasNotYetRun(validationText)
        ? ["Required evidence or environment matrix rows still include `not yet run`."]
        : []),
      ...(incompleteRequiredRows.length > 0
        ? [
            "Required evidence and environment matrix rows must be marked complete or passed:",
            ...incompleteRequiredRows.map((row) => `- ${row}`)
          ]
        : []),
      ...(missingRequiredRows.length > 0
        ? [
            "Required evidence and environment matrix rows are missing:",
            ...missingRequiredRows.map((row) => `- ${row}`)
          ]
        : []),
      ...(missingEvidence.length > 0
        ? [
            "Missing required RC evidence markers:",
            ...missingEvidence.map((label) => `- ${label}`)
          ]
        : []),
      ...(placeholderEvidence.length > 0
        ? [
            "Passed RC evidence still contains placeholder text:",
            ...placeholderEvidence.map((line) => `- ${line}`)
          ]
        : []),
      ...(rcEvidenceFieldFailures.length > 0
        ? [
            "Passed RC evidence entries must include release provenance and blocker fields for the current source commit:",
            ...rcEvidenceFieldFailures.map((line) => `- ${line}`)
          ]
        : []),
      ...(primaryRcEvidenceCaveats.length > 0
        ? [
            "Primary Ubuntu Desktop/AppImage RC evidence still contains incomplete, failed, unconfirmed, mismatched, target-negating, non-RC, or script-development-only evidence text:",
            ...primaryRcEvidenceCaveats.map((line) => `- ${line}`)
          ]
        : []),
      ...(macCompatibilityEvidenceCaveats.length > 0
        ? [
            "macOS compatibility RC evidence still contains incomplete, failed, unconfirmed, mismatched, target-negating, non-RC, or script-development-only evidence text:",
            ...macCompatibilityEvidenceCaveats.map((line) => `- ${line}`)
          ]
        : [])
    ].join("\n")
  );
}

export function assertLinuxPublicPublishingGate({
  env = process.env,
  assetsDir = DEFAULT_RELEASE_ASSETS_DIR,
  rcValidationText,
  workflowText,
  currentCommit = currentGitCommit(),
  currentGitDirty = currentGitDirtyState()
} = {}) {
  if (isLinuxPublicReleaseEnabled(env)) {
    assertLinuxReleaseCandidatePassed(rcValidationText, { currentCommit });
    if (currentGitDirty !== "no") {
      throw new Error(
        [
          "Linux public release publishing requires a clean current source git worktree.",
          `Current source git dirty state: ${currentGitDirty || "unknown"}.`,
          "Generated release artifact directories are ignored by this check; re-run the Ubuntu Desktop/AppImage RC and update docs/linux-release-validation.md after committing the exact source state being released."
        ].join("\n")
      );
    }
    const linuxAssets = listLinuxReleaseAssets(assetsDir);
    if (linuxAssets.length === 0) {
      throw new Error(
        [
          "Linux public release publishing is enabled, but no Linux release assets were found in the public release upload directory.",
          `Checked directory: ${assetsDir}.`,
          "Expected an AppImage, matching AppImage blockmap sidecar, and latest-linux update metadata from the exact source state that passed RC."
        ].join("\n")
      );
    }
    const appImageAssets = linuxAssets.filter(isLinuxAppImageReleaseAssetName);
    if (appImageAssets.length === 0) {
      throw new Error(
        [
          "Linux public release publishing is enabled, but no AppImage artifact was found in the public release upload directory.",
          `Checked directory: ${assetsDir}.`,
          "Expected a kmux Linux AppImage from the exact source state that passed RC."
        ].join("\n")
      );
    }
    const namingFailures = appImageNamingFailures(appImageAssets);
    if (namingFailures.length > 0) {
      throw new Error(
        [
          "Linux public release publishing is enabled, but AppImage artifacts are not named for the kmux Linux release policy.",
          "AppImage artifacts must be named kmux-<version>-linux-<arch>.AppImage:",
          ...namingFailures
        ].join("\n")
      );
    }
    const blockmapFailures = appImageBlockmapSidecarFailures({
      appImageAssets,
      linuxAssets,
      assetsDir
    });
    if (blockmapFailures.length > 0) {
      throw new Error(
        [
          "Linux public release publishing is enabled, but AppImage blockmap sidecars are missing or empty in the public release upload directory:",
          ...blockmapFailures
        ].join("\n")
      );
    }
    const metadataAssets = linuxAssets.filter(
      isLinuxUpdateMetadataReleaseAssetName
    );
    if (metadataAssets.length === 0) {
      throw new Error(
        [
          "Linux public release publishing is enabled, but no latest-linux update metadata was found in the public release upload directory.",
          `Checked directory: ${assetsDir}.`,
          "Expected latest-linux.yml or latest-linux-<arch>.yml from the exact source state that passed RC."
        ].join("\n")
      );
    }
    const metadataFailures = linuxUpdateMetadataValidationFailures({
      appImageAssets,
      metadataAssets,
      assetsDir
    });
    if (metadataFailures.length > 0) {
      throw new Error(
        [
          "Linux public release publishing is enabled, but latest-linux update metadata does not match the AppImage artifacts in the public release upload directory:",
          ...metadataFailures
        ].join("\n")
      );
    }
    const unexpectedAssetFailures = unexpectedLinuxPublicAssetFailures({
      linuxAssets,
      appImageAssets
    });
    if (unexpectedAssetFailures.length > 0) {
      throw new Error(
        [
          "Linux public release publishing is enabled, but the public release upload directory contains unexpected Linux release assets for the current AppImage-only release policy:",
          ...unexpectedAssetFailures
        ].join("\n")
      );
    }
    if (!workflowAllowsLinuxPublicUploads(workflowText)) {
      throw new Error(
        "Linux public release publishing is enabled, but the release workflow does not upload Linux artifacts."
      );
    }
    if (!workflowUploadsLinuxAppImageArtifacts(workflowText)) {
      throw new Error(
        "Linux public release publishing is enabled, but the release workflow does not upload AppImage artifacts."
      );
    }
    if (!workflowRunsLinuxPublicGateBeforeReleasePublish(workflowText)) {
      throw new Error(
        "Linux public release publishing is enabled, but the release workflow does not run the Linux public release gate before publishing."
      );
    }
    return {
      enabled: true,
      linuxAssets
    };
  }

  const linuxAssets = listLinuxReleaseAssets(assetsDir);
  if (linuxAssets.length > 0) {
    throw new Error(
      [
        "Linux public release publishing is gated, but Linux assets are present in the public release upload directory:",
        ...linuxAssets.map((asset) => `- ${asset}`),
        "Set KMUX_ENABLE_LINUX_PUBLIC_RELEASE=1 only after the stable Linux RC gate passes."
      ].join("\n")
    );
  }

  if (workflowAllowsLinuxPublicUploads(workflowText)) {
    throw new Error(
      "Linux public release publishing is gated, but the release workflow appears to upload Linux artifacts."
    );
  }

  if (!workflowRunsLinuxPublicGateBeforeReleasePublish(workflowText)) {
    throw new Error(
      "Linux public release publishing is gated, but the release workflow does not run the Linux public release gate before publishing."
    );
  }

  return {
    enabled: false,
    linuxAssets
  };
}

function main(argv = process.argv.slice(2)) {
  const { requireUbuntuDesktop } = parseArgs(argv);
  assertLinuxReleaseCheckTarget({ requireUbuntuDesktop });

  const result = assertLinuxPublicPublishingGate();
  if (!result.enabled) {
    console.log(
      "Linux release check passed: AppImage packaging is local/internal and public GitHub release uploads remain gated."
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}

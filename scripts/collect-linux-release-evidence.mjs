import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  calculateFileSha512,
  describeAppImageBlockmap,
  expectedLinuxUpdateMetadataNames,
  extractAppImageDesktopIdentity,
  isKmuxLinuxAppImagePath,
  isLinuxUpdateMetadataName,
  linuxUpdateMetadataCandidates,
  selectLinuxAppImagePath
} from "./smoke-packaged-linux.mjs";
import {
  UBUNTU_DESKTOP_RC_TARGET_HINT,
  assertUbuntuDesktopLtsTarget,
  hasUbuntuDesktopSession,
  parseOsRelease,
  readOsRelease
} from "./linux-desktop-target.mjs";
import {
  RELEASE_BUILD_OUTPUT_STATUS_EXCLUDES,
  linuxReleaseSourceStatusArgs
} from "./linux-release-git.mjs";
import {
  workflowAllowsLinuxPublicUploads,
  workflowRunsLinuxPublicGateBeforeReleasePublish
} from "./release-check-linux.mjs";

export { parseOsRelease };

const require = createRequire(import.meta.url);
const ts = require("typescript");
const yaml = require("js-yaml");

const DEFAULT_RELEASE_SEARCH_ROOTS = [
  path.resolve("apps/desktop/release"),
  path.resolve("release-assets")
];
const DEFAULT_RELEASE_WORKFLOW_PATH = path.resolve(
  ".github/workflows/release-desktop.yml"
);

const DESKTOP_ENV_KEYS = [
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
  "DESKTOP_SESSION",
  "GDMSESSION",
  "DISPLAY",
  "WAYLAND_DISPLAY"
];

const IME_ENV_KEYS = [
  "GTK_IM_MODULE",
  "QT_IM_MODULE",
  "XMODIFIERS",
  "INPUT_METHOD"
];

const XDG_ENV_KEYS = [
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME"
];

const SHELL_PATH_ENV_KEYS = [
  "HOME",
  "SHELL",
  "PATH",
  "NVM_DIR",
  "PYENV_ROOT",
  "CARGO_HOME"
];

const DESKTOP_INTEGRATION_ENV_KEYS = [
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_DATA_HOME",
  "XDG_DATA_DIRS",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_TYPE",
  "DESKTOP_SESSION",
  "GDMSESSION",
  "XDG_MENU_PREFIX"
];

const DESKTOP_ENTRY_ID = "kmux.desktop";
const DEFAULT_XDG_DATA_DIRS = ["/usr/local/share", "/usr/share"];
const DESKTOP_ENTRY_IDENTITY_FIELDS = [
  "Name",
  "Icon",
  "Categories",
  "StartupWMClass",
  "StartupNotify",
  "Terminal"
];

const NOTIFICATION_DBUS_PROBES = [
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
    ]
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
    ]
  }
];

const DESKTOP_SHELL_ENV_KEYS = [
  "XDG_SESSION_ID",
  "XDG_SESSION_CLASS",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "DESKTOP_SESSION",
  "GDMSESSION",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "ELECTRON_OZONE_PLATFORM_HINT",
  "GDK_BACKEND",
  "QT_QPA_PLATFORM"
];

const GNOME_SETTINGS_PROBES = [
  {
    label: "GNOME notification banners",
    schema: "org.gnome.desktop.notifications",
    key: "show-banners"
  },
  {
    label: "GNOME notification application list",
    schema: "org.gnome.desktop.notifications",
    key: "application-children"
  },
  {
    label: "GNOME window button layout",
    schema: "org.gnome.desktop.wm.preferences",
    key: "button-layout"
  },
  ...buildNumberedGnomeSettingsProbes({
    labelPrefix: "GNOME switch application shortcut",
    schema: "org.gnome.shell.keybindings",
    keyPrefix: "switch-to-application",
    count: 4
  }),
  ...buildNumberedGnomeSettingsProbes({
    labelPrefix: "GNOME switch workspace shortcut",
    schema: "org.gnome.desktop.wm.keybindings",
    keyPrefix: "switch-to-workspace",
    count: 4
  }),
  ...buildNumberedGnomeSettingsProbes({
    labelPrefix: "GNOME move to workspace shortcut",
    schema: "org.gnome.desktop.wm.keybindings",
    keyPrefix: "move-to-workspace",
    count: 4
  }),
  {
    label: "GNOME switch workspace left shortcut",
    schema: "org.gnome.desktop.wm.keybindings",
    key: "switch-to-workspace-left"
  },
  {
    label: "GNOME switch workspace right shortcut",
    schema: "org.gnome.desktop.wm.keybindings",
    key: "switch-to-workspace-right"
  }
];

function buildNumberedGnomeSettingsProbes({
  labelPrefix,
  schema,
  keyPrefix,
  count
}) {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return {
      label: `${labelPrefix} ${number}`,
      schema,
      key: `${keyPrefix}-${number}`
    };
  });
}

const APPIMAGE_SANDBOX_ENV_KEYS = [
  "APPIMAGE",
  "APPIMAGE_EXTRACT_AND_RUN",
  "ELECTRON_DISABLE_SANDBOX",
  "ELECTRON_NO_SANDBOX",
  "CHROME_DEVEL_SANDBOX"
];

const LINUX_SANDBOX_PROC_SETTINGS = [
  {
    key: "kernel.unprivileged_userns_clone",
    relativePath: path.join("sys", "kernel", "unprivileged_userns_clone")
  },
  {
    key: "user.max_user_namespaces",
    relativePath: path.join("sys", "user", "max_user_namespaces")
  }
];

const LINUX_INOTIFY_PROC_SETTINGS = [
  {
    key: "fs.inotify.max_user_watches",
    relativePath: path.join("sys", "fs", "inotify", "max_user_watches")
  },
  {
    key: "fs.inotify.max_user_instances",
    relativePath: path.join("sys", "fs", "inotify", "max_user_instances")
  },
  {
    key: "fs.inotify.max_queued_events",
    relativePath: path.join("sys", "fs", "inotify", "max_queued_events")
  }
];

export const AGENT_COMMANDS = [
  "codex",
  "claude",
  "claude-code",
  "gemini",
  "gemini-cli",
  "antigravity",
  "antigravity-cli",
  "agy"
];

const AGENT_STORAGE_PATHS = [
  {
    provider: "codex",
    label: "root",
    relativePath: [".codex"]
  },
  {
    provider: "codex",
    label: "sessionsDir",
    relativePath: [".codex", "sessions"]
  },
  {
    provider: "codex",
    label: "authPath",
    relativePath: [".codex", "auth.json"]
  },
  {
    provider: "claude",
    label: "root",
    relativePath: [".claude"]
  },
  {
    provider: "claude",
    label: "projectsDir",
    relativePath: [".claude", "projects"]
  },
  {
    provider: "claude",
    label: "credentialsPath",
    relativePath: [".claude", ".credentials.json"]
  },
  {
    provider: "claude",
    label: "settingsPath",
    relativePath: [".claude", "settings.json"]
  },
  {
    provider: "gemini",
    label: "root",
    relativePath: [".gemini"]
  },
  {
    provider: "gemini",
    label: "tmpDir",
    relativePath: [".gemini", "tmp"]
  },
  {
    provider: "gemini",
    label: "historyDir",
    relativePath: [".gemini", "history"]
  },
  {
    provider: "gemini",
    label: "oauthCredentialsPath",
    relativePath: [".gemini", "oauth_creds.json"]
  },
  {
    provider: "gemini",
    label: "settingsPath",
    relativePath: [".gemini", "settings.json"]
  },
  {
    provider: "antigravity",
    label: "root",
    relativePath: [".gemini", "antigravity-cli"]
  },
  {
    provider: "antigravity",
    label: "brainDir",
    relativePath: [".gemini", "antigravity-cli", "brain"]
  },
  {
    provider: "antigravity",
    label: "historyPath",
    relativePath: [".gemini", "antigravity-cli", "history.jsonl"]
  },
  {
    provider: "antigravity",
    label: "cacheProjectsPath",
    relativePath: [".gemini", "antigravity-cli", "cache", "projects.json"]
  },
  {
    provider: "antigravity",
    label: "conversationsDir",
    relativePath: [".gemini", "antigravity-cli", "conversations"]
  },
  {
    provider: "antigravity",
    label: "hooksPath",
    relativePath: [".gemini", "config", "hooks.json"]
  }
];

const SYSTEM_COMMANDS = [
  "ps",
  "script",
  "lsof",
  "fc-list",
  "fc-match",
  "notify-send",
  "gsettings",
  "gio",
  "xdg-mime",
  "dbus-send",
  "loginctl",
  "ibus",
  "fcitx5-remote",
  "fcitx-remote",
  "gnome-shell",
  "xrandr",
  "xdpyinfo",
  "xprop"
];

const IME_PROBES = [
  {
    label: "ibus current engine",
    command: "ibus",
    args: ["engine"]
  },
  {
    label: "ibus version",
    command: "ibus",
    args: ["version"]
  },
  {
    label: "fcitx5 current input method",
    command: "fcitx5-remote",
    args: ["-n"]
  },
  {
    label: "fcitx current input method",
    command: "fcitx-remote",
    args: ["-n"]
  }
];

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readYaml(filePath) {
  return yaml.load(readFileSync(filePath, "utf8"));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readScript(packageJson, scriptName) {
  return isRecord(packageJson.scripts) &&
    typeof packageJson.scripts[scriptName] === "string"
    ? packageJson.scripts[scriptName]
    : "";
}

function readExportedStringConstants(filePath, names) {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const pending = new Map();
  const values = new Map();
  const wanted = new Set(names);

  sourceFile.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) {
      return;
    }
    const isExported = node.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    );
    if (!isExported) {
      return;
    }
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
        continue;
      }
      const name = declaration.name.text;
      if (!wanted.has(name)) {
        continue;
      }
      const initializer = unwrapTsExpression(declaration.initializer);
      if (
        ts.isStringLiteral(initializer) ||
        ts.isNoSubstitutionTemplateLiteral(initializer)
      ) {
        values.set(name, initializer.text);
      } else if (ts.isIdentifier(initializer)) {
        pending.set(name, initializer.text);
      }
    }
  });

  let resolvedPending = true;
  while (resolvedPending && pending.size > 0) {
    resolvedPending = false;
    for (const [name, reference] of pending.entries()) {
      if (values.has(reference)) {
        values.set(name, values.get(reference));
        pending.delete(name);
        resolvedPending = true;
      }
    }
  }

  return Object.fromEntries(names.map((name) => [name, values.get(name) ?? ""]));
}

function unwrapTsExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isLinuxPackageArtifactName(fileName) {
  return /\.(?:deb|rpm|snap|flatpak)$/i.test(fileName);
}

export function parseArgs(argv) {
  const parsed = {
    allowAnyPlatform: false,
    outputPath: undefined
  };
  const readPathArg = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a path value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--allow-any-platform") {
      parsed.allowAnyPlatform = true;
    } else if (token === "--output") {
      parsed.outputPath = path.resolve(readPathArg(index, token));
      index += 1;
    } else {
      throw new Error(`unknown release:evidence:linux argument: ${token}`);
    }
  }

  return parsed;
}

export function assertLinuxHost({
  platform = process.platform,
  allowAnyPlatform = false
} = {}) {
  if (platform === "linux" || allowAnyPlatform) {
    return;
  }

  throw new Error(
    [
      `Linux release evidence collection must run on Ubuntu Desktop; current platform is ${platform}.`,
      "Use --allow-any-platform only for script development.",
      UBUNTU_DESKTOP_RC_TARGET_HINT
    ].join("\n")
  );
}

export function assertLinuxEvidenceTarget({
  platform = process.platform,
  env = process.env,
  osReleaseText = readOsRelease(),
  allowAnyPlatform = false
} = {}) {
  if (allowAnyPlatform) {
    return;
  }

  const distribution = parseOsRelease(osReleaseText);
  assertUbuntuDesktopLtsTarget({
    platform,
    env,
    osReleaseText,
    platformMessage: `Linux release evidence collection must run on Ubuntu Desktop; current platform is ${platform}. Use --allow-any-platform only for script development.`,
    distributionMessage: [
      "Linux release evidence collection must run on Ubuntu Desktop LTS.",
      `Detected distro: ${distribution.prettyName || distribution.id || "<unknown>"}.`,
      "Use --allow-any-platform only for script development."
    ].join("\n"),
    displayMessage: [
      "Linux release evidence collection must run inside a desktop session.",
      "Set DISPLAY or WAYLAND_DISPLAY by running it from Ubuntu Desktop, not from a headless shell.",
      "Use --allow-any-platform only for script development."
    ].join("\n")
  });
}

export function detectDesktopSession(env = process.env) {
  const displayServer = env.WAYLAND_DISPLAY
    ? "wayland"
    : env.DISPLAY
      ? "x11"
      : "none";

  return {
    displayServer,
    hasDisplay: displayServer !== "none",
    hasUbuntuDesktopSession: hasUbuntuDesktopSession(env),
    values: Object.fromEntries(
      DESKTOP_ENV_KEYS.map((key) => [key, env[key] ?? ""])
    )
  };
}

export function collectEnvironmentSnapshot({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  release = os.release(),
  nodeVersion = process.version,
  osReleaseText = readOsRelease()
} = {}) {
  return {
    platform,
    arch,
    release,
    nodeVersion,
    distribution: parseOsRelease(osReleaseText),
    desktop: detectDesktopSession(env),
    ime: Object.fromEntries(IME_ENV_KEYS.map((key) => [key, env[key] ?? ""])),
    xdg: Object.fromEntries(XDG_ENV_KEYS.map((key) => [key, env[key] ?? ""])),
    appImage: env.APPIMAGE ?? ""
  };
}

export function collectReleaseArtifacts(
  searchRoots = DEFAULT_RELEASE_SEARCH_ROOTS
) {
  return searchRoots.flatMap((root) => {
    if (!existsSync(root)) {
      return [];
    }

    return listFilesRecursive(root)
      .filter((filePath) => {
        const fileName = path.basename(filePath);
        return (
          fileName.endsWith(".AppImage") ||
          fileName.endsWith(".AppImage.blockmap") ||
          isLinuxPackageArtifactName(fileName) ||
          isLinuxUpdateMetadataName(fileName)
        );
      })
      .map((filePath) => {
        const stats = statSync(filePath);
        return {
          name: path.basename(filePath),
          path: filePath,
          root,
          sizeBytes: stats.size
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));
  });
}

export function collectPackagingConfiguration({
  rootPackagePath = "package.json",
  desktopPackagePath = path.join("apps", "desktop", "package.json"),
  builderConfigPath = path.join("apps", "desktop", "electron-builder.yml")
} = {}) {
  const rootPackage = readJson(rootPackagePath);
  const desktopPackage = readJson(desktopPackagePath);
  const builderConfig = readYaml(builderConfigPath);
  const publishConfig = isRecord(builderConfig?.publish)
    ? builderConfig.publish
    : {};
  const linuxConfig = isRecord(builderConfig?.linux)
    ? builderConfig.linux
    : {};
  const linuxTarget = Array.isArray(linuxConfig.target)
    ? linuxConfig.target.map((target) => String(target))
    : [];
  const rootPackageLinuxScript = readScript(rootPackage, "package:linux");
  const rootReleaseCheckLinuxScript = readScript(
    rootPackage,
    "release:check:linux"
  );
  const desktopDistLinuxScript = readScript(desktopPackage, "dist:linux");

  return {
    rootPackageLinuxScript,
    rootReleaseCheckLinuxScript,
    desktopDistLinuxScript,
    rootPackageUsesDistLinux: /\bnpm\s+run\s+dist:linux\b/.test(
      rootPackageLinuxScript
    ),
    desktopDistLinuxUsesPublishNever:
      /(?:^|\s)--publish(?:=|\s+)never\b/.test(desktopDistLinuxScript),
    publishProvider:
      typeof publishConfig.provider === "string"
        ? publishConfig.provider
        : "",
    publishOwner:
      typeof publishConfig.owner === "string" ? publishConfig.owner : "",
    publishRepo:
      typeof publishConfig.repo === "string" ? publishConfig.repo : "",
    publishReleaseType:
      typeof publishConfig.releaseType === "string"
        ? publishConfig.releaseType
        : "",
    linuxTarget,
    linuxArtifactName:
      typeof linuxConfig.artifactName === "string"
        ? linuxConfig.artifactName
        : "",
    linuxExecutableName:
      typeof linuxConfig.executableName === "string"
        ? linuxConfig.executableName
        : ""
  };
}

export function collectRuntimeIdentityConfiguration({
  appIdentityPath = path.join("apps", "desktop", "src", "main", "appIdentity.ts"),
  builderConfigPath = path.join("apps", "desktop", "electron-builder.yml")
} = {}) {
  try {
    const identity = readExportedStringConstants(appIdentityPath, [
      "KMUX_APP_ID",
      "KMUX_APP_NAME",
      "LINUX_STARTUP_WM_CLASS"
    ]);
    const builderConfig = readYaml(builderConfigPath);
    const linuxConfig = isRecord(builderConfig?.linux)
      ? builderConfig.linux
      : {};
    const desktopConfig = isRecord(linuxConfig.desktop)
      ? linuxConfig.desktop
      : {};
    const desktopEntry = isRecord(desktopConfig.entry)
      ? desktopConfig.entry
      : {};

    const appId = identity.KMUX_APP_ID;
    const appName = identity.KMUX_APP_NAME;
    const startupWmClass = identity.LINUX_STARTUP_WM_CLASS;
    const builderAppId =
      typeof builderConfig?.appId === "string" ? builderConfig.appId : "";
    const builderProductName =
      typeof builderConfig?.productName === "string"
        ? builderConfig.productName
        : "";
    const builderLinuxExecutableName =
      typeof linuxConfig.executableName === "string"
        ? linuxConfig.executableName
        : "";
    const builderDesktopName =
      typeof desktopEntry.Name === "string" ? desktopEntry.Name : "";
    const builderDesktopStartupWmClass =
      typeof desktopEntry.StartupWMClass === "string"
        ? desktopEntry.StartupWMClass
        : "";

    return {
      status: "read",
      appIdentityPath,
      builderConfigPath,
      appId,
      appName,
      startupWmClass,
      builderAppId,
      builderProductName,
      builderLinuxExecutableName,
      builderDesktopName,
      builderDesktopStartupWmClass,
      appIdMatchesBuilder: appId !== "" && appId === builderAppId,
      appNameMatchesProductName:
        appName !== "" && appName === builderProductName,
      executableNameMatchesAppName:
        appName !== "" && appName === builderLinuxExecutableName,
      desktopNameMatchesAppName:
        appName !== "" && appName === builderDesktopName,
      startupWmClassMatchesDesktopEntry:
        startupWmClass !== "" &&
        startupWmClass === builderDesktopStartupWmClass,
      error: ""
    };
  } catch (error) {
    return {
      status: "error",
      appIdentityPath,
      builderConfigPath,
      appId: "",
      appName: "",
      startupWmClass: "",
      builderAppId: "",
      builderProductName: "",
      builderLinuxExecutableName: "",
      builderDesktopName: "",
      builderDesktopStartupWmClass: "",
      appIdMatchesBuilder: false,
      appNameMatchesProductName: false,
      executableNameMatchesAppName: false,
      desktopNameMatchesAppName: false,
      startupWmClassMatchesDesktopEntry: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function collectReleaseWorkflowConfiguration({
  workflowPath = DEFAULT_RELEASE_WORKFLOW_PATH
} = {}) {
  if (!existsSync(workflowPath)) {
    return {
      workflowPath,
      status: "missing",
      hasLinuxPublicGateCommand: false,
      linuxPublicGateBeforePublish: false,
      linuxPublicUploadsAllowed: false,
      linuxPublicPublishingGated: false,
      error: "release workflow not found"
    };
  }

  try {
    const workflowText = readFileSync(workflowPath, "utf8");
    const hasLinuxPublicGateCommand =
      /\bnode\s+scripts\/release-check-linux\.mjs\b/.test(workflowText);
    const linuxPublicGateBeforePublish =
      workflowRunsLinuxPublicGateBeforeReleasePublish(workflowText);
    const linuxPublicUploadsAllowed =
      workflowAllowsLinuxPublicUploads(workflowText);

    return {
      workflowPath,
      status: "read",
      hasLinuxPublicGateCommand,
      linuxPublicGateBeforePublish,
      linuxPublicUploadsAllowed,
      linuxPublicPublishingGated:
        hasLinuxPublicGateCommand &&
        linuxPublicGateBeforePublish &&
        !linuxPublicUploadsAllowed,
      error: ""
    };
  } catch (error) {
    return {
      workflowPath,
      status: "error",
      hasLinuxPublicGateCommand: false,
      linuxPublicGateBeforePublish: false,
      linuxPublicUploadsAllowed: false,
      linuxPublicPublishingGated: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function listFilesRecursive(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listFilesRecursive(entryPath);
    }
    if (!entry.isFile()) {
      return [];
    }
    return [entryPath];
  });
}

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 5000,
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
    ...options.spawnOptions
  });

  return {
    command,
    args,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? String(result.error.message) : ""
  };
}

export function resolveCommandPath(command, runner = runCommand) {
  const result = runner("sh", ["-lc", `command -v ${shellQuote(command)}`], {
    timeoutMs: 3000
  });
  if (result.status !== 0) {
    return "";
  }

  return result.stdout.trim().split(/\r?\n/)[0] ?? "";
}

export function collectCommandAvailability(commands, runner = runCommand) {
  return commands.map((command) => {
    const resolvedPath = resolveCommandPath(command, runner);
    return {
      command,
      path: resolvedPath,
      available: resolvedPath.length > 0
    };
  });
}

export function collectShellPathSnapshot({ env = process.env } = {}) {
  const homeDir = resolveEvidenceHomeDir(env);
  const pathValue = env.PATH ?? "";
  const pathSegments = pathValue.split(path.delimiter).filter(Boolean);
  const nvmDir =
    nonBlankAbsolutePath(env.NVM_DIR) || path.join(homeDir, ".nvm");
  const pyenvRoot =
    nonBlankAbsolutePath(env.PYENV_ROOT) || path.join(homeDir, ".pyenv");
  const cargoHome =
    nonBlankAbsolutePath(env.CARGO_HOME) || path.join(homeDir, ".cargo");
  const expectedPathSegments = [
    {
      label: "~/.local/bin",
      path: path.join(homeDir, ".local", "bin"),
      present: pathHasExactSegment(
        pathSegments,
        path.join(homeDir, ".local", "bin")
      )
    },
    {
      label: "cargo bin",
      path: path.join(cargoHome, "bin"),
      present: pathHasExactSegment(pathSegments, path.join(cargoHome, "bin"))
    },
    {
      label: "pyenv bin",
      path: path.join(pyenvRoot, "bin"),
      present: pathHasExactSegment(pathSegments, path.join(pyenvRoot, "bin"))
    },
    {
      label: "pyenv shims",
      path: path.join(pyenvRoot, "shims"),
      present: pathHasExactSegment(pathSegments, path.join(pyenvRoot, "shims"))
    },
    {
      label: "nvm-managed bin",
      path: nvmDir,
      present: pathHasPrefixSegment(pathSegments, nvmDir)
    }
  ];

  return {
    env: Object.fromEntries(
      SHELL_PATH_ENV_KEYS.map((key) => [key, env[key] ?? ""])
    ),
    pathSegments,
    expectedPathSegments
  };
}

function normalizePathSegment(value) {
  return String(value).replace(/\/+$/u, "");
}

function pathHasExactSegment(pathSegments, expectedPath) {
  const normalizedExpected = normalizePathSegment(expectedPath);
  return pathSegments.some(
    (segment) => normalizePathSegment(segment) === normalizedExpected
  );
}

function pathHasPrefixSegment(pathSegments, expectedPrefix) {
  const normalizedPrefix = normalizePathSegment(expectedPrefix);
  return pathSegments.some((segment) => {
    const normalizedSegment = normalizePathSegment(segment);
    return (
      normalizedSegment === normalizedPrefix ||
      normalizedSegment.startsWith(`${normalizedPrefix}${path.sep}`)
    );
  });
}

export function collectAgentStorageSnapshot({
  env = process.env,
  homeDir,
  storagePaths = AGENT_STORAGE_PATHS
} = {}) {
  const resolvedHomeDir = resolveEvidenceHomeDir(env, homeDir);
  return {
    homeDir: resolvedHomeDir,
    entries: storagePaths.map((storagePath) =>
      describeStoragePath({
        homeDir: resolvedHomeDir,
        provider: storagePath.provider,
        label: storagePath.label,
        relativePath: storagePath.relativePath
      })
    )
  };
}

function describeStoragePath({ homeDir, provider, label, relativePath }) {
  const absolutePath = path.join(homeDir, ...relativePath);
  if (!existsSync(absolutePath)) {
    return {
      provider,
      label,
      path: absolutePath,
      status: "missing",
      entryCount: null
    };
  }

  try {
    const stats = statSync(absolutePath);
    const status = stats.isDirectory()
      ? "directory"
      : stats.isFile()
        ? "file"
        : "other";
    return {
      provider,
      label,
      path: absolutePath,
      status,
      entryCount:
        status === "directory" ? readdirSync(absolutePath).length : null
    };
  } catch (error) {
    return {
      provider,
      label,
      path: absolutePath,
      status: "error",
      entryCount: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function parseDesktopEntrySubset(source = "") {
  const values = Object.fromEntries(
    DESKTOP_ENTRY_IDENTITY_FIELDS.map((key) => [key, ""])
  );
  const wantedKeys = new Set(DESKTOP_ENTRY_IDENTITY_FIELDS);
  let section = "";

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const sectionMatch = line.match(/^\[([^\]]+)\]$/u);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      continue;
    }

    if (section !== "Desktop Entry") {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex);
    if (wantedKeys.has(key)) {
      values[key] = line.slice(separatorIndex + 1).trim();
    }
  }

  return values;
}

export function collectDesktopIntegrationSnapshot({
  env = process.env,
  homeDir,
  desktopEntryId = DESKTOP_ENTRY_ID,
  runner = runCommand
} = {}) {
  const resolvedHomeDir = resolveEvidenceHomeDir(env, homeDir);
  const dataHome =
    nonBlankAbsolutePath(env.XDG_DATA_HOME) ||
    path.join(resolvedHomeDir, ".local", "share");
  const explicitDataDirs =
    typeof env.XDG_DATA_DIRS === "string" && env.XDG_DATA_DIRS.trim()
      ? env.XDG_DATA_DIRS.split(path.delimiter)
          .map((entry) => nonBlankAbsolutePath(entry))
          .filter(Boolean)
      : [];
  const dataDirs =
    explicitDataDirs.length > 0 ? explicitDataDirs : DEFAULT_XDG_DATA_DIRS;
  const applicationRoots = uniqueStrings(
    [dataHome, ...dataDirs].map((root) => path.join(root, "applications"))
  );
  const exactCandidates = applicationRoots.map((root) =>
    path.join(root, desktopEntryId)
  );
  const discoveredCandidates = applicationRoots.flatMap((root) =>
    discoverDesktopEntryCandidates(root, desktopEntryId)
  );
  const applicationEntryCandidates = uniqueStrings([
    ...exactCandidates,
    ...discoveredCandidates
  ]).map((desktopEntryPath) => describeDesktopEntryPath(desktopEntryPath));

  return {
    env: Object.fromEntries(
      DESKTOP_INTEGRATION_ENV_KEYS.map((key) => [key, env[key] ?? ""])
    ),
    notificationProbes: NOTIFICATION_DBUS_PROBES.map((probe) =>
      collectCommandProbe({
        label: probe.label,
        command: probe.command,
        args: probe.args,
        runner,
        skipReason: env.DBUS_SESSION_BUS_ADDRESS
          ? ""
          : "DBUS_SESSION_BUS_ADDRESS is unset"
      })
    ),
    applicationEntryCandidates
  };
}

function resolveEvidenceHomeDir(env, homeDir) {
  return (
    nonBlankAbsolutePath(homeDir) ||
    nonBlankAbsolutePath(env.HOME) ||
    os.homedir()
  );
}

function nonBlankAbsolutePath(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return trimmed && path.isAbsolute(trimmed) ? trimmed : "";
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

function discoverDesktopEntryCandidates(applicationsRoot, desktopEntryId) {
  const desktopEntryStem = path
    .basename(desktopEntryId, ".desktop")
    .toLowerCase();
  try {
    if (
      !existsSync(applicationsRoot) ||
      !statSync(applicationsRoot).isDirectory()
    ) {
      return [];
    }

    return readdirSync(applicationsRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => {
        const normalizedName = name.toLowerCase();
        return (
          normalizedName.endsWith(".desktop") &&
          normalizedName.includes(desktopEntryStem)
        );
      })
      .map((name) => path.join(applicationsRoot, name));
  } catch {
    return [];
  }
}

function describeDesktopEntryPath(desktopEntryPath) {
  try {
    if (!existsSync(desktopEntryPath)) {
      return {
        path: desktopEntryPath,
        status: "missing"
      };
    }

    const stats = statSync(desktopEntryPath);
    if (!stats.isFile()) {
      return {
        path: desktopEntryPath,
        status: stats.isDirectory() ? "directory" : "other"
      };
    }

    const source = readFileSync(desktopEntryPath, "utf8");
    return {
      path: desktopEntryPath,
      status: "file",
      sizeBytes: stats.size,
      desktopEntry: parseDesktopEntrySubset(source)
    };
  } catch (error) {
    return {
      path: desktopEntryPath,
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function collectDesktopShellSnapshot({
  env = process.env,
  runner = runCommand
} = {}) {
  const gnomeSkipReason = isGnomeDesktopEnv(env)
    ? ""
    : "GNOME desktop env is not detected";
  return {
    env: Object.fromEntries(
      DESKTOP_SHELL_ENV_KEYS.map((key) => [key, env[key] ?? ""])
    ),
    probes: [
      collectLoginctlSessionProbe({ env, runner }),
      collectCommandProbe({
        label: "GNOME Shell version",
        command: "gnome-shell",
        args: ["--version"],
        runner,
        skipReason: gnomeSkipReason
      }),
      ...GNOME_SETTINGS_PROBES.map((probe) =>
        collectCommandProbe({
          label: probe.label,
          command: "gsettings",
          args: ["get", probe.schema, probe.key],
          runner,
          skipReason: gnomeSkipReason
        })
      ),
      collectCommandProbe({
        label: "X11 display query",
        command: "xrandr",
        args: ["--query"],
        runner,
        skipReason: env.DISPLAY ? "" : "DISPLAY is unset",
        maxLines: 8
      }),
      collectCommandProbe({
        label: "X11 display info",
        command: "xdpyinfo",
        args: [],
        runner,
        skipReason: env.DISPLAY ? "" : "DISPLAY is unset",
        maxLines: 8
      }),
      collectCommandProbe({
        label: "X11 window manager root properties",
        command: "xprop",
        args: [
          "-root",
          "_NET_SUPPORTING_WM_CHECK",
          "_NET_ACTIVE_WINDOW",
          "_NET_CLIENT_LIST"
        ],
        runner,
        skipReason: env.DISPLAY ? "" : "DISPLAY is unset",
        maxLines: 8
      }),
      collectCommandProbe({
        label: "Wayland display info",
        command: "wayland-info",
        args: [],
        runner,
        skipReason: env.WAYLAND_DISPLAY ? "" : "WAYLAND_DISPLAY is unset",
        maxLines: 10
      }),
      collectCommandProbe({
        label: "OpenGL renderer info",
        command: "glxinfo",
        args: ["-B"],
        runner,
        skipReason: hasDesktopDisplay(env)
          ? ""
          : "DISPLAY and WAYLAND_DISPLAY are unset",
        maxLines: 10
      }),
      collectCommandProbe({
        label: "Vulkan device summary",
        command: "vulkaninfo",
        args: ["--summary"],
        runner,
        skipReason: hasDesktopDisplay(env)
          ? ""
          : "DISPLAY and WAYLAND_DISPLAY are unset",
        maxLines: 10
      })
    ]
  };
}

function hasDesktopDisplay(env) {
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export function collectImeSnapshot({
  env = process.env,
  runner = runCommand
} = {}) {
  return {
    env: Object.fromEntries(IME_ENV_KEYS.map((key) => [key, env[key] ?? ""])),
    probes: IME_PROBES.map((probe) =>
      collectCommandProbe({
        label: probe.label,
        command: probe.command,
        args: probe.args,
        runner,
        maxLines: 4
      })
    )
  };
}

function isGnomeDesktopEnv(env) {
  const desktopValues = [
    env.XDG_CURRENT_DESKTOP,
    env.XDG_SESSION_DESKTOP,
    env.DESKTOP_SESSION,
    env.GDMSESSION
  ];
  return desktopValues
    .filter((value) => typeof value === "string")
    .some((value) => /\b(?:gnome|ubuntu)\b/i.test(value));
}

function collectLoginctlSessionProbe({ env, runner }) {
  const sessionId = env.XDG_SESSION_ID ?? "";
  const sessionArg = sessionId || "<XDG_SESSION_ID>";
  return collectCommandProbe({
    label: "loginctl session",
    command: "loginctl",
    args: [
      "show-session",
      sessionArg,
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
    ],
    runner,
    skipReason: sessionId ? "" : "XDG_SESSION_ID is unset"
  });
}

function collectCommandProbe({
  label,
  command,
  args,
  runner,
  skipReason = "",
  maxLines = 6
}) {
  if (skipReason) {
    return {
      label,
      command,
      args,
      skipped: true,
      reason: skipReason,
      status: null,
      signal: null,
      error: "",
      sample: ""
    };
  }

  const result = runner(command, args, {
    timeoutMs: 5000,
    maxBuffer: 128 * 1024
  });
  return {
    label,
    command,
    args,
    skipped: false,
    reason: "",
    status: result.status,
    signal: result.signal,
    error: result.error,
    sample: summarizeCommandOutput(result, maxLines)
  };
}

export function summarizeCommandOutput(result, maxLines = 6) {
  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!output) {
    return "";
  }

  return output.split(/\r?\n/).slice(0, maxLines).join("\n");
}

export function parsePsProcessTable(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/u))
    .filter((match) => Boolean(match))
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      commandLine: match[3]?.trim() ?? ""
    }))
    .filter(
      (entry) =>
        Number.isFinite(entry.pid) &&
        entry.pid > 0 &&
        Number.isFinite(entry.parentPid) &&
        entry.parentPid >= 0 &&
        entry.commandLine.length > 0
    );
}

export function collectSystemSamples(runner = runCommand) {
  const psSample = runner("ps", ["-axo", "pid=,ppid=,command="], {
    timeoutMs: 5000,
    maxBuffer: 512 * 1024
  });
  const lsofSample = runner("lsof", ["-Pan", "-iTCP", "-sTCP:LISTEN"], {
    timeoutMs: 5000,
    maxBuffer: 512 * 1024
  });
  const fontSample = runner("fc-list", ["--format", "%{family}\n"], {
    timeoutMs: 5000,
    maxBuffer: 512 * 1024
  });

  const fontFamilies =
    fontSample.status === 0
      ? new Set(
          fontSample.stdout
            .split(/\r?\n/)
            .flatMap((line) => line.split(","))
            .map((family) => family.trim())
            .filter(Boolean)
        ).size
      : 0;
  const psRows =
    psSample.status === 0 ? parsePsProcessTable(psSample.stdout) : [];
  let psParseStatus = "unavailable";
  if (psSample.status === 0) {
    psParseStatus = psRows.length > 0 ? "parsed" : "empty";
  }

  return {
    ps: {
      status: psSample.status,
      parseStatus: psParseStatus,
      parsedRows: psRows.length,
      sample: summarizeCommandOutput(psSample, 8)
    },
    lsof: {
      status: lsofSample.status,
      sample: summarizeCommandOutput(lsofSample, 8)
    },
    fontFamilies,
    fontStatus: fontSample.status,
    fontSample: summarizeCommandOutput(fontSample, 8)
  };
}

export function collectSandboxSnapshot({
  env = process.env,
  procRoot = "/proc"
} = {}) {
  return {
    appImageEnv: Object.fromEntries(
      APPIMAGE_SANDBOX_ENV_KEYS.map((key) => [key, env[key] ?? ""])
    ),
    linuxUserNamespace: collectProcSettings(
      LINUX_SANDBOX_PROC_SETTINGS,
      procRoot
    )
  };
}

export function collectWatchSnapshot({ procRoot = "/proc" } = {}) {
  return {
    inotify: collectProcSettings(LINUX_INOTIFY_PROC_SETTINGS, procRoot)
  };
}

function collectProcSettings(settings, procRoot) {
  return settings.map((setting) => {
    const settingPath = path.join(procRoot, setting.relativePath);
    if (!existsSync(settingPath)) {
      return {
        key: setting.key,
        path: settingPath,
        status: "missing",
        value: ""
      };
    }

    try {
      return {
        key: setting.key,
        path: settingPath,
        status: "read",
        value: readFileSync(settingPath, "utf8").trim()
      };
    } catch (error) {
      return {
        key: setting.key,
        path: settingPath,
        status: "error",
        value: error instanceof Error ? error.message : String(error)
      };
    }
  });
}

export function collectGitProvenance(runner = runCommand) {
  const commitResult = runner("git", ["rev-parse", "--short", "HEAD"], {
    timeoutMs: 3000
  });
  const statusResult = runner("git", linuxReleaseSourceStatusArgs(), {
    timeoutMs: 3000,
    maxBuffer: 256 * 1024
  });
  const statusLines =
    statusResult.status === 0
      ? statusResult.stdout.split(/\r?\n/).filter(Boolean)
      : [];

  return {
    commit:
      commitResult.status === 0 && commitResult.stdout.trim()
        ? commitResult.stdout.trim()
        : "unknown",
    dirty: statusResult.status === 0 ? statusLines.length > 0 : null,
    statusScope:
      "source worktree, ignoring generated release artifact directories",
    statusIgnoredPaths: RELEASE_BUILD_OUTPUT_STATUS_EXCLUDES,
    statusEntryCount: statusLines.length,
    statusSample: statusLines.slice(0, 20).join("\n"),
    statusError:
      statusResult.status === 0
        ? ""
        : summarizeCommandOutput(statusResult, 4) || statusResult.error
  };
}

function formatKeyValueMap(values) {
  return Object.entries(values)
    .map(([key, value]) => `- ${key}: ${value || "<unset>"}`)
    .join("\n");
}

function formatAvailability(entries) {
  return entries
    .map(
      (entry) =>
        `- ${entry.command}: ${entry.available ? entry.path : "not found"}`
    )
    .join("\n");
}

function formatShellPathSnapshot(snapshot) {
  const envRows = formatKeyValueMap(snapshot.env ?? {});
  const markerRows =
    snapshot.expectedPathSegments?.length > 0
      ? snapshot.expectedPathSegments
          .map(
            (entry) =>
              `- ${entry.label}: ${entry.present ? "present" : "missing"} (${entry.path})`
          )
          .join("\n")
      : "- <no PATH marker checks recorded>";
  const pathSegmentRows =
    snapshot.pathSegments?.length > 0
      ? snapshot.pathSegments.join("\n")
      : "<empty PATH>";

  return [
    "Shell/PATH env:",
    "",
    envRows || "- <none>",
    "",
    "Expected PATH markers:",
    "",
    markerRows,
    "",
    "PATH entries:",
    "",
    "```text",
    pathSegmentRows,
    "```"
  ].join("\n");
}

function formatAgentStorageSnapshot(snapshot) {
  const grouped = new Map();
  for (const entry of snapshot.entries ?? []) {
    const entries = grouped.get(entry.provider) ?? [];
    entries.push(entry);
    grouped.set(entry.provider, entries);
  }

  const lines = [`- HOME: ${snapshot.homeDir || "<unknown>"}`];
  for (const [provider, entries] of grouped.entries()) {
    lines.push("", `### ${provider}`);
    for (const entry of entries) {
      const count =
        typeof entry.entryCount === "number"
          ? `, entries=${entry.entryCount}`
          : "";
      const error = entry.error ? `, error=${entry.error}` : "";
      lines.push(
        `- ${entry.label}: ${entry.status} (${entry.path})${count}${error}`
      );
    }
  }

  return lines.join("\n");
}

function formatDesktopIntegrationSnapshot(snapshot) {
  const envRows = formatKeyValueMap(snapshot.env ?? {});
  const notificationProbeRows =
    snapshot.notificationProbes?.length > 0
      ? snapshot.notificationProbes
          .map((probe) => formatCommandProbe(probe))
          .join("\n\n")
      : "- <no notification DBus probes recorded>";
  const candidateRows =
    snapshot.applicationEntryCandidates?.length > 0
      ? snapshot.applicationEntryCandidates
          .map((candidate) => {
            const details =
              candidate.status === "file"
                ? DESKTOP_ENTRY_IDENTITY_FIELDS.map(
                    (field) =>
                      `${field}=${candidate.desktopEntry?.[field] || "<missing>"}`
                  ).join(", ")
                : candidate.error
                  ? `error=${candidate.error}`
                  : "";
            const size =
              typeof candidate.sizeBytes === "number"
                ? `, ${candidate.sizeBytes} bytes`
                : "";
            return `- ${candidate.path}: ${candidate.status}${size}${details ? `, ${details}` : ""}`;
          })
          .join("\n")
      : "- <no desktop entry candidates recorded>";

  return [
    "Desktop integration env:",
    "",
    envRows || "- <none>",
    "",
    "Notification DBus probes:",
    "",
    notificationProbeRows,
    "",
    "Installed desktop entry candidates:",
    "",
    candidateRows
  ].join("\n");
}

function formatDesktopShellSnapshot(snapshot) {
  const envRows = formatKeyValueMap(snapshot.env ?? {});
  const probeRows =
    snapshot.probes?.length > 0
      ? snapshot.probes.map((probe) => formatCommandProbe(probe)).join("\n\n")
      : "- <no desktop shell probes recorded>";

  return [
    "Desktop shell/display env:",
    "",
    envRows || "- <none>",
    "",
    "Command probes:",
    "",
    probeRows
  ].join("\n");
}

function formatImeSnapshot(snapshot) {
  const envRows = formatKeyValueMap(snapshot.env ?? {});
  const probeRows =
    snapshot.probes?.length > 0
      ? snapshot.probes.map((probe) => formatCommandProbe(probe)).join("\n\n")
      : "- <no IME/input-method probes recorded>";

  return [
    "IME/input-method env:",
    "",
    envRows || "- <none>",
    "",
    "Command probes:",
    "",
    probeRows
  ].join("\n");
}

function resolveImeSnapshot(data) {
  return (
    data.ime ?? {
      env: data.environment?.ime ?? {},
      probes: []
    }
  );
}

function formatCommandProbe(probe) {
  const commandLine = probe.command
    ? [probe.command, ...(probe.args ?? [])].join(" ")
    : "<unknown>";
  const lines = [
    `### ${probe.label || "<unnamed probe>"}`,
    "",
    `- command: ${commandLine}`,
    `- status: ${
      probe.skipped ? `skipped (${probe.reason || "no reason recorded"})` : (probe.status ?? "unknown")
    }`
  ];

  if (probe.signal) {
    lines.push(`- signal: ${probe.signal}`);
  }
  if (probe.error) {
    lines.push(`- error: ${probe.error}`);
  }

  lines.push(
    "",
    "```text",
    probe.sample || "<no sample>",
    "```"
  );

  return lines.join("\n");
}

function formatSandboxSnapshot(snapshot) {
  const appImageEnv = formatKeyValueMap(snapshot.appImageEnv ?? {});
  const namespaceRows =
    snapshot.linuxUserNamespace?.length > 0
      ? snapshot.linuxUserNamespace
          .map(
            (setting) =>
              `- ${setting.key}: ${setting.status} (${setting.path}) => ${setting.value || "<empty>"}`
          )
          .join("\n")
      : "- <no Linux user namespace settings recorded>";

  return [
    "AppImage and sandbox env:",
    "",
    appImageEnv || "- <none>",
    "",
    "Linux user namespace settings:",
    "",
    namespaceRows
  ].join("\n");
}

function formatWatchSnapshot(snapshot) {
  const inotifyRows =
    snapshot.inotify?.length > 0
      ? snapshot.inotify
          .map(
            (setting) =>
              `- ${setting.key}: ${setting.status} (${setting.path}) => ${setting.value || "<empty>"}`
          )
          .join("\n")
      : "- <no Linux inotify settings recorded>";

  return ["Linux inotify settings:", "", inotifyRows].join("\n");
}

function formatArtifacts(artifacts) {
  if (artifacts.length === 0) {
    return "- No AppImage, Linux package artifact, or Linux update metadata found in release roots.";
  }

  return artifacts
    .map((artifact) => `- ${artifact.path} (${artifact.sizeBytes} bytes)`)
    .join("\n");
}

function formatPackagingConfiguration(packaging = {}) {
  return [
    `- root package:linux: ${packaging.rootPackageLinuxScript || "<missing>"}`,
    `- root release:check:linux: ${packaging.rootReleaseCheckLinuxScript || "<missing>"}`,
    `- desktop dist:linux: ${packaging.desktopDistLinuxScript || "<missing>"}`,
    `- root package:linux uses dist:linux: ${packaging.rootPackageUsesDistLinux ? "yes" : "no"}`,
    `- desktop dist:linux uses --publish never: ${packaging.desktopDistLinuxUsesPublishNever ? "yes" : "no"}`,
    `- electron-builder publish provider: ${packaging.publishProvider || "<missing>"}`,
    `- electron-builder publish owner/repo: ${packaging.publishOwner || "<missing>"}/${packaging.publishRepo || "<missing>"}`,
    `- electron-builder publish releaseType: ${packaging.publishReleaseType || "<missing>"}`,
    `- electron-builder linux target: ${
      packaging.linuxTarget?.length > 0
        ? packaging.linuxTarget.join(", ")
        : "<missing>"
    }`,
    `- electron-builder linux artifactName: ${packaging.linuxArtifactName || "<missing>"}`,
    `- electron-builder linux executableName: ${packaging.linuxExecutableName || "<missing>"}`
  ].join("\n");
}

function formatRuntimeIdentityConfiguration(identity = {}) {
  return [
    `- runtime identity status: ${identity.status || "unknown"}`,
    `- app identity source: ${identity.appIdentityPath || "<missing>"}`,
    `- electron-builder config: ${identity.builderConfigPath || "<missing>"}`,
    `- runtime app id: ${identity.appId || "<missing>"}`,
    `- electron-builder appId: ${identity.builderAppId || "<missing>"}`,
    `- app id matches builder appId: ${identity.appIdMatchesBuilder ? "yes" : "no"}`,
    `- runtime app name: ${identity.appName || "<missing>"}`,
    `- electron-builder productName: ${identity.builderProductName || "<missing>"}`,
    `- productName matches runtime app name: ${identity.appNameMatchesProductName ? "yes" : "no"}`,
    `- electron-builder linux executableName: ${identity.builderLinuxExecutableName || "<missing>"}`,
    `- linux executableName matches runtime app name: ${identity.executableNameMatchesAppName ? "yes" : "no"}`,
    `- electron-builder desktop Name: ${identity.builderDesktopName || "<missing>"}`,
    `- desktop Name matches runtime app name: ${identity.desktopNameMatchesAppName ? "yes" : "no"}`,
    `- runtime StartupWMClass: ${identity.startupWmClass || "<missing>"}`,
    `- electron-builder desktop StartupWMClass: ${identity.builderDesktopStartupWmClass || "<missing>"}`,
    `- StartupWMClass matches desktop entry: ${identity.startupWmClassMatchesDesktopEntry ? "yes" : "no"}`,
    `- runtime identity error: ${identity.error || "<none>"}`
  ].join("\n");
}

function formatReleaseWorkflowConfiguration(workflow = {}) {
  return [
    `- release workflow path: ${workflow.workflowPath || "<missing>"}`,
    `- release workflow status: ${workflow.status || "unknown"}`,
    `- Linux public gate command present: ${workflow.hasLinuxPublicGateCommand ? "yes" : "no"}`,
    `- Linux public gate runs before publishing: ${workflow.linuxPublicGateBeforePublish ? "yes" : "no"}`,
    `- workflow appears to upload Linux public artifacts while gated: ${workflow.linuxPublicUploadsAllowed ? "yes" : "no"}`,
    `- Linux public publishing gated in workflow: ${workflow.linuxPublicPublishingGated ? "yes" : "no"}`,
    `- release workflow error: ${workflow.error || "<none>"}`
  ].join("\n");
}

function selectLinuxAppImageArtifact(artifacts, preferredArch = process.arch) {
  const appImageArtifacts = artifacts.filter((artifact) =>
    isKmuxLinuxAppImagePath(artifact.path)
  );
  const selectedPath = selectLinuxAppImagePath(
    appImageArtifacts.map((artifact) => artifact.path),
    preferredArch
  );
  return appImageArtifacts.find((artifact) => artifact.path === selectedPath);
}

function selectLinuxUpdateMetadataArtifact(artifacts, appImage) {
  const metadataArtifacts = artifacts.filter((artifact) =>
    isLinuxUpdateMetadataName(artifact.name)
  );
  const metadataCandidates = new Set(
    linuxUpdateMetadataCandidates(appImage?.path)
  );
  const sameDirectoryMetadata = appImage
    ? metadataArtifacts.filter(
        (artifact) => path.dirname(artifact.path) === path.dirname(appImage.path)
      )
    : [];

  return (
    sameDirectoryMetadata.find((artifact) =>
      metadataCandidates.has(artifact.name)
    ) ??
    metadataArtifacts.find((artifact) =>
      metadataCandidates.has(artifact.name)
    ) ??
    sameDirectoryMetadata[0] ??
    metadataArtifacts[0]
  );
}

export function summarizeLinuxUpdateMetadata(
  metadataPath,
  { appImagePath } = {}
) {
  if (!metadataPath) {
    return {
      status: "missing",
      path: "",
      error: "latest-linux.yml not found in release roots"
    };
  }

  try {
    const metadata = yaml.load(readFileSync(metadataPath, "utf8"));
    if (!isRecord(metadata)) {
      throw new Error("metadata is not a YAML object");
    }

    const files = Array.isArray(metadata.files) ? metadata.files : [];
    const selectedAppImageName = appImagePath ? path.basename(appImagePath) : "";
    const metadataFileName = path.basename(metadataPath);
    const expectedMetadataNames = appImagePath
      ? expectedLinuxUpdateMetadataNames(appImagePath)
      : [];
    const metadataColocatedWithAppImage =
      appImagePath && metadataPath
        ? path.dirname(metadataPath) === path.dirname(appImagePath)
        : null;
    const updatePath = typeof metadata.path === "string" ? metadata.path : "";
    const updatePathName = updatePath ? path.basename(updatePath) : "";
    const appImageFileEntries = files.filter((file) => {
      if (!isRecord(file)) {
        return false;
      }
      const filePath = typeof file.url === "string" ? file.url : file.path;
      return typeof filePath === "string" && filePath.endsWith(".AppImage");
    });
    const appImageFile =
      appImageFileEntries.find((file) => {
        const filePath = typeof file.url === "string" ? file.url : file.path;
        return (
          selectedAppImageName.length > 0 &&
          path.basename(filePath) === selectedAppImageName
        );
      }) ??
      appImageFileEntries.find((file) => {
        const filePath = typeof file.url === "string" ? file.url : file.path;
        return (
          updatePathName.length > 0 &&
          path.basename(filePath) === updatePathName
        );
      }) ??
      appImageFileEntries[0];
    const appImageFilePath = isRecord(appImageFile)
      ? (appImageFile.url ?? appImageFile.path ?? "")
      : "";
    const appImageFileName =
      typeof appImageFilePath === "string" && appImageFilePath.length > 0
        ? path.basename(appImageFilePath)
        : "";
    const appImageFileChecksum =
      isRecord(appImageFile) && typeof appImageFile.sha512 === "string"
        ? appImageFile.sha512
        : "";
    const appImageFileSize =
      isRecord(appImageFile) && typeof appImageFile.size === "number"
        ? appImageFile.size
        : undefined;
    const actualAppImageSize =
      appImagePath && existsSync(appImagePath)
        ? statSync(appImagePath).size
        : undefined;
    const actualAppImageSha512 =
      appImagePath && existsSync(appImagePath)
        ? calculateFileSha512(appImagePath)
        : "";
    const topLevelChecksum =
      typeof metadata.sha512 === "string" ? metadata.sha512 : "";

    return {
      status: "parsed",
      path: metadataPath,
      metadataFileName,
      expectedMetadataNames,
      metadataNameMatchesAppImage:
        expectedMetadataNames.length > 0
          ? expectedMetadataNames.includes(metadataFileName)
          : null,
      metadataColocatedWithAppImage,
      version: typeof metadata.version === "string" ? metadata.version : "",
      updatePath,
      fileCount: files.length,
      appImageFilePath:
        typeof appImageFilePath === "string" ? appImageFilePath : "",
      updatePathMatchesAppImage:
        selectedAppImageName.length > 0 && updatePathName.length > 0
          ? updatePathName === selectedAppImageName
          : null,
      fileEntryMatchesUpdatePath:
        appImageFileName.length > 0 && updatePathName.length > 0
          ? appImageFileName === updatePathName
          : null,
      fileEntryMatchesAppImage:
        appImageFileName.length > 0 && selectedAppImageName.length > 0
          ? appImageFileName === selectedAppImageName
          : null,
      hasTopLevelSha512: topLevelChecksum.length > 0,
      topLevelSha512: topLevelChecksum,
      hasAppImageFileSha512: appImageFileChecksum.length > 0,
      appImageFileSha512: appImageFileChecksum,
      checksumMatches:
        topLevelChecksum.length > 0 &&
        appImageFileChecksum.length > 0 &&
        topLevelChecksum === appImageFileChecksum,
      hasActualAppImageSha512: actualAppImageSha512.length > 0,
      actualAppImageSha512,
      appImageSha512MatchesActual:
        appImageFileChecksum.length > 0 &&
        actualAppImageSha512.length > 0
          ? appImageFileChecksum === actualAppImageSha512
          : null,
      hasAppImageFileSize: typeof appImageFileSize === "number",
      appImageFileSize:
        typeof appImageFileSize === "number" ? appImageFileSize : null,
      actualAppImageSize:
        typeof actualAppImageSize === "number" ? actualAppImageSize : null,
      sizeMatches:
        typeof appImageFileSize === "number" &&
        typeof actualAppImageSize === "number"
          ? appImageFileSize === actualAppImageSize
          : null
    };
  } catch (error) {
    return {
      status: "error",
      path: metadataPath,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function collectAppImageIdentity(
  appImagePath,
  identityExtractor = extractAppImageDesktopIdentity
) {
  if (!appImagePath) {
    return {
      status: "missing",
      appImagePath: "",
      error: "AppImage not found in release roots"
    };
  }

  try {
    const identity = identityExtractor({ appImagePath });
    if (!isRecord(identity)) {
      throw new Error("identity extractor did not return an object");
    }
    const rawDesktopEntry = identity.desktopEntry;
    const desktopEntry =
      isRecord(rawDesktopEntry) && isRecord(rawDesktopEntry["Desktop Entry"])
        ? rawDesktopEntry["Desktop Entry"]
        : rawDesktopEntry;
    if (!isRecord(desktopEntry)) {
      throw new Error("extracted desktop entry is not an object");
    }
    return {
      status: "extracted",
      appImagePath,
      desktopEntry: {
        Name: desktopEntry?.Name ?? "",
        Icon: desktopEntry?.Icon ?? "",
        Categories: desktopEntry?.Categories ?? "",
        StartupWMClass: desktopEntry?.StartupWMClass ?? "",
        StartupNotify: desktopEntry?.StartupNotify ?? "",
        Terminal: desktopEntry?.Terminal ?? ""
      },
      notificationIconResourcePath: identity.notificationIconResourcePath ?? ""
    };
  } catch (error) {
    return {
      status: "error",
      appImagePath,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function collectPackagedArtifactDiagnostics({
  artifacts,
  identityExtractor = extractAppImageDesktopIdentity,
  preferredArch = process.arch
}) {
  const appImage = selectLinuxAppImageArtifact(artifacts, preferredArch);
  const metadata = selectLinuxUpdateMetadataArtifact(artifacts, appImage);

  return {
    selectedAppImagePath: appImage?.path ?? "",
    selectedAppImageBlockmap: describeAppImageBlockmap(appImage?.path ?? ""),
    selectedMetadataPath: metadata?.path ?? "",
    updateMetadata: summarizeLinuxUpdateMetadata(metadata?.path, {
      appImagePath: appImage?.path
    }),
    appImageIdentity: collectAppImageIdentity(appImage?.path, identityExtractor)
  };
}

function formatAppImageBlockmapForReport(blockmap) {
  if (blockmap?.status === "present") {
    return `${blockmap.path} (${blockmap.sizeBytes} bytes)`;
  }
  if (blockmap?.path) {
    return `<${blockmap.status}> (${blockmap.path})`;
  }
  return "<missing>";
}

function formatUpdateMetadataSummary(summary) {
  const formatCheck = (value) =>
    typeof value === "boolean" ? (value ? "yes" : "no") : "not checked";
  const lines = [
    `- metadata status: ${summary.status}`,
    `- metadata path: ${summary.path || "<missing>"}`
  ];
  if (summary.status === "parsed") {
    lines.push(
      `- metadata filename: ${summary.metadataFileName || "<missing>"}`,
      `- expected metadata filename: ${summary.expectedMetadataNames?.join(" or ") || "<not checked>"}`,
      `- metadata filename matches selected AppImage: ${formatCheck(summary.metadataNameMatchesAppImage)}`,
      `- metadata colocated with selected AppImage: ${formatCheck(summary.metadataColocatedWithAppImage)}`,
      `- channel naming match: ${formatCheck(summary.metadataNameMatchesAppImage)}`,
      `- version: ${summary.version || "<missing>"}`,
      `- update path: ${summary.updatePath || "<missing>"}`,
      `- file entries: ${summary.fileCount}`,
      `- AppImage file entry: ${summary.appImageFilePath || "<missing>"}`,
      `- update path matches selected AppImage: ${formatCheck(summary.updatePathMatchesAppImage)}`,
      `- file entry matches update path: ${formatCheck(summary.fileEntryMatchesUpdatePath)}`,
      `- file entry matches selected AppImage: ${formatCheck(summary.fileEntryMatchesAppImage)}`,
      `- top-level sha512 present: ${summary.hasTopLevelSha512 ? "yes" : "no"}`,
      `- top-level sha512: ${summary.topLevelSha512 || "<missing>"}`,
      `- AppImage sha512 present: ${summary.hasAppImageFileSha512 ? "yes" : "no"}`,
      `- AppImage file sha512: ${summary.appImageFileSha512 || "<missing>"}`,
      `- checksum match: ${summary.checksumMatches ? "yes" : "no"}`,
      `- actual AppImage sha512 present: ${summary.hasActualAppImageSha512 ? "yes" : "no"}`,
      `- actual AppImage sha512: ${summary.actualAppImageSha512 || "<not checked>"}`,
      `- AppImage sha512 matches actual file: ${formatCheck(summary.appImageSha512MatchesActual)}`,
      `- AppImage metadata size: ${summary.appImageFileSize ?? "<missing>"}`,
      `- actual AppImage size: ${summary.actualAppImageSize ?? "<not checked>"}`,
      `- size match: ${formatCheck(summary.sizeMatches)}`
    );
  } else {
    lines.push(`- metadata error: ${summary.error || "<none>"}`);
  }
  return lines.join("\n");
}

function formatAppImageIdentitySummary(summary) {
  const lines = [
    `- extraction status: ${summary.status}`,
    `- AppImage path: ${summary.appImagePath || "<missing>"}`
  ];
  if (summary.status === "extracted") {
    lines.push(
      `- desktop Name: ${summary.desktopEntry.Name || "<missing>"}`,
      `- desktop Icon: ${summary.desktopEntry.Icon || "<missing>"}`,
      `- desktop Categories: ${summary.desktopEntry.Categories || "<missing>"}`,
      `- desktop StartupWMClass: ${summary.desktopEntry.StartupWMClass || "<missing>"}`,
      `- desktop StartupNotify: ${summary.desktopEntry.StartupNotify || "<missing>"}`,
      `- desktop Terminal: ${summary.desktopEntry.Terminal || "<missing>"}`,
      `- notification icon resource: ${summary.notificationIconResourcePath || "<missing>"}`
    );
  } else {
    lines.push(`- extraction error: ${summary.error || "<none>"}`);
  }
  return lines.join("\n");
}

function formatRcLedgerFieldHandoff(data, gitDirty) {
  const distro = formatRcEnvironmentDistro(data.environment);
  const desktopValues = data.environment.desktop.values ?? {};
  const desktopContext = [
    ["XDG_CURRENT_DESKTOP", desktopValues.XDG_CURRENT_DESKTOP],
    ["XDG_SESSION_DESKTOP", desktopValues.XDG_SESSION_DESKTOP],
    ["DESKTOP_SESSION", desktopValues.DESKTOP_SESSION],
    ["GDMSESSION", desktopValues.GDMSESSION],
    [
      "XDG_SESSION_TYPE",
      desktopValues.XDG_SESSION_TYPE || data.environment.desktop.displayServer
    ]
  ]
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([key, value]) => `${key}=${value}`);
  const dateSlug = String(data.date ?? "").slice(0, 10) || "YYYY-MM-DD";
  const evidenceCommand = data.allowAnyPlatform
    ? `npm run release:evidence:linux -- --allow-any-platform --output docs/plans/linux-rc-evidence-${dateSlug}.md`
    : `npm run release:evidence:linux -- --output docs/plans/linux-rc-evidence-${dateSlug}.md`;

  return [
    "Do not paste this as a passing ledger entry until every manual Ubuntu Desktop/AppImage observation below has actually passed. The public-publishing gate only accepts markers from passed `## Recorded Evidence` entries and checks these field names.",
    "",
    "```text",
    `Date: ${dateSlug}`,
    `Commit: ${data.commit}`,
    `Git dirty: ${gitDirty}`,
    `Environment: ${[distro, ...desktopContext].join(", ")}`,
    `Artifact: ${data.packagedDiagnostics.selectedAppImagePath || "<missing AppImage artifact>"}`,
    [
      "Commands: npm run gate:walking-skeleton:linux",
      "npm run package:linux",
      "npm run smoke:packaged:linux",
      "npm run release:check:linux",
      evidenceCommand,
      "npm run release:check:mac"
    ].join("; "),
    "Result: Not passed until Ubuntu Desktop manual RC validation is complete.",
    "Notes: TODO replace after manual validation with GUI launch normal window launch path screenshot/run-log evidence; terminal launch shell env; CLI and desktop same POSIX socket; PATH recovery for GUI-launched app shell env with nvm, pyenv, cargo, ~/.local/bin, and installed agent CLIs; node-pty spawned shells in dev and packaged AppImage builds through ShellLaunchPolicy with AppImage sandbox env and user-namespace settings recorded; hook runtime env in pty sessions containing KMUX_SOCKET_PATH, KMUX_AGENT_BIN_DIR, and KMUX_NODE_PATH; Codex, Claude, Gemini, and Antigravity hooks notify when installed and configured with per-agent hook logs and UI notification evidence; Codex wrapper works with shell rc integration disabled in a walking-skeleton or targeted Codex wrapper run; external session discovery/resume for verified vendor roots tied to agent storage roots; usage history; subscription usage with verified credential source, recorded storage-root evidence, and dashboard evidence; missing credentials unavailable/disconnected states with recorded missing credential paths; no macOS security command calls plus platform-specific script probing args, script command availability, parsed ps process-table rows, and bounded lsof listening-socket samples; filesystem watch/resync evidence for missed events with eventual usage/external-session refresh and inotify limit diagnostics; AppImage startup/sandbox/no-sandbox/user-namespace evidence; AppImage updater check/download/install, latest-linux*.yml metadata, channel naming, release visibility, AppImage blockmap sidecar, top-level sha512, AppImage file-entry sha512, actual AppImage sha512, and size consistency; AppImage provenance recorded Git dirty state, APPIMAGE env behavior, and selected AppImage artifact path; AppImage extracted desktop entry app name/icon/categories/StartupWMClass=kmux, installed desktop-entry candidate evidence, and resources/notificationIcon.png notification icon resource output; Runtime and packaged identity alignment matched app id, app name, executable name, desktop entry Name, and StartupWMClass=kmux; notification title/body/icon app attribution observed in the Ubuntu notification center and window grouping matched the app window, tied to recorded DBus/session and desktop-entry facts; native window chrome evidence on Ubuntu Desktop with X11/Wayland notes tied to recorded desktop shell/display and GPU renderer probes, resize, and compositor observations; shortcut policy evidence against terminal input and GNOME defaults with keyboard smoke notes tied to GNOME keybinding probes; terminal font loaded and stable cell metrics evidence with fc-list font inventory and xterm observations; IME/input-method smoke passed where ibus or fcitx validation was available with IME environment, input notes, and terminal input unaffected; split panes, surface switching, restore, foreground resize, and readable agent output continuity evidence; User and release docs covered Linux baseline, unsupported scope, AppImage updater behavior, and unavailable credential states; validation matrix covered Ubuntu Desktop LTS GUI launcher, terminal launch, packaged AppImage, dev build, X11 session where available, and Wayland session where available; and macOS compatibility evidence.",
    "Remaining blockers: TODO replace with any failed or not-yet-run Ubuntu Desktop/AppImage observations, or `none` after they pass.",
    "```"
  ].join("\n");
}

function formatRcEnvironmentDistro(environment) {
  const distribution = environment.distribution ?? {};
  const distro = distribution.prettyName || "<unknown distro>";
  if (
    distribution.isUbuntuLts &&
    environment.desktop?.hasUbuntuDesktopSession &&
    /^Ubuntu\b/i.test(distro) &&
    !/\bDesktop\b/i.test(distro)
  ) {
    return distro.replace(/^Ubuntu\b/i, "Ubuntu Desktop");
  }
  return distro;
}

export function buildEvidenceReport(data) {
  const gitDirty =
    typeof data.git?.dirty === "boolean"
      ? data.git.dirty
        ? "yes"
        : "no"
      : "unknown";
  const reportMode = data.allowAnyPlatform
    ? "script-development/non-RC (--allow-any-platform)"
    : "Ubuntu Desktop ledger input";
  const lines = [
    "# Linux Release Evidence Report",
    "",
    `Date: ${data.date}`,
    `Commit: ${data.commit}`,
    `Package version: ${data.packageVersion}`,
    `Report mode: ${reportMode}`,
    "Passing RC evidence: no; keep the handoff Result non-passing until manual Ubuntu Desktop/AppImage observations pass.",
    `Git dirty: ${gitDirty}`,
    `Git status scope: ${data.git?.statusScope ?? "unknown"}`,
    `Git status ignored paths: ${(data.git?.statusIgnoredPaths ?? []).join(", ") || "<none>"}`,
    `Git status entries: ${data.git?.statusEntryCount ?? "unknown"}`,
    "",
    "```text",
    data.git?.statusSample || data.git?.statusError || "<clean>",
    "```",
    "",
    "## Host",
    "",
    `- platform: ${data.environment.platform}`,
    `- arch: ${data.environment.arch}`,
    `- kernel/release: ${data.environment.release}`,
    `- node: ${data.environment.nodeVersion}`,
    `- distro: ${data.environment.distribution.prettyName || "<unknown>"}`,
    `- distro id: ${data.environment.distribution.id || "<unknown>"}`,
    `- Ubuntu LTS detected: ${data.environment.distribution.isUbuntuLts ? "yes" : "no"}`,
    `- desktop display detected: ${data.environment.desktop.hasDisplay ? "yes" : "no"}`,
    `- Ubuntu Desktop session env detected: ${data.environment.desktop.hasUbuntuDesktopSession ? "yes" : "no"}`,
    `- display server: ${data.environment.desktop.displayServer}`,
    "",
    "## Desktop Session Environment",
    "",
    formatKeyValueMap(data.environment.desktop.values),
    "",
    "## Desktop Integration Context",
    "",
    formatDesktopIntegrationSnapshot(data.desktopIntegration ?? {}),
    "",
    "## Desktop Shell And Display Probes",
    "",
    formatDesktopShellSnapshot(data.desktopShell ?? {}),
    "",
    "## XDG And AppImage Environment",
    "",
    formatKeyValueMap({
      ...data.environment.xdg,
      APPIMAGE: data.environment.appImage
    }),
    "",
    "## AppImage Sandbox Context",
    "",
    formatSandboxSnapshot(data.sandbox ?? {}),
    "",
    "## Filesystem Watch Context",
    "",
    formatWatchSnapshot(data.watch ?? {}),
    "",
    "## IME/Input Method Environment",
    "",
    formatImeSnapshot(resolveImeSnapshot(data)),
    "",
    "## Release Artifacts",
    "",
    formatArtifacts(data.artifacts),
    "",
    "## Packaging And Publishing Configuration",
    "",
    formatPackagingConfiguration(data.packaging),
    "",
    "## Runtime And Packaged Identity Alignment",
    "",
    formatRuntimeIdentityConfiguration(data.runtimeIdentity),
    "",
    "## Release Workflow Public Gate",
    "",
    formatReleaseWorkflowConfiguration(data.releaseWorkflow),
    "",
    "## Packaged AppImage Diagnostics",
    "",
    `- selected AppImage: ${data.packagedDiagnostics.selectedAppImagePath || "<missing>"}`,
    `- selected AppImage blockmap: ${formatAppImageBlockmapForReport(data.packagedDiagnostics.selectedAppImageBlockmap)}`,
    `- selected latest-linux.yml: ${data.packagedDiagnostics.selectedMetadataPath || "<missing>"}`,
    "",
    "### Update Metadata",
    "",
    formatUpdateMetadataSummary(data.packagedDiagnostics.updateMetadata),
    "",
    "### Extracted Desktop Identity",
    "",
    formatAppImageIdentitySummary(data.packagedDiagnostics.appImageIdentity),
    "",
    "## RC Ledger Field Handoff",
    "",
    formatRcLedgerFieldHandoff(data, gitDirty),
    "",
    "## Agent CLI Availability",
    "",
    formatAvailability(data.agentCommands),
    "",
    "## Shell PATH Context",
    "",
    formatShellPathSnapshot(data.shellPath ?? {}),
    "",
    "## Agent Storage Roots",
    "",
    formatAgentStorageSnapshot(data.agentStorage ?? {}),
    "",
    "## System Tool Availability",
    "",
    formatAvailability(data.systemCommands),
    "",
    "## Subprocess And Font Samples",
    "",
    `- ps status: ${data.systemSamples.ps.status ?? "unknown"}`,
    `- ps parse status: ${data.systemSamples.ps.parseStatus ?? "unknown"}`,
    `- ps parsed rows: ${data.systemSamples.ps.parsedRows ?? "unknown"}`,
    "",
    "```text",
    data.systemSamples.ps.sample || "<no ps sample>",
    "```",
    "",
    `- lsof status: ${data.systemSamples.lsof?.status ?? "unknown"}`,
    "",
    "```text",
    data.systemSamples.lsof?.sample || "<no lsof sample>",
    "```",
    "",
    `- fc-list status: ${data.systemSamples.fontStatus ?? "unknown"}`,
    `- unique font family count: ${data.systemSamples.fontFamilies}`,
    "",
    "```text",
    data.systemSamples.fontSample || "<no font sample>",
    "```",
    "",
    "## Required Manual Observations To Add",
    "",
    "- GUI launch path, screenshot or run log, and whether a normal window opens.",
    "- Terminal launch command, shell/PATH notes, and CLI/desktop same POSIX socket evidence.",
    "- PATH recovery observations from GUI-launched app shell env for nvm, pyenv, cargo, ~/.local/bin, and installed agent CLIs.",
    "- `npm run gate:walking-skeleton:linux` output.",
    "- node-pty shell spawning evidence in dev and packaged AppImage builds through ShellLaunchPolicy, including AppImage sandbox env and user-namespace settings.",
    "- Hook runtime env in pty sessions, including KMUX_SOCKET_PATH, KMUX_AGENT_BIN_DIR, and KMUX_NODE_PATH.",
    "- Codex, Claude, Gemini, and Antigravity hook notification observations when hooks are installed and configured, including per-agent hook logs and UI notification evidence.",
    "- Codex wrapper evidence with shell rc integration disabled from walking-skeleton or targeted Codex wrapper run output.",
    "- `npm run release:check:linux` output, including its nested `gate:walking-skeleton:linux`, `package:linux`, and `smoke:packaged:linux` stages; keep the individual command markers in the ledger.",
    "- AppImage startup/sandbox notes, user-namespace settings, and whether `--no-sandbox` was needed plus the product/security decision if it was.",
    "- AppImage updater check/download/install notes plus latest-linux*.yml metadata, channel naming, release visibility, AppImage blockmap sidecar, top-level sha512, AppImage file-entry sha512, actual AppImage sha512, and size consistency.",
    "- AppImage provenance evidence covering Git dirty state, APPIMAGE env behavior, and selected AppImage artifact path.",
    "- AppImage extracted desktop-entry app name, icon, categories, StartupWMClass=kmux, installed desktop-entry candidate evidence, resources/notificationIcon.png notification icon resource output from the packaged diagnostics, and runtime/packaged identity alignment with app id, app name, executable name, desktop entry Name, and StartupWMClass=kmux.",
    "- Notification title/body/icon/app attribution observed in the Ubuntu notification center and window grouping matched the app window, tied to recorded DBus/session and desktop-entry facts.",
    "- Native window chrome observations on Ubuntu Desktop with X11/Wayland notes tied to recorded desktop shell/display and GPU renderer probes, resize, compositor, and output-continuity behavior.",
    "- Shortcut policy observations against terminal input and GNOME defaults, including keyboard smoke notes tied to recorded GNOME keybinding probes.",
    "- Terminal font loaded and stable cell metrics evidence, including fc-list font inventory and xterm observations.",
    "- IME/input-method smoke notes for ibus or fcitx validation where available, including IME environment, input notes, and terminal input behavior.",
    "- External session discovery/resume for verified vendor roots, usage history, subscription usage with verified credential source, recorded storage-root evidence, and dashboard evidence, missing-credential unavailable/disconnected states with recorded missing credential paths, no macOS security command calls, platform-specific script probing args, script command availability, parsed ps process-table rows, and bounded lsof listening-socket samples, tied to the agent storage roots above.",
    "- Filesystem watch/resync observations for missed events with eventual usage/external-session refresh and inotify limit diagnostics.",
    "- User and release docs evidence covering Linux baseline, unsupported scope, AppImage updater behavior, and unavailable credential states.",
    "- Validation matrix evidence covering Ubuntu Desktop LTS GUI launcher, terminal launch, packaged AppImage, dev build, X11 session where available, and Wayland session where available.",
    "- macOS compatibility evidence from `npm run release:check:mac` for the same release commit.",
    ""
  ];

  return `${lines.join("\n")}\n`;
}

export function collectEvidence({
  env = process.env,
  platform = process.platform,
  allowAnyPlatform = false,
  runner = runCommand,
  identityExtractor = extractAppImageDesktopIdentity,
  now = new Date(),
  searchRoots = DEFAULT_RELEASE_SEARCH_ROOTS
} = {}) {
  const packageJson = readJson("package.json");
  const git = collectGitProvenance(runner);
  const artifacts = collectReleaseArtifacts(searchRoots);

  return {
    date: now.toISOString(),
    commit: git.commit,
    git,
    packageVersion: packageJson.version,
    allowAnyPlatform,
    environment: collectEnvironmentSnapshot({ env, platform }),
    desktopIntegration: collectDesktopIntegrationSnapshot({ env, runner }),
    desktopShell: collectDesktopShellSnapshot({ env, runner }),
    ime: collectImeSnapshot({ env, runner }),
    sandbox: collectSandboxSnapshot({ env }),
    watch: collectWatchSnapshot(),
    artifacts,
    packaging: collectPackagingConfiguration(),
    runtimeIdentity: collectRuntimeIdentityConfiguration(),
    releaseWorkflow: collectReleaseWorkflowConfiguration(),
    packagedDiagnostics: collectPackagedArtifactDiagnostics({
      artifacts,
      identityExtractor
    }),
    agentCommands: collectCommandAvailability(AGENT_COMMANDS, runner),
    shellPath: collectShellPathSnapshot({ env }),
    agentStorage: collectAgentStorageSnapshot({ env }),
    systemCommands: collectCommandAvailability(SYSTEM_COMMANDS, runner),
    systemSamples: collectSystemSamples(runner)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  assertLinuxEvidenceTarget({
    platform: process.platform,
    env: process.env,
    allowAnyPlatform: args.allowAnyPlatform
  });

  const report = buildEvidenceReport(
    collectEvidence({
      allowAnyPlatform: args.allowAnyPlatform
    })
  );

  if (args.outputPath) {
    mkdirSync(path.dirname(args.outputPath), { recursive: true });
    writeFileSync(args.outputPath, report);
    console.log(`Linux release evidence report written to ${args.outputPath}`);
    return;
  }

  process.stdout.write(report);
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

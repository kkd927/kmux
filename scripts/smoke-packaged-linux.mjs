import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import {
  UBUNTU_DESKTOP_RC_TARGET_HINT,
  assertUbuntuDesktopLtsTarget,
  hasDesktopDisplay,
  parseOsRelease,
  readOsRelease
} from "./linux-desktop-target.mjs";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

const DEFAULT_RELEASE_SEARCH_ROOTS = [
  path.resolve("apps/desktop/release"),
  path.resolve("release-assets")
];
const DEFAULT_BUILDER_CONFIG_PATH = path.resolve(
  "apps/desktop/electron-builder.yml"
);
const KMUX_LINUX_APPIMAGE_NAME_PATTERN =
  /^kmux-\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?-linux-[A-Za-z0-9_-]+\.AppImage$/i;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExistingFile(filePath) {
  return existsSync(filePath) && statSync(filePath).isFile();
}

function assertExistingFile(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`${label} not found at ${filePath}`);
  }
  if (!statSync(filePath).isFile()) {
    throw new Error(`${label} at ${filePath} is not a file`);
  }
}

export function calculateFileSha512(filePath) {
  const hash = createHash("sha512");
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    while (bytesRead > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("base64");
}

export function parseArgs(argv) {
  const parsed = { allowAnyLinuxDesktop: false };
  const readPathArg = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a path value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--appimage") {
      parsed.appImagePath = path.resolve(readPathArg(index, token));
      index += 1;
    } else if (token === "--metadata") {
      parsed.metadataPath = path.resolve(readPathArg(index, token));
      index += 1;
    } else if (token === "--allow-any-linux-desktop") {
      parsed.allowAnyLinuxDesktop = true;
    } else {
      throw new Error(`unknown smoke:packaged:linux argument: ${token}`);
    }
  }
  return parsed;
}

export function findAppImagePath({
  explicitPath,
  preferredArch = process.arch,
  searchRoots = DEFAULT_RELEASE_SEARCH_ROOTS
} = {}) {
  if (explicitPath) {
    assertExistingFile(explicitPath, "AppImage");
    if (!isKmuxLinuxAppImagePath(explicitPath)) {
      throw new Error(
        `AppImage artifact must be named kmux-<version>-linux-<arch>.AppImage; got ${path.basename(explicitPath)}`
      );
    }
    return explicitPath;
  }

  const entries = searchRoots.flatMap((root) => {
    if (!existsSync(root)) {
      return [];
    }
    return walkFiles(root).filter((entry) => isKmuxLinuxAppImagePath(entry));
  });
  if (entries.length > 0) {
    return selectLinuxAppImagePath(entries, preferredArch);
  }

  throw new Error(
    "Could not find a packaged AppImage named kmux-<version>-linux-<arch>.AppImage. Run `npm run package:linux` first or pass --appimage <path>."
  );
}

export function isLinuxUpdateMetadataName(fileName) {
  return /^latest-linux(?:-[\w-]+)?\.ya?ml$/i.test(fileName);
}

export function inferLinuxAppImageArch(appImagePath) {
  const match = /-linux-([^.]+)\.AppImage$/i.exec(path.basename(appImagePath));
  return match?.[1] ?? "";
}

export function isKmuxLinuxAppImagePath(appImagePath) {
  return KMUX_LINUX_APPIMAGE_NAME_PATTERN.test(path.basename(appImagePath));
}

function linuxAppImageMtimeMs(appImagePath) {
  try {
    return statSync(appImagePath).mtimeMs;
  } catch {
    return 0;
  }
}

function linuxAppImageVersion(appImagePath) {
  const match =
    /^kmux-(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?-linux-/i.exec(
      path.basename(appImagePath)
    );
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? ""
  };
}

function compareLinuxAppImageVersion(leftPath, rightPath) {
  const left = linuxAppImageVersion(leftPath);
  const right = linuxAppImageVersion(rightPath);
  if (!left || !right) {
    return 0;
  }

  for (const key of ["major", "minor", "patch"]) {
    const delta = right[key] - left[key];
    if (delta !== 0) {
      return delta;
    }
  }

  if (left.prerelease === right.prerelease) {
    return 0;
  }
  if (!left.prerelease) {
    return -1;
  }
  if (!right.prerelease) {
    return 1;
  }
  return right.prerelease.localeCompare(left.prerelease);
}

function compareLinuxAppImagePath(left, right) {
  const mtimeDelta = linuxAppImageMtimeMs(right) - linuxAppImageMtimeMs(left);
  if (mtimeDelta !== 0) {
    return mtimeDelta;
  }

  const versionDelta = compareLinuxAppImageVersion(left, right);
  if (versionDelta !== 0) {
    return versionDelta;
  }

  return left.localeCompare(right);
}

export function selectLinuxAppImagePath(
  appImagePaths,
  preferredArch = process.arch
) {
  const sortedPaths = [...appImagePaths].sort(compareLinuxAppImagePath);
  return (
    sortedPaths.find(
      (appImagePath) => inferLinuxAppImageArch(appImagePath) === preferredArch
    ) ?? sortedPaths[0]
  );
}

export function linuxUpdateMetadataCandidates(appImagePath) {
  const arch = appImagePath ? inferLinuxAppImageArch(appImagePath) : "";
  return [
    ...(arch && arch !== "x64" ? [`latest-linux-${arch}.yml`] : []),
    "latest-linux.yml",
    ...(arch && arch !== "x64" ? [`latest-linux-${arch}.yaml`] : []),
    "latest-linux.yaml"
  ];
}

export function expectedLinuxUpdateMetadataNames(appImagePath) {
  const arch = appImagePath ? inferLinuxAppImageArch(appImagePath) : "";
  if (arch && arch !== "x64") {
    return [`latest-linux-${arch}.yml`, `latest-linux-${arch}.yaml`];
  }
  return ["latest-linux.yml", "latest-linux.yaml"];
}

export function findLinuxUpdateMetadataPath({
  appImagePath,
  explicitPath,
  searchRoots = DEFAULT_RELEASE_SEARCH_ROOTS
} = {}) {
  if (explicitPath) {
    assertExistingFile(explicitPath, "Linux update metadata");
    return explicitPath;
  }

  const appImageDir = appImagePath ? path.dirname(appImagePath) : undefined;
  const roots = [
    ...(appImageDir ? [appImageDir] : []),
    ...searchRoots.filter((root) => root !== appImageDir)
  ];
  const candidateNames = linuxUpdateMetadataCandidates(appImagePath);

  for (const root of roots) {
    for (const fileName of candidateNames) {
      const candidate = path.join(root, fileName);
      if (isExistingFile(candidate)) {
        return candidate;
      }
    }
    if (existsSync(root)) {
      const files = walkFiles(root).sort();
      for (const fileName of candidateNames) {
        const candidate = files.find(
          (filePath) => path.basename(filePath) === fileName
        );
        if (candidate) {
          return candidate;
        }
      }
      const matchingMetadata = files
        .filter((filePath) => isLinuxUpdateMetadataName(path.basename(filePath)))
        .sort();
      if (matchingMetadata.length > 0) {
        return matchingMetadata[0];
      }
    }
  }

  throw new Error(
    "Could not find latest-linux.yml or latest-linux-<arch>.yml for the packaged AppImage. Re-run `npm run package:linux`."
  );
}

export function loadLinuxUpdateMetadata(metadataPath) {
  const loaded = yaml.load(readFileSync(metadataPath, "utf8"));
  if (!isRecord(loaded)) {
    throw new Error(
      `Linux update metadata at ${metadataPath} is not a YAML object`
    );
  }
  return loaded;
}

export function parseDesktopEntry(source) {
  const groups = {};
  let currentGroup;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const groupMatch = /^\[([^\]]+)\]$/.exec(line);
    if (groupMatch) {
      currentGroup = groupMatch[1];
      groups[currentGroup] ??= {};
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (!currentGroup || separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    groups[currentGroup][key] = value;
  }

  return groups;
}

export function normalizeLinuxDesktopEntry(desktopEntry) {
  if (!isRecord(desktopEntry)) {
    throw new Error("Desktop entry must be an object");
  }

  return isRecord(desktopEntry["Desktop Entry"]) && !("Name" in desktopEntry)
    ? desktopEntry["Desktop Entry"]
    : desktopEntry;
}

export function loadExpectedLinuxDesktopEntry(
  builderConfigPath = DEFAULT_BUILDER_CONFIG_PATH
) {
  const config = yaml.load(readFileSync(builderConfigPath, "utf8"));
  if (!isRecord(config)) {
    throw new Error(`${builderConfigPath} must contain an object`);
  }
  const linux = config.linux;
  if (!isRecord(linux)) {
    throw new Error(`${builderConfigPath} must include linux config`);
  }
  const desktop = linux.desktop;
  if (!isRecord(desktop)) {
    throw new Error(`${builderConfigPath} must include linux.desktop config`);
  }
  const entry = desktop.entry;
  if (!isRecord(entry)) {
    throw new Error(`${builderConfigPath} must include linux.desktop.entry`);
  }
  return entry;
}

function walkFiles(root) {
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

export function findExtractedDesktopEntryPath(extractedRoot) {
  if (!existsSync(extractedRoot)) {
    throw new Error(`Extracted AppImage root not found at ${extractedRoot}`);
  }

  const desktopFiles = walkFiles(extractedRoot).filter((filePath) =>
    filePath.endsWith(".desktop")
  );
  if (desktopFiles.length === 0) {
    throw new Error(`No .desktop file found under ${extractedRoot}`);
  }

  return (
    desktopFiles.find(
      (filePath) => path.basename(filePath).toLowerCase() === "kmux.desktop"
    ) ?? desktopFiles[0]
  );
}

export function findExtractedNotificationIconPath(extractedRoot) {
  if (!existsSync(extractedRoot)) {
    throw new Error(`Extracted AppImage root not found at ${extractedRoot}`);
  }

  const iconPath = path.join(
    extractedRoot,
    "resources",
    "notificationIcon.png"
  );
  if (!existsSync(iconPath) || !statSync(iconPath).isFile()) {
    throw new Error(
      `Notification icon resource not found at ${iconPath}. Check electron-builder extraResources.`
    );
  }
  return iconPath;
}

export function validateLinuxDesktopEntry(
  desktopEntry,
  expectedEntry = loadExpectedLinuxDesktopEntry()
) {
  const entry = normalizeLinuxDesktopEntry(desktopEntry);

  for (const [key, expectedValue] of Object.entries(expectedEntry)) {
    if (typeof expectedValue !== "string") {
      continue;
    }
    if (entry[key] !== expectedValue) {
      throw new Error(
        `Desktop entry ${key} must be ${expectedValue}, got ${entry[key] ?? "<missing>"}`
      );
    }
  }
}

function metadataAppImageFileEntry(metadata, appImageName) {
  if (!isRecord(metadata) || !Array.isArray(metadata.files)) {
    return undefined;
  }

  return metadata.files.find((file) => {
    if (!isRecord(file)) {
      return false;
    }
    const filePath = typeof file.url === "string" ? file.url : file.path;
    return (
      typeof filePath === "string" &&
      filePath.endsWith(".AppImage") &&
      (!appImageName || path.basename(filePath) === appImageName) &&
      typeof file.sha512 === "string" &&
      file.sha512.length > 0
    );
  });
}

function metadataAppImageFilePath(file) {
  if (!isRecord(file)) {
    return undefined;
  }
  return typeof file.url === "string" ? file.url : file.path;
}

function metadataAppImageFileSize(file) {
  return isRecord(file) && typeof file.size === "number"
    ? file.size
    : undefined;
}

function metadataAppImageFileSha512(file) {
  return isRecord(file) && typeof file.sha512 === "string"
    ? file.sha512
    : undefined;
}

export function describeAppImageBlockmap(appImagePath) {
  if (!appImagePath) {
    return {
      status: "missing",
      path: "",
      sizeBytes: null
    };
  }

  const blockmapPath = `${appImagePath}.blockmap`;
  if (!existsSync(blockmapPath)) {
    return {
      status: "missing",
      path: blockmapPath,
      sizeBytes: null
    };
  }

  const stats = statSync(blockmapPath);
  return {
    status: stats.isFile() ? "present" : "not-file",
    path: blockmapPath,
    sizeBytes: stats.isFile() ? stats.size : null
  };
}

export function assertAppImageBlockmapPresent(appImagePath) {
  const blockmap = describeAppImageBlockmap(appImagePath);
  if (blockmap.status !== "present") {
    throw new Error(
      `AppImage blockmap sidecar is required for Linux updater smoke; got ${blockmap.status} at ${blockmap.path || "<missing>"}`
    );
  }
  if (typeof blockmap.sizeBytes !== "number" || blockmap.sizeBytes <= 0) {
    throw new Error(
      `AppImage blockmap sidecar must be non-empty for Linux updater smoke; got ${blockmap.sizeBytes ?? "<missing>"} bytes at ${blockmap.path}`
    );
  }
  return blockmap;
}

function formatAppImageBlockmapSummary(blockmap) {
  if (blockmap.status === "present") {
    return `${blockmap.path} (${blockmap.sizeBytes} bytes)`;
  }
  if (blockmap.path) {
    return `<${blockmap.status}> (${blockmap.path})`;
  }
  return "<missing>";
}

export function validateLinuxUpdateMetadata(
  metadata,
  { appImagePath, expectedVersion, metadataPath } = {}
) {
  if (!isRecord(metadata)) {
    throw new Error("Linux update metadata must be an object");
  }

  const appImageName = appImagePath ? path.basename(appImagePath) : undefined;
  if (metadataPath && appImagePath) {
    const metadataName = path.basename(metadataPath);
    const expectedNames = expectedLinuxUpdateMetadataNames(appImagePath);
    if (!expectedNames.includes(metadataName)) {
      throw new Error(
        `Linux update metadata filename ${metadataName} must match selected AppImage channel naming (${expectedNames.join(" or ")})`
      );
    }
  }

  if (typeof metadata.version !== "string" || metadata.version.length === 0) {
    throw new Error("latest-linux.yml must include a non-empty version");
  }

  if (expectedVersion && metadata.version !== expectedVersion) {
    throw new Error(
      `latest-linux.yml version ${metadata.version} does not match package version ${expectedVersion}`
    );
  }

  if (
    typeof metadata.path !== "string" ||
    !metadata.path.endsWith(".AppImage")
  ) {
    throw new Error("latest-linux.yml must point to an AppImage path");
  }

  if (appImageName && path.basename(metadata.path) !== appImageName) {
    throw new Error(
      `latest-linux.yml points to ${metadata.path}, but packaged AppImage is ${appImageName}`
    );
  }

  if (typeof metadata.sha512 !== "string" || metadata.sha512.length === 0) {
    throw new Error(
      "latest-linux.yml must include a top-level sha512 checksum"
    );
  }

  if (!Array.isArray(metadata.files) || metadata.files.length === 0) {
    throw new Error("latest-linux.yml must include at least one file entry");
  }

  const appImageFile = metadataAppImageFileEntry(metadata, appImageName);

  if (!appImageFile) {
    throw new Error(
      "latest-linux.yml must include an AppImage file entry with a sha512 checksum"
    );
  }

  if (
    typeof appImageFile.size !== "number" ||
    !Number.isInteger(appImageFile.size) ||
    appImageFile.size < 0
  ) {
    throw new Error(
      "latest-linux.yml must include a numeric AppImage file size"
    );
  }

  let appImageSize;
  if (appImagePath) {
    appImageSize = statSync(appImagePath).size;
    if (appImageFile.size !== appImageSize) {
      throw new Error(
        `latest-linux.yml AppImage file size ${appImageFile.size} does not match packaged AppImage size ${appImageSize}`
      );
    }
  }

  if (appImageFile.sha512 !== metadata.sha512) {
    throw new Error(
      "latest-linux.yml top-level sha512 must match the AppImage file entry checksum"
    );
  }

  let appImageSha512;
  if (appImagePath) {
    appImageSha512 = calculateFileSha512(appImagePath);
    if (appImageFile.sha512 !== appImageSha512) {
      throw new Error(
        "latest-linux.yml AppImage file entry sha512 must match the packaged AppImage sha512"
      );
    }
  }

  return {
    appImageFilePath: metadataAppImageFilePath(appImageFile),
    appImageFileSha512: appImageFile.sha512,
    appImageFileSize: appImageFile.size,
    appImageSha512,
    appImageSize,
    topLevelSha512: metadata.sha512
  };
}

export function assertLinuxDesktopEnvironment({
  platform = process.platform,
  env = process.env,
  osReleaseText = readOsRelease(),
  allowAnyLinuxDesktop = false
} = {}) {
  if (platform !== "linux") {
    throw new Error(
      [
        `smoke:packaged:linux only runs on Linux; current platform is ${platform}.`,
        UBUNTU_DESKTOP_RC_TARGET_HINT
      ].join("\n")
    );
  }

  if (allowAnyLinuxDesktop) {
    if (!hasDesktopDisplay(env)) {
      throw new Error(
        "smoke:packaged:linux requires a Linux desktop session (DISPLAY or WAYLAND_DISPLAY)."
      );
    }
    return;
  }

  const distribution = parseOsRelease(osReleaseText);
  assertUbuntuDesktopLtsTarget({
    platform,
    env,
    osReleaseText,
    distributionMessage: [
      "smoke:packaged:linux must run on Ubuntu Desktop LTS for RC validation.",
      `Detected distro: ${distribution.prettyName || distribution.id || "<unknown>"}.`,
      "Use --allow-any-linux-desktop only for non-RC diagnostics."
    ].join("\n"),
    displayMessage:
      "smoke:packaged:linux requires an Ubuntu Desktop session (DISPLAY or WAYLAND_DISPLAY)."
  });
}

export function extractAppImageDesktopEntry({
  appImagePath,
  runCommand = spawnSync
}) {
  return extractAppImageDesktopIdentity({ appImagePath, runCommand })
    .desktopEntry;
}

export function extractAppImageDesktopIdentity({
  appImagePath,
  runCommand = spawnSync
}) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "kmux-appimage-desktop-"));
  try {
    const result = runCommand(appImagePath, ["--appimage-extract"], {
      cwd: tempRoot,
      stdio: "pipe",
      encoding: "utf8"
    });

    if (result.status !== 0) {
      throw new Error(
        [
          `${appImagePath} --appimage-extract failed with exit code ${result.status ?? "unknown"}`,
          result.stdout,
          result.stderr
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    const extractedRoot = path.join(tempRoot, "squashfs-root");
    const desktopEntryPath = findExtractedDesktopEntryPath(extractedRoot);
    const notificationIconPath =
      findExtractedNotificationIconPath(extractedRoot);
    return {
      desktopEntry: parseDesktopEntry(readFileSync(desktopEntryPath, "utf8")),
      notificationIconResourcePath: path.relative(
        extractedRoot,
        notificationIconPath
      )
    };
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

function ensureExecutable(filePath) {
  const stats = statSync(filePath);
  if ((stats.mode & 0o111) === 0) {
    chmodSync(filePath, stats.mode | 0o755);
  }
}

function expectedPackageVersion() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  return pkg.version;
}

export function runPackagedPlaywrightSmoke({
  appImagePath,
  env = process.env
}) {
  const playwrightCli = path.resolve("node_modules", "playwright", "cli.js");
  const result = spawnSync(
    process.execPath,
    [
      playwrightCli,
      "test",
      "tests/e2e/kmux-packaged-smoke.spec.ts",
      "--config",
      "playwright.config.ts"
    ],
    {
      stdio: "inherit",
      env: buildPackagedSmokeEnv({ appImagePath, env })
    }
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

export function buildPackagedSmokeEnv({ appImagePath, env = process.env }) {
  return {
    ...env,
    APPIMAGE: appImagePath,
    APPIMAGE_EXTRACT_AND_RUN: env.APPIMAGE_EXTRACT_AND_RUN ?? "1",
    KMUX_PACKAGED_EXECUTABLE_PATH: appImagePath
  };
}

function summaryValue(value) {
  return typeof value === "string" && value.length > 0 ? value : "<missing>";
}

function formatMetadataSizeMatchSummary(metadataSize, appImageSize) {
  const metadataSizeSummary =
    typeof metadataSize === "number" ? `${metadataSize} bytes` : "<missing>";
  const appImageSizeSummary =
    typeof appImageSize === "number" ? `${appImageSize} bytes` : "<missing>";
  if (typeof metadataSize !== "number" || typeof appImageSize !== "number") {
    return `${metadataSizeSummary} (packaged AppImage size: ${appImageSizeSummary})`;
  }
  const matchStatus =
    metadataSize === appImageSize ? "matches" : "does not match";
  return `${metadataSizeSummary} (${matchStatus} packaged AppImage size ${appImageSizeSummary})`;
}

function formatMetadataChecksumMatchSummary({
  appImageFileSha512,
  appImageSha512,
  topLevelSha512
}) {
  const checksumValues = [topLevelSha512, appImageFileSha512, appImageSha512];
  if (
    !checksumValues.every(
      (value) => typeof value === "string" && value.length > 0
    )
  ) {
    return "<missing>";
  }
  return topLevelSha512 === appImageFileSha512 &&
    appImageFileSha512 === appImageSha512
    ? "top-level, file entry, and packaged AppImage sha512 match"
    : "sha512 mismatch";
}

export function buildPackagedSmokeSummary({
  appImagePath,
  updateMetadataPath,
  updateMetadata,
  desktopIdentity,
  updateMetadataValidation,
  allowAnyLinuxDesktop = false,
  env = process.env
}) {
  const appImageName = path.basename(appImagePath);
  const appImageFile = metadataAppImageFileEntry(updateMetadata, appImageName);
  const appImageSize =
    updateMetadataValidation?.appImageSize ?? statSync(appImagePath).size;
  const appImageSha512 = updateMetadataValidation?.appImageSha512;
  const appImageFilePath =
    updateMetadataValidation?.appImageFilePath ??
    metadataAppImageFilePath(appImageFile);
  const appImageFileSize =
    updateMetadataValidation?.appImageFileSize ??
    metadataAppImageFileSize(appImageFile);
  const appImageFileSha512 =
    updateMetadataValidation?.appImageFileSha512 ??
    metadataAppImageFileSha512(appImageFile);
  const topLevelSha512 =
    updateMetadataValidation?.topLevelSha512 ?? updateMetadata.sha512;
  const desktopEntry = normalizeLinuxDesktopEntry(desktopIdentity.desktopEntry);
  const smokeEnv = buildPackagedSmokeEnv({ appImagePath, env });
  const blockmap = describeAppImageBlockmap(appImagePath);

  return [
    "Linux packaged smoke preflight:",
    `- Smoke mode: ${
      allowAnyLinuxDesktop
        ? "non-RC diagnostics (--allow-any-linux-desktop)"
        : "Ubuntu Desktop RC preflight"
    }`,
    "- Passing RC evidence: no automatic pass; record real Ubuntu Desktop/AppImage observations in the RC ledger.",
    `- AppImage artifact: ${appImagePath}`,
    `- AppImage arch: ${summaryValue(inferLinuxAppImageArch(appImagePath))}`,
    `- AppImage size: ${appImageSize}`,
    `- AppImage blockmap: ${formatAppImageBlockmapSummary(blockmap)}`,
    `- Update metadata: ${updateMetadataPath}`,
    `- Update metadata version: ${summaryValue(updateMetadata.version)}`,
    `- Update metadata AppImage path: ${summaryValue(updateMetadata.path)}`,
    `- Update metadata AppImage file entry: ${summaryValue(appImageFilePath)}`,
    `- Update metadata AppImage file size: ${formatMetadataSizeMatchSummary(appImageFileSize, appImageSize)}`,
    `- Update metadata top-level sha512: ${summaryValue(topLevelSha512)}`,
    `- Update metadata AppImage file sha512: ${summaryValue(appImageFileSha512)}`,
    `- Packaged AppImage sha512: ${summaryValue(appImageSha512)}`,
    `- Update metadata checksum match: ${formatMetadataChecksumMatchSummary({
      appImageFileSha512,
      appImageSha512,
      topLevelSha512
    })}`,
    "- Release visibility/updater install: not validated by packaged smoke; record updater check/download/install evidence separately in the RC ledger.",
    `- Desktop entry: ${[
      `Name=${summaryValue(desktopEntry.Name)}`,
      `Icon=${summaryValue(desktopEntry.Icon)}`,
      `Categories=${summaryValue(desktopEntry.Categories)}`,
      `StartupWMClass=${summaryValue(desktopEntry.StartupWMClass)}`,
      `StartupNotify=${summaryValue(desktopEntry.StartupNotify)}`,
      `Terminal=${summaryValue(desktopEntry.Terminal)}`
    ].join(" | ")}`,
    `- Notification icon resource: ${summaryValue(desktopIdentity.notificationIconResourcePath)}`,
    "- Notification delivery/window grouping: not validated by packaged smoke; record notification title/body/icon app attribution observed in the Ubuntu notification center and window grouping matched the app window separately in the RC ledger.",
    `- AppImage runtime env: ${[
      `APPIMAGE=${summaryValue(smokeEnv.APPIMAGE)}`,
      `APPIMAGE_EXTRACT_AND_RUN=${summaryValue(smokeEnv.APPIMAGE_EXTRACT_AND_RUN)}`,
      `KMUX_PACKAGED_EXECUTABLE_PATH=${summaryValue(smokeEnv.KMUX_PACKAGED_EXECUTABLE_PATH)}`
    ].join(" | ")}`,
    "- AppImage launch args: <none>; --no-sandbox not added by smoke wrapper"
  ].join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const {
    appImagePath: explicitAppImagePath,
    metadataPath,
    allowAnyLinuxDesktop
  } = parseArgs(argv);
  assertLinuxDesktopEnvironment({ allowAnyLinuxDesktop });

  const appImagePath = findAppImagePath({ explicitPath: explicitAppImagePath });
  const updateMetadataPath = findLinuxUpdateMetadataPath({
    appImagePath,
    explicitPath: metadataPath
  });
  const updateMetadata = loadLinuxUpdateMetadata(updateMetadataPath);

  ensureExecutable(appImagePath);
  const updateMetadataValidation = validateLinuxUpdateMetadata(updateMetadata, {
    appImagePath,
    expectedVersion: expectedPackageVersion(),
    metadataPath: updateMetadataPath
  });
  assertAppImageBlockmapPresent(appImagePath);
  const desktopIdentity = extractAppImageDesktopIdentity({
    appImagePath
  });
  validateLinuxDesktopEntry(desktopIdentity.desktopEntry);
  process.stdout.write(
    `${buildPackagedSmokeSummary({
      appImagePath,
      updateMetadataPath,
      updateMetadata,
      desktopIdentity,
      updateMetadataValidation,
      allowAnyLinuxDesktop
    })}\n`
  );
  runPackagedPlaywrightSmoke({ appImagePath });
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

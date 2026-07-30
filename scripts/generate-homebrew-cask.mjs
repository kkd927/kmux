#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const NUMERIC_IDENTIFIER = "(?:0|[1-9][0-9]*)";
const STABLE_VERSION_PATTERN = new RegExp(
  `^v?(${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER})$`
);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ARCHITECTURES = ["arm64", "x64"];
const USAGE = [
  "Usage: node scripts/generate-homebrew-cask.mjs",
  "  --version <vX.Y.Z|X.Y.Z>",
  "  --dmg <kmux-X.Y.Z-mac-arm64.dmg>",
  "  --dmg <kmux-X.Y.Z-mac-x64.dmg>",
  "  --output <kmux.rb>",
  "  [--current-cask <kmux.rb>]"
].join(" \\\n");

export function normalizeStableVersion(input) {
  const match = STABLE_VERSION_PATTERN.exec(input);
  if (!match) {
    throw new Error(
      `Invalid stable version ${JSON.stringify(input)}. Expected vX.Y.Z or X.Y.Z with no prerelease, build metadata, or leading zeroes.`
    );
  }
  return match[1];
}

export function compareStableVersions(leftInput, rightInput) {
  const left = normalizeStableVersion(leftInput)
    .split(".")
    .map((part) => BigInt(part));
  const right = normalizeStableVersion(rightInput)
    .split(".")
    .map((part) => BigInt(part));

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) {
      return -1;
    }
    if (left[index] > right[index]) {
      return 1;
    }
  }
  return 0;
}

export function extractCaskVersion(caskSource) {
  const match = /^\s*version "([^"]+)"\s*$/m.exec(caskSource);
  if (!match) {
    throw new Error('Current Cask must contain exactly one `version "X.Y.Z"` stanza.');
  }

  const normalized = normalizeStableVersion(match[1]);
  if (normalized !== match[1]) {
    throw new Error(
      `Current Cask version must omit the v prefix; received ${JSON.stringify(match[1])}.`
    );
  }
  return normalized;
}

export function renderHomebrewCask({
  version: versionInput,
  arm64Sha256,
  x64Sha256
}) {
  const version = normalizeStableVersion(versionInput);
  validateSha256("arm64", arm64Sha256);
  validateSha256("x64", x64Sha256);

  return `cask "kmux" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${arm64Sha256}",
         intel: "${x64Sha256}"

  url "https://github.com/kkd927/kmux/releases/download/v#{version}/kmux-#{version}-mac-#{arch}.dmg"
  name "kmux"
  desc "Keyboard-first terminal workspace manager for coding agents"
  homepage "https://github.com/kkd927/kmux"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: :monterey

  app "kmux.app"
end
`;
}

export async function resolveDmgArtifacts({
  version: versionInput,
  dmgPaths
}) {
  const version = normalizeStableVersion(versionInput);
  if (!Array.isArray(dmgPaths) || dmgPaths.length !== 2) {
    throw new Error(
      `Expected exactly two DMGs (arm64 and x64); received ${dmgPaths?.length ?? 0}.`
    );
  }

  const artifacts = {};
  for (const dmgPath of dmgPaths) {
    const basename = path.basename(dmgPath);
    const architecture = ARCHITECTURES.find(
      (candidate) =>
        basename === `kmux-${version}-mac-${candidate}.dmg`
    );
    if (!architecture) {
      throw new Error(
        `Unexpected DMG filename ${JSON.stringify(basename)}. Expected kmux-${version}-mac-arm64.dmg or kmux-${version}-mac-x64.dmg.`
      );
    }
    if (artifacts[architecture]) {
      throw new Error(
        `Duplicate ${architecture} DMG: ${JSON.stringify(dmgPath)}.`
      );
    }

    const fileStats = await stat(dmgPath).catch((error) => {
      if (error?.code === "ENOENT") {
        throw new Error(`DMG does not exist: ${JSON.stringify(dmgPath)}.`);
      }
      throw error;
    });
    if (!fileStats.isFile()) {
      throw new Error(`DMG is not a file: ${JSON.stringify(dmgPath)}.`);
    }
    artifacts[architecture] = { path: dmgPath };
  }

  for (const architecture of ARCHITECTURES) {
    if (!artifacts[architecture]) {
      throw new Error(`Missing ${architecture} DMG for version ${version}.`);
    }
  }

  await Promise.all(
    ARCHITECTURES.map(async (architecture) => {
      artifacts[architecture].sha256 = await sha256File(
        artifacts[architecture].path
      );
    })
  );
  return artifacts;
}

export async function updateHomebrewCask({
  version: versionInput,
  dmgPaths,
  outputPath,
  currentCaskPath
}) {
  const version = normalizeStableVersion(versionInput);
  if (!outputPath) {
    throw new Error("An output Cask path is required.");
  }

  let currentSource;
  let currentVersion;
  if (currentCaskPath) {
    currentSource = await readFile(currentCaskPath, "utf8");
    currentVersion = extractCaskVersion(currentSource);
    if (compareStableVersions(version, currentVersion) < 0) {
      return {
        status: "skipped-downgrade",
        version,
        currentVersion,
        outputPath
      };
    }
  }

  const artifacts = await resolveDmgArtifacts({ version, dmgPaths });
  const source = renderHomebrewCask({
    version,
    arm64Sha256: artifacts.arm64.sha256,
    x64Sha256: artifacts.x64.sha256
  });
  const existingOutput =
    currentCaskPath &&
    path.resolve(currentCaskPath) === path.resolve(outputPath)
      ? currentSource
      : await readFile(outputPath, "utf8").catch((error) => {
          if (error?.code === "ENOENT") {
            return undefined;
          }
          throw error;
        });

  if (existingOutput === source) {
    return {
      status: "unchanged",
      version,
      currentVersion,
      outputPath
    };
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, source, "utf8");
  return {
    status: "updated",
    version,
    currentVersion,
    outputPath
  };
}

export function parseCliArgs(argv) {
  const options = { dmgPaths: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      return { help: true };
    }
    if (
      !["--version", "--dmg", "--output", "--current-cask"].includes(argument)
    ) {
      throw new Error(`Unknown argument ${JSON.stringify(argument)}.\n${USAGE}`);
    }

    const value = argv[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${argument}.\n${USAGE}`);
    }
    index += 1;

    if (argument === "--dmg") {
      options.dmgPaths.push(value);
      continue;
    }

    const property = {
      "--version": "version",
      "--output": "outputPath",
      "--current-cask": "currentCaskPath"
    }[argument];
    if (options[property]) {
      throw new Error(`Duplicate ${argument} argument.\n${USAGE}`);
    }
    options[property] = value;
  }

  if (!options.version || !options.outputPath) {
    throw new Error(`--version and --output are required.\n${USAGE}`);
  }
  return options;
}

function validateSha256(architecture, value) {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${architecture} SHA-256 ${JSON.stringify(value)}; expected 64 lowercase hexadecimal characters.`
    );
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const result = await updateHomebrewCask(options);
  if (result.status === "skipped-downgrade") {
    console.log(
      `Skipped kmux ${result.version} because the Tap already contains ${result.currentVersion}.`
    );
    return;
  }
  if (result.status === "unchanged") {
    console.log(`Cask is already up to date for kmux ${result.version}.`);
    return;
  }
  console.log(`Generated ${result.outputPath} for kmux ${result.version}.`);
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

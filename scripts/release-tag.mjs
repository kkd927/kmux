#!/usr/bin/env node

import { access, appendFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const NUMERIC_IDENTIFIER = "(?:0|[1-9][0-9]*)";
const STABLE_TAG_PATTERN = new RegExp(
  `^v(${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER})$`
);
const PRERELEASE_TAG_PATTERN = new RegExp(
  `^v(${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}-(?:alpha|beta)\\.${NUMERIC_IDENTIFIER})$`
);

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

export function classifyReleaseTag(tag) {
  const stableMatch = STABLE_TAG_PATTERN.exec(tag);
  if (stableMatch) {
    return {
      version: stableMatch[1],
      releaseKind: "stable",
      isPrerelease: false
    };
  }

  const prereleaseMatch = PRERELEASE_TAG_PATTERN.exec(tag);
  if (prereleaseMatch) {
    return {
      version: prereleaseMatch[1],
      releaseKind: "prerelease",
      isPrerelease: true
    };
  }

  throw new Error(
    `Invalid release tag ${JSON.stringify(tag)}. Expected vX.Y.Z, vX.Y.Z-alpha.N, or vX.Y.Z-beta.N with no leading zeroes.`
  );
}

export function validateVersionConsistency(expectedVersion, entries) {
  const mismatches = entries.filter(
    ({ version }) => version !== expectedVersion
  );
  if (mismatches.length === 0) {
    return;
  }

  const details = mismatches
    .map(
      ({ source, version }) =>
        `- ${source}: ${version === undefined ? "<missing>" : JSON.stringify(version)}`
    )
    .join("\n");
  throw new Error(
    `Release tag version ${JSON.stringify(expectedVersion)} does not match repository package versions:\n${details}`
  );
}

export async function collectRepositoryVersions(rootDir = REPOSITORY_ROOT) {
  const rootPackagePath = path.join(rootDir, "package.json");
  const rootPackage = await readJson(rootPackagePath);
  const workspacePaths = await resolveWorkspacePaths(rootDir, rootPackage);
  const packagePaths = ["", ...workspacePaths];
  const packageEntries = await Promise.all(
    packagePaths.map(async (relativePath) => {
      const manifestPath = relativePath
        ? path.join(rootDir, relativePath, "package.json")
        : rootPackagePath;
      const manifest = relativePath
        ? await readJson(manifestPath)
        : rootPackage;
      return {
        source: relativePath ? `${relativePath}/package.json` : "package.json",
        version: manifest.version
      };
    })
  );

  const lockfile = await readJson(path.join(rootDir, "package-lock.json"));
  const lockEntries = [
    { source: "package-lock.json#version", version: lockfile.version },
    ...packagePaths.map((relativePath) => ({
      source: relativePath
        ? `package-lock.json#packages[${JSON.stringify(relativePath)}]`
        : 'package-lock.json#packages[""]',
      version: lockfile.packages?.[relativePath]?.version
    }))
  ];

  return [...packageEntries, ...lockEntries];
}

export async function resolveReleaseMetadata({
  tag,
  rootDir = REPOSITORY_ROOT
}) {
  const metadata = classifyReleaseTag(tag);
  const versions = await collectRepositoryVersions(rootDir);
  validateVersionConsistency(metadata.version, versions);
  return metadata;
}

async function resolveWorkspacePaths(rootDir, rootPackage) {
  if (!Array.isArray(rootPackage.workspaces)) {
    throw new Error("package.json workspaces must be an array.");
  }

  const resolved = [];
  for (const pattern of rootPackage.workspaces) {
    if (typeof pattern !== "string" || !pattern.endsWith("/*")) {
      throw new Error(
        `Unsupported workspace pattern ${JSON.stringify(pattern)}; expected a directory/* pattern.`
      );
    }
    const parent = pattern.slice(0, -2);
    const directoryEntries = await readdir(path.join(rootDir, parent), {
      withFileTypes: true
    });
    for (const entry of directoryEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const workspacePath = path.posix.join(parent, entry.name);
      try {
        await access(path.join(rootDir, workspacePath, "package.json"));
        resolved.push(workspacePath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
  return resolved.sort();
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function main() {
  const tag = process.env.GITHUB_REF_NAME;
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!tag) {
    throw new Error("GITHUB_REF_NAME is required.");
  }
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required.");
  }

  const metadata = await resolveReleaseMetadata({ tag });
  const output = [
    `version=${metadata.version}`,
    `release_kind=${metadata.releaseKind}`,
    `is_prerelease=${String(metadata.isPrerelease)}`
  ].join("\n");
  await appendFile(outputPath, `${output}\n`, "utf8");
  console.log(
    `Validated ${tag} as ${metadata.releaseKind} version ${metadata.version}.`
  );
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

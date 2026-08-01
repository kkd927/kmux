import {
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fromMarkdown } from "mdast-util-from-markdown";

const SUPPORTED_IMAGE_EXTENSION = /\.(?:gif|jpe?g|png|webp)$/iu;

export function loadBundledReleaseNotes({
  repoRoot,
  version: requestedVersion
}) {
  const desktopPackagePath = path.join(
    repoRoot,
    "apps",
    "desktop",
    "package.json"
  );
  const version =
    requestedVersion ??
    JSON.parse(readFileSync(desktopPackagePath, "utf8")).version;
  if (typeof version !== "string" || !version.trim()) {
    throw new Error(
      `Desktop package version is missing from ${desktopPackagePath}.`
    );
  }

  const noteDirectory = path.join(repoRoot, "docs", "release-notes");
  const defaultFileName = `v${version}.md`;
  const localizedFilePrefix = `v${version}.`;
  let fileNames;
  try {
    fileNames = readdirSync(noteDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const localizedSources = [];
  const normalizedLocales = new Map();
  for (const fileName of fileNames.sort()) {
    if (
      fileName === defaultFileName ||
      !fileName.startsWith(localizedFilePrefix) ||
      !fileName.endsWith(".md")
    ) {
      continue;
    }
    const locale = fileName.slice(localizedFilePrefix.length, -".md".length);
    const normalizedLocale = normalizeReleaseNoteLocale(locale, fileName);
    const duplicateFileName = normalizedLocales.get(normalizedLocale);
    if (duplicateFileName) {
      throw new Error(
        `Release note locales ${JSON.stringify(duplicateFileName)} and ${JSON.stringify(fileName)} both normalize to ${JSON.stringify(normalizedLocale)}.`
      );
    }
    normalizedLocales.set(normalizedLocale, fileName);
    localizedSources.push({
      locale: normalizedLocale,
      notePath: path.join(noteDirectory, fileName)
    });
  }

  const defaultNotePath = path.join(noteDirectory, defaultFileName);
  let defaultMarkdown = null;
  try {
    defaultMarkdown = readFileSync(defaultNotePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  if (!defaultMarkdown?.trim()) {
    if (localizedSources.length > 0) {
      throw new Error(
        `Localized release notes for v${version} require a non-empty default ${defaultFileName}.`
      );
    }
    return null;
  }

  const defaultReleaseNotes = loadReleaseNoteDocument({
    markdown: defaultMarkdown,
    notePath: defaultNotePath
  });
  const localized = {};
  for (const source of localizedSources) {
    const markdown = readFileSync(source.notePath, "utf8");
    if (!markdown.trim()) {
      continue;
    }
    localized[source.locale] = loadReleaseNoteDocument({
      markdown,
      notePath: source.notePath
    });
  }

  return {
    version,
    default: defaultReleaseNotes,
    localized
  };
}

function loadReleaseNoteDocument({ markdown, notePath }) {
  return {
    markdown,
    notePath,
    images: resolveReleaseNoteImages({
      markdown,
      notePath
    })
  };
}

function normalizeReleaseNoteLocale(locale, fileName) {
  let normalized;
  try {
    [normalized] = Intl.getCanonicalLocales(locale);
  } catch {
    throw new Error(
      `Invalid release note locale suffix in ${JSON.stringify(fileName)}.`
    );
  }
  if (!normalized) {
    throw new Error(
      `Invalid release note locale suffix in ${JSON.stringify(fileName)}.`
    );
  }
  return normalized;
}

export function resolveReleaseNoteImages({ markdown, notePath }) {
  const sources = collectMarkdownImageOccurrences(markdown).map(
    ({ source }) => source
  );
  const expectedPrefix = "assets/";
  const assetDirectory = path.resolve(path.dirname(notePath), "assets");

  return [...new Set(sources)].map((source) => {
    const documentRelativeSource = source.startsWith("./")
      ? source.slice("./".length)
      : source;
    if (
      !documentRelativeSource.startsWith(expectedPrefix) ||
      source.includes("\\") ||
      source.includes("?") ||
      source.includes("#")
    ) {
      throw invalidImageSourceError(source);
    }

    const encodedRelativeAssetPath = documentRelativeSource.slice(
      expectedPrefix.length
    );
    let relativeAssetPath;
    try {
      relativeAssetPath = decodeURIComponent(encodedRelativeAssetPath);
    } catch {
      throw invalidImageSourceError(source);
    }
    if (
      !relativeAssetPath ||
      relativeAssetPath.includes("\0") ||
      path.posix.normalize(relativeAssetPath) !== relativeAssetPath ||
      relativeAssetPath.startsWith("/") ||
      !SUPPORTED_IMAGE_EXTENSION.test(relativeAssetPath)
    ) {
      throw invalidImageSourceError(source);
    }

    const absolutePath = path.resolve(assetDirectory, relativeAssetPath);
    assertPathInside(assetDirectory, absolutePath, source);

    let realAssetDirectory;
    let realAssetPath;
    try {
      realAssetDirectory = realpathSync(assetDirectory);
      realAssetPath = realpathSync(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(
          `Release note image ${JSON.stringify(source)} does not exist.`
        );
      }
      throw error;
    }
    assertPathInside(realAssetDirectory, realAssetPath, source);
    if (!statSync(realAssetPath).isFile()) {
      throw new Error(
        `Release note image ${JSON.stringify(source)} is not a file.`
      );
    }

    return { source, absolutePath: realAssetPath };
  });
}

export function rewriteReleaseNoteImagesForGitHub(markdown, options) {
  const images = resolveReleaseNoteImages({
    markdown,
    notePath: options.notePath
  });
  const rawUrls = new Map();
  for (const image of images) {
    const documentRelativeSource = image.source.startsWith("./")
      ? image.source.slice("./".length)
      : image.source;
    const repositoryPath = [
      "docs",
      "release-notes",
      ...decodeURIComponent(documentRelativeSource).split("/")
    ]
      .map(encodeURIComponent)
      .join("/");
    const rawUrl = `https://raw.githubusercontent.com/${options.repository}/${encodeURIComponent(options.tag)}/${repositoryPath}`;
    rawUrls.set(image.source, rawUrl);
  }

  const replacements = collectMarkdownImageOccurrences(markdown)
    .map((occurrence) => {
      const rawUrl = rawUrls.get(occurrence.source);
      if (!rawUrl) {
        throw new Error(
          `Release note image ${JSON.stringify(occurrence.source)} was not validated.`
        );
      }
      const segment = markdown.slice(occurrence.start, occurrence.end);
      const destinationStart =
        occurrence.kind === "image"
          ? Math.max(0, segment.indexOf("](") + 2)
          : Math.max(0, segment.indexOf(":") + 1);
      const sourceOffset = segment.indexOf(occurrence.source, destinationStart);
      if (sourceOffset < 0) {
        throw new Error(
          `Could not locate release note image ${JSON.stringify(occurrence.source)} in its Markdown source.`
        );
      }
      return {
        start: occurrence.start + sourceOffset,
        end: occurrence.start + sourceOffset + occurrence.source.length,
        rawUrl
      };
    })
    .filter(
      (replacement, index, allReplacements) =>
        allReplacements.findIndex(
          (candidate) =>
            candidate.start === replacement.start &&
            candidate.end === replacement.end
        ) === index
    )
    .sort((left, right) => right.start - left.start);

  let rewritten = markdown;
  for (const replacement of replacements) {
    rewritten =
      rewritten.slice(0, replacement.start) +
      replacement.rawUrl +
      rewritten.slice(replacement.end);
  }
  return rewritten;
}

export function prepareGitHubReleaseNotes({
  repoRoot,
  repository,
  tag,
  outputPath
}) {
  if (!/^v[^/]+$/u.test(tag)) {
    throw new Error(`Invalid release tag ${JSON.stringify(tag)}.`);
  }
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
    throw new Error(`Invalid GitHub repository ${JSON.stringify(repository)}.`);
  }

  const version = tag.slice(1);
  const releaseNotes = loadBundledReleaseNotes({ repoRoot, version });
  if (!releaseNotes) {
    return false;
  }
  const rewritten = rewriteReleaseNoteImagesForGitHub(
    releaseNotes.default.markdown,
    {
      notePath: releaseNotes.default.notePath,
      repository,
      tag
    }
  );
  writeFileSync(outputPath, rewritten, "utf8");
  return true;
}

function collectMarkdownImageOccurrences(markdown) {
  const tree = fromMarkdown(markdown);
  const definitions = new Map();
  const occurrences = [];

  visit(tree, (node) => {
    if (
      node.type === "definition" &&
      typeof node.identifier === "string" &&
      typeof node.url === "string"
    ) {
      definitions.set(node.identifier, node);
    }
  });
  visit(tree, (node) => {
    if (node.type === "image" && typeof node.url === "string") {
      occurrences.push(imageOccurrence(node, node.url, "image"));
      return;
    }
    if (node.type === "imageReference" && typeof node.identifier === "string") {
      const definition = definitions.get(node.identifier);
      if (definition) {
        occurrences.push(
          imageOccurrence(definition, definition.url, "definition")
        );
      }
    }
  });

  return occurrences;
}

function imageOccurrence(node, source, kind) {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (
    typeof source !== "string" ||
    typeof start !== "number" ||
    typeof end !== "number"
  ) {
    throw new Error("Release note image is missing a Markdown source range.");
  }
  return { source, start, end, kind };
}

function visit(node, visitor) {
  visitor(node);
  if (!Array.isArray(node.children)) {
    return;
  }
  for (const child of node.children) {
    visit(child, visitor);
  }
}

function assertPathInside(parentPath, candidatePath, source) {
  const relative = path.relative(parentPath, candidatePath);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    if (!relative) {
      throw new Error(
        `Release note image ${JSON.stringify(source)} must name a file.`
      );
    }
    throw invalidImageSourceError(source);
  }
}

function invalidImageSourceError(source) {
  return new Error(
    `Invalid release note image ${JSON.stringify(source)}. Images must be local PNG, JPEG, WebP, or GIF files under assets/.`
  );
}

function parseCliArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("Expected --tag, --repository, and --output arguments.");
    }
    values.set(name.slice(2), value);
  }
  return values;
}

function main() {
  const args = parseCliArguments(process.argv.slice(2));
  const tag = args.get("tag");
  const repository = args.get("repository");
  const outputPath = args.get("output");
  if (!tag || !repository || !outputPath) {
    throw new Error("--tag, --repository, and --output are required.");
  }
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  const prepared = prepareGitHubReleaseNotes({
    repoRoot,
    repository,
    tag,
    outputPath: path.resolve(outputPath)
  });
  if (!prepared) {
    throw new Error(`No non-empty release notes exist for ${tag}.`);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

const fs = require("node:fs/promises");
const path = require("node:path");

const { signApp, walkAsync } = require("@electron/osx-sign");

const MACH_O_MAGIC = new Set([
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca"
]);

function isEnabled(value) {
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

function shouldRequireSigning(env = process.env) {
  return isEnabled(env.KMUX_REQUIRE_SIGNING);
}

function isBundlePath(targetPath) {
  const extension = path.extname(targetPath);
  return extension === ".app" || extension === ".framework";
}

async function isMachOFile(targetPath) {
  let handle;
  try {
    handle = await fs.open(targetPath, "r");
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 4) {
      return false;
    }

    return MACH_O_MAGIC.has(header.toString("hex"));
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

async function isCodeSignTarget(targetPath) {
  if (isBundlePath(targetPath)) {
    return true;
  }

  return isMachOFile(targetPath);
}

function countSharedTrailingSegments(leftPath, rightPath) {
  const leftParts = leftPath.split(path.sep).filter(Boolean);
  const rightParts = rightPath.split(path.sep).filter(Boolean);
  const maxLength = Math.min(leftParts.length, rightParts.length);
  let sharedCount = 0;

  while (sharedCount < maxLength) {
    const leftSegment = leftParts[leftParts.length - 1 - sharedCount];
    const rightSegment = rightParts[rightParts.length - 1 - sharedCount];
    if (leftSegment !== rightSegment) {
      break;
    }

    sharedCount += 1;
  }

  return sharedCount;
}

function scoreCanonicalPath(targetPath, resolvedPath) {
  const trailingMatchCount = countSharedTrailingSegments(targetPath, resolvedPath);

  if (targetPath === resolvedPath) {
    return [0, 0, -trailingMatchCount, targetPath.length, targetPath];
  }

  if (!targetPath.includes("/Versions/Current/")) {
    return [1, 0, -trailingMatchCount, targetPath.length, targetPath];
  }

  return [1, 1, -trailingMatchCount, targetPath.length, targetPath];
}

function chooseCanonicalPath(paths, resolvedPath) {
  return [...paths].sort((left, right) => {
    const leftScore = scoreCanonicalPath(left, resolvedPath);
    const rightScore = scoreCanonicalPath(right, resolvedPath);
    const comparedLength = Math.min(leftScore.length, rightScore.length);

    for (let index = 0; index < comparedLength; index += 1) {
      if (leftScore[index] < rightScore[index]) {
        return -1;
      }

      if (leftScore[index] > rightScore[index]) {
        return 1;
      }
    }

    return 0;
  })[0];
}

function matchesOriginalIgnore(originalIgnore, filePath) {
  if (typeof originalIgnore === "function") {
    return originalIgnore(filePath);
  }

  if (Array.isArray(originalIgnore)) {
    return originalIgnore.some((value) => filePath.match(value));
  }

  return false;
}

async function buildIgnoreSet(appPath) {
  const walkedPaths = await walkAsync(path.join(appPath, "Contents"));
  const skippedNonCode = new Set();
  const buckets = new Map();

  for (const walkedPath of walkedPaths) {
    if (!(await isCodeSignTarget(walkedPath))) {
      skippedNonCode.add(walkedPath);
      continue;
    }

    const resolvedPath = await fs.realpath(walkedPath);
    const bucket = buckets.get(resolvedPath) ?? [];
    bucket.push(walkedPath);
    buckets.set(resolvedPath, bucket);
  }

  const duplicateAliases = new Set();
  for (const [resolvedPath, bucket] of buckets.entries()) {
    const canonicalPath = chooseCanonicalPath(bucket, resolvedPath);
    for (const candidate of bucket) {
      if (candidate !== canonicalPath) {
        duplicateAliases.add(candidate);
      }
    }
  }

  return {
    walkedCount: walkedPaths.length,
    skippedNonCode,
    duplicateAliases,
    finalSignTargets: walkedPaths.length - skippedNonCode.size - duplicateAliases.size
  };
}

async function customMacSign(opts) {
  if (!shouldRequireSigning()) {
    console.log(
      "[custom-mac-sign] Skipping signing because KMUX_REQUIRE_SIGNING is not enabled."
    );
    return;
  }

  const originalIgnore = opts.ignore;
  const {
    walkedCount,
    skippedNonCode,
    duplicateAliases,
    finalSignTargets
  } = await buildIgnoreSet(opts.app);

  console.log(
    `[custom-mac-sign] Walked ${walkedCount} paths; skipped ${skippedNonCode.size} non-code entries; filtered ${duplicateAliases.size} duplicate aliases; signing ${finalSignTargets}.`
  );

  await signApp({
    ...opts,
    ignore(filePath) {
      return (
        matchesOriginalIgnore(originalIgnore, filePath) ||
        skippedNonCode.has(filePath) ||
        duplicateAliases.has(filePath)
      );
    }
  });

  console.log("[custom-mac-sign] Signing completed.");
}

module.exports = customMacSign;
module.exports.default = customMacSign;
module.exports._test = {
  MACH_O_MAGIC,
  isEnabled,
  shouldRequireSigning,
  isBundlePath,
  isMachOFile,
  isCodeSignTarget,
  countSharedTrailingSegments,
  scoreCanonicalPath,
  chooseCanonicalPath,
  matchesOriginalIgnore,
  buildIgnoreSet
};

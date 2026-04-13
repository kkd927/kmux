const fs = require("node:fs/promises");
const path = require("node:path");
const { sign, walkAsync } = require("@electron/osx-sign");

const MACH_O_MAGIC = new Set([
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
]);

function chooseCanonicalPath(paths) {
  return [...paths].sort((left, right) => scorePath(left) - scorePath(right) || left.length - right.length)[0];
}

function scorePath(targetPath) {
  if (targetPath.includes("/Versions/A/")) {
    return 0;
  }

  if (targetPath.includes("/Versions/") && !targetPath.includes("/Versions/Current/")) {
    return 1;
  }

  if (!targetPath.includes("/Versions/Current/")) {
    return 2;
  }

  return 3;
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
  } finally {
    await handle?.close();
  }
}

async function buildIgnoreSet(appPath) {
  const contentsPath = path.join(appPath, "Contents");
  const walkedPaths = await walkAsync(contentsPath);
  const skippedNonCode = new Set();
  const buckets = new Map();

  for (const walkedPath of walkedPaths) {
    const ext = path.extname(walkedPath);
    const isBundle = ext === ".app" || ext === ".framework";

    if (!isBundle && !(await isMachOFile(walkedPath))) {
      skippedNonCode.add(walkedPath);
      continue;
    }

    const resolvedPath = await fs.realpath(walkedPath);
    const bucket = buckets.get(resolvedPath) ?? [];
    bucket.push(walkedPath);
    buckets.set(resolvedPath, bucket);
  }

  const duplicateAliases = new Set();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) {
      continue;
    }

    const canonicalPath = chooseCanonicalPath(bucket);
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
  };
}

async function customMacSign(opts) {
  const originalIgnore = opts.ignore;
  const { walkedCount, skippedNonCode, duplicateAliases } = await buildIgnoreSet(opts.app);
  const skippedCount = skippedNonCode.size + duplicateAliases.size;

  console.log(
    `[custom-mac-sign] Walked ${walkedCount} paths; signing ${walkedCount - skippedCount} after filtering ${skippedNonCode.size} non-code entries and ${duplicateAliases.size} duplicate aliases.`,
  );

  return sign({
    ...opts,
    ignore(filePath) {
      const originalResult =
        typeof originalIgnore === "function" ? originalIgnore(filePath) : Array.isArray(originalIgnore) ? originalIgnore.some((value) => filePath.match(value)) : false;

      return originalResult || skippedNonCode.has(filePath) || duplicateAliases.has(filePath);
    },
  });
}

module.exports = customMacSign;
module.exports.default = customMacSign;

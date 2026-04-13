const { signApp, walkAsync } = require("@electron/osx-sign");

const fs = require("node:fs/promises");

function chooseCanonicalPath(paths) {
  return [...paths].sort((left, right) => scorePath(left) - scorePath(right) || left.length - right.length)[0];
}

function scorePath(targetPath) {
  if (!targetPath.includes("/Versions/")) {
    return 0;
  }

  if (targetPath.includes("/Versions/A/")) {
    return 1;
  }

  if (!targetPath.includes("/Versions/Current/")) {
    return 2;
  }

  return 3;
}

async function buildIgnoreSet(appPath) {
  const walkedPaths = await walkAsync(`${appPath}/Contents`);
  const buckets = new Map();

  for (const walkedPath of walkedPaths) {
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
    duplicateAliases,
  };
}

async function customMacSign(opts) {
  const originalIgnore = opts.ignore;
  const { walkedCount, duplicateAliases } = await buildIgnoreSet(opts.app);

  console.log(
    `[custom-mac-sign] Walked ${walkedCount} paths; signing ${walkedCount - duplicateAliases.size} after filtering ${duplicateAliases.size} duplicate aliases.`,
  );

  await signApp({
    ...opts,
    ignore(filePath) {
      const originalResult =
        typeof originalIgnore === "function" ? originalIgnore(filePath) : Array.isArray(originalIgnore) ? originalIgnore.some((value) => filePath.match(value)) : false;

      return originalResult || duplicateAliases.has(filePath);
    },
  });

  console.log("[custom-mac-sign] Signing completed.");
}

module.exports = customMacSign;
module.exports.default = customMacSign;

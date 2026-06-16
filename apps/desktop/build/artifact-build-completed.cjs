const path = require("node:path");

const { createBlockmap } = require("app-builder-lib/out/targets/differentialUpdateInfoBuilder");

const customMacArtifactNotarize = require("./custom-mac-artifact-notarize.cjs");

function isMacDmgArtifact(context) {
  return path.extname(context.file ?? "").toLowerCase() === ".dmg";
}

function isLinuxAppImageArtifact(context) {
  return path.extname(context.file ?? "").toLowerCase() === ".appimage";
}

async function buildLinuxAppImageBlockmap(context, createBlockmapFn = createBlockmap) {
  const safeArtifactName = context.safeArtifactName ?? path.basename(context.file);
  await createBlockmapFn(
    context.file,
    context.target,
    context.packager,
    safeArtifactName
  );
}

async function artifactBuildCompleted(context) {
  if (!isMacDmgArtifact(context)) {
    if (isLinuxAppImageArtifact(context)) {
      await buildLinuxAppImageBlockmap(context);
    }
    return;
  }
  return customMacArtifactNotarize(context);
}

module.exports = artifactBuildCompleted;
module.exports.default = artifactBuildCompleted;
module.exports._test = {
  buildLinuxAppImageBlockmap,
  isLinuxAppImageArtifact,
  isMacDmgArtifact
};

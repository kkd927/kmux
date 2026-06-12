const path = require("node:path");

const customMacArtifactNotarize = require("./custom-mac-artifact-notarize.cjs");

function isMacDmgArtifact(context) {
  return path.extname(context.file ?? "").toLowerCase() === ".dmg";
}

async function artifactBuildCompleted(context) {
  if (!isMacDmgArtifact(context)) {
    return;
  }
  return customMacArtifactNotarize(context);
}

module.exports = artifactBuildCompleted;
module.exports.default = artifactBuildCompleted;
module.exports._test = {
  isMacDmgArtifact
};

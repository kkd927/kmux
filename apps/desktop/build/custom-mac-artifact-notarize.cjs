const path = require("node:path");

const { notarize } = require("@electron/notarize");

function isDmgArtifact(context) {
  return path.extname(context.file).toLowerCase() === ".dmg";
}

function getNotarizeOptions(filePath, env = process.env) {
  const tool = "notarytool";

  const appleId = env.APPLE_ID;
  const appleIdPassword = env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = env.APPLE_TEAM_ID;
  if (appleId || appleIdPassword) {
    if (!appleId) {
      throw new Error("APPLE_ID env var needs to be set");
    }
    if (!appleIdPassword) {
      throw new Error("APPLE_APP_SPECIFIC_PASSWORD env var needs to be set");
    }
    if (!teamId) {
      throw new Error("APPLE_TEAM_ID env var needs to be set");
    }

    return {
      tool,
      appPath: filePath,
      appleId,
      appleIdPassword,
      teamId
    };
  }

  const appleApiKey = env.APPLE_API_KEY;
  const appleApiKeyId = env.APPLE_API_KEY_ID;
  const appleApiIssuer = env.APPLE_API_ISSUER;
  if (appleApiKey || appleApiKeyId || appleApiIssuer) {
    if (!appleApiKey || !appleApiKeyId || !appleApiIssuer) {
      throw new Error(
        "Env vars APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER need to be set"
      );
    }

    return {
      tool,
      appPath: filePath,
      appleApiKey,
      appleApiKeyId,
      appleApiIssuer
    };
  }

  const keychainProfile = env.APPLE_KEYCHAIN_PROFILE;
  const keychain = env.APPLE_KEYCHAIN;
  if (keychainProfile) {
    const options = {
      tool,
      appPath: filePath,
      keychainProfile
    };

    if (keychain) {
      return {
        ...options,
        keychain
      };
    }

    return options;
  }

  return undefined;
}

async function customMacArtifactNotarize(context) {
  if (!isDmgArtifact(context)) {
    return;
  }

  const options = getNotarizeOptions(context.file);
  if (!options) {
    console.log(
      `[custom-mac-artifact-notarize] Skipping ${path.basename(context.file)} because notarization credentials were not provided.`
    );
    return;
  }

  console.log(
    `[custom-mac-artifact-notarize] Notarizing and stapling ${path.basename(context.file)}.`
  );
  await notarize(options);
  console.log(
    `[custom-mac-artifact-notarize] Notarization completed for ${path.basename(context.file)}.`
  );
}

module.exports = customMacArtifactNotarize;
module.exports.default = customMacArtifactNotarize;
module.exports._test = {
  isDmgArtifact,
  getNotarizeOptions
};

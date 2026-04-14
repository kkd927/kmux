import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const customMacArtifactNotarizeModule = require("./custom-mac-artifact-notarize.cjs") as {
  _test: {
    isDmgArtifact: (context: { file: string }) => boolean;
    getNotarizeOptions: (
      filePath: string,
      env?: NodeJS.ProcessEnv
    ) =>
      | {
          tool: string;
          appPath: string;
          appleApiKey?: string;
          appleApiKeyId?: string;
          appleApiIssuer?: string;
          appleId?: string;
          appleIdPassword?: string;
          teamId?: string;
          keychainProfile?: string;
          keychain?: string;
        }
      | undefined;
  };
};

const { getNotarizeOptions, isDmgArtifact } = customMacArtifactNotarizeModule._test;

describe("custom-mac-artifact-notarize", () => {
  it("targets dmg artifacts only", () => {
    expect(isDmgArtifact({ file: "/tmp/kmux-0.1.8-mac-arm64.dmg" })).toBe(true);
    expect(isDmgArtifact({ file: "/tmp/kmux.app" })).toBe(false);
  });

  it("builds App Store Connect notarization options from env", () => {
    expect(
      getNotarizeOptions("/tmp/kmux.dmg", {
        APPLE_API_KEY: "/tmp/AuthKey_TEST.p8",
        APPLE_API_KEY_ID: "ABC1234567",
        APPLE_API_ISSUER: "issuer-uuid"
      })
    ).toEqual({
      tool: "notarytool",
      appPath: "/tmp/kmux.dmg",
      appleApiKey: "/tmp/AuthKey_TEST.p8",
      appleApiKeyId: "ABC1234567",
      appleApiIssuer: "issuer-uuid"
    });
  });

  it("builds keychain-profile notarization options from env", () => {
    expect(
      getNotarizeOptions("/tmp/kmux.dmg", {
        APPLE_KEYCHAIN_PROFILE: "kmux-profile",
        APPLE_KEYCHAIN: "/tmp/login.keychain-db"
      })
    ).toEqual({
      tool: "notarytool",
      appPath: "/tmp/kmux.dmg",
      keychainProfile: "kmux-profile",
      keychain: "/tmp/login.keychain-db"
    });
  });

  it("returns undefined when notarization credentials are absent", () => {
    expect(getNotarizeOptions("/tmp/kmux.dmg", {})).toBeUndefined();
  });
});

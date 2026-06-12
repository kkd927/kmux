import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const artifactBuildCompletedModule =
  require("./artifact-build-completed.cjs") as {
    _test: {
      isMacDmgArtifact: (context: { file?: string }) => boolean;
    };
  };

const { isMacDmgArtifact } = artifactBuildCompletedModule._test;

describe("artifact-build-completed hook", () => {
  it("routes only macOS DMG artifacts to the macOS notarization hook", () => {
    expect(isMacDmgArtifact({ file: "/tmp/kmux-0.3.12-mac-arm64.dmg" })).toBe(
      true
    );
    expect(
      isMacDmgArtifact({ file: "/tmp/kmux-0.3.12-linux-x64.AppImage" })
    ).toBe(false);
    expect(isMacDmgArtifact({ file: "/tmp/latest-linux.yml" })).toBe(false);
    expect(isMacDmgArtifact({ file: "/tmp/kmux-0.3.12-mac-arm64.zip" })).toBe(
      false
    );
  });
});

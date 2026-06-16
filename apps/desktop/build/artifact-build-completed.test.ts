import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const artifactBuildCompletedModule =
  require("./artifact-build-completed.cjs") as {
    _test: {
      buildLinuxAppImageBlockmap: (
        context: {
          file: string;
          target?: unknown;
          packager?: unknown;
          safeArtifactName?: string | null;
        },
        createBlockmapFn: (
          file: string,
          target: unknown,
          packager: unknown,
          safeArtifactName: string
        ) => Promise<void>
      ) => Promise<void>;
      isLinuxAppImageArtifact: (context: { file?: string }) => boolean;
      isMacDmgArtifact: (context: { file?: string }) => boolean;
    };
  };

const {
  buildLinuxAppImageBlockmap,
  isLinuxAppImageArtifact,
  isMacDmgArtifact
} = artifactBuildCompletedModule._test;

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

  it("routes only Linux AppImage artifacts to blockmap sidecar generation", () => {
    expect(
      isLinuxAppImageArtifact({
        file: "/tmp/kmux-0.3.12-linux-arm64.AppImage"
      })
    ).toBe(true);
    expect(
      isLinuxAppImageArtifact({
        file: "/tmp/kmux-0.3.12-linux-arm64.AppImage.blockmap"
      })
    ).toBe(false);
    expect(isLinuxAppImageArtifact({ file: "/tmp/latest-linux.yml" })).toBe(
      false
    );
    expect(
      isLinuxAppImageArtifact({ file: "/tmp/kmux-0.3.12-mac-arm64.dmg" })
    ).toBe(false);
  });

  it("builds a Linux AppImage blockmap sidecar with the emitted artifact name", async () => {
    const createBlockmap = vi.fn(async () => {});
    const target = {};
    const packager = {};

    await buildLinuxAppImageBlockmap(
      {
        file: "/tmp/kmux-0.3.12-linux-arm64.AppImage",
        target,
        packager,
        safeArtifactName: "kmux-0.3.12-linux-arm64.AppImage"
      },
      createBlockmap
    );

    expect(createBlockmap).toHaveBeenCalledWith(
      "/tmp/kmux-0.3.12-linux-arm64.AppImage",
      target,
      packager,
      "kmux-0.3.12-linux-arm64.AppImage"
    );
  });
});

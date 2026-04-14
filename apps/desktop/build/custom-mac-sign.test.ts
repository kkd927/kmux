import { access, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const customMacSignModule = require("./custom-mac-sign.cjs") as {
  _test: {
    buildIgnoreSet: (appPath: string) => Promise<{
      walkedCount: number;
      skippedNonCode: Set<string>;
      duplicateAliases: Set<string>;
      finalSignTargets: number;
    }>;
    chooseCanonicalPath: (paths: string[], resolvedPath: string) => string;
    isEnabled: (value: string | undefined) => boolean;
    shouldRequireSigning: (env?: NodeJS.ProcessEnv) => boolean;
  };
};

const {
  buildIgnoreSet,
  chooseCanonicalPath,
  isEnabled,
  shouldRequireSigning
} = customMacSignModule._test;

async function createFrameworkFixture() {
  const root = await mkdtemp(join(tmpdir(), "kmux-custom-sign-"));
  const appPath = join(root, "Fixture.app");
  const frameworkPath = join(
    appPath,
    "Contents",
    "Frameworks",
    "Fixture Framework.framework"
  );
  const versionsPath = join(frameworkPath, "Versions");
  const versionAPath = join(versionsPath, "A");
  const resourcesPath = join(versionAPath, "Resources");
  const binaryPath = join(versionAPath, "Fixture Framework");
  const pakPath = join(resourcesPath, "locale.pak");
  const nibPath = join(resourcesPath, "MainMenu.nib");
  const dataPath = join(resourcesPath, "icudtl.dat");

  await mkdir(resourcesPath, { recursive: true });
  await writeFile(binaryPath, Buffer.from("feedfacf00000000", "hex"));
  await writeFile(pakPath, Buffer.from([0, 1, 2, 3, 4, 5]));
  await writeFile(nibPath, Buffer.from([6, 7, 8, 9, 10, 11]));
  await writeFile(dataPath, Buffer.from([12, 13, 14, 15, 16, 17]));
  await symlink("A", join(versionsPath, "Current"));
  await symlink(
    "Versions/Current/Fixture Framework",
    join(frameworkPath, "Fixture Framework")
  );
  await symlink("Versions/Current/Resources", join(frameworkPath, "Resources"));

  return {
    appPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
    paths: {
      actualBinary: binaryPath,
      currentBinary: join(
        frameworkPath,
        "Versions",
        "Current",
        "Fixture Framework"
      ),
      rootBinary: join(frameworkPath, "Fixture Framework"),
      pakPath,
      nibPath,
      dataPath
    }
  };
}

describe("custom-mac-sign", () => {
  it("prefers the non-symlink target when deduping versioned framework aliases", async () => {
    const fixture = await createFrameworkFixture();

    try {
      const canonicalPath = chooseCanonicalPath(
        [
          fixture.paths.rootBinary,
          fixture.paths.actualBinary,
          fixture.paths.currentBinary
        ],
        fixture.paths.actualBinary
      );

      expect(canonicalPath).toBe(fixture.paths.actualBinary);

      const ignoreSet = await buildIgnoreSet(fixture.appPath);
      expect(ignoreSet.duplicateAliases.has(fixture.paths.rootBinary)).toBe(true);
      expect(ignoreSet.duplicateAliases.has(fixture.paths.currentBinary)).toBe(true);
      expect(ignoreSet.duplicateAliases.has(fixture.paths.actualBinary)).toBe(false);
      expect(ignoreSet.finalSignTargets).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it("filters non-code resources while keeping bundles and Mach-O binaries", async () => {
    const fixture = await createFrameworkFixture();

    try {
      const ignoreSet = await buildIgnoreSet(fixture.appPath);

      expect(ignoreSet.skippedNonCode.has(fixture.paths.pakPath)).toBe(true);
      expect(ignoreSet.skippedNonCode.has(fixture.paths.nibPath)).toBe(true);
      expect(ignoreSet.skippedNonCode.has(fixture.paths.dataPath)).toBe(true);
      expect(ignoreSet.finalSignTargets).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it("shrinks Electron.app signing to a code-only unique set", async () => {
    const electronAppPath = resolve("node_modules/electron/dist/Electron.app");
    await access(electronAppPath);

    const ignoreSet = await buildIgnoreSet(electronAppPath);

    expect(ignoreSet.walkedCount).toBeGreaterThan(0);
    expect(ignoreSet.skippedNonCode.size).toBeGreaterThan(ignoreSet.walkedCount / 2);
    expect(ignoreSet.duplicateAliases.size).toBeGreaterThan(0);
    expect(ignoreSet.finalSignTargets).toBeLessThan(ignoreSet.walkedCount / 4);
    expect(
      ignoreSet.walkedCount -
        ignoreSet.skippedNonCode.size -
        ignoreSet.duplicateAliases.size
    ).toBe(ignoreSet.finalSignTargets);
  });

  it("keeps the framework root binary as a symlink to the current version", async () => {
    const fixture = await createFrameworkFixture();

    try {
      expect(
        await readlink(
          join(
            fixture.appPath,
            "Contents",
            "Frameworks",
            "Fixture Framework.framework",
            "Fixture Framework"
          )
        )
      ).toBe("Versions/Current/Fixture Framework");
    } finally {
      await fixture.cleanup();
    }
  });

  it("treats KMUX_REQUIRE_SIGNING as opt-in", () => {
    expect(isEnabled(undefined)).toBe(false);
    expect(isEnabled("0")).toBe(false);
    expect(isEnabled("true")).toBe(true);
    expect(isEnabled("ON")).toBe(true);
  });

  it("requires signing only when KMUX_REQUIRE_SIGNING is enabled", () => {
    expect(shouldRequireSigning({})).toBe(false);
    expect(shouldRequireSigning({ KMUX_REQUIRE_SIGNING: "0" })).toBe(false);
    expect(shouldRequireSigning({ KMUX_REQUIRE_SIGNING: "1" })).toBe(true);
  });
});

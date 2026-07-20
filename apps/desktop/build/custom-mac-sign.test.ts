import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
    bundledRemoteRuntimeRoot: (appPath: string) => string;
    createRootOnlyIgnore: (appPath: string) => (filePath: string) => boolean;
    signWithFinalRemoteRuntimeMetadata: (
      opts: Record<string, unknown> & { app: string },
      firstPassIgnore: (filePath: string) => boolean,
      dependencies: {
        signApplication?: (opts: Record<string, unknown>) => Promise<void>;
        refreshRemoteRuntime?: (appPath: string) => Promise<void>;
      }
    ) => Promise<void>;
  };
};

const {
  buildIgnoreSet,
  chooseCanonicalPath,
  isEnabled,
  shouldRequireSigning,
  bundledRemoteRuntimeRoot,
  createRootOnlyIgnore,
  signWithFinalRemoteRuntimeMetadata
} = customMacSignModule._test;

const macOnlyIt = process.platform === "darwin" ? it : it.skip;

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

async function createRuntimeSigningFixture() {
  const root = await mkdtemp(join(tmpdir(), "kmux-runtime-sign-"));
  const appPath = join(root, "Fixture.app");
  const contentsPath = join(appPath, "Contents");
  const macOsPath = join(contentsPath, "MacOS");
  const runtimeDirectory = join(
    contentsPath,
    "Resources",
    "remote-runtime",
    "darwin-x64"
  );
  const mainExecutable = join(macOsPath, "Fixture");
  const runtimeExecutable = join(runtimeDirectory, "kmuxd");
  const manifestPath = join(runtimeDirectory, "manifest.json");
  const entitlementsPath = join(root, "entitlements.plist");

  await mkdir(macOsPath, { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  await copyFile("/usr/bin/true", mainExecutable);
  await copyFile("/usr/bin/true", runtimeExecutable);
  await chmod(mainExecutable, 0o755);
  await chmod(runtimeExecutable, 0o755);
  await writeFile(
    join(contentsPath, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Fixture</string>
<key>CFBundleIdentifier</key><string>dev.kmux.sign-fixture</string>
<key>CFBundleName</key><string>Fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>
`
  );
  await writeFile(manifestPath, "before-signing\n");
  await writeFile(
    entitlementsPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict/></plist>
`
  );

  return {
    appPath,
    runtimeExecutable,
    manifestPath,
    entitlementsPath,
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
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
      expect(ignoreSet.duplicateAliases.has(fixture.paths.rootBinary)).toBe(
        true
      );
      expect(ignoreSet.duplicateAliases.has(fixture.paths.currentBinary)).toBe(
        true
      );
      expect(ignoreSet.duplicateAliases.has(fixture.paths.actualBinary)).toBe(
        false
      );
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

  macOnlyIt(
    "shrinks Electron.app signing to a code-only unique set",
    async () => {
      const electronAppPath = resolve(
        "node_modules/electron/dist/Electron.app"
      );
      await access(electronAppPath);

      const ignoreSet = await buildIgnoreSet(electronAppPath);

      expect(ignoreSet.walkedCount).toBeGreaterThan(0);
      expect(ignoreSet.skippedNonCode.size).toBeGreaterThan(
        ignoreSet.walkedCount / 2
      );
      expect(ignoreSet.duplicateAliases.size).toBeGreaterThan(0);
      expect(ignoreSet.finalSignTargets).toBeLessThan(
        ignoreSet.walkedCount / 4
      );
      expect(
        ignoreSet.walkedCount -
          ignoreSet.skippedNonCode.size -
          ignoreSet.duplicateAliases.size
      ).toBe(ignoreSet.finalSignTargets);
    }
  );

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

  it("refreshes bundled runtime metadata between nested-code and root signing", async () => {
    const appPath = join("/tmp", "Fixture.app");
    const childPath = join(appPath, "Contents", "Resources", "remote-runtime");
    const firstPassIgnore = (filePath: string) => filePath === "ignored";
    const events: Array<
      | { type: "sign"; opts: Record<string, unknown> }
      | { type: "refresh"; appPath: string }
    > = [];

    await signWithFinalRemoteRuntimeMetadata(
      { app: appPath, identity: "fixture-identity" },
      firstPassIgnore,
      {
        async signApplication(opts) {
          events.push({ type: "sign", opts });
        },
        async refreshRemoteRuntime(refreshedAppPath) {
          events.push({ type: "refresh", appPath: refreshedAppPath });
        }
      }
    );

    expect(events.map((event) => event.type)).toEqual([
      "sign",
      "refresh",
      "sign"
    ]);
    expect(events[1]).toEqual({ type: "refresh", appPath });
    const firstSign = events[0];
    const finalSign = events[2];
    expect(firstSign.type).toBe("sign");
    expect(finalSign.type).toBe("sign");
    if (firstSign.type !== "sign" || finalSign.type !== "sign") {
      throw new Error("unexpected signing test event");
    }
    expect(firstSign.opts.ignore).toBe(firstPassIgnore);
    expect(finalSign.opts.preEmbedProvisioningProfile).toBe(false);
    const finalIgnore = finalSign.opts.ignore as (filePath: string) => boolean;
    expect(finalIgnore(childPath)).toBe(true);
    expect(finalIgnore(appPath)).toBe(false);
    expect(createRootOnlyIgnore(appPath)(childPath)).toBe(true);
    expect(bundledRemoteRuntimeRoot(appPath)).toBe(childPath);
  });

  macOnlyIt(
    "reseals refreshed runtime metadata without changing nested signed bytes",
    async () => {
      const fixture = await createRuntimeSigningFixture();
      let nestedHashAfterFirstSign: string | undefined;

      try {
        await signWithFinalRemoteRuntimeMetadata(
          {
            app: fixture.appPath,
            platform: "darwin",
            identity: "-",
            identityValidation: false,
            preAutoEntitlements: false,
            preEmbedProvisioningProfile: false,
            strictVerify: true,
            optionsForFile() {
              return {
                entitlements: fixture.entitlementsPath,
                hardenedRuntime: false,
                timestamp: "none"
              };
            }
          },
          () => false,
          {
            async refreshRemoteRuntime() {
              nestedHashAfterFirstSign = await sha256(
                fixture.runtimeExecutable
              );
              await writeFile(fixture.manifestPath, "final-signed-bytes\n");
            }
          }
        );

        expect(nestedHashAfterFirstSign).toBeDefined();
        expect(await sha256(fixture.runtimeExecutable)).toBe(
          nestedHashAfterFirstSign
        );
        expect(await readFile(fixture.manifestPath, "utf8")).toBe(
          "final-signed-bytes\n"
        );
        await execFileAsync("codesign", [
          "--verify",
          "--deep",
          "--strict",
          fixture.appPath
        ]);
      } finally {
        await fixture.cleanup();
      }
    },
    20_000
  );
});

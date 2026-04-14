import {existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import process from "node:process";
import {spawnSync} from "node:child_process";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "pipe",
    encoding: "utf8",
    ...options
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`,
        result.stdout,
        result.stderr
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return result.stdout.trim();
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dmg" && argv[index + 1]) {
      parsed.dmgPath = path.resolve(argv[index + 1]);
      index += 1;
    }
  }
  return parsed;
}

function findDmgPath(explicitPath) {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(`DMG not found at ${explicitPath}`);
    }
    return explicitPath;
  }

  const releaseSearchRoots = [
    path.resolve("apps/desktop/release"),
    path.resolve("release-assets")
  ];

  for (const root of releaseSearchRoots) {
    if (!existsSync(root)) {
      continue;
    }
    const entries = readdirSync(root)
      .filter((entry) => entry.endsWith(".dmg"))
      .sort();
    if (entries.length > 0) {
      return path.join(root, entries[0]);
    }
  }

  throw new Error(
    "Could not find a packaged DMG. Run `npm run package:mac` first or pass --dmg <path>."
  );
}

function copyMountedApp(mountPoint, destinationRoot) {
  const mountedEntries = readdirSync(mountPoint).filter((entry) =>
    entry.endsWith(".app")
  );
  if (mountedEntries.length === 0) {
    throw new Error(`No .app bundle found under mounted DMG at ${mountPoint}`);
  }

  const sourceAppPath = path.join(mountPoint, mountedEntries[0]);
  const destinationAppPath = path.join(destinationRoot, mountedEntries[0]);
  run("ditto", [sourceAppPath, destinationAppPath]);

  const macOsDir = path.join(destinationAppPath, "Contents", "MacOS");
  const executableEntries = readdirSync(macOsDir);
  if (executableEntries.length === 0) {
    throw new Error(`No executable found under ${macOsDir}`);
  }

  return {
    appPath: destinationAppPath,
    executablePath: path.join(macOsDir, executableEntries[0])
  };
}

function main() {
  if (process.platform !== "darwin") {
    throw new Error("smoke:packaged:mac only runs on macOS");
  }

  const { dmgPath: explicitDmgPath } = parseArgs(process.argv.slice(2));
  const dmgPath = findDmgPath(explicitDmgPath);
  const tempRoot = mkdtempSync(path.join(tmpdir(), "kmux-packaged-smoke-"));
  const mountPoint = path.join(tempRoot, "mount");
  mkdirSync(mountPoint, { recursive: true });

  let appPath;
  let executablePath;

  try {
    run("hdiutil", ["attach", dmgPath, "-mountpoint", mountPoint, "-nobrowse"]);
    ({ appPath, executablePath } = copyMountedApp(mountPoint, tempRoot));
    run("hdiutil", ["detach", mountPoint]);

    const env = {
      ...process.env,
      KMUX_PACKAGED_APP_PATH: appPath,
      KMUX_PACKAGED_EXECUTABLE_PATH: executablePath
    };

    const playwrightCli = path.resolve("node_modules", "playwright", "cli.js");
    const result = spawnSync(
      process.execPath,
      [
        playwrightCli,
        "test",
        "tests/e2e/kmux-packaged-smoke.spec.ts",
        "--config",
        "playwright.config.ts"
      ],
      {
        stdio: "inherit",
        env
      }
    );

    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  } finally {
    spawnSync("hdiutil", ["detach", mountPoint], { stdio: "ignore" });
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

main();

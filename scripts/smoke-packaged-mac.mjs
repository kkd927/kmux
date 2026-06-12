import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync
} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import process from "node:process";
import {spawnSync} from "node:child_process";

const DEFAULT_RELEASE_SEARCH_ROOTS = [
  path.resolve("apps/desktop/release"),
  path.resolve("release-assets")
];

function readPathArg(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flagName} requires a path value`);
  }
  return value;
}

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

export function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dmg") {
      parsed.dmgPath = path.resolve(readPathArg(argv, index, "--dmg"));
      index += 1;
    } else {
      throw new Error(`unknown smoke:packaged:mac argument: ${token}`);
    }
  }
  return parsed;
}

export function findDmgPath(
  explicitPath,
  releaseSearchRoots = DEFAULT_RELEASE_SEARCH_ROOTS
) {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(`DMG not found at ${explicitPath}`);
    }
    return explicitPath;
  }

  for (const root of releaseSearchRoots) {
    if (!existsSync(root)) {
      continue;
    }
    const entries = readdirSync(root)
      .filter((entry) => entry.endsWith(".dmg"))
      .map((entry) => {
        const dmgPath = path.join(root, entry);
        return {
          dmgPath,
          mtimeMs: statSync(dmgPath).mtimeMs
        };
      })
      .sort(
        (left, right) =>
          right.mtimeMs - left.mtimeMs ||
          left.dmgPath.localeCompare(right.dmgPath)
      );
    if (entries.length > 0) {
      return entries[0].dmgPath;
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

export function main(argv = process.argv.slice(2)) {
  if (process.platform !== "darwin") {
    throw new Error("smoke:packaged:mac only runs on macOS");
  }

  const { dmgPath: explicitDmgPath } = parseArgs(argv);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

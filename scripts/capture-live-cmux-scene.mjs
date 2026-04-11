import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const cwd = globalThis.process.cwd();
const outputDir = path.join(cwd, "output", "playwright");
const outputPath = path.join(outputDir, "live-cmux-scene.png");
const metadataPath = path.join(outputDir, "live-cmux-scene.json");

const windowBounds = {
  x: 80,
  y: 80,
  width: 1277,
  height: 1179
};

const appPath =
  globalThis.process.env.KMUX_CMUX_APP_PATH ?? "/Applications/cmux.app";
const executablePath = path.join(appPath, "Contents", "MacOS", "cmux");

const ensure = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    ...options
  });

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    throw new Error(
      stderr || stdout || `Command failed: ${command} ${args.join(" ")}`
    );
  }

  return (result.stdout ?? "").trim();
};

const runAppleScript = (...lines) =>
  run(
    "osascript",
    lines.flatMap((line) => ["-e", line])
  );

const delay = (seconds) => runAppleScript(`delay ${seconds}`);

const parseBounds = (raw) => {
  const values = raw
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value));

  ensure(values.length === 4, `Unexpected window bounds output: ${raw}`);
  return {
    x: values[0],
    y: values[1],
    width: values[2],
    height: values[3]
  };
};

const appVersion = () =>
  execFileSync(
    "defaults",
    [
      "read",
      path.join(appPath, "Contents", "Info"),
      "CFBundleShortVersionString"
    ],
    {
      encoding: "utf8"
    }
  ).trim();

const appProcessRunning = () => {
  const output = runAppleScript(
    'tell application "System Events" to count (every process whose name is "cmux")'
  );
  return Number.parseInt(output, 10) > 0;
};

const activateCmux = () => {
  if (!appProcessRunning()) {
    run("open", ["-a", appPath]);
    delay(1);
  }

  runAppleScript('tell application "cmux" to activate');
  delay(0.6);

  const windowCount = Number.parseInt(
    runAppleScript(
      'tell application "System Events" to tell process "cmux" to get count of windows'
    ),
    10
  );
  ensure(
    windowCount > 0,
    "cmux is running but no window is available for capture"
  );
};

const getFrontWindowBounds = () =>
  parseBounds(
    runAppleScript(
      'tell application "System Events" to tell process "cmux" to get {position, size} of front window'
    )
  );

const setFrontWindowBounds = ({ x, y, width, height }) => {
  runAppleScript(
    `tell application "System Events" to tell process "cmux" to set position of front window to {${x}, ${y}}`,
    `tell application "System Events" to tell process "cmux" to set size of front window to {${width}, ${height}}`
  );
};

const captureWindow = () => {
  run("screencapture", [
    "-R",
    `${windowBounds.x},${windowBounds.y},${windowBounds.width},${windowBounds.height}`,
    outputPath
  ]);
};

ensure(existsSync(appPath), `cmux app not found at ${appPath}`);
ensure(
  existsSync(executablePath),
  `cmux executable not found at ${executablePath}`
);
mkdirSync(outputDir, { recursive: true });

activateCmux();

const originalBounds = getFrontWindowBounds();

try {
  setFrontWindowBounds(windowBounds);
  delay(0.8);
  captureWindow();
} finally {
  setFrontWindowBounds(originalBounds);
  delay(0.2);
}

writeFileSync(
  metadataPath,
  JSON.stringify(
    {
      appPath,
      executablePath,
      version: appVersion(),
      capturedAt: new Date().toISOString(),
      captureBounds: windowBounds,
      restoredBounds: originalBounds
    },
    null,
    2
  )
);

globalThis.console.log(`live cmux scene captured at ${outputPath}`);

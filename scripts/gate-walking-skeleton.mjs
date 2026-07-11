import { spawn } from "node:child_process";
import process from "node:process";

import {
  assertUbuntuDesktopLtsTarget,
  parseOsRelease,
  readOsRelease
} from "./linux-desktop-target.mjs";

const unitSuites = [
  "scripts/linux-desktop-target.test.mjs",
  "scripts/gate-walking-skeleton.test.mjs",
  "scripts/architecture-boundary.test.mjs",
  "packages/core/src/index.test.ts",
  "packages/proto/src/terminalDataPlane.test.ts",
  "packages/persistence/src/index.test.ts",
  "packages/cli/src/bin.test.ts",
  "packages/cli/src/agentHooks.test.ts",
  "packages/metadata/src/agentStorage.test.ts",
  "packages/metadata/src/usage.test.ts",
  "packages/metadata/src/usage-performance.test.ts",
  "packages/metadata/src/modelPricing.test.ts",
  "packages/metadata/src/index.test.ts",
  "packages/metadata/src/aiCliProcess.test.ts",
  "packages/metadata/src/listeningPorts.test.ts",
  "packages/ui/src/index.test.ts",
  "apps/desktop/build/electron-builder-config.test.ts",
  "apps/desktop/build/artifact-build-completed.test.ts",
  "apps/desktop/build/custom-mac-artifact-notarize.test.ts",
  "apps/desktop/build/custom-mac-sign.test.ts",
  "apps/desktop/src/main/socketServer.test.ts",
  "apps/desktop/src/main/socketRpc.test.ts",
  "apps/desktop/src/main/platform/runtime.test.ts",
  "apps/desktop/src/shared/platform/keyboardPolicy.test.ts",
  "apps/desktop/src/shared/platform/rendererPlatform.test.ts",
  "apps/desktop/src/main/shellEnvironment.test.ts",
  "apps/desktop/src/main/appRuntime.test.ts",
  "apps/desktop/src/main/cliRuntime.test.ts",
  "apps/desktop/src/main/claudeIntegration.test.ts",
  "apps/desktop/src/main/antigravityIntegration.test.ts",
  "apps/desktop/src/main/ipcHandlers.test.ts",
  "apps/desktop/src/main/metadataRuntime.test.ts",
  "apps/desktop/src/main/usageRuntime.test.ts",
  "apps/desktop/src/main/usageScanWorkerClient.test.ts",
  "apps/desktop/src/main/subscriptionUsage.test.ts",
  "apps/desktop/src/main/externalSessions.test.ts",
  "apps/desktop/src/main/appIdentity.test.ts",
  "apps/desktop/src/main/appMenu.test.ts",
  "apps/desktop/src/main/nativeNotifications.test.ts",
  "apps/desktop/src/main/terminalTypography.test.ts",
  "apps/desktop/src/main/itermcolors.test.ts",
  "apps/desktop/src/main/pendingUpdate.test.ts",
  "apps/desktop/src/main/updater.test.ts",
  "apps/desktop/src/main/updaterChannel.test.ts",
  "apps/desktop/src/main/updaterUi.test.ts",
  "apps/desktop/src/main/windowLifecycle.test.ts",
  "apps/desktop/src/main/mainLifecycle.test.ts",
  "apps/desktop/src/main/settingsJson.test.ts",
  "apps/desktop/src/main/shellWrapperRuntime.test.ts",
  "apps/desktop/src/main/workspaceContextMenu.test.ts",
  "apps/desktop/src/main/worktreeRuntime.test.ts",
  "apps/desktop/src/main/imageAttachments.test.ts",
  "apps/desktop/src/main/ptyHost.test.ts",
  "apps/desktop/src/main/terminalDataPlane.test.ts",
  "apps/desktop/src/main/surfaceCapture.test.ts",
  "apps/desktop/src/main/terminalBridge.test.ts",
  "apps/desktop/src/renderer/src/components/ExternalSessionsPanel.test.tsx",
  "apps/desktop/src/renderer/src/components/PaneTree.test.tsx",
  "apps/desktop/src/renderer/src/components/TerminalPane.visibility.test.tsx",
  "apps/desktop/src/renderer/src/components/AppOverlays.test.ts",
  "apps/desktop/src/renderer/src/components/TitlebarUpdateAction.test.tsx",
  "apps/desktop/src/renderer/src/components/TitlebarWindowControls.test.tsx",
  "apps/desktop/src/renderer/src/components/UsageDashboard.test.tsx",
  "apps/desktop/src/renderer/src/hooks/useExternalAgentSessions.test.tsx",
  "apps/desktop/src/renderer/src/hooks/useSidebarResize.test.ts",
  "apps/desktop/src/renderer/src/hooks/useShellStore.test.tsx",
  "apps/desktop/src/renderer/src/hooks/useGlobalShortcuts.test.tsx",
  "apps/desktop/src/renderer/src/hooks/useTerminalInstanceCleanup.test.tsx",
  "apps/desktop/src/renderer/src/shortcutLabels.test.ts",
  "apps/desktop/src/renderer/src/surfaceCloseStrategy.test.ts",
  "apps/desktop/src/renderer/src/surfaceTabDrag.test.ts",
  "apps/desktop/src/renderer/src/terminalForegroundFit.test.ts",
  "apps/desktop/src/renderer/src/terminalCheckpointController.test.ts",
  "apps/desktop/src/renderer/src/terminalInstanceStore.test.ts",
  "apps/desktop/src/renderer/src/terminalRenderer.test.ts",
  "apps/desktop/src/renderer/src/terminalResizeSync.test.ts",
  "apps/desktop/src/renderer/src/terminalStreamClient.test.ts",
  "apps/desktop/src/renderer/src/terminalStreamRouter.test.ts",
  "apps/desktop/src/renderer/src/terminalTypography.test.ts",
  "apps/desktop/src/renderer/src/visibleTerminalWriteScheduler.test.ts",
  "apps/desktop/src/preload/index.test.ts",
  "apps/desktop/src/preload/clipboardImages.test.ts",
  "apps/desktop/src/shared/diagnostics.test.ts",
  "apps/desktop/src/shared/ptyProtocol.test.ts",
  "apps/desktop/src/shared/smoothnessProfile.test.ts",
  "apps/desktop/src/shared/smoothnessProfileBucket.test.ts",
  "apps/desktop/src/shared/terminalDataPlaneMetrics.test.ts",
  "apps/desktop/src/shared/terminalConfig.test.ts",
  "apps/desktop/src/shared/updaterPresentation.test.ts",
  "apps/desktop/src/shared/workspaceContextMenu.test.ts",
  "apps/desktop/src/pty-host/index.test.ts",
  "apps/desktop/src/pty-host/fairSessionScheduler.test.ts",
  "apps/desktop/src/pty-host/osc7.test.ts",
  "apps/desktop/src/pty-host/ptySpawnLaunch.test.ts",
  "apps/desktop/src/pty-host/rawOutputHistoryPath.test.ts",
  "apps/desktop/src/pty-host/rawTerminalStdoutLog.test.ts",
  "apps/desktop/src/pty-host/resizeRuntime.test.ts",
  "apps/desktop/src/pty-host/sessionMutationQueue.test.ts",
  "apps/desktop/src/pty-host/sessionEnv.test.ts",
  "apps/desktop/src/pty-host/shellInputReady.test.ts",
  "apps/desktop/src/pty-host/shellIntegration.test.ts",
  "apps/desktop/src/pty-host/snapshotCache.test.ts",
  "apps/desktop/src/pty-host/terminalInput.test.ts",
  "apps/desktop/src/pty-host/terminalDeltaStore.test.ts",
  "apps/desktop/src/pty-host/terminalDataPlaneSupervisorMetrics.test.ts",
  "apps/desktop/src/pty-host/terminalNotifications.test.ts",
  "apps/desktop/src/pty-host/terminalSessionStream.test.ts",
  "apps/desktop/src/pty-host/terminalWireCoalescing.test.ts",
  "apps/desktop/src/pty-host/utilityProcessTransport.test.ts",
  "scripts/dev.test.mjs",
  "scripts/terminal-data-plane-load.test.mjs",
  "scripts/smoke-dev.test.mjs",
  "scripts/smoke-packaged-linux.test.mjs",
  "scripts/smoke-packaged-mac.test.mjs",
  "tests/e2e/helpers.test.ts"
];

const e2eSpecs = [
  "tests/e2e/kmux-walking-skeleton.spec.ts",
  "tests/e2e/kmux-restore.spec.ts",
  "tests/e2e/kmux-regressions.spec.ts"
];

const e2eGrep = [
  "walking skeleton",
  "unclean shutdown reuses the saved workspace snapshot on relaunch",
  "terminal output survives surface switches through attach snapshots",
  "repeated workspace switches preserve terminal snapshots",
  "workspace switches restore busy alternate-screen terminal content",
  "right sidebar toggles keep streaming terminal output visible during resize",
  "terminal resize applies after the remote PTY resize barrier"
].join("|");

export function walkingSkeletonGateUnitSuites() {
  return [...unitSuites];
}

export function walkingSkeletonGateUnitCommandArgs() {
  return ["vitest", "run", "--maxWorkers=4", ...unitSuites];
}

export function walkingSkeletonGateSlowUnitCommandArgs() {
  return ["vitest", "run", "--maxWorkers=1"];
}

export function walkingSkeletonGateE2eSpecs() {
  return [...e2eSpecs];
}

export function walkingSkeletonGateE2eGrep() {
  return e2eGrep;
}

const knownArgs = new Set([
  "--require-linux-desktop",
  "--skip-e2e",
  "--skip-build"
]);

export function parseArgs(argv = process.argv.slice(2)) {
  const unknownArgs = argv.filter((arg) => !knownArgs.has(arg));
  if (unknownArgs.length > 0) {
    throw new Error(
      `unknown walking skeleton gate argument(s): ${unknownArgs.join(", ")}`
    );
  }

  const args = new Set(argv);
  return {
    requireLinuxDesktop: args.has("--require-linux-desktop"),
    skipE2e: args.has("--skip-e2e"),
    skipBuild: args.has("--skip-build")
  };
}

export function assertWalkingSkeletonGateOptions({
  requireLinuxDesktop = false,
  skipE2e = false,
  skipBuild = false
} = {}) {
  if (!requireLinuxDesktop) {
    return;
  }

  const partialFlags = [
    skipE2e ? "--skip-e2e" : "",
    skipBuild ? "--skip-build" : ""
  ].filter(Boolean);
  if (partialFlags.length === 0) {
    return;
  }

  throw new Error(
    [
      "walking skeleton Linux desktop gate must run the complete release-scope checks.",
      `Partial gate flags are not allowed with --require-linux-desktop: ${partialFlags.join(
        ", "
      )}.`
    ].join("\n")
  );
}

export function walkingSkeletonGateStages({
  skipE2e = false,
  skipBuild = false
} = {}) {
  return [
    "typecheck",
    "unit",
    ...(!skipE2e ? ["smoke:dev"] : []),
    ...(!skipBuild ? ["build"] : []),
    ...(!skipE2e ? ["playwright"] : [])
  ];
}

export function walkingSkeletonGateModeSummary({
  requireLinuxDesktop = false,
  skipE2e = false,
  skipBuild = false,
  platform = process.platform
} = {}) {
  if (requireLinuxDesktop) {
    return [
      "Gate mode: Ubuntu Desktop Linux gate",
      "Linux release scope: walking-skeleton component only; run package:linux and smoke:packaged:linux before release."
    ].join("\n");
  }

  const partialFlags = [
    skipE2e ? "--skip-e2e" : "",
    skipBuild ? "--skip-build" : ""
  ].filter(Boolean);
  return [
    `Gate mode: portable preflight on ${platform}${
      partialFlags.length > 0 ? ` (${partialFlags.join(", ")})` : ""
    }`,
    "Linux release scope: no; run `npm run gate:walking-skeleton:linux` on Ubuntu Desktop without skip flags for the Linux gate."
  ].join("\n");
}

export function assertWalkingSkeletonTarget({
  requireLinuxDesktop = false,
  platform = process.platform,
  env = process.env,
  osReleaseText = readOsRelease()
} = {}) {
  if (!requireLinuxDesktop) {
    return;
  }

  const distribution = parseOsRelease(osReleaseText);
  assertUbuntuDesktopLtsTarget({
    platform,
    env,
    osReleaseText,
    platformMessage: `walking skeleton Linux desktop gate requires linux; current platform is ${platform}`,
    distributionMessage: [
      "walking skeleton Linux desktop gate requires Ubuntu Desktop LTS.",
      `Detected distro: ${distribution.prettyName || distribution.id || "<unknown>"}.`
    ].join("\n"),
    displayMessage:
      "walking skeleton Linux desktop gate requires an Ubuntu Desktop session (DISPLAY or WAYLAND_DISPLAY)"
  });
}

function commandForNpm() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function commandForNpx() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`\n$ ${[command, ...commandArgs].join(" ")}\n`);
    const child = spawn(command, commandArgs, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...options.env
      },
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${commandArgs.join(" ")} failed with ${signal ?? code}`
        )
      );
    });
  });
}

async function main() {
  const { requireLinuxDesktop, skipE2e, skipBuild } = parseArgs();
  const gateEnv = requireLinuxDesktop
    ? {
        KMUX_DISABLE_SHELL_ENV_PROBE: "0",
        KMUX_E2E_WINDOW_MODE: "visible"
      }
    : { KMUX_DISABLE_SHELL_ENV_PROBE: "1" };

  assertWalkingSkeletonTarget({ requireLinuxDesktop });
  assertWalkingSkeletonGateOptions({ requireLinuxDesktop, skipE2e, skipBuild });
  process.stdout.write(
    `${walkingSkeletonGateModeSummary({
      requireLinuxDesktop,
      skipE2e,
      skipBuild
    })}\n`
  );

  const stages = new Set(walkingSkeletonGateStages({ skipE2e, skipBuild }));

  if (stages.has("typecheck")) {
    await run(commandForNpm(), ["run", "typecheck"]);
  }
  if (stages.has("unit")) {
    await run(commandForNpx(), walkingSkeletonGateUnitCommandArgs());
    await run(commandForNpx(), walkingSkeletonGateSlowUnitCommandArgs());
  }
  if (stages.has("smoke:dev")) {
    await run(commandForNpm(), ["run", "smoke:dev"], {
      env: gateEnv
    });
  }
  if (stages.has("build")) {
    await run(commandForNpm(), ["run", "build"]);
  }
  if (stages.has("playwright")) {
    await run(
      commandForNpx(),
      ["playwright", "test", ...e2eSpecs, "--grep", e2eGrep],
      {
        env: gateEnv
      }
    );
  }

  if (requireLinuxDesktop) {
    process.stdout.write(
      "\nwalking skeleton Linux desktop gate passed for the executable checks in this script.\n"
    );
  } else {
    process.stdout.write(
      "\nwalking skeleton portable preflight passed. Run `npm run gate:walking-skeleton:linux` on Ubuntu Desktop for the Linux desktop gate.\n"
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}

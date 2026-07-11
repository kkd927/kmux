import { describe, expect, it } from "vitest";

import {
  assertWalkingSkeletonGateOptions,
  assertWalkingSkeletonTarget,
  parseArgs,
  walkingSkeletonGateE2eGrep,
  walkingSkeletonGateE2eSpecs,
  walkingSkeletonGateSlowUnitCommandArgs,
  walkingSkeletonGateUnitCommandArgs,
  walkingSkeletonGateUnitSuites,
  walkingSkeletonGateModeSummary,
  walkingSkeletonGateStages
} from "./gate-walking-skeleton.mjs";

const ubuntuLts = [
  'PRETTY_NAME="Ubuntu 24.04.2 LTS"',
  'VERSION="24.04.2 LTS (Noble Numbat)"',
  "ID=ubuntu"
].join("\n");

describe("walking skeleton gate target preflight", () => {
  it("parses gate flags", () => {
    expect(parseArgs(["--require-linux-desktop", "--skip-e2e"])).toEqual({
      requireLinuxDesktop: true,
      skipE2e: true,
      skipBuild: false
    });
    expect(parseArgs(["--skip-build"])).toEqual({
      requireLinuxDesktop: false,
      skipE2e: false,
      skipBuild: true
    });
  });

  it("rejects unknown gate flags instead of ignoring typos", () => {
    expect(() => parseArgs(["--require-linux-desktop", "--skip-ee2"])).toThrow(
      /unknown walking skeleton gate argument/
    );
  });

  it("rejects partial skips for the Linux desktop gate only", () => {
    expect(() =>
      assertWalkingSkeletonGateOptions({
        requireLinuxDesktop: false,
        skipE2e: true,
        skipBuild: true
      })
    ).not.toThrow();

    expect(() =>
      assertWalkingSkeletonGateOptions({
        requireLinuxDesktop: true,
        skipE2e: false,
        skipBuild: false
      })
    ).not.toThrow();

    expect(() =>
      assertWalkingSkeletonGateOptions({
        requireLinuxDesktop: true,
        skipE2e: true
      })
    ).toThrow(/Partial gate flags are not allowed/);

    expect(() =>
      assertWalkingSkeletonGateOptions({
        requireLinuxDesktop: true,
        skipBuild: true
      })
    ).toThrow(/Partial gate flags are not allowed/);
  });

  it("keeps portable skip-e2e and skip-build stages independent", () => {
    expect(walkingSkeletonGateStages()).toEqual([
      "typecheck",
      "unit",
      "smoke:dev",
      "build",
      "playwright"
    ]);
    expect(walkingSkeletonGateStages({ skipE2e: true })).toEqual([
      "typecheck",
      "unit",
      "build"
    ]);
    expect(walkingSkeletonGateStages({ skipBuild: true })).toEqual([
      "typecheck",
      "unit",
      "smoke:dev",
      "playwright"
    ]);
    expect(
      walkingSkeletonGateStages({ skipE2e: true, skipBuild: true })
    ).toEqual(["typecheck", "unit"]);
  });

  it("limits unit-test workers so the expanded portable gate stays stable", () => {
    expect(walkingSkeletonGateUnitCommandArgs()).toEqual([
      "vitest",
      "run",
      "--maxWorkers=4",
      ...walkingSkeletonGateUnitSuites()
    ]);
    expect(walkingSkeletonGateSlowUnitCommandArgs()).toEqual([
      "vitest",
      "run",
      "--maxWorkers=1"
    ]);
  });

  it("keeps release-scope continuity checks in the walking skeleton gate", () => {
    expect(walkingSkeletonGateUnitSuites()).toEqual(
      expect.arrayContaining([
        "scripts/architecture-boundary.test.mjs",
        "packages/core/src/index.test.ts",
        "packages/proto/src/terminalDataPlane.test.ts",
        "packages/persistence/src/index.test.ts",
        "packages/cli/src/bin.test.ts",
        "packages/cli/src/agentHooks.test.ts",
        "apps/desktop/src/main/platform/runtime.test.ts",
        "apps/desktop/src/shared/platform/rendererPlatform.test.ts",
        "apps/desktop/src/main/shellEnvironment.test.ts",
        "apps/desktop/src/main/appRuntime.test.ts",
        "apps/desktop/src/main/cliRuntime.test.ts",
        "apps/desktop/src/main/claudeIntegration.test.ts",
        "apps/desktop/src/main/antigravityIntegration.test.ts",
        "apps/desktop/src/main/ipcHandlers.test.ts",
        "apps/desktop/src/main/metadataRuntime.test.ts",
        "apps/desktop/src/main/usageRuntime.test.ts",
        "apps/desktop/src/main/ptyHost.test.ts",
        "apps/desktop/src/main/terminalDataPlane.test.ts",
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
        "apps/desktop/src/main/surfaceCapture.test.ts",
        "apps/desktop/src/renderer/src/components/ExternalSessionsPanel.test.tsx",
        "apps/desktop/src/renderer/src/components/PaneTree.test.tsx",
        "apps/desktop/src/renderer/src/components/TerminalPane.visibility.test.tsx",
        "apps/desktop/src/renderer/src/components/AppOverlays.test.ts",
        "apps/desktop/src/renderer/src/components/TitlebarUpdateAction.test.tsx",
        "apps/desktop/src/renderer/src/components/TitlebarWindowControls.test.tsx",
        "apps/desktop/src/renderer/src/components/UsageDashboard.test.tsx",
        "apps/desktop/src/renderer/src/hooks/useExternalAgentSessions.test.tsx",
        "apps/desktop/src/renderer/src/hooks/useSidebarResize.test.ts",
        "apps/desktop/src/shared/platform/keyboardPolicy.test.ts",
        "apps/desktop/src/renderer/src/hooks/useShellStore.test.tsx",
        "apps/desktop/src/renderer/src/hooks/useGlobalShortcuts.test.tsx",
        "apps/desktop/src/renderer/src/hooks/useTerminalInstanceCleanup.test.tsx",
        "apps/desktop/src/renderer/src/shortcutLabels.test.ts",
        "apps/desktop/src/main/terminalBridge.test.ts",
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
      ])
    );
    expect(walkingSkeletonGateE2eSpecs()).toEqual(
      expect.arrayContaining([
        "tests/e2e/kmux-walking-skeleton.spec.ts",
        "tests/e2e/kmux-restore.spec.ts",
        "tests/e2e/kmux-regressions.spec.ts"
      ])
    );

    const grep = walkingSkeletonGateE2eGrep();
    for (const requiredScenario of [
      "walking skeleton",
      "terminal output survives surface switches through attach snapshots",
      "repeated workspace switches preserve terminal snapshots",
      "workspace switches restore busy alternate-screen terminal content",
      "right sidebar toggles keep streaming terminal output visible during resize",
      "terminal resize applies after the remote PTY resize barrier"
    ]) {
      expect(grep).toContain(requiredScenario);
    }
  });

  it("prints mode summaries that distinguish portable preflight from the Linux gate", () => {
    expect(
      walkingSkeletonGateModeSummary({
        platform: "darwin",
        skipE2e: true,
        skipBuild: true
      })
    ).toContain(
      "Gate mode: portable preflight on darwin (--skip-e2e, --skip-build)"
    );
    expect(
      walkingSkeletonGateModeSummary({
        platform: "darwin",
        skipE2e: true,
        skipBuild: true
      })
    ).toContain("Linux release scope: no");
    expect(
      walkingSkeletonGateModeSummary({
        requireLinuxDesktop: true,
        platform: "linux"
      })
    ).toContain("Gate mode: Ubuntu Desktop Linux gate");
    expect(
      walkingSkeletonGateModeSummary({
        requireLinuxDesktop: true,
        platform: "linux"
      })
    ).toContain("Linux release scope: walking-skeleton component only");
  });

  it("keeps portable preflight available outside Linux", () => {
    expect(() =>
      assertWalkingSkeletonTarget({
        requireLinuxDesktop: false,
        platform: "darwin",
        env: {},
        osReleaseText: ""
      })
    ).not.toThrow();
  });

  it("requires Ubuntu Desktop LTS for the Linux desktop gate", () => {
    expect(() =>
      assertWalkingSkeletonTarget({
        requireLinuxDesktop: true,
        platform: "linux",
        env: {
          WAYLAND_DISPLAY: "wayland-0",
          XDG_CURRENT_DESKTOP: "ubuntu:GNOME"
        },
        osReleaseText: ubuntuLts
      })
    ).not.toThrow();
    expect(() =>
      assertWalkingSkeletonTarget({
        requireLinuxDesktop: true,
        platform: "linux",
        env: { DISPLAY: ":0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
        osReleaseText: [
          'PRETTY_NAME="Fedora Linux 40 (Workstation Edition)"',
          "ID=fedora"
        ].join("\n")
      })
    ).toThrow(/Ubuntu Desktop LTS/);
    expect(() =>
      assertWalkingSkeletonTarget({
        requireLinuxDesktop: true,
        platform: "linux",
        env: {},
        osReleaseText: ubuntuLts
      })
    ).toThrow(/DISPLAY or WAYLAND_DISPLAY/);
    expect(() =>
      assertWalkingSkeletonTarget({
        requireLinuxDesktop: true,
        platform: "darwin",
        env: { DISPLAY: ":0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
        osReleaseText: ubuntuLts
      })
    ).toThrow(/requires linux/);
  });
});

import { readFile } from "node:fs/promises";

const manifestPath = new URL(
  "../e2e/fixtures/remote-performance-gates.v1.json",
  import.meta.url
);

describe("ADR 0005 remote performance manifest", () => {
  it("locks the normative v1 topology, workload, and release limits", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      referenceTargetMinimum: {
        physicalCpuCores: 4,
        memoryBytes: 8 * 1024 * 1024 * 1024,
        stateStorage: "ssd-backed"
      },
      network: { roundTripLatencyMs: 20, maximumInjectedJitterMs: 1 },
      ssh: { controlMastersPerTarget: 1, featureDirectFallback: false },
      workload: {
        minimumDurationMs: 120_000,
        keepers: {
          total: 16,
          attached: 4,
          detached: 12,
          attachedOutputBytesPerSecondEach: 256 * 1024,
          detachedOutputBytesPerSecondEach: 64 * 1024
        },
        keyEcho: { probesPerSecond: 10 },
        sftp: { bytes: 512 * 1024 * 1024 },
        journal: {
          mustCrossGroupCommit: true,
          maximumGroupIntervalMs: 50,
          maximumGroupBytes: 1024 * 1024
        },
        checkpoint: { minimumCompletedPerKeeper: 1 }
      },
      gates: {
        addedKeyEchoLatencyMs: { p95Max: 8, p99Max: 20 },
        remoteHostEventLoopDelayMs: { p99Max: 10, singleStallMax: 100 },
        keeperRssBytes: { p95Max: 32 * 1024 * 1024 },
        remoteHostProcessTreeRssBytes: { max: 192 * 1024 * 1024 },
        journalGroupSyncMs: {
          p99Max: 250,
          storageDegradedAtOrAbove: 2000
        },
        loadedSftpThroughput: { minimumDirectBaselineRatio: 0.8 }
      }
    });
    expect(manifest.changeControl).toMatch(/explicit ADR amendment/iu);
  });

  it("records a measured but explicitly non-normative phase-one baseline", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest.phase1MeasuredBaseline).toMatchObject({
      normative: false,
      environmentKind: "docker-desktop-functional-baseline",
      runtimeArtifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      network: {
        upstreamLatencyMs: 10,
        downstreamLatencyMs: 10,
        injectedRoundTripLatencyMs: 20,
        jitterMs: 0
      },
      directMuxedOpenSsh: {
        echoSamples: 200,
        echoIntervalMs: 100,
        sftpBytes: 512 * 1024 * 1024,
        sftpSha256: manifest.workload.sftp.sha256,
        routeBaseline: {
          acceptedTcpConnections: 1,
          acceptedAuthentications: 1
        },
        featureDelta: {
          acceptedTcpConnections: 0,
          authenticationAttempts: 0,
          acceptedAuthentications: 0
        }
      }
    });
    expect(manifest.phase1MeasuredBaseline.limitations).not.toHaveLength(0);
  });
});

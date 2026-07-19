import { readFile } from "node:fs/promises";

const manifestPath = new URL(
  "../e2e/fixtures/remote-performance-gates.v1.json",
  import.meta.url
);

describe("ADR 0005 remote performance manifest", () => {
  it("locks the normative v1 topology, workload, and release limits", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(Object.keys(manifest).sort()).toEqual([
      "changeControl",
      "contract",
      "gates",
      "network",
      "phase1MeasuredBaseline",
      "referenceTargetMinimum",
      "schemaVersion",
      "ssh",
      "workload"
    ]);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.contract).toBe(
      "docs/adr/0005-ssh-remote-workspaces.md#normative-performance-and-resource-gates"
    );
    expect(manifest.referenceTargetMinimum).toEqual({
      physicalCpuCores: 4,
      memoryBytes: 8 * 1024 * 1024 * 1024,
      stateStorage: "ssd-backed"
    });
    expect(manifest.network).toEqual({
      roundTripLatencyMs: 20,
      maximumInjectedJitterMs: 1,
      phase1Shaper: {
        implementation: "Toxiproxy 2.9.0",
        image:
          "ghcr.io/shopify/toxiproxy:2.9.0@sha256:b44c283298cea49e2defaba1b3028783798346f2a926684e3a345fd8441af3b8",
        upstreamLatencyMs: 10,
        downstreamLatencyMs: 10,
        jitterMs: 0
      }
    });
    expect(manifest.ssh).toEqual({
      client: "host system OpenSSH ssh/sftp",
      controlMastersPerTarget: 1,
      controlPersist: false,
      featureDirectFallback: false,
      phase1HostVersion: "OpenSSH_10.2p1, LibreSSL 3.3.6",
      phase1TargetVersion: "OpenSSH_9.2, OpenSSL 3.0.20 7 Apr 2026"
    });
    expect(manifest.workload).toEqual({
      minimumDurationMs: 120_000,
      keepers: {
        total: 16,
        attached: 4,
        detached: 12,
        attachedOutputBytesPerSecondEach: 256 * 1024,
        detachedOutputBytesPerSecondEach: 64 * 1024
      },
      keyEcho: {
        probesPerSecond: 10,
        generator: "monotonic probe index plus fixed 16-byte ASCII suffix"
      },
      sftp: {
        bytes: 512 * 1024 * 1024,
        generator: "all-zero byte stream",
        sha256:
          "9acca8e8c22201155389f65abbf6bc9723edc7384ead80503839f49dcc56d767"
      },
      git: {
        repositoryPath: "/opt/kmux-fixtures/repository",
        repositoryCommit: "8408912c3abac9be93ece7e8f360dac4eadf4507",
        operations: ["git status --porcelain=v2", "git diff --no-ext-diff"],
        repetitionsPerSecond: 1
      },
      terminalOutputGenerator: {
        encoding: "binary",
        pattern: "seeded xorshift64 byte stream",
        seed: "0x4b4d555852454d31",
        statusRequestPrefix: "KMUX_PROFILE_STATUS:",
        steadyChunkBytes: 4 * 1024,
        burst: {
          triggerPrefix: "KMUX_PROFILE_BURST:",
          pattern: "ASCII x byte stream",
          attachedKeepers: 1,
          totalBytes: 4 * 1024 * 1024,
          chunkBytes: 64 * 1024,
          chunkIntervalMs: 20,
          echoPauseMs: 100,
          echoProbes: 20,
          completionTimeoutMs: 30_000
        }
      },
      journal: {
        mustCrossGroupCommit: true,
        maximumGroupIntervalMs: 50,
        maximumGroupBytes: 1024 * 1024
      },
      checkpoint: {
        minimumCompletedPerKeeper: 1,
        maximumBytes: 16 * 1024 * 1024,
        maximumChunkBytes: 256 * 1024
      }
    });
    expect(manifest.gates).toEqual({
      addedKeyEchoLatencyMs: { p95Max: 8, p99Max: 20 },
      remoteHostEventLoopDelayMs: { p99Max: 10, singleStallMax: 100 },
      terminalMutationContinuity: {
        missing: 0,
        duplicate: 0,
        reordered: 0
      },
      keeperRssBytes: { p95Max: 32 * 1024 * 1024 },
      remoteHostProcessTreeRssBytes: { max: 192 * 1024 * 1024 },
      journalGroupSyncMs: {
        p99Max: 250,
        storageDegradedAtOrAbove: 2000
      },
      sshFeatureTransport: {
        targetAuthenticatedMasterRoutes: 1,
        physicalTcpLegs: "resolved-route-baseline",
        featureAuthenticationAttempts: 0
      },
      loadedSftpThroughput: { minimumDirectBaselineRatio: 0.8 }
    });
    expect(manifest.changeControl).toMatch(/generator shape/iu);
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

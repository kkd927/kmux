import { readFile } from "node:fs/promises";

const manifestPath = new URL(
  "../e2e/fixtures/remote-performance-gates.v1.json",
  import.meta.url
);

describe("ADR 0005 remote performance manifest", () => {
  it("validates the v1 schema and its release-contract invariants", async () => {
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
    const { workload, gates } = manifest;
    const positiveNumbers = [
      manifest.referenceTargetMinimum.physicalCpuCores,
      manifest.referenceTargetMinimum.memoryBytes,
      manifest.network.roundTripLatencyMs,
      workload.minimumDurationMs,
      workload.keepers.total,
      workload.keepers.attached,
      workload.keepers.detached,
      workload.keepers.attachedOutputBytesPerSecondEach,
      workload.keepers.detachedOutputBytesPerSecondEach,
      workload.keyEcho.probesPerSecond,
      workload.sftp.bytes,
      workload.git.repetitionsPerSecond,
      workload.terminalOutputGenerator.steadyChunkBytes,
      workload.terminalOutputGenerator.burst.attachedKeepers,
      workload.terminalOutputGenerator.burst.totalBytes,
      workload.terminalOutputGenerator.burst.chunkBytes,
      workload.terminalOutputGenerator.burst.chunkIntervalMs,
      workload.terminalOutputGenerator.burst.echoProbes,
      workload.terminalOutputGenerator.burst.completionTimeoutMs,
      workload.checkpoint.minimumCompletedPerKeeper,
      workload.checkpoint.maximumBytes,
      workload.checkpoint.maximumChunkBytes,
      gates.addedKeyEchoLatencyMs.p95Max,
      gates.addedKeyEchoLatencyMs.p99Max,
      gates.remoteHostEventLoopDelayMs.p99Max,
      gates.remoteHostEventLoopDelayMs.singleStallMax,
      gates.keeperRssBytes.p95Max,
      gates.remoteHostProcessTreeRssBytes.max,
      gates.journalGroupSyncMs.p99Max,
      gates.journalGroupSyncMs.storageDegradedAtOrAbove
    ];
    expect(
      positiveNumbers.every(
        (value) => Number.isFinite(value) && Number(value) > 0
      )
    ).toBe(true);
    expect(manifest.referenceTargetMinimum.stateStorage).toBe("ssd-backed");
    expect(workload.keepers.total).toBe(
      workload.keepers.attached + workload.keepers.detached
    );
    expect(
      workload.terminalOutputGenerator.burst.attachedKeepers
    ).toBeLessThanOrEqual(workload.keepers.attached);
    expect(
      workload.terminalOutputGenerator.burst.totalBytes %
        workload.terminalOutputGenerator.burst.chunkBytes
    ).toBe(0);
    expect(workload.terminalOutputGenerator.burst).not.toHaveProperty(
      "echoPauseMs"
    );
    expect(workload.checkpoint.maximumChunkBytes).toBeLessThanOrEqual(
      workload.checkpoint.maximumBytes
    );
    expect(workload.sftp.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(workload.git.repositoryCommit).toMatch(/^[a-f0-9]{40}$/u);
    expect(manifest.ssh).toMatchObject({
      controlMastersPerTarget: 1,
      controlPersist: false,
      featureDirectFallback: false
    });
    expect(gates.sshFeatureTransport).toEqual({
      targetAuthenticatedMasterRoutes: 1,
      physicalTcpLegs: "resolved-route-baseline",
      featureAuthenticationAttempts: 0
    });
    expect(gates.addedKeyEchoLatencyMs.p95Max).toBeLessThanOrEqual(
      gates.addedKeyEchoLatencyMs.p99Max
    );
    expect(gates.journalGroupSyncMs.p99Max).toBeLessThan(
      gates.journalGroupSyncMs.storageDegradedAtOrAbove
    );
    expect(
      gates.loadedSftpThroughput.minimumDirectBaselineRatio
    ).toBeGreaterThan(0);
    expect(
      gates.loadedSftpThroughput.minimumDirectBaselineRatio
    ).toBeLessThanOrEqual(1);
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

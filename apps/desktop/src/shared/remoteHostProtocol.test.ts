import { IncrementalSha256, uint64 } from "@kmux/proto";

import {
  DEFAULT_REMOTE_RETENTION_POLICY,
  decodeRemoteHostOperationOutcome,
  decodeRemoteHostRequest,
  decodeRemoteHostResponse,
  resolveRemoteRetentionPolicyForSshProfile
} from "./remoteHostProtocol";

describe("remote retention profile policy", () => {
  it("resolves defaults and exact bounded SSH profile overrides", () => {
    expect(resolveRemoteRetentionPolicyForSshProfile({})).toEqual(
      DEFAULT_REMOTE_RETENTION_POLICY
    );
    expect(
      resolveRemoteRetentionPolicyForSshProfile({
        sessionRetentionQuotaMiB: 512,
        targetRetentionQuotaMiB: 4096
      })
    ).toEqual({ sessionQuotaMiB: 512, targetQuotaMiB: 4096 });
  });

  it("rejects profile quota overrides outside the runtime contract", () => {
    expect(() =>
      resolveRemoteRetentionPolicyForSshProfile({
        sessionRetentionQuotaMiB: 32
      })
    ).toThrow(/outside its allowed range/u);
    expect(() =>
      resolveRemoteRetentionPolicyForSshProfile({
        sessionRetentionQuotaMiB: 1024,
        targetRetentionQuotaMiB: 512
      })
    ).toThrow(/outside its allowed range/u);
  });
});

describe("remote-host UtilityProcess operation outcome boundary", () => {
  it("accepts only an exact bounded utility-owned SSH config request", () => {
    expect(
      decodeRemoteHostRequest({
        type: "ssh-config.resolve",
        requestId: "request_config",
        sshPath: "/usr/bin/ssh",
        configPath: "/tmp/ssh_config",
        host: "target-alias"
      })
    ).toEqual({
      type: "ssh-config.resolve",
      requestId: "request_config",
      sshPath: "/usr/bin/ssh",
      configPath: "/tmp/ssh_config",
      host: "target-alias"
    });
    expect(() =>
      decodeRemoteHostRequest({
        type: "ssh-config.resolve",
        requestId: "request_config",
        sshPath: "ssh",
        configPath: "/tmp/ssh_config",
        host: "target-alias"
      })
    ).toThrow(/absolute path/u);
  });

  it("accepts exact bounded results while preserving uint64 bigint", () => {
    expect(
      decodeRemoteHostOperationOutcome({
        status: "succeeded",
        operationId: "operation_1",
        remoteResourceRevision: 7n,
        resultDigest: "a".repeat(64),
        keeperGeneration: "keeper_1"
      })
    ).toEqual({
      status: "succeeded",
      operationId: "operation_1",
      remoteResourceRevision: uint64(7n),
      resultDigest: "a".repeat(64),
      keeperGeneration: "keeper_1"
    });
  });

  it("rejects malformed authority-bearing fields and object escapes", () => {
    expect(() =>
      decodeRemoteHostOperationOutcome({
        status: "succeeded",
        operationId: "operation_1",
        remoteResourceRevision: "7",
        resultDigest: "a".repeat(64)
      })
    ).toThrow(/bigint/u);
    expect(() =>
      decodeRemoteHostOperationOutcome({
        status: "failed",
        operationId: "operation_1",
        resultDigest: "not-a-digest",
        code: "failed",
        message: "failed"
      })
    ).toThrow(/SHA-256/u);
    expect(() =>
      decodeRemoteHostOperationOutcome({
        status: "failed",
        operationId: "operation_1",
        resultDigest: "b".repeat(64),
        code: "failed",
        message: "failed",
        arbitrary: true
      })
    ).toThrow(/unexpected/u);
  });

  it("accepts only the assigned-master loss event code", () => {
    expect(
      decodeRemoteHostResponse({
        type: "target.lost",
        targetId: "target_1",
        masterGeneration: "master_1",
        code: "master-closed",
        message: "master exited"
      })
    ).toMatchObject({ code: "master-closed" });
    expect(() =>
      decodeRemoteHostResponse({
        type: "target.lost",
        targetId: "target_1",
        masterGeneration: "master_1",
        code: "other",
        message: "master exited"
      })
    ).toThrow(/master-closed/u);
  });
});

describe("remote-host Phase 6 control request boundary", () => {
  const resourceKey = {
    desktopInstallationId: "desktop_1",
    targetId: "target_1",
    workspaceId: "workspace_1",
    sessionId: "session_1"
  };

  it("accepts exact terminal injection, capture, and replay cursors", () => {
    const input = "hello\0world";
    const payloadHash = new IncrementalSha256()
      .update(new TextEncoder().encode(input))
      .digestHex();
    expect(
      decodeRemoteHostRequest({
        type: "terminal.inject",
        requestId: "request_1",
        targetId: "target_1",
        injection: {
          resourceKey,
          expectedKeeperGeneration: "keeper_1",
          operationId: "operation_1",
          payloadHash,
          input
        }
      })
    ).toMatchObject({ injection: { input, payloadHash } });
    expect(
      decodeRemoteHostRequest({
        type: "surface.capture",
        requestId: "request_2",
        targetId: "target_1",
        capture: {
          resourceKey,
          expectedKeeperGeneration: "keeper_1",
          captureId: "capture_1",
          lineLimit: 65_536,
          maxBytes: 1024 * 1024
        }
      })
    ).toMatchObject({ capture: { captureId: "capture_1" } });
    expect(
      decodeRemoteHostRequest({
        type: "events.replay",
        requestId: "request_3",
        targetId: "target_1",
        desktopInstallationId: "desktop_1",
        afterSequence: "18446744073709551615"
      })
    ).toMatchObject({ afterSequence: "18446744073709551615" });
  });

  it("rejects changed input hashes, noncanonical cursors, and capture overflow", () => {
    expect(() =>
      decodeRemoteHostRequest({
        type: "terminal.inject",
        requestId: "request_1",
        targetId: "target_1",
        injection: {
          resourceKey,
          expectedKeeperGeneration: "keeper_1",
          operationId: "operation_1",
          payloadHash: "0".repeat(64),
          input: "changed"
        }
      })
    ).toThrow(/hash does not match/u);
    expect(() =>
      decodeRemoteHostRequest({
        type: "events.ack",
        requestId: "request_2",
        targetId: "target_1",
        desktopInstallationId: "desktop_1",
        throughSequence: "01"
      })
    ).toThrow(/canonical uint64/u);
    expect(() =>
      decodeRemoteHostRequest({
        type: "surface.capture",
        requestId: "request_3",
        targetId: "target_1",
        capture: {
          resourceKey,
          expectedKeeperGeneration: "keeper_1",
          captureId: "capture_1",
          lineLimit: 1,
          maxBytes: 1024 * 1024 + 1
        }
      })
    ).toThrow(/maxBytes/u);
  });
});

describe("remote-host Phase 7 metadata request boundary", () => {
  const resourceKey = {
    desktopInstallationId: "desktop_1",
    targetId: "target_1",
    workspaceId: "workspace_1",
    sessionId: "session_1"
  };

  it("accepts exact target-bound port and bounded history/usage requests", () => {
    expect(
      decodeRemoteHostRequest({
        type: "ports.inspect",
        requestId: "request_ports",
        targetId: "target_1",
        resourceKey
      })
    ).toMatchObject({ type: "ports.inspect", resourceKey });
    expect(
      decodeRemoteHostRequest({
        type: "history.scan",
        requestId: "request_history",
        targetId: "target_1",
        desktopInstallationId: "desktop_1",
        maxRecords: 100
      })
    ).toMatchObject({ type: "history.scan", maxRecords: 100 });
    expect(
      decodeRemoteHostRequest({
        type: "usage.scan",
        requestId: "request_usage",
        targetId: "target_1",
        desktopInstallationId: "desktop_1",
        startAtUnixMs: 1_000,
        maxRecords: 64
      })
    ).toMatchObject({ type: "usage.scan", startAtUnixMs: 1_000 });
  });

  it("rejects cross-target port scope and history overflow", () => {
    expect(() =>
      decodeRemoteHostRequest({
        type: "ports.inspect",
        requestId: "request_ports",
        targetId: "target_2",
        resourceKey
      })
    ).toThrow(/outside its target/u);
    expect(() =>
      decodeRemoteHostRequest({
        type: "history.scan",
        requestId: "request_history",
        targetId: "target_1",
        desktopInstallationId: "desktop_1",
        maxRecords: 101
      })
    ).toThrow(/maxRecords/u);
    expect(() =>
      decodeRemoteHostRequest({
        type: "usage.scan",
        requestId: "request_usage",
        targetId: "target_1",
        desktopInstallationId: "desktop_1",
        startAtUnixMs: -1,
        maxRecords: 64
      })
    ).toThrow(/startAtUnixMs/u);
  });
});

describe("remote-host Phase 8 runtime maintenance boundary", () => {
  it("accepts only exact target-scoped clean and reset requests", () => {
    expect(
      decodeRemoteHostRequest({
        type: "target.runtime-clean",
        requestId: "request_clean",
        targetId: "target_1"
      })
    ).toEqual({
      type: "target.runtime-clean",
      requestId: "request_clean",
      targetId: "target_1"
    });
    expect(
      decodeRemoteHostRequest({
        type: "target.runtime-reset",
        requestId: "request_reset",
        targetId: "target_1"
      })
    ).toEqual({
      type: "target.runtime-reset",
      requestId: "request_reset",
      targetId: "target_1"
    });

    expect(() =>
      decodeRemoteHostRequest({
        type: "target.runtime-reset",
        requestId: "request_reset",
        targetId: "target_1",
        installRoot: "/"
      })
    ).toThrow(/unexpected/u);
  });
});

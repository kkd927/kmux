import { describe, expect, it } from "vitest";

import {
  decodeRemoteBridgeResponseEnvelope,
  decodeRemoteKeeperControlMessage,
  encodeRemoteControlJson
} from "./remoteControl";

describe("remote control v1", () => {
  it("strictly bounds target-local port and history metadata", () => {
    const ports = decodeRemoteBridgeResponseEnvelope(
      encodeRemoteControlJson({
        protocolVersion: 1,
        requestId: "request_ports",
        status: "ok",
        body: {
          type: "ports.inspected",
          resourceKey: {
            desktopInstallationId: "desktop_1",
            targetId: "target_1",
            workspaceId: "workspace_1",
            sessionId: "session_1"
          },
          ports: [3000, 5173]
        }
      })
    );
    if (ports.status !== "ok") throw new Error("expected port response");
    expect(ports.body).toMatchObject({
      type: "ports.inspected",
      ports: [3000, 5173]
    });

    const history = decodeRemoteBridgeResponseEnvelope(
      encodeRemoteControlJson({
        protocolVersion: 1,
        requestId: "request_history",
        status: "ok",
        body: {
          type: "history.scanned",
          targetId: "target_1",
          principal: { uid: 1000, accountName: "kmux" },
          records: [
            {
              vendor: "codex",
              sessionId: "session_1",
              updatedAtUnixMs: "1",
              canResume: true,
              cwd: "/srv/repo"
            }
          ]
        }
      })
    );
    if (history.status !== "ok") throw new Error("expected history response");
    expect(history.body).toMatchObject({
      type: "history.scanned",
      targetId: "target_1",
      records: [{ vendor: "codex", cwd: "/srv/repo" }]
    });

    const usage = decodeRemoteBridgeResponseEnvelope(
      encodeRemoteControlJson({
        protocolVersion: 1,
        requestId: "request_usage",
        status: "ok",
        body: {
          type: "usage.scanned",
          targetId: "target_1",
          principal: { uid: 1000, accountName: "kmux" },
          truncated: false,
          records: [
            {
              vendor: "codex",
              sampleId: "codex:session_1",
              timestampUnixMs: "1",
              sessionId: "session_1",
              cwd: "/srv/repo",
              inputTokens: "10",
              outputTokens: "2",
              thinkingTokens: "1",
              cacheReadTokens: "3",
              cacheWriteTokens: "0",
              cacheWriteTokensKnown: true,
              totalTokens: "16"
            }
          ]
        }
      })
    );
    if (usage.status !== "ok") throw new Error("expected usage response");
    expect(usage.body).toMatchObject({
      type: "usage.scanned",
      targetId: "target_1",
      records: [{ sampleId: "codex:session_1", totalTokens: "16" }]
    });

    expect(() =>
      decodeRemoteBridgeResponseEnvelope(
        encodeRemoteControlJson({
          protocolVersion: 1,
          requestId: "request_duplicate_ports",
          status: "ok",
          body: {
            type: "ports.inspected",
            resourceKey: {
              desktopInstallationId: "desktop_1",
              targetId: "target_1",
              workspaceId: "workspace_1",
              sessionId: "session_1"
            },
            ports: [3000, 3000]
          }
        })
      )
    ).toThrow(/unique/u);

    expect(() =>
      decodeRemoteBridgeResponseEnvelope(
        encodeRemoteControlJson({
          protocolVersion: 1,
          requestId: "request_git_relative",
          status: "ok",
          body: {
            type: "git.inspected",
            cwd: "/srv/repo",
            repository: {
              root: "relative/repo",
              gitDir: "/srv/repo/.git",
              commonGitDir: "/srv/repo/.git",
              linkedWorktree: false
            },
            dirtyEntries: [],
            dirtyEntriesTruncated: false
          }
        })
      )
    ).toThrow(/absolute remote path/u);
  });

  it("strictly decodes direct and pinned cohort attach endpoints", () => {
    const base = {
      protocolVersion: 1,
      requestId: "request_attach",
      status: "ok",
      body: {
        type: "attach.authorized",
        resourceKey: {
          desktopInstallationId: "desktop_1",
          targetId: "target_1",
          workspaceId: "workspace_1",
          sessionId: "session_1"
        },
        keeperGeneration: "keeper_1",
        attachCapability: "a".repeat(64),
        expiresAt: "2026-07-18T00:00:30.000Z",
        access: "write"
      }
    } as const;
    expect(
      decodeRemoteBridgeResponseEnvelope(
        encodeRemoteControlJson({
          ...base,
          body: { ...base.body, terminalProxy: { kind: "direct" } }
        })
      )
    ).toMatchObject({
      body: { terminalProxy: { kind: "direct" } }
    });
    expect(
      decodeRemoteBridgeResponseEnvelope(
        encodeRemoteControlJson({
          ...base,
          body: {
            ...base.body,
            terminalProxy: {
              kind: "cohort",
              executablePath: "/opt/kmux/old/kmuxd",
              socketPath: "/tmp/kmux/cohort.sock",
              keeperLocalProtocolMajor: 2
            }
          }
        })
      )
    ).toMatchObject({
      body: {
        terminalProxy: {
          kind: "cohort",
          keeperLocalProtocolMajor: 2
        }
      }
    });
  });

  it("decodes exact hello authority and successful operation results", () => {
    expect(
      decodeRemoteBridgeResponseEnvelope(
        encodeRemoteControlJson({
          protocolVersion: 1,
          requestId: "request_1",
          status: "ok",
          body: {
            type: "hello",
            protocolVersion: 1,
            runtimeVersion: "0.1.0",
            bridgeGeneration: "bridge_1",
            capabilities: ["terminal-v1"],
            authority: {
              remoteInstallationId: "installation_1",
              executionNodeId: "node_1",
              authenticatedPrincipal: { uid: 1000, accountName: "kmux" }
            },
            platform: "linux",
            arch: "x86_64",
            abi: "musl",
            persistenceLevel: "ssh-disconnect"
          }
        })
      )
    ).toMatchObject({
      status: "ok",
      body: {
        type: "hello",
        persistenceLevel: "ssh-disconnect",
        authority: {
          remoteInstallationId: "installation_1",
          executionNodeId: "node_1"
        }
      }
    });

    expect(() =>
      decodeRemoteBridgeResponseEnvelope(
        encodeRemoteControlJson({
          protocolVersion: 1,
          requestId: "request_bad_persistence",
          status: "ok",
          body: {
            type: "hello",
            protocolVersion: 1,
            runtimeVersion: "0.1.0",
            bridgeGeneration: "bridge_1",
            capabilities: [],
            authority: {
              remoteInstallationId: "installation_1",
              executionNodeId: "node_1",
              authenticatedPrincipal: { uid: 1000, accountName: "kmux" }
            },
            platform: "linux",
            arch: "x86_64",
            abi: "musl",
            persistenceLevel: "persistent"
          }
        })
      )
    ).toThrow(/persistenceLevel/u);

    expect(
      decodeRemoteBridgeResponseEnvelope(
        encodeRemoteControlJson({
          protocolVersion: 1,
          requestId: "request_2",
          status: "ok",
          body: {
            type: "operation.result",
            outcome: "succeeded",
            operationId: "operation_1",
            remoteResourceRevision: "18446744073709551615",
            resultDigest: "a".repeat(64),
            keeperGeneration: "keeper_1"
          }
        })
      )
    ).toEqual({
      protocolVersion: 1,
      requestId: "request_2",
      status: "ok",
      body: {
        type: "operation.result",
        outcome: "succeeded",
        operationId: "operation_1",
        remoteResourceRevision: "18446744073709551615",
        resultDigest: "a".repeat(64),
        keeperGeneration: "keeper_1"
      }
    });
  });

  it("rejects surplus fields and noncanonical uint64 JSON", () => {
    expect(() =>
      decodeRemoteBridgeResponseEnvelope(
        encodeRemoteControlJson({
          protocolVersion: 1,
          requestId: "request_1",
          status: "error",
          error: { code: "failed", message: "failed", retryable: false },
          surprise: true
        })
      )
    ).toThrow(/unexpected remote control field/u);

    expect(() =>
      decodeRemoteBridgeResponseEnvelope(
        encodeRemoteControlJson({
          protocolVersion: 1,
          requestId: "request_1",
          status: "ok",
          body: {
            type: "operation.result",
            outcome: "succeeded",
            operationId: "operation_1",
            remoteResourceRevision: "01",
            resultDigest: "a".repeat(64)
          }
        })
      )
    ).toThrow(/canonical uint64/u);
  });

  it("strictly decodes conversion evidence and retained descriptor observations", () => {
    const envelope = (requestId: string, body: unknown) =>
      decodeRemoteBridgeResponseEnvelope(
        encodeRemoteControlJson({
          protocolVersion: 1,
          requestId,
          status: "ok",
          body
        })
      );
    expect(
      envelope("prepare_1", {
        type: "conversion.prepared",
        transactionId: "conversion_1",
        remoteSnapshotHash: "a".repeat(64),
        workspaceDescriptorHash: "b".repeat(64),
        sessionDescriptorHash: "c".repeat(64),
        keeperGeneration: "keeper_1",
        remoteResourceRevision: "1",
        remoteCreatedAt: "2026-07-18T00:00:00.000Z"
      })
    ).toMatchObject({ body: { type: "conversion.prepared" } });
    expect(
      envelope("promote_1", {
        type: "conversion.promoted",
        transactionId: "conversion_1",
        remoteSnapshotHash: "a".repeat(64),
        remotePromotionHash: "d".repeat(64)
      })
    ).toMatchObject({ body: { type: "conversion.promoted" } });
    expect(
      envelope("reclaim_1", {
        type: "provisional.reclaimed",
        protectedCount: 1,
        terminatedTransactionIds: ["conversion_expired"],
        skippedEverLeasedTransactionIds: ["conversion_leased"]
      })
    ).toMatchObject({
      body: {
        protectedCount: 1,
        terminatedTransactionIds: ["conversion_expired"]
      }
    });

    const observed = {
      type: "observed",
      targetId: "target_1",
      bridgeGeneration: "bridge_1",
      observedAt: "2026-07-18T00:00:00.000Z",
      workspaces: [
        {
          resourceKey: {
            desktopInstallationId: "desktop_1",
            targetId: "target_1",
            workspaceId: "workspace_1"
          },
          state: "active",
          remoteResourceRevision: "2",
          createOperationId: "workspace_create_1",
          canonicalCreatePayloadHash: "d".repeat(64),
          lastOperationId: "worktree_create_1",
          lastOperationPayloadHash: "e".repeat(64),
          lastResultDigest: "f".repeat(64)
        }
      ],
      keepers: [
        {
          resourceKey: {
            desktopInstallationId: "desktop_1",
            targetId: "target_1",
            workspaceId: "workspace_1",
            sessionId: "session_1"
          },
          keeperGeneration: "keeper_1",
          descriptorState: "running",
          processState: "running",
          remoteResourceRevision: "1",
          createOperationId: "create_1",
          canonicalCreatePayloadHash: "a".repeat(64),
          lastOperationId: "create_1",
          lastOperationPayloadHash: "a".repeat(64),
          lastResultDigest: "b".repeat(64),
          launch: { cwd: "/srv/app", shell: "/bin/sh" },
          lifecycleState: "provisional",
          conversionTransactionId: "conversion_1",
          remoteSnapshotHash: "c".repeat(64),
          provisionalCreatedAt: "2026-07-18T00:00:00.000Z",
          everGrantedWriterLease: false,
          checkpointAvailable: true,
          retainedRangeTruncated: true,
          storageStatus: {
            state: "degraded",
            journalAdmitted: "17",
            journalSynced: "16",
            emergencyBytes: 1024,
            lastSyncDurationMs: 2100
          }
        }
      ]
    };
    expect(envelope("observe_1", observed)).toMatchObject({
      body: {
        workspaces: [
          {
            state: "active",
            remoteResourceRevision: "2",
            lastOperationId: "worktree_create_1"
          }
        ],
        keepers: [
          {
            lifecycleState: "provisional",
            descriptorState: "running",
            everGrantedWriterLease: false,
            checkpointAvailable: true,
            retainedRangeTruncated: true,
            storageStatus: {
              state: "degraded",
              journalAdmitted: "17",
              journalSynced: "16",
              emergencyBytes: 1024
            }
          }
        ]
      }
    });
    expect(() =>
      envelope("observe_bad", {
        ...observed,
        keepers: [{ ...observed.keepers[0], unknownEvidence: true }]
      })
    ).toThrow(/unexpected remote control field/u);
    expect(() =>
      envelope("observe_bad_storage_sequence", {
        ...observed,
        keepers: [
          {
            ...observed.keepers[0],
            storageStatus: {
              ...observed.keepers[0].storageStatus,
              journalAdmitted: "16",
              journalSynced: "17"
            }
          }
        ]
      })
    ).toThrow(/journalSynced cannot exceed journalAdmitted/u);
  });

  it("decodes bounded terminal injection, capture, and event replay results", () => {
    const resourceKey = {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: "workspace_1",
      sessionId: "session_1"
    } as const;
    const envelope = (requestId: string, body: unknown) =>
      decodeRemoteBridgeResponseEnvelope(
        encodeRemoteControlJson({
          protocolVersion: 1,
          requestId,
          status: "ok",
          body
        })
      );

    expect(
      envelope("input_1", {
        type: "terminal.input-ack",
        resourceKey,
        keeperGeneration: "keeper_1",
        operationId: "operation_1",
        writerLeaseId: "lease_1",
        byteLength: 5,
        boundary: "pty-write"
      })
    ).toMatchObject({
      body: {
        type: "terminal.input-ack",
        operationId: "operation_1",
        boundary: "pty-write"
      }
    });
    expect(
      envelope("capture_chunk_1", {
        type: "surface.capture-chunk",
        captureId: "capture_1",
        index: 0,
        text: "첫 줄\n"
      })
    ).toMatchObject({
      body: { type: "surface.capture-chunk", index: 0, text: "첫 줄\n" }
    });
    expect(
      envelope("capture_complete_1", {
        type: "surface.capture-completed",
        captureId: "capture_1",
        resourceKey,
        keeperGeneration: "keeper_1",
        mutationSequence: "17",
        cols: 120,
        rows: 40,
        lineCount: 2,
        byteLength: 12,
        chunkCount: 1,
        sha256: "a".repeat(64),
        linesTruncated: false,
        bytesTruncated: false,
        retainedRangeTruncated: true
      })
    ).toMatchObject({
      body: {
        type: "surface.capture-completed",
        mutationSequence: "17",
        retainedRangeTruncated: true
      }
    });

    expect(
      envelope("events_1", {
        type: "events.replayed",
        targetId: "target_1",
        events: [
          {
            version: 1,
            sequence: "1",
            eventId: "event_1",
            kind: "notification",
            name: "needs-input",
            resourceKey,
            surfaceId: "surface_1",
            keeperGeneration: "keeper_1",
            createdAtUnixMs: "1784370000000",
            payload: { title: "Input needed" }
          }
        ],
        acknowledgedThrough: "0",
        hasMore: false,
        admittedCount: "1",
        droppedLowValueCount: "0"
      })
    ).toMatchObject({
      body: {
        type: "events.replayed",
        events: [{ eventId: "event_1", sequence: "1" }]
      }
    });
    expect(
      envelope("events_ack_1", {
        type: "events.acknowledged",
        targetId: "target_1",
        acknowledgedThrough: "1",
        removedCount: 1
      })
    ).toMatchObject({
      body: {
        type: "events.acknowledged",
        acknowledgedThrough: "1",
        removedCount: 1
      }
    });
  });

  it("rejects capture and event payloads outside their hard bounds", () => {
    const envelope = (body: unknown) =>
      decodeRemoteBridgeResponseEnvelope(
        encodeRemoteControlJson({
          protocolVersion: 1,
          requestId: "bounded_1",
          status: "ok",
          body
        })
      );
    expect(() =>
      envelope({
        type: "surface.capture-chunk",
        captureId: "capture_1",
        index: 0,
        text: "가".repeat(11_000)
      })
    ).toThrow(/capture text chunk/u);
    expect(() =>
      envelope({
        type: "events.replayed",
        targetId: "target_1",
        events: [
          {
            version: 1,
            sequence: "01",
            eventId: "event_1",
            kind: "notification",
            name: "notice",
            resourceKey: {
              desktopInstallationId: "desktop_1",
              targetId: "target_1",
              workspaceId: "workspace_1",
              sessionId: "session_1"
            },
            surfaceId: "surface_1",
            keeperGeneration: "keeper_1",
            createdAtUnixMs: "1",
            payload: {}
          }
        ],
        acknowledgedThrough: "0",
        hasMore: false,
        admittedCount: "1",
        droppedLowValueCount: "0"
      })
    ).toThrow(/canonical uint64/u);
  });

  it("validates keeper acknowledgements at the PTY boundary", () => {
    expect(
      decodeRemoteKeeperControlMessage(
        encodeRemoteControlJson({
          type: "attach.ready",
          keeperGeneration: "keeper_1",
          attachmentId: "attachment_1",
          writerLeaseId: "lease_1",
          checkpointAvailable: false,
          cols: 120,
          rows: 40,
          earliestAvailableSequence: "1",
          replayFromSequence: "8",
          liveStartsAfterSequence: "9"
        })
      )
    ).toMatchObject({
      type: "attach.ready",
      cols: 120,
      rows: 40,
      replayFromSequence: "8"
    });

    expect(
      decodeRemoteKeeperControlMessage(
        encodeRemoteControlJson({
          type: "input.ack",
          writerLeaseId: "lease_1",
          attachmentId: "attachment_1",
          highestAppliedInputSequence: "7",
          boundary: "pty-write"
        })
      )
    ).toEqual({
      type: "input.ack",
      writerLeaseId: "lease_1",
      attachmentId: "attachment_1",
      highestAppliedInputSequence: "7",
      boundary: "pty-write"
    });

    expect(() =>
      decodeRemoteKeeperControlMessage(
        encodeRemoteControlJson({
          type: "input.ack",
          writerLeaseId: "lease_1",
          attachmentId: "attachment_1",
          highestAppliedInputSequence: "7",
          boundary: "accepted"
        })
      )
    ).toThrow(/boundary/u);
  });

  it("retains a bounded incompatible checkpoint identity for replay fallback", () => {
    expect(
      decodeRemoteKeeperControlMessage(
        encodeRemoteControlJson({
          type: "checkpoint.begin",
          checkpointId: "checkpoint_1",
          format: "future-vt/2",
          parserVersion: "future-parser/1",
          lastMutationSequence: "7",
          cols: 80,
          rows: 24,
          byteLength: "128"
        })
      )
    ).toMatchObject({
      type: "checkpoint.begin",
      format: "future-vt/2",
      parserVersion: "future-parser/1"
    });

    expect(() =>
      decodeRemoteKeeperControlMessage(
        encodeRemoteControlJson({
          type: "checkpoint.begin",
          checkpointId: "checkpoint_1",
          format: "x".repeat(257),
          parserVersion: "future-parser/1",
          lastMutationSequence: "7",
          cols: 80,
          rows: 24,
          byteLength: "128"
        })
      )
    ).toThrow(/format/u);
  });

  it("enforces the control-message byte bound before framing", () => {
    expect(() =>
      encodeRemoteControlJson({ value: "x".repeat(256 * 1024) })
    ).toThrow(/256 KiB/u);
  });
});

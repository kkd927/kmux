import {
  METADATA_SOURCE_CONTRACT,
  type MetadataSourceContract
} from "@kmux/metadata/core";
import { createFileUsageAdapter } from "@kmux/metadata";
import { decodeAgentDescriptorCatalogDto, decodeAgentId } from "@kmux/proto";
import { describe, expect, it, vi } from "vitest";
import ordinaryAgentManifestFixture from "../fixtures/ordinary-agent-manifest.json";

const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>()
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  clipboard: {
    availableFormats: vi.fn(() => []),
    read: vi.fn(() => ""),
    readBookmark: vi.fn(() => ({ title: "", url: "" })),
    readBuffer: vi.fn(() => Buffer.alloc(0)),
    readImage: vi.fn(() => ({
      isEmpty: () => true,
      toPNG: () => Buffer.alloc(0)
    })),
    readText: vi.fn(() => ""),
    writeText: vi.fn()
  },
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        ipcHandlers.set(channel, handler);
      }
    )
  },
  Menu: { buildFromTemplate: vi.fn() }
}));

import { registerIpcHandlers } from "../../../apps/desktop/src/main/ipcHandlers";
import { mergeExternalAgentSessionSnapshots } from "../../../apps/desktop/src/main/targetHistoryRuntime";
import type {
  RemoteMetadataSourceQuery,
  RemoteMetadataSourceRead,
  RemoteMetadataSourcesList
} from "../../../apps/desktop/src/remote-host/linuxX64RemoteRuntime";
import { RemoteMetadataSession } from "../../../apps/desktop/src/remote-host/remoteMetadataSession";
import { projectExternalSessionAgentFilters } from "../../../apps/desktop/src/renderer/src/components/ExternalSessionsPanel";
import { resolveAgentResumePolicy } from "./command";
import { createInternalAgentModuleRegistry } from "./composition";
import {
  createMaterializedExternalSessionIndexer,
  materializeAgentSessionSources,
  type AgentSessionProjectionBinding
} from "./externalSessionRuntime";
import { createAgentHookRuntime } from "./hookRuntime";
import { createPortableAgentManifest } from "./manifest";
import { normalizeAgentScopeSettings } from "./settings";
import type { AgentModule } from "./contracts";
import {
  createJsonlUsageSourceProjection,
  extractGenericUsageSample,
  isUsageTimestampInRange
} from "./builtins/usageParsingShared";

const basicFixture = {
  descriptor: {
    id: "fixture-nebula",
    displayName: "Nebula Fixture",
    aliases: ["nebula-cli"],
    presentation: { shortLabel: "NEB" }
  },
  definitionRevision: "fixture-nebula-v1",
  command: { executable: "nebula" },
  resume: {
    build: (commonArgs, sessionId) => [...commonArgs, "resume", sessionId]
  },
  hooks: {
    portable: {
      format: "grouped-hooks",
      relativePath: ".nebula/hooks.json",
      marker: "KMUX_MANAGED_NEBULA_FIXTURE=1",
      managed: [{ event: "Completed" }],
      deprecated: [],
      outputMode: "silent",
      successResponse: {},
      fallbackResponse: {},
      sessionClaim: {
        startEvents: ["Completed"],
        sessionIdFields: ["sessionId"]
      }
    },
    normalize(event, payload) {
      if (event.toLowerCase() !== "completed") return null;
      return {
        event: "turn_complete",
        vendorSessionId:
          typeof payload.sessionId === "string" ? payload.sessionId : undefined
      };
    }
  }
} satisfies AgentModule;

const sharedMetadataFixture = {
  descriptor: {
    id: "fixture-orbit",
    displayName: "Orbit Fixture",
    aliases: []
  },
  definitionRevision: "fixture-orbit-v1",
  hooks: {
    portable: {
      format: "grouped-hooks",
      relativePath: ".orbit/hooks.json",
      marker: "KMUX_MANAGED_ORBIT_FIXTURE=1",
      managed: [{ event: "Started" }],
      deprecated: [],
      outputMode: "silent",
      successResponse: {},
      fallbackResponse: {},
      sessionClaim: {
        startEvents: ["Started"],
        sessionIdFields: ["sessionId"]
      }
    },
    normalize(event, payload) {
      if (event.toLowerCase() !== "started") return null;
      return {
        event: "turn_complete",
        vendorSessionId:
          typeof payload.sessionId === "string" ? payload.sessionId : undefined
      };
    }
  },
  metadataSources: {
    revision: "fixture-orbit-metadata-v1",
    defaultRoot: ".orbit/sessions",
    resolveLocalRoots: () => ["/fixture/orbit/sessions"],
    sources: [
      {
        role: "fixture-orbit/session-jsonl",
        format: "jsonl",
        pattern: "**/*.jsonl",
        purposes: ["externalSessions", "history", "usage"],
        claimScope: "agent"
      }
    ]
  },
  externalSessions: {
    createMetadataProjection: createOrbitProjection
  },
  history: {
    createMetadataProjection: createOrbitProjection,
    createSourceProjection: () => ({
      projectSource: (input) =>
        (input.records ?? []).flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const record = value as Record<string, unknown>;
          if (typeof record.session_id !== "string") return [];
          return [
            {
              sessionId: record.session_id,
              title: "Orbit source session",
              updatedAtMs:
                typeof record.timestamp === "string"
                  ? Date.parse(record.timestamp)
                  : input.mtimeMs
            }
          ];
        })
    })
  },
  usage: {
    createSourceProjection: () => createOrbitUsageProjection(),
    createLocalAdapter(options) {
      return createFileUsageAdapter({
        agentId: "fixture-orbit",
        roots: ["/fixture/orbit/sessions"],
        sourceProjection: createOrbitUsageProjection(),
        classifySource: () => ({
          role: "fixture-orbit/session-jsonl",
          format: "jsonl"
        }),
        metadataInventory: options.metadataInventory
      });
    }
  }
} satisfies AgentModule;

function createOrbitUsageProjection() {
  return createJsonlUsageSourceProjection("fixture-orbit", {
    createState: () => ({}),
    cloneState: () => ({}),
    resetSource: () => undefined,
    parseRecord(_state, input) {
      const sample = extractGenericUsageSample({
        agentId: "fixture-orbit",
        record: input.record,
        sourcePath: input.sourcePath
      });
      return sample && isUsageTimestampInRange(sample.timestampMs, input.range)
        ? [sample]
        : [];
    }
  });
}

function createOrbitProjection() {
  return {
    async project(input: {
      maxRecords: number;
      readText(request: {
        path: string;
        offset: number;
        maxBytes: number;
      }): Promise<string>;
    }) {
      const title = await input.readText({
        path: "/fixture/orbit/sessions/session.jsonl",
        offset: 0,
        maxBytes: 256
      });
      return {
        records: [
          {
            sessionId: "orbit-session",
            title,
            updatedAtMs: Date.parse("2026-08-18T00:00:00.000Z")
          }
        ].slice(0, input.maxRecords),
        truncated: false
      };
    }
  };
}

describe("ordinary new-agent architecture gate", () => {
  it("traverses catalog, settings, dispatch, hook/wire, and manifest projections without a consumer whitelist", async () => {
    const registry = createInternalAgentModuleRegistry([
      basicFixture,
      sharedMetadataFixture
    ]);
    expect(
      registry
        .resolver("usage")
        .resolve("fixture-orbit")
        ?.createLocalAdapter?.({}).vendor
    ).toBe("fixture-orbit");

    const settings = normalizeAgentScopeSettings({
      catalog: registry.catalog,
      value: {
        "fixture-nebula": { command: "/opt/nebula", args: ["--safe"] },
        "future-unknown": { command: "/opt/future" }
      }
    });
    expect(settings.has(decodeAgentId("future-unknown"))).toBe(false);

    const command = registry.commands().get("fixture-nebula")!;
    const resume = registry.resolver("resume").resolve("fixture-nebula")!;
    expect(
      resolveAgentResumePolicy({
        agentId: "fixture-nebula",
        command,
        resume,
        settings: settings.get("fixture-nebula"),
        sessionId: "session-1"
      })
    ).toEqual({
      agentId: "fixture-nebula",
      command: "/opt/nebula",
      args: ["--safe", "resume", "session-1"]
    });

    const hooks = createAgentHookRuntime({
      catalog: registry.catalog,
      hooks: registry.resolver("hooks")
    });
    expect(
      hooks.normalizeEvent("NEBULA-CLI", "Completed", { sessionId: "s-1" })
    ).toMatchObject({
      agent: "fixture-nebula",
      event: "turn_complete",
      vendorSessionId: "s-1"
    });

    const bindings: AgentSessionProjectionBinding[] = [
      ...registry
        .materialize("externalSessions")
        .map(({ agentId, capability }) => ({
          agentId,
          purpose: "externalSessions" as const,
          capability
        })),
      ...registry.materialize("history").map(({ agentId, capability }) => ({
        agentId,
        purpose: "history" as const,
        capability
      }))
    ];
    const sources = materializeAgentSessionSources({
      bindings,
      metadataSources: registry.metadataSources(),
      runtime: { homeDir: "/fixture" }
    });
    const inventory = vi.fn(async () => ({
      candidates: [
        {
          path: "/fixture/orbit/sessions/session.jsonl",
          mtimeMs: Date.parse("2026-08-18T00:00:00.000Z"),
          size: 16
        }
      ],
      diagnostics: [],
      truncated: false
    }));
    const readText = vi.fn(async () => "Orbit metadata session");
    const acquire = vi.fn(() => ({
      inventory,
      readText,
      query: vi.fn(async (request) => ({
        queryPlanId: request.queryPlanId,
        rows: []
      })),
      watch: () => () => undefined,
      invalidate: () => undefined,
      release: async () => undefined
    }));
    const metadataInventory = {
      acquire,
      invalidate: () => undefined,
      close: async () => undefined
    };
    const indexer = createMaterializedExternalSessionIndexer({
      sources,
      metadataInventory,
      catalog: registry.catalog,
      resolveResume: () => undefined,
      commandAvailability: () => true,
      now: () => new Date("2026-08-18T01:00:00.000Z")
    });
    const snapshot = await indexer.listExternalAgentSessions();
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({
        vendor: "fixture-orbit",
        title: "Orbit metadata session"
      })
    ]);
    const historySnapshot = await indexer.listAgentHistorySessions();
    expect(historySnapshot.sessions).toEqual([
      expect.objectContaining({
        vendor: "fixture-orbit",
        title: "Orbit metadata session"
      })
    ]);
    expect(
      sources.map(({ agentId, purpose }) => ({ agentId, purpose }))
    ).toEqual(
      expect.arrayContaining([
        { agentId: "fixture-orbit", purpose: "externalSessions" },
        { agentId: "fixture-orbit", purpose: "history" }
      ])
    );
    expect(acquire).toHaveBeenCalledWith(
      "fixture-orbit",
      ["/fixture/orbit/sessions"],
      undefined
    );
    expect(readText).toHaveBeenCalled();
    const usageAdapter = registry.resolver("usage").resolve("fixture-orbit")!
      .createLocalAdapter!({ metadataInventory });
    await expect(usageAdapter.initialScan(0)).resolves.toMatchObject({
      sourceCount: 1
    });
    usageAdapter.close();

    ipcHandlers.clear();
    registerIpcHandlers({
      getAgentCatalog: () => registry.catalog.listDescriptors(),
      getExternalAgentSessions: () =>
        mergeExternalAgentSessionSnapshots([historySnapshot, snapshot]),
      clipboard: {
        readText: () => "",
        writeText: () => undefined,
        readImages: () => [],
        hasPasteableContent: () => false
      }
    } as never);
    const catalogHandler = ipcHandlers.get("kmux:agents:catalog");
    const sessionsHandler = ipcHandlers.get("kmux:external-sessions:get");
    expect(catalogHandler).toBeDefined();
    expect(sessionsHandler).toBeDefined();
    const rendererCatalog = decodeAgentDescriptorCatalogDto(
      structuredClone(await catalogHandler?.())
    );
    expect(
      rendererCatalog.find(({ id }) => id === "fixture-nebula")
    ).toMatchObject({
      displayName: "Nebula Fixture",
      capabilities: expect.arrayContaining(["resume", "hooks"])
    });
    const rendererSnapshot = structuredClone(
      await sessionsHandler?.()
    ) as typeof snapshot;
    expect(
      projectExternalSessionAgentFilters(
        rendererCatalog,
        rendererSnapshot.sessions
      )
    ).toEqual([{ key: "fixture-orbit", label: "Orbit Fixture" }]);

    const remoteProjection = registry
      .resolver("history")
      .resolve("fixture-orbit")
      ?.createSourceProjection?.();
    expect(remoteProjection).toBeDefined();
    const remoteContent = [
      {
        prompt: "remote",
        timestamp: "2026-08-18T00:00:00.001Z",
        session_id: "orbit-remote",
        input_tokens: 7,
        output_tokens: 3,
        total_tokens: 10
      },
      {
        prompt: "remote second",
        timestamp: "2026-08-18T00:00:00.002Z",
        session_id: "orbit-remote-2",
        input_tokens: 11,
        output_tokens: 5,
        total_tokens: 16
      }
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")
      .concat("\n");
    const remoteDefinitions = { "fixture-orbit": "fixture-orbit-v1" };
    const remoteClaim = {
      sessionId: "orbit-remote",
      claimedAtUnixMs: "1787011200000",
      lastSeenAtUnixMs: "1787011200001",
      cwd: "/srv/orbit",
      workspacePaths: ["/srv/orbit"],
      launchTitle: "Orbit launch"
    };
    const secondRemoteClaim = {
      sessionId: "orbit-remote-2",
      claimedAtUnixMs: "1787011200000",
      lastSeenAtUnixMs: "1787011200002",
      cwd: "/srv/orbit-2",
      workspacePaths: ["/srv/orbit-2"],
      launchTitle: "Orbit launch 2"
    };
    const sourceContract = {
      ...METADATA_SOURCE_CONTRACT,
      sources: [
        ...METADATA_SOURCE_CONTRACT.sources,
        {
          vendor: "fixture-orbit",
          role: "fixture-orbit/session-jsonl",
          format: "jsonl",
          purposes: ["history", "usage"],
          claimScope: "agent",
          pattern: "**/*.jsonl"
        }
      ]
    } satisfies MetadataSourceContract;
    const remoteSession = new RemoteMetadataSession({
      runtime: {
        async listMetadataSources(request: {
          purpose: "usage" | "history" | "all";
        }): Promise<RemoteMetadataSourcesList> {
          return {
            type: "metadata.sources.listed",
            targetId: "target_1",
            purpose: request.purpose,
            contractVersion: 2,
            agentDefinitions: remoteDefinitions,
            truncated: false,
            claims:
              request.purpose === "usage"
                ? []
                : [
                    { vendor: "fixture-orbit", ...remoteClaim },
                    { vendor: "fixture-orbit", ...secondRemoteClaim }
                  ],
            sources: [
              {
                sourceId: "source_1",
                vendor: "fixture-orbit",
                definitionRevision: "fixture-orbit-v1",
                role: "fixture-orbit/session-jsonl",
                format: "jsonl",
                logicalName: "sessions/orbit-session.jsonl",
                size: String(Buffer.byteLength(remoteContent)),
                mtimeUnixMs: "1787011200000",
                fileIdentity: "orbit:1",
                claim: remoteClaim
              }
            ]
          };
        },
        async readMetadataSource(request: {
          sourceId: string;
          offset: number;
          maxBytes: number;
        }): Promise<RemoteMetadataSourceRead> {
          const bytes = Buffer.from(remoteContent);
          const end = Math.min(bytes.length, request.offset + request.maxBytes);
          return {
            type: "metadata.sources.read",
            sourceId: request.sourceId,
            offset: String(request.offset),
            nextOffset: String(end),
            eof: end === bytes.length,
            fileIdentity: "orbit:1",
            content: bytes.subarray(request.offset, end).toString("utf8")
          };
        },
        async queryMetadataSource(): Promise<RemoteMetadataSourceQuery> {
          throw new Error("unexpected query");
        }
      },
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      principal: { uid: 1_000, accountName: "kmux" },
      agentDefinitions: remoteDefinitions,
      sourceContract,
      historyProjections: new Map([["fixture-orbit", remoteProjection!]]),
      usageProjections: new Map([
        ["fixture-orbit", sharedMetadataFixture.usage.createSourceProjection()]
      ])
    });
    await expect(
      remoteSession.scanHistory({ maxRecords: 100 })
    ).resolves.toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({
          vendor: "fixture-orbit",
          sessionId: "orbit-remote",
          title: "Orbit source session",
          cwd: "/srv/orbit"
        }),
        expect.objectContaining({
          vendor: "fixture-orbit",
          sessionId: "orbit-remote-2",
          title: "Orbit source session",
          cwd: "/srv/orbit-2"
        })
      ])
    });
    await expect(
      remoteSession.scanUsage({ startAtUnixMs: 0, maxRecords: 100 })
    ).resolves.toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({
          vendor: "fixture-orbit",
          sessionId: "orbit-remote",
          inputTokens: "7",
          outputTokens: "3"
        }),
        expect.objectContaining({
          vendor: "fixture-orbit",
          sessionId: "orbit-remote-2",
          inputTokens: "11",
          outputTokens: "5"
        })
      ])
    });

    const manifest = createPortableAgentManifest([
      basicFixture,
      sharedMetadataFixture
    ]);
    expect(manifest).toEqual(ordinaryAgentManifestFixture);
    expect(manifest.agents.map(({ id }) => id)).toEqual([
      "fixture-nebula",
      "fixture-orbit"
    ]);
    expect(manifest.agents[1]?.metadata?.sources[0]).toMatchObject({
      role: "fixture-orbit/session-jsonl",
      pattern: "**/*.jsonl"
    });
  });
});

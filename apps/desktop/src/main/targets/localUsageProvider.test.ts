import { encodeLocatedPathDto, localLocatedPath } from "@kmux/core";

import type { UsageScanService } from "../usageScanWorkerClient";
import { createLocalUsageProvider } from "./localUsageProvider";

describe("local usage provider", () => {
  it("adapts the existing worker through the target provider contract", async () => {
    const cleanup = vi.fn();
    const scanService: UsageScanService = {
      watch: vi.fn(() => cleanup),
      scan: vi.fn<UsageScanService["scan"]>(async () => ({
        reads: [
          {
            sourceCount: 1,
            samples: [
              {
                vendor: "claude",
                timestampMs: 1_000,
                sourcePath: "/tmp/session.jsonl",
                sourceType: "jsonl",
                sessionId: "session-1",
                cwd: "/tmp/repo",
                inputTokens: 10,
                outputTokens: 2,
                cacheTokens: 0,
                totalTokens: 12,
                estimatedCostUsd: 0.01,
                costSource: "reported"
              }
            ]
          }
        ]
      })),
      markDirty: vi.fn(),
      close: vi.fn()
    };
    const provider = createLocalUsageProvider({ scanService });

    const scan = await provider.refresh({
      startAtUnixMs: 0,
      initial: true,
      maxRecords: 100
    });

    expect(scan.records).toMatchObject([
      {
        vendor: "claude",
        sessionId: "session-1",
        totalTokens: 12
      }
    ]);
    expect(
      encodeLocatedPathDto(localLocatedPath(scan.records[0].cwd!))
    ).toEqual({ kind: "local", path: "/tmp/repo" });
    const watch = vi.fn();
    expect(provider.watch?.(watch)).toBe(cleanup);
    provider.markDirty?.("claude", { discoverNewSources: true });
    expect(scanService.markDirty).toHaveBeenCalledWith("claude", {
      discoverNewSources: true
    });
    provider.close?.();
    expect(scanService.close).toHaveBeenCalledOnce();
  });

  it("forces a complete snapshot after a partial scan", async () => {
    const historyDays = [
      {
        dayKey: "2026-07-17",
        totalCostUsd: 0,
        reportedCostUsd: 0,
        estimatedCostUsd: 0,
        unknownCostTokens: 0,
        totalTokens: 0,
        vendors: []
      }
    ];
    const scanService: UsageScanService = {
      watch: vi.fn(() => () => undefined),
      scan: vi
        .fn<UsageScanService["scan"]>()
        .mockResolvedValueOnce({
          reads: [{ sourceCount: 1, samples: [], truncated: true }],
          historyDays
        })
        .mockResolvedValueOnce({
          reads: [{ sourceCount: 1, samples: [], truncated: false }],
          historyDays
        })
        .mockResolvedValueOnce({
          reads: [{ sourceCount: 1, samples: [], truncated: false }]
        }),
      markDirty: vi.fn(),
      close: vi.fn()
    };
    const provider = createLocalUsageProvider({ scanService });

    const partial = await provider.refresh({
      startAtUnixMs: 0,
      initial: true,
      maxRecords: 100
    });
    expect(partial).toMatchObject({ truncated: true, incremental: false });
    expect(partial.historyDays).toBeUndefined();
    await expect(
      provider.refresh({
        startAtUnixMs: 0,
        initial: false,
        maxRecords: 100
      })
    ).resolves.toMatchObject({
      truncated: false,
      incremental: false,
      historyDays
    });
    await expect(
      provider.refresh({
        startAtUnixMs: 0,
        initial: false,
        maxRecords: 100
      })
    ).resolves.toMatchObject({ truncated: false, incremental: true });

    expect(scanService.scan).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ initial: true })
    );
    expect(scanService.scan).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ initial: false })
    );
  });

  it("keeps complete history aggregates when only the record wire limit truncates", async () => {
    const sample = {
      vendor: "claude" as const,
      timestampMs: 1_000,
      sourcePath: "/tmp/session.jsonl",
      sourceType: "jsonl" as const,
      inputTokens: 10,
      outputTokens: 2,
      cacheTokens: 0,
      totalTokens: 12,
      estimatedCostUsd: 0.01
    };
    const historyDays = [
      {
        dayKey: "2026-07-17",
        totalCostUsd: 0.01,
        reportedCostUsd: 0,
        estimatedCostUsd: 0.01,
        unknownCostTokens: 0,
        totalTokens: 24,
        vendors: [
          {
            vendor: "claude" as const,
            totalCostUsd: 0.01,
            totalTokens: 24
          }
        ]
      }
    ];
    const scanService: UsageScanService = {
      watch: vi.fn(() => () => undefined),
      scan: vi
        .fn<UsageScanService["scan"]>()
        .mockResolvedValueOnce({
          reads: [
            {
              sourceCount: 1,
              samples: [
                { ...sample, sessionId: "session-1" },
                { ...sample, sessionId: "session-2" }
              ]
            }
          ],
          historyDays
        })
        .mockResolvedValueOnce({
          reads: [{ sourceCount: 1, samples: [] }]
        }),
      markDirty: vi.fn(),
      close: vi.fn()
    };
    const provider = createLocalUsageProvider({ scanService });

    const bounded = await provider.refresh({
      startAtUnixMs: 0,
      initial: true,
      maxRecords: 1,
      historyRange: { fromMs: 0, toMs: 2_000 }
    });
    expect(bounded).toMatchObject({
      truncated: true,
      incremental: false,
      historyDays
    });
    expect(bounded.records).toHaveLength(1);

    await provider.refresh({
      startAtUnixMs: 0,
      initial: false,
      maxRecords: 1
    });
    expect(scanService.scan).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ initial: false })
    );
  });
});

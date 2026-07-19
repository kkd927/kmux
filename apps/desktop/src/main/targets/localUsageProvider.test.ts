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
});

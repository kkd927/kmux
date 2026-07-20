import {
  decodeRemotePath,
  encodeLocatedPathDto,
  remoteLocatedPath
} from "@kmux/core";

import { createRemoteUsageProvider } from "./remoteUsageProvider";

describe("remote usage provider", () => {
  it("normalizes bounded target/principal usage without local path fallback", async () => {
    const scanUsage = vi.fn(async () => ({
      type: "usage.scanned" as const,
      targetId: "target_1",
      principal: { uid: 1_000, accountName: "kmux" },
      truncated: false,
      records: [
        {
          vendor: "codex" as const,
          sampleId: "codex:session-1",
          timestampUnixMs: "1000",
          sessionId: "session-1",
          model: "gpt-5.4-mini",
          cwd: "/srv/repo",
          projectPath: "/srv/repo",
          inputTokens: "100",
          outputTokens: "20",
          thinkingTokens: "5",
          cacheReadTokens: "10",
          cacheWriteTokens: "0",
          cacheWriteTokensKnown: true,
          totalTokens: "135"
        }
      ]
    }));
    const provider = createRemoteUsageProvider({
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      host: { scanUsage } as never,
      decodeRemotePath
    });

    const result = await provider.refresh({
      startAtUnixMs: 0,
      initial: true,
      maxRecords: 64
    });

    expect(scanUsage).toHaveBeenCalledWith({
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      startAtUnixMs: 0,
      maxRecords: 64
    });
    expect(result).toMatchObject({
      principal: { uid: 1_000, accountName: "kmux" },
      truncated: false,
      records: [
        {
          vendor: "codex",
          sessionId: "session-1",
          totalTokens: 135,
          costSource: "estimated"
        }
      ]
    });
    const record = result.records[0];
    expect(
      encodeLocatedPathDto(remoteLocatedPath("target_1", record.cwd!))
    ).toEqual({ kind: "ssh", targetId: "target_1", path: "/srv/repo" });
  });

  it("rejects relative paths and unsafe uint64 values", async () => {
    const base = {
      type: "usage.scanned" as const,
      targetId: "target_1",
      principal: { uid: 1_000, accountName: "kmux" },
      truncated: false,
      records: [
        {
          vendor: "claude" as const,
          sampleId: "sample-1",
          timestampUnixMs: "1",
          cwd: "relative",
          inputTokens: "1",
          outputTokens: "0",
          thinkingTokens: "0",
          cacheReadTokens: "0",
          cacheWriteTokens: "0",
          cacheWriteTokensKnown: true,
          totalTokens: "1"
        }
      ]
    };
    const scanUsage = vi.fn(async () => structuredClone(base));
    const provider = createRemoteUsageProvider({
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      host: { scanUsage } as never,
      decodeRemotePath
    });

    await expect(
      provider.refresh({ startAtUnixMs: 0, initial: true, maxRecords: 64 })
    ).rejects.toThrow(/not absolute/u);
    base.records[0].cwd = "/srv/repo";
    base.records[0].totalTokens = "9007199254740992";
    await expect(
      provider.refresh({ startAtUnixMs: 0, initial: true, maxRecords: 64 })
    ).rejects.toThrow(/safe range/u);
  });
});

import { decodeRemotePath } from "@kmux/core";
import { describe, expect, it, vi } from "vitest";

import { createRemoteHistoryProvider } from "./remoteHistoryProvider";

describe("remote history provider", () => {
  it("returns target-principal-scoped records with decoded remote paths", async () => {
    const decodePath = vi.fn((value: string) => decodeRemotePath(value));
    const scanHistory = vi.fn(async () => ({
      type: "history.scanned" as const,
      targetId: "target_1",
      principal: { uid: 1_000, accountName: "kmux" },
      records: [
        {
          vendor: "codex" as const,
          sessionId: "session-1",
          updatedAtUnixMs: "1",
          canResume: true,
          cwd: "/srv/repo",
          title: "Remote session"
        }
      ]
    }));
    const provider = createRemoteHistoryProvider({
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      host: { scanHistory } as never,
      decodeRemotePath: decodePath
    });

    await expect(provider.refresh({ maxRecords: 10 })).resolves.toMatchObject([
      {
        vendor: "codex",
        sessionId: "session-1",
        updatedAtUnixMs: 1,
        canResume: true,
        title: "Remote session",
        principal: { uid: 1_000, accountName: "kmux" }
      }
    ]);
    expect(scanHistory).toHaveBeenCalledWith({
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      maxRecords: 10
    });
    expect(decodePath).toHaveBeenCalledWith("/srv/repo");
  });

  it("rejects a relative cwd before creating a remote path", async () => {
    const provider = createRemoteHistoryProvider({
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      host: {
        scanHistory: vi.fn(async () => ({
          type: "history.scanned" as const,
          targetId: "target_1",
          principal: { uid: 1_000, accountName: "kmux" },
          records: [
            {
              vendor: "claude" as const,
              sessionId: "session-1",
              updatedAtUnixMs: "1",
              canResume: true,
              cwd: "relative/path"
            }
          ]
        }))
      } as never,
      decodeRemotePath: vi.fn()
    });

    await expect(provider.refresh({ maxRecords: 10 })).rejects.toThrow(
      /absolute/
    );
  });
});

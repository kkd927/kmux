import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  createCopilotSubscriptionRuntime,
  normalizeCopilotSubscriptionUsage,
  probeCopilotQuotaViaRpc,
  type CopilotQuotaResult
} from "./subscription";

const nowMs = new Date("2026-08-26T01:00:00.000Z").getTime();

describe("Copilot subscription usage", () => {
  it("uses the finite chat quota when premium interactions are not entitled", () => {
    const usage = normalizeCopilotSubscriptionUsage(
      quotaResult(
        {
          chat: snapshot({
            entitlementRequests: 200,
            usedRequests: 3,
            remainingPercentage: 98.3,
            tokenBasedBilling: true
          }),
          completions: snapshot({
            entitlementRequests: 2_000,
            remainingPercentage: 100
          }),
          premium_interactions: snapshot({
            entitlementRequests: 0,
            remainingPercentage: 0
          })
        },
        {
          copilotPlan: "individual",
          accessTypeSku: "free_limited_copilot",
          quotaResetDateUtc: "2026-09-01T00:00:00.000Z"
        }
      ),
      nowMs
    );

    expect(usage).toEqual({
      provider: "copilot",
      providerLabel: "GitHub Copilot",
      planLabel: "Free",
      accentTone: "violet",
      source: "copilot-rpc",
      updatedAt: "2026-08-26T01:00:00.000Z",
      rows: [
        expect.objectContaining({
          key: "plan",
          label: "AI Credits",
          usedPercent: 2,
          resetLabel: "Resets in 5d 23h",
          resetsAt: "2026-09-01T00:00:00.000Z",
          windowKind: "credits"
        })
      ]
    });
  });

  it("prefers an entitled premium-interactions plan quota", () => {
    const usage = normalizeCopilotSubscriptionUsage(
      quotaResult(
        {
          chat: snapshot({ entitlementRequests: 200, remainingPercentage: 90 }),
          premium_interactions: snapshot({
            entitlementRequests: 1_200,
            usedRequests: 300,
            remainingPercentage: 75,
            tokenBasedBilling: false
          })
        },
        {
          copilotPlan: "individual_pro",
          accessTypeSku: "plus_monthly_subscriber_quota"
        }
      ),
      nowMs
    );

    expect(usage?.rows).toEqual([
      expect.objectContaining({
        label: "Premium Requests",
        usedPercent: 25
      })
    ]);
    expect(usage?.planLabel).toBe("Pro+");
  });

  it("represents unlimited plan quota without inventing a percentage", () => {
    const usage = normalizeCopilotSubscriptionUsage(
      quotaResult({
        premium_interactions: snapshot({
          isUnlimitedEntitlement: true,
          entitlementRequests: -1,
          remainingPercentage: 100,
          tokenBasedBilling: true
        })
      }),
      nowMs
    );

    expect(usage?.rows).toEqual([
      {
        key: "plan",
        label: "AI Credits",
        valueKind: "unlimited",
        resetLabel: "No quota limit reported",
        windowKind: "credits"
      }
    ]);
  });

  it("shares the short-lived quota result between auth detection and fetch", async () => {
    const quotaProbe = vi.fn(async () =>
      quotaResult({
        chat: snapshot({ entitlementRequests: 200, remainingPercentage: 100 })
      })
    );
    const runtime = createCopilotSubscriptionRuntime({
      quotaProbe,
      now: () => nowMs
    });

    await expect(runtime.detectAuth()).resolves.toBe(true);
    await expect(runtime.fetch()).resolves.toMatchObject({
      provider: "copilot"
    });
    expect(quotaProbe).toHaveBeenCalledTimes(1);
  });

  it("uses bounded framed RPC and always terminates the probe process", async () => {
    const fake = new FakeCopilotProcess({
      connect: { protocolVersion: 1 },
      "account.getQuota": quotaResult({
        chat: snapshot({ entitlementRequests: 200, remainingPercentage: 100 })
      }),
      "account.getCurrentAuth": {
        authInfo: {
          copilotUser: {
            copilot_plan: "individual",
            access_type_sku: "free_limited_copilot",
            quota_reset_date_utc: "2026-09-01T00:00:00.000Z"
          }
        }
      }
    });
    const spawnImpl = vi.fn(() => fake.asChildProcess());

    await expect(
      probeCopilotQuotaViaRpc({ spawnImpl, timeoutMs: 100 })
    ).resolves.toEqual(
      quotaResult(
        {
          chat: snapshot({ entitlementRequests: 200, remainingPercentage: 100 })
        },
        {
          copilotPlan: "individual",
          accessTypeSku: "free_limited_copilot",
          quotaResetDateUtc: "2026-09-01T00:00:00.000Z"
        }
      )
    );
    expect(spawnImpl).toHaveBeenCalledWith(
      "copilot",
      ["--headless", "--no-auto-update", "--stdio", "--log-level", "none"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] })
    );
    expect(fake.methods).toEqual([
      "connect",
      "account.getQuota",
      "account.getCurrentAuth"
    ]);
    expect(fake.kill).toHaveBeenCalledTimes(1);
  });

  it("kills an unresponsive quota process at the deadline", async () => {
    const fake = new FakeCopilotProcess({});

    await expect(
      probeCopilotQuotaViaRpc({
        spawnImpl: () => fake.asChildProcess(),
        timeoutMs: 10
      })
    ).rejects.toThrow("operation timed out");
    expect(fake.kill).toHaveBeenCalledTimes(1);
  });
});

function quotaResult(
  quotaSnapshots: Record<string, unknown>,
  account?: CopilotQuotaResult["account"]
): CopilotQuotaResult {
  return { quotaSnapshots, ...(account ? { account } : {}) };
}

function snapshot(
  overrides: Partial<{
    isUnlimitedEntitlement: boolean;
    entitlementRequests: number;
    usedRequests: number;
    remainingPercentage: number;
    tokenBasedBilling: boolean;
  }> = {}
): Record<string, unknown> {
  return {
    isUnlimitedEntitlement: false,
    entitlementRequests: 0,
    usedRequests: 0,
    remainingPercentage: 0,
    ...overrides
  };
}

class FakeCopilotProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly methods: string[] = [];
  readonly kill = vi.fn(() => true);
  private input = Buffer.alloc(0);

  constructor(private readonly responses: Record<string, unknown>) {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.input = Buffer.concat([this.input, chunk]);
      this.consumeRequests();
    });
  }

  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }

  private consumeRequests(): void {
    while (this.input.byteLength > 0) {
      const headerEnd = this.input.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.input.subarray(0, headerEnd).toString("ascii");
      const length = Number(header.match(/Content-Length:\s*(\d+)/iu)?.[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (!Number.isSafeInteger(length) || this.input.byteLength < bodyEnd) {
        return;
      }
      const request = JSON.parse(
        this.input.subarray(bodyStart, bodyEnd).toString("utf8")
      ) as { id: number; method: string };
      this.input = this.input.subarray(bodyEnd);
      this.methods.push(request.method);
      if (!(request.method in this.responses)) continue;
      const body = Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: this.responses[request.method]
        }),
        "utf8"
      );
      queueMicrotask(() => {
        this.stdout.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
        this.stdout.write(body);
      });
    }
  }
}

import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {
  createSubscriptionAuthDetectors,
  fetchClaudeSubscriptionUsage,
  fetchCodexSubscriptionUsage,
  fetchGeminiSubscriptionUsage
} from "./subscriptionUsage";

const sandboxDirs: string[] = [];

afterEach(() => {
  for (const sandboxDir of sandboxDirs.splice(0)) {
    rmSync(sandboxDir, { force: true, recursive: true });
  }
  vi.restoreAllMocks();
});

describe("subscription usage fetchers", () => {
  it("maps Codex OAuth usage windows into session and weekly rows", async () => {
    const homeDir = createSandboxHome();
    writeJson(homeDir, [".codex", "auth.json"], {
      auth_mode: "chatgpt",
      last_refresh: "2026-04-17T00:00:00.000Z",
      tokens: {
        access_token: "codex-access-token",
        account_id: "acct_123"
      }
    });
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 64,
              reset_at: 1_776_385_200,
              limit_window_seconds: 18_000
            },
            secondary_window: {
              used_percent: 18,
              reset_at: 1_776_903_600,
              limit_window_seconds: 604_800
            }
          }
        }),
        { status: 200 }
      )
    );

    const usage = await fetchCodexSubscriptionUsage({
      homeDir,
      fetchImpl,
      now: () => new Date("2026-04-18T00:00:00.000Z").getTime()
    });

    expect(usage).toEqual(
      expect.objectContaining({
        provider: "codex",
        providerLabel: "Codex",
        planLabel: "Pro",
        source: "oauth",
        rows: [
          expect.objectContaining({
            key: "session",
            label: "Session",
            usedPercent: 64,
            windowKind: "session"
          }),
          expect.objectContaining({
            key: "weekly",
            label: "Weekly",
            usedPercent: 18,
            windowKind: "weekly"
          })
        ]
      })
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to Codex RPC when the OAuth usage endpoint is unavailable", async () => {
    const homeDir = createSandboxHome();
    writeJson(homeDir, [".codex", "auth.json"], {
      auth_mode: "chatgpt",
      last_refresh: "2026-04-17T00:00:00.000Z",
      tokens: {
        access_token: "codex-access-token",
        account_id: "acct_123"
      }
    });
    const fetchImpl = vi.fn(async () => new Response("denied", { status: 401 }));
    const codexRpcProbe = vi.fn(async () => ({
      planType: "plus",
      windows: [
        {
          key: "session" as const,
          usedPercent: 38,
          resetsAtMs: Date.parse("2026-04-18T03:00:00.000Z")
        },
        {
          key: "weekly" as const,
          usedPercent: 55,
          resetsAtMs: Date.parse("2026-04-21T00:00:00.000Z")
        }
      ]
    }));

    const usage = await fetchCodexSubscriptionUsage({
      homeDir,
      fetchImpl,
      codexRpcProbe,
      now: () => new Date("2026-04-18T00:00:00.000Z").getTime()
    });

    expect(usage).toEqual(
      expect.objectContaining({
        provider: "codex",
        planLabel: "Plus",
        source: "rpc"
      })
    );
    expect(codexRpcProbe).toHaveBeenCalledTimes(1);
  });

  it("passes the desktop app version to the Codex RPC probe fallback", async () => {
    const homeDir = createSandboxHome();
    writeJson(homeDir, [".codex", "auth.json"], {
      auth_mode: "chatgpt",
      last_refresh: "2026-04-17T00:00:00.000Z",
      tokens: {
        access_token: "codex-access-token",
        account_id: "acct_123"
      }
    });
    const fetchImpl = vi.fn(async () => new Response("denied", { status: 401 }));
    const codexRpcProbe = vi.fn(async () => ({
      planType: "plus",
      windows: [
        {
          key: "session" as const,
          usedPercent: 38,
          resetsAtMs: Date.parse("2026-04-18T03:00:00.000Z")
        }
      ]
    }));

    await fetchCodexSubscriptionUsage({
      homeDir,
      fetchImpl,
      codexRpcProbe,
      now: () => new Date("2026-04-18T00:00:00.000Z").getTime()
    });

    const desktopPackage = JSON.parse(
      readFileSync(join(process.cwd(), "apps", "desktop", "package.json"), "utf8")
    ) as { version: string };
    expect(codexRpcProbe).toHaveBeenCalledWith(desktopPackage.version);
  });

  it("skips Codex fallback probes when there is no local auth token", async () => {
    const homeDir = createSandboxHome();
    const fetchImpl = vi.fn();
    const codexRpcProbe = vi.fn();
    const codexStatusProbe = vi.fn();

    const usage = await fetchCodexSubscriptionUsage({
      homeDir,
      fetchImpl: fetchImpl as never,
      codexRpcProbe: codexRpcProbe as never,
      codexStatusProbe: codexStatusProbe as never,
      now: () => new Date("2026-04-18T00:00:00.000Z").getTime()
    });

    expect(usage).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(codexRpcProbe).not.toHaveBeenCalled();
    expect(codexStatusProbe).not.toHaveBeenCalled();
  });

  it("throws when Codex OAuth fails and both local fallback probes are exhausted so callers can back off", async () => {
    const homeDir = createSandboxHome();
    writeJson(homeDir, [".codex", "auth.json"], {
      auth_mode: "chatgpt",
      last_refresh: "2026-04-17T00:00:00.000Z",
      tokens: {
        access_token: "codex-access-token",
        account_id: "acct_123"
      }
    });
    const fetchImpl = vi.fn(async () => new Response("denied", { status: 401 }));
    const codexRpcProbe = vi.fn(async () => null);
    const codexStatusProbe = vi.fn(async () => null);

    await expect(
      fetchCodexSubscriptionUsage({
        homeDir,
        fetchImpl,
        codexRpcProbe,
        codexStatusProbe,
        now: () => new Date("2026-04-18T00:00:00.000Z").getTime()
      })
    ).rejects.toThrow(/probes exhausted/i);
  });

  it("renders weekly-only Codex plans with a single weekly row", async () => {
    const homeDir = createSandboxHome();
    writeJson(homeDir, [".codex", "auth.json"], {
      auth_mode: "chatgpt",
      last_refresh: "2026-04-17T00:00:00.000Z",
      tokens: {
        access_token: "codex-access-token",
        account_id: "acct_123"
      }
    });
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          plan_type: "team",
          rate_limit: {
            primary_window: {
              used_percent: 12,
              reset_at: 1_776_903_600,
              limit_window_seconds: 604_800
            }
          }
        }),
        { status: 200 }
      )
    );

    const usage = await fetchCodexSubscriptionUsage({
      homeDir,
      fetchImpl,
      now: () => new Date("2026-04-18T00:00:00.000Z").getTime()
    });

    expect(usage?.rows).toEqual([
      expect.objectContaining({
        key: "weekly",
        label: "Weekly",
        usedPercent: 12
      })
    ]);
  });

  it("maps Claude OAuth usage windows and plan tier from Claude Code credentials", async () => {
    const homeDir = createSandboxHome();
    writeJson(homeDir, [".claude", ".credentials.json"], {
      claudeAiOauth: {
        accessToken: "claude-access-token",
        refreshToken: "claude-refresh-token",
        expiresAt: Date.parse("2026-04-19T00:00:00.000Z"),
        scopes: ["user:profile", "org:read"],
        rateLimitTier: "claude_max"
      }
    });
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          five_hour: {
            utilization: 0.64,
            resets_at: "2026-04-18T03:53:00.000Z"
          },
          seven_day: {
            utilization: 0.19,
            resets_at: "2026-04-21T00:00:00.000Z"
          }
        }),
        { status: 200 }
      )
    );

    const usage = await fetchClaudeSubscriptionUsage({
      homeDir,
      fetchImpl,
      now: () => new Date("2026-04-18T00:00:00.000Z").getTime()
    });

    expect(usage).toEqual(
      expect.objectContaining({
        provider: "claude",
        providerLabel: "Claude Code",
        planLabel: "Max",
        source: "oauth_usage",
        rows: [
          expect.objectContaining({
            key: "session",
            usedPercent: 64,
            label: "Session"
          }),
          expect.objectContaining({
            key: "weekly",
            usedPercent: 19,
            label: "Weekly"
          })
        ]
      })
    );
  });

  it("returns null when the Claude OAuth usage endpoint fails instead of spending quota on a fallback messages probe", async () => {
    const homeDir = createSandboxHome();
    writeJson(homeDir, [".claude", ".credentials.json"], {
      claudeAiOauth: {
        accessToken: "claude-access-token",
        refreshToken: "claude-refresh-token",
        expiresAt: Date.parse("2026-04-19T00:00:00.000Z"),
        scopes: ["user:profile"],
        rateLimitTier: "claude_pro"
      }
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("disabled", { status: 404 }));

    const usage = await fetchClaudeSubscriptionUsage({
      homeDir,
      fetchImpl,
      now: () => new Date("2026-04-18T00:00:00.000Z").getTime()
    });

    expect(usage).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("hides Claude usage when the local token only has inference-grade scopes", async () => {
    const homeDir = createSandboxHome();
    writeJson(homeDir, [".claude", ".credentials.json"], {
      claudeAiOauth: {
        accessToken: "claude-access-token",
        expiresAt: Date.parse("2026-04-19T00:00:00.000Z"),
        scopes: ["messages:write"]
      }
    });

    const usage = await fetchClaudeSubscriptionUsage({
      homeDir,
      fetchImpl: vi.fn(),
      now: () => new Date("2026-04-18T00:00:00.000Z").getTime()
    });

    expect(usage).toBeNull();
  });

  it("maps Gemini paid quotas to native model-family rows", async () => {
    const homeDir = createSandboxHome();
    writeJson(homeDir, [".gemini", "oauth_creds.json"], {
      access_token: "gemini-access-token",
      refresh_token: "gemini-refresh-token",
      expiry_date: Date.parse("2026-04-19T00:00:00.000Z"),
      id_token: makeGoogleIdToken({ email: "user@gmail.com" })
    });
    writeJson(homeDir, [".gemini", "settings.json"], {
      security: {
        auth: {
          selectedType: "oauth-personal"
        }
      }
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            currentTier: {
              id: "standard-tier"
            },
            cloudaicompanionProject: "projects/demo-project"
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            buckets: [
              {
                modelId: "gemini-2.5-pro",
                remainingFraction: 0.25,
                resetTime: "2026-04-19T00:00:00.000Z"
              },
              {
                modelId: "gemini-2.5-flash",
                remainingFraction: 0.4,
                resetTime: "2026-04-19T00:00:00.000Z"
              },
              {
                modelId: "gemini-2.0-flash-lite",
                remainingFraction: 0.8,
                resetTime: "2026-04-19T00:00:00.000Z"
              }
            ]
          }),
          { status: 200 }
        )
      );

    const usage = await fetchGeminiSubscriptionUsage({
      homeDir,
      fetchImpl,
      now: () => new Date("2026-04-18T00:00:00.000Z").getTime()
    });

    expect(usage).toEqual(
      expect.objectContaining({
        provider: "gemini",
        planLabel: "Paid",
        rows: [
          expect.objectContaining({ key: "pro", label: "Pro", usedPercent: 75 }),
          expect.objectContaining({ key: "flash", label: "Flash", usedPercent: 60 }),
          expect.objectContaining({
            key: "flash-lite",
            label: "Flash Lite",
            usedPercent: 20
          })
        ]
      })
    );
  });

  it("hides Gemini model-family rows when the used percentage is zero", async () => {
    const homeDir = createSandboxHome();
    writeJson(homeDir, [".gemini", "oauth_creds.json"], {
      access_token: "gemini-access-token",
      refresh_token: "gemini-refresh-token",
      expiry_date: Date.parse("2026-04-19T00:00:00.000Z"),
      id_token: makeGoogleIdToken({ email: "user@gmail.com" })
    });
    writeJson(homeDir, [".gemini", "settings.json"], {
      security: {
        auth: {
          selectedType: "oauth-personal"
        }
      }
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            currentTier: {
              id: "standard-tier"
            }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            buckets: [
              {
                modelId: "gemini-2.5-pro",
                remainingFraction: 0.25,
                resetTime: "2026-04-19T00:00:00.000Z"
              },
              {
                modelId: "gemini-2.5-flash",
                remainingFraction: 1,
                resetTime: "2026-04-19T00:00:00.000Z"
              }
            ]
          }),
          { status: 200 }
        )
      );

    const usage = await fetchGeminiSubscriptionUsage({
      homeDir,
      fetchImpl,
      now: () => new Date("2026-04-18T00:00:00.000Z").getTime()
    });

    expect(usage?.rows).toEqual([
      expect.objectContaining({ key: "pro", label: "Pro", usedPercent: 75 })
    ]);
  });

  it("shows Gemini workspace quota windows but hides free-tier accounts", async () => {
    const homeDir = createSandboxHome();
    writeJson(homeDir, [".gemini", "oauth_creds.json"], {
      access_token: "gemini-access-token",
      refresh_token: "gemini-refresh-token",
      expiry_date: Date.parse("2026-04-19T00:00:00.000Z"),
      id_token: makeGoogleIdToken({
        email: "user@company.dev",
        hd: "company.dev"
      })
    });
    writeJson(homeDir, [".gemini", "settings.json"], {
      security: {
        auth: {
          selectedType: "oauth-personal"
        }
      }
    });
    const workspaceFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            currentTier: {
              id: "free-tier"
            }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            buckets: [
              {
                modelId: "gemini-2.5-pro",
                remainingFraction: 0.5,
                resetTime: "2026-04-19T00:00:00.000Z"
              }
            ]
          }),
          { status: 200 }
        )
      );

    const workspaceUsage = await fetchGeminiSubscriptionUsage({
      homeDir,
      fetchImpl: workspaceFetch,
      now: () => new Date("2026-04-18T00:00:00.000Z").getTime()
    });

    expect(workspaceUsage).toEqual(
      expect.objectContaining({
        planLabel: "Workspace"
      })
    );

    const freeHomeDir = createSandboxHome();
    writeJson(freeHomeDir, [".gemini", "oauth_creds.json"], {
      access_token: "gemini-access-token",
      refresh_token: "gemini-refresh-token",
      expiry_date: Date.parse("2026-04-19T00:00:00.000Z"),
      id_token: makeGoogleIdToken({ email: "user@gmail.com" })
    });
    writeJson(freeHomeDir, [".gemini", "settings.json"], {
      security: {
        auth: {
          selectedType: "oauth-personal"
        }
      }
    });
    const freeFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            currentTier: {
              id: "free-tier"
            }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            buckets: [
              {
                modelId: "gemini-2.5-pro",
                remainingFraction: 0.5,
                resetTime: "2026-04-19T00:00:00.000Z"
              }
            ]
          }),
          { status: 200 }
        )
      );

    const freeUsage = await fetchGeminiSubscriptionUsage({
      homeDir: freeHomeDir,
      fetchImpl: freeFetch,
      now: () => new Date("2026-04-18T00:00:00.000Z").getTime()
    });

    expect(freeUsage).toBeNull();
  });

  it("refreshes expired Gemini OAuth tokens before fetching quota usage", async () => {
    const homeDir = createSandboxHome();
    writeJson(homeDir, [".gemini", "oauth_creds.json"], {
      access_token: "expired-token",
      refresh_token: "refresh-token",
      expiry_date: Date.parse("2026-04-17T00:00:00.000Z"),
      id_token: makeGoogleIdToken({ email: "user@gmail.com" })
    });
    writeJson(homeDir, [".gemini", "settings.json"], {
      security: {
        auth: {
          selectedType: "oauth-personal"
        }
      }
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "fresh-token",
            refresh_token: "refresh-token-2",
            expires_in: 3600,
            token_type: "Bearer"
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            currentTier: {
              id: "standard-tier"
            }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            buckets: [
              {
                modelId: "gemini-2.5-pro",
                remainingFraction: 0.4,
                resetTime: "2026-04-19T00:00:00.000Z"
              }
            ]
          }),
          { status: 200 }
        )
      );

    const usage = await fetchGeminiSubscriptionUsage({
      homeDir,
      fetchImpl,
      googleOAuthClientConfig: {
        clientId: "client-id",
        clientSecret: "client-secret"
      },
      now: () => new Date("2026-04-18T00:00:00.000Z").getTime()
    });

    expect(usage).toEqual(
      expect.objectContaining({
        provider: "gemini",
        planLabel: "Paid",
        rows: [expect.objectContaining({ key: "pro", usedPercent: 60 })]
      })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({
        method: "POST"
      })
    );
    const refreshedCredentials = JSON.parse(
      readFileSync(join(homeDir, ".gemini", "oauth_creds.json"), "utf8")
    );
    expect(refreshedCredentials.access_token).toBe("fresh-token");
    expect(refreshedCredentials.refresh_token).toBe("refresh-token-2");
    expect(refreshedCredentials.expiry_date).toBeGreaterThan(
      Date.parse("2026-04-18T00:50:00.000Z")
    );
  });

  it("treats expired Gemini auth with a refresh token as visible local auth", async () => {
    const homeDir = createSandboxHome();
    writeJson(homeDir, [".gemini", "oauth_creds.json"], {
      access_token: "expired-token",
      refresh_token: "refresh-token",
      expiry_date: Date.parse("2026-04-17T00:00:00.000Z")
    });
    writeJson(homeDir, [".gemini", "settings.json"], {
      security: {
        auth: {
          selectedType: "oauth-personal"
        }
      }
    });

    const detectors = createSubscriptionAuthDetectors({
      homeDir,
      now: () => new Date("2026-04-18T00:00:00.000Z").getTime()
    });

    await expect(detectors.gemini?.()).resolves.toBe(true);
  });
});

function createSandboxHome(): string {
  const homeDir = mkdtempSync(join(tmpdir(), "kmux-subscription-usage-"));
  sandboxDirs.push(homeDir);
  return homeDir;
}

function writeJson(
  homeDir: string,
  segments: string[],
  value: unknown
): void {
  const filePath = join(homeDir, ...segments);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeGoogleIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }))
    .toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.`;
}

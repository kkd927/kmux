import { describe, expect, it, vi } from "vitest";
import { createAgentModelCatalog } from "./modelCatalog";
import { parseCodexModels } from "./builtins/codex/models";
import { parseClaudeModels } from "./builtins/claude/models";
import { parseCopilotModels } from "./builtins/copilot/models";
import {
  parseAntigravityModels,
  resolveAntigravityPreferences
} from "./builtins/antigravity/models";

describe("Agent model discovery", () => {
  it("retains per-model efforts and excludes hidden or disabled models", () => {
    expect(
      parseCodexModels({
        data: [
          {
            model: "wide",
            displayName: "Wide",
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "ultra" }
            ]
          },
          { hidden: true }
        ]
      })
    ).toEqual([
      {
        id: "wide",
        displayName: "Wide",
        efforts: ["low", "ultra"],
        defaultEffort: "low"
      }
    ]);
    expect(
      parseClaudeModels({
        models: [
          {
            value: "reasoning",
            displayName: "Reasoning",
            supportsEffort: true,
            supportedEffortLevels: ["low", "high"]
          },
          { value: "fast", displayName: "Fast", supportsEffort: false }
        ]
      })
    ).toEqual([
      { id: "reasoning", displayName: "Reasoning", efforts: ["low", "high"] },
      { id: "fast", displayName: "Fast", efforts: [] }
    ]);
    const auto = { id: "auto", name: "Auto" };
    expect(
      parseCopilotModels({
        models: [
          auto,
          auto,
          { id: "blocked", policy: { state: "disabled" } },
          {
            id: "thinking",
            name: "Thinking",
            supportedReasoningEfforts: ["medium"],
            defaultReasoningEffort: "medium"
          }
        ]
      })
    ).toEqual([
      { id: "auto", displayName: "Auto", efforts: [] },
      {
        id: "thinking",
        displayName: "Thinking",
        efforts: ["medium"],
        defaultEffort: "medium"
      }
    ]);
  });

  it("groups AGY tiers without inventing unsupported effort levels and accepts saved tier IDs", () => {
    const models = parseAntigravityModels(
      "gemini-3.1-pro-high\tGemini 3.1 Pro (High)\ngemini-3.1-pro-low\tGemini 3.1 Pro (Low)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n"
    );
    expect(models).toEqual([
      {
        id: "gemini-3.1-pro",
        displayName: "Gemini 3.1 Pro",
        efforts: ["low", "high"],
        effortRequired: true,
        defaultEffort: "high",
        variants: [
          { model: "gemini-3.1-pro-high", effort: "high" },
          { model: "gemini-3.1-pro-low", effort: "low" }
        ]
      },
      {
        id: "gpt-oss-120b",
        displayName: "GPT-OSS 120B",
        efforts: ["medium"],
        effortRequired: true,
        defaultEffort: "medium",
        variants: [{ model: "gpt-oss-120b-medium", effort: "medium" }]
      }
    ]);
    expect(
      resolveAntigravityPreferences({
        model: "gemini-3.1-pro-high",
        effort: "low"
      })
    ).toEqual({ model: "gemini-3.1-pro-low" });
    expect(
      resolveAntigravityPreferences({ model: "gemini-3.1-pro-high" })
    ).toEqual({ model: "gemini-3.1-pro-high" });
  });

  it("shares in-flight requests and refreshes after expiry or command configuration changes", async () => {
    let now = 0;
    let context = "first-command";
    const load = vi.fn(async () => [
      { id: "m", displayName: "Model", efforts: [] }
    ]);
    const catalog = createAgentModelCatalog({
      load,
      now: () => now,
      ttlMs: 20,
      contextKey: () => context
    });
    const first = catalog.list("fixture");
    expect(catalog.list("fixture")).toBe(first);
    await first;
    await catalog.list("fixture");
    expect(load).toHaveBeenCalledTimes(1);
    now = 21;
    await catalog.list("fixture");
    context = "second-command";
    await catalog.list("fixture");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("captures the command configuration before a concurrent settings change", async () => {
    let command = "first";
    const catalog = createAgentModelCatalog({
      contextKey: () => command,
      load: async () => [{ id: command, displayName: command, efforts: [] }]
    });
    const first = catalog.list("fixture");
    command = "second";
    expect((await first)[0]?.id).toBe("first");
    expect((await catalog.list("fixture"))[0]?.id).toBe("second");
  });

  it("evicts failed discovery so a retry can recover", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([]);
    const catalog = createAgentModelCatalog({ load });
    await expect(catalog.list("fixture")).rejects.toThrow(/retry/u);
    await expect(catalog.list("fixture")).resolves.toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

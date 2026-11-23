import { describe, expect, it } from "vitest";

import {
  decodeAgentDescriptorCatalogDto,
  decodeAgentId,
  decodeAgentModelOptions,
  isAgentId
} from "./agents";

describe("open agent identity codecs", () => {
  it("bounds model metadata and rejects inconsistent effort choices at the IPC boundary", () => {
    const option = {
      id: "model",
      displayName: "Model",
      efforts: ["low", "high"],
      defaultEffort: "low"
    };
    expect(decodeAgentModelOptions([option])).toEqual([option]);
    expect(() => decodeAgentModelOptions([option, option])).toThrow(
      /duplicate model ids/u
    );
    expect(() => decodeAgentModelOptions(Array(257).fill(option))).toThrow(
      /catalog is invalid/u
    );
    expect(() =>
      decodeAgentModelOptions([{ ...option, defaultEffort: "max" }])
    ).toThrow(/default effort must be supported/u);
    expect(() =>
      decodeAgentModelOptions([{ ...option, efforts: ["low", "low"] }])
    ).toThrow(/duplicate model efforts/u);
    expect(() =>
      decodeAgentModelOptions([
        { ...option, variants: [{ model: "model-max", effort: "max" }] }
      ])
    ).toThrow(/variant effort must be supported/u);
  });

  it("validates canonical syntax without requiring catalog membership", () => {
    expect(decodeAgentId("future.agent_2-beta")).toBe("future.agent_2-beta");
    expect(isAgentId("unknown")).toBe(false);
    expect(() => decodeAgentId("Uppercase")).toThrow(/invalid/u);
    expect(() => decodeAgentId(`a${"x".repeat(64)}`)).toThrow(/invalid/u);
  });

  it("bounds and exactly decodes renderer descriptor catalogs", () => {
    expect(
      decodeAgentDescriptorCatalogDto([
        {
          id: "future",
          displayName: "Future",
          aliases: [],
          capabilities: ["resume"]
        }
      ])
    ).toHaveLength(1);
    expect(() =>
      decodeAgentDescriptorCatalogDto([
        {
          id: "future",
          displayName: "Future",
          aliases: [],
          capabilities: ["resume"],
          executable: "/tmp/not-serializable-policy"
        }
      ])
    ).toThrow(/unknown field/u);
  });

  it("keeps launch preference capability and metadata atomic", () => {
    const base = {
      id: "future",
      displayName: "Future",
      aliases: []
    };
    expect(() =>
      decodeAgentDescriptorCatalogDto([
        { ...base, capabilities: ["launchPreferences"] }
      ])
    ).toThrow(/declared together/u);
    expect(() =>
      decodeAgentDescriptorCatalogDto([
        {
          ...base,
          capabilities: [],
          launchPreferences: {
            model: "opaque-provider-id",
            efforts: ["low"],
            effortRequiresModel: true
          }
        }
      ])
    ).toThrow(/declared together/u);
    expect(
      decodeAgentDescriptorCatalogDto([
        {
          ...base,
          capabilities: ["launchPreferences"],
          launchPreferences: {
            model: "opaque-provider-id",
            efforts: ["low"],
            effortRequiresModel: true
          }
        }
      ])[0]?.launchPreferences?.efforts
    ).toEqual(["low"]);
  });

  it("keeps skill placement capability and serializable scopes atomic", () => {
    const base = {
      id: "future",
      displayName: "Future",
      aliases: []
    };
    expect(() =>
      decodeAgentDescriptorCatalogDto([
        { ...base, capabilities: ["skillPlacement"] }
      ])
    ).toThrow(/declared together/u);
    expect(() =>
      decodeAgentDescriptorCatalogDto([
        {
          ...base,
          capabilities: [],
          skillPlacement: { scopes: ["global"] }
        }
      ])
    ).toThrow(/declared together/u);
    expect(
      decodeAgentDescriptorCatalogDto([
        {
          ...base,
          capabilities: ["skillPlacement"],
          skillPlacement: { scopes: ["global", "workspace"] }
        }
      ])[0]?.skillPlacement?.scopes
    ).toEqual(["global", "workspace"]);
  });
});

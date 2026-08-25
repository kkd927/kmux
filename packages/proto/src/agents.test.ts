import { describe, expect, it } from "vitest";

import {
  decodeAgentDescriptorCatalogDto,
  decodeAgentId,
  isAgentId
} from "./agents";

describe("open agent identity codecs", () => {
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
});

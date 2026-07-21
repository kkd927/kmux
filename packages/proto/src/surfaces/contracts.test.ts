import { describe, expect, it } from "vitest";

import {
  decodeMarkdownDocumentEvent,
  decodeMarkdownDocumentSubscriptionDto,
  decodeTerminalFileLinkActivationDto
} from "./contracts";

describe("Markdown document IPC decoders", () => {
  it("accepts exact bounded subscription and event variants", () => {
    expect(
      decodeMarkdownDocumentSubscriptionDto({ surfaceId: "surface_1" })
    ).toEqual({ surfaceId: "surface_1" });
    expect(
      decodeMarkdownDocumentEvent({
        type: "snapshot",
        surfaceId: "surface_1",
        revision: 2,
        text: "# title",
        byteLength: 7
      })
    ).toEqual({
      type: "snapshot",
      surfaceId: "surface_1",
      revision: 2,
      text: "# title",
      byteLength: 7
    });
  });

  it("rejects unknown keys and invalid revisions or error codes", () => {
    expect(() =>
      decodeMarkdownDocumentSubscriptionDto({
        surfaceId: "surface_1",
        targetId: "target_untrusted"
      })
    ).toThrow(/keys/u);
    expect(() =>
      decodeMarkdownDocumentEvent({
        type: "loading",
        surfaceId: "surface_1",
        revision: 0
      })
    ).toThrow(/revision/u);
    expect(() =>
      decodeMarkdownDocumentEvent({
        type: "error",
        surfaceId: "surface_1",
        revision: 1,
        errorCode: "credentials"
      })
    ).toThrow(/error code/u);
  });

  it("accepts only exact bounded terminal file-link activations", () => {
    expect(
      decodeTerminalFileLinkActivationDto({
        sourceSurfaceId: "surface_1",
        rawPath: "docs/README.md",
        baseCwd: "/repo"
      })
    ).toEqual({
      sourceSurfaceId: "surface_1",
      rawPath: "docs/README.md",
      baseCwd: "/repo"
    });
    expect(() =>
      decodeTerminalFileLinkActivationDto({
        sourceSurfaceId: "surface_1",
        rawPath: "docs/README.md",
        targetId: "target_forged"
      })
    ).toThrow(/keys/u);
    expect(() =>
      decodeTerminalFileLinkActivationDto({
        sourceSurfaceId: "surface_1",
        rawPath: "x".repeat(32 * 1024 + 1)
      })
    ).toThrow(/bounded path/u);
  });
});

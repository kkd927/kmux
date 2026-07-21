import { describe, expect, it } from "vitest";

import {
  decodeMarkdownDocumentEvent,
  decodeMarkdownDocumentSubscriptionDto
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
});

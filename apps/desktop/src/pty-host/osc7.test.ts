import { describe, expect, it } from "vitest";
import { TERMINAL_DATA_PLANE_MAX_METADATA_STRING_BYTES } from "@kmux/proto";

import {
  isTerminalMetadataWithinProtocolLimit,
  parseOsc7Cwd,
  resolveOsc7Cwd
} from "./osc7";

describe("OSC 7 cwd parsing", () => {
  it("parses percent-encoded file URLs", () => {
    expect(parseOsc7Cwd("file://localhost/Users/test/My%20Project")).toBe(
      "/Users/test/My Project"
    );
  });

  it("ignores malformed cwd payloads", () => {
    expect(parseOsc7Cwd("not-a-url")).toBeUndefined();
  });

  it("preserves duplicate cwd payloads as prompt ticks", () => {
    expect(resolveOsc7Cwd("/tmp/project", "file://localhost/tmp/project")).toBe(
      "/tmp/project"
    );
  });

  it("rejects cwd and title metadata over the UTF-8 protocol bound", () => {
    const valid = "한".repeat(
      Math.floor(TERMINAL_DATA_PLANE_MAX_METADATA_STRING_BYTES / 3)
    );
    const oversized = `${valid}한`;
    const url = new URL("file://localhost");
    url.pathname = `/${oversized}`;

    expect(isTerminalMetadataWithinProtocolLimit(valid)).toBe(true);
    expect(isTerminalMetadataWithinProtocolLimit(oversized)).toBe(false);
    expect(parseOsc7Cwd(url.href)).toBeUndefined();
    expect(resolveOsc7Cwd("/existing", url.href)).toBeUndefined();
  });
});

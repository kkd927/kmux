import { describe, expect, it } from "vitest";

import { parseOsc7Cwd, resolveOsc7Cwd } from "./osc7";

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
});

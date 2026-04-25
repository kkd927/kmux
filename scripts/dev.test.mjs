import { describe, expect, it } from "vitest";

import { exitCodeForSignal } from "./dev.mjs";

describe("dev launcher", () => {
  it("converts child signal exits into cancellation exit codes", () => {
    expect(exitCodeForSignal("SIGINT")).toBe(130);
    expect(exitCodeForSignal("SIGTERM")).toBe(143);
  });
});

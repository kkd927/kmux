import { describe, expect, it } from "vitest";

import {
  LINUX_SHUTDOWN_TIMEOUT_MS,
  UPDATE_INSTALL_EXIT_TIMEOUT_MS,
  UPDATE_RELAUNCH_PARENT_TIMEOUT_MS
} from "./linuxUpdateTiming";

describe("Linux update timing policy", () => {
  it("leaves ordered headroom for shutdown diagnostics and parent handoff", () => {
    expect(LINUX_SHUTDOWN_TIMEOUT_MS).toBeLessThan(
      UPDATE_INSTALL_EXIT_TIMEOUT_MS
    );
    expect(UPDATE_INSTALL_EXIT_TIMEOUT_MS).toBeLessThan(
      UPDATE_RELAUNCH_PARENT_TIMEOUT_MS
    );
  });
});

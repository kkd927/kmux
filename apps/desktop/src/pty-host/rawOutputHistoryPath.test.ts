import { describe, expect, it } from "vitest";

import { KMUX_RAW_OUTPUT_ROOT_ENV } from "../shared/platform/env";
import { resolveRawOutputHistoryDir } from "./rawOutputHistoryPath";

describe("raw output history path resolution", () => {
  it("uses the explicit raw output root instead of KMUX_RUNTIME_DIR", () => {
    expect(
      resolveRawOutputHistoryDir(
        "session/one",
        "surface:two",
        {
          KMUX_RUNTIME_DIR: "/run/user/1000/kmux",
          [KMUX_RAW_OUTPUT_ROOT_ENV]: "/home/test/.local/state/kmux/pty-raw"
        },
        "/repo"
      )
    ).toBe("/home/test/.local/state/kmux/pty-raw/session%2Fone-surface%3Atwo");
  });

  it("falls back to a dev state root when no explicit root is present", () => {
    expect(
      resolveRawOutputHistoryDir("session_1", "surface_1", {}, "/repo")
    ).toBe("/repo/.kmux/dev/state/pty-raw/session_1-surface_1");
  });

  it("falls back to a dev state root when the explicit root is blank", () => {
    expect(
      resolveRawOutputHistoryDir(
        "session_1",
        "surface_1",
        { [KMUX_RAW_OUTPUT_ROOT_ENV]: "   " },
        "/repo"
      )
    ).toBe("/repo/.kmux/dev/state/pty-raw/session_1-surface_1");
  });

  it("ignores relative explicit roots", () => {
    expect(
      resolveRawOutputHistoryDir(
        "session_1",
        "surface_1",
        { [KMUX_RAW_OUTPUT_ROOT_ENV]: ".kmux/raw-output" },
        "/repo"
      )
    ).toBe("/repo/.kmux/dev/state/pty-raw/session_1-surface_1");
  });

  it("keeps distinct raw history directories for ids with colliding safe forms", () => {
    const root = "/home/test/.local/state/kmux/pty-raw";
    const slashPath = resolveRawOutputHistoryDir(
      "session/one",
      "surface",
      { [KMUX_RAW_OUTPUT_ROOT_ENV]: root },
      "/repo"
    );
    const underscorePath = resolveRawOutputHistoryDir(
      "session_one",
      "surface",
      { [KMUX_RAW_OUTPUT_ROOT_ENV]: root },
      "/repo"
    );

    expect(slashPath).toBe(`${root}/session%2Fone-surface`);
    expect(underscorePath).toBe(`${root}/session_one-surface`);
    expect(slashPath).not.toBe(underscorePath);
  });
});

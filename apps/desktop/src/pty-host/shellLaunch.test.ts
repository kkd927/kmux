import {describe, expect, it} from "vitest";

import {
  resolveDefaultShellArgs,
  shouldStripShellManagedEnv
} from "./shellLaunch";

describe("pty shell launch defaults", () => {
  it("uses login shell args for supported macOS shells", () => {
    expect(resolveDefaultShellArgs("/bin/zsh", "darwin")).toEqual(["-l"]);
    expect(resolveDefaultShellArgs("/bin/sh", "darwin")).toEqual(["-l"]);
    expect(resolveDefaultShellArgs("/opt/homebrew/bin/fish", "darwin")).toEqual(
      ["-l"]
    );
    expect(resolveDefaultShellArgs("/bin/bash", "darwin")).toEqual([
      "--login"
    ]);
    expect(resolveDefaultShellArgs("/usr/local/bin/pwsh", "darwin")).toEqual([
      "-Login"
    ]);
    expect(resolveDefaultShellArgs("/usr/bin/env", "darwin")).toEqual([]);
  });

  it("keeps linux shells non-login by default", () => {
    expect(resolveDefaultShellArgs("/bin/zsh", "linux")).toEqual([]);
    expect(resolveDefaultShellArgs("/bin/bash", "linux")).toEqual([]);
  });

  it("only strips shell-managed env for default macOS login launches", () => {
    expect(shouldStripShellManagedEnv("/bin/zsh", undefined, "darwin")).toBe(
      true
    );
    expect(shouldStripShellManagedEnv("/bin/zsh", ["-l"], "darwin")).toBe(
      false
    );
    expect(shouldStripShellManagedEnv("/bin/zsh", undefined, "linux")).toBe(
      false
    );
  });
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  buildBootstrapHelperCommand,
  buildBootstrapScriptCommand,
  resolveBootstrapShellPolicy
} from "./bootstrapShellAdapter";

describe("bootstrap shell adapters", () => {
  const execFileAsync = promisify(execFile);
  it.each([
    ["/bin/sh", "bourne"],
    ["/bin/bash", "bourne"],
    ["/bin/zsh", "bourne"],
    ["/usr/bin/fish", "fish"],
    ["/bin/tcsh", "csh"]
  ] as const)("selects an explicit adapter for %s", (shell, kind) => {
    expect(
      resolveBootstrapShellPolicy({
        environmentOutput: `HOME=/home/user\nSHELL=${shell}\n`
      })
    ).toEqual({
      accountShellPath: shell,
      accountShellKind: kind,
      bootstrapShellPath: "/bin/sh"
    });
  });

  it("requires an override for an unknown account shell", () => {
    expect(() =>
      resolveBootstrapShellPolicy({
        environmentOutput: "SHELL=/opt/custom/bin/agent-shell\n"
      })
    ).toThrow(/bootstrapShellOverride/u);
    expect(
      resolveBootstrapShellPolicy({
        environmentOutput: "SHELL=/opt/custom/bin/agent-shell\n",
        bootstrapShellOverride: "/bin/bash"
      })
    ).toEqual({
      accountShellPath: "/opt/custom/bin/agent-shell",
      accountShellKind: "explicit",
      bootstrapShellPath: "/bin/bash"
    });
  });

  it("quotes helper paths and arguments without interpolating shell syntax", async () => {
    const policy = resolveBootstrapShellPolicy({
      environmentOutput: "SHELL=/bin/zsh\n"
    });
    const command = buildBootstrapHelperCommand(policy, "/usr/bin/printf", [
      "%s\\n",
      "literal; printf INJECTED"
    ]);
    const result = await execFileAsync("/bin/sh", ["-c", command]);
    expect(result.stdout).toBe("literal; printf INJECTED\n");
  });

  it("uses fish-specific outer quoting while retaining a POSIX bootstrap interpreter", () => {
    const command = buildBootstrapScriptCommand(
      resolveBootstrapShellPolicy({
        environmentOutput: "SHELL=/usr/bin/fish\n"
      }),
      "printf '%s\\n' 'quoted'"
    );
    expect(command).toMatch(/^exec '\/bin\/sh' -c '/u);
    expect(command).toContain("\\'");
  });
});

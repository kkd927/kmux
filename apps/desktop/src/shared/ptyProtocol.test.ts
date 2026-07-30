import { describe, expect, it } from "vitest";
import { uint64 } from "@kmux/proto";

import { stringifyJson } from "./json";

import {
  resolveDefaultShellArgs,
  resolvePolicyShellArgs,
  resolvePolicyShellPath,
  shouldApplyShellIntegration,
  shouldStripShellManagedEnv,
  type PtyEvent,
  type PtyRequest,
  type ShellLaunchProfile,
  type ShellLaunchPolicy
} from "./ptyProtocol";

const macOsShellLaunchProfile: ShellLaunchProfile = {
  defaultArgs: "login",
  stripManagedEnv: true,
  integrationMode: "posix-wrapper"
};

const linuxShellLaunchProfile: ShellLaunchProfile = {
  defaultArgs: "none",
  stripManagedEnv: false,
  integrationMode: "posix-wrapper"
};

const shellLaunchPolicy: ShellLaunchPolicy = {
  defaultShellPath: "/bin/bash",
  defaultShellArgs: [],
  stripManagedEnv: false,
  integration: {
    enabled: false,
    mode: "none"
  },
  agentPath: {
    helperBinDir: "/home/test/.local/share/kmux/hooks",
    wrapperBinDir: "/home/test/.local/share/kmux/wrappers",
    prependWrapperToPath: true
  },
  hookEnv: {
    KMUX_SOCKET_PATH: "/run/user/1000/kmux/control.sock",
    KMUX_AGENT_BIN_DIR: "/home/test/.local/share/kmux/hooks",
    KMUX_NODE_PATH: "/opt/kmux/kmux"
  }
};

describe("desktop pty protocol", () => {
  it("resolves shell policy defaults before pty-host launch", () => {
    expect(
      resolveDefaultShellArgs("/bin/zsh", macOsShellLaunchProfile)
    ).toEqual(["-l"]);
    expect(
      resolveDefaultShellArgs("/bin/zsh/", macOsShellLaunchProfile)
    ).toEqual(["-l"]);
    expect(resolveDefaultShellArgs("/bin/sh", macOsShellLaunchProfile)).toEqual(
      ["-l"]
    );
    expect(
      resolveDefaultShellArgs("/opt/homebrew/bin/fish", macOsShellLaunchProfile)
    ).toEqual(["-l"]);
    expect(
      resolveDefaultShellArgs("/bin/bash", macOsShellLaunchProfile)
    ).toEqual(["--login"]);
    expect(
      resolveDefaultShellArgs("/usr/local/bin/pwsh", macOsShellLaunchProfile)
    ).toEqual(["-Login"]);
    expect(
      resolveDefaultShellArgs(
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        macOsShellLaunchProfile
      )
    ).toEqual(["-Login"]);
    expect(
      resolveDefaultShellArgs("/usr/bin/env", macOsShellLaunchProfile)
    ).toEqual([]);
    expect(
      resolveDefaultShellArgs("/bin/zsh", linuxShellLaunchProfile)
    ).toEqual([]);
    expect(
      resolveDefaultShellArgs("/bin/bash", linuxShellLaunchProfile)
    ).toEqual([]);
  });

  it("keeps shell integration policy decisions outside pty-host runtime", () => {
    expect(
      shouldApplyShellIntegration(
        "/bin/zsh",
        undefined,
        macOsShellLaunchProfile
      )
    ).toBe(true);
    expect(
      shouldApplyShellIntegration(
        "/bin/bash",
        undefined,
        macOsShellLaunchProfile
      )
    ).toBe(true);
    expect(
      shouldApplyShellIntegration(
        "/opt/homebrew/bin/fish",
        undefined,
        macOsShellLaunchProfile
      )
    ).toBe(true);
    expect(
      shouldApplyShellIntegration("/bin/zsh", ["-l"], macOsShellLaunchProfile)
    ).toBe(false);
    expect(
      shouldApplyShellIntegration(
        "/bin/zsh",
        undefined,
        linuxShellLaunchProfile
      )
    ).toBe(true);
    expect(
      shouldApplyShellIntegration(
        "/bin/bash",
        undefined,
        linuxShellLaunchProfile
      )
    ).toBe(true);
    expect(
      shouldApplyShellIntegration(
        "/usr/bin/fish",
        undefined,
        linuxShellLaunchProfile
      )
    ).toBe(true);
    expect(
      shouldApplyShellIntegration("/bin/sh", undefined, linuxShellLaunchProfile)
    ).toBe(false);
  });

  it("strips shell-managed env only for default macOS login launches", () => {
    expect(
      shouldStripShellManagedEnv("/bin/zsh", undefined, macOsShellLaunchProfile)
    ).toBe(true);
    expect(
      shouldStripShellManagedEnv("/bin/zsh", ["-l"], macOsShellLaunchProfile)
    ).toBe(false);
    expect(
      shouldStripShellManagedEnv("/bin/zsh", undefined, linuxShellLaunchProfile)
    ).toBe(false);
  });

  it("resolves missing launch shells from the serialized policy", () => {
    expect(resolvePolicyShellPath(shellLaunchPolicy, {})).toBe("/bin/bash");
    expect(resolvePolicyShellArgs(shellLaunchPolicy, {})).toEqual([]);
    expect(resolvePolicyShellPath(shellLaunchPolicy, { shell: "codex" })).toBe(
      "codex"
    );
    expect(
      resolvePolicyShellArgs(shellLaunchPolicy, { shell: "codex" })
    ).toEqual([]);
    expect(resolvePolicyShellPath(shellLaunchPolicy, {})).not.toBe("/bin/zsh");
  });

  it("keeps request envelopes serializable under desktop ownership", () => {
    const requests: PtyRequest[] = [
      {
        type: "spawn",
        shellLaunchPolicy,
        spec: {
          sessionId: "session_1",
          surfaceId: "surface_1",
          runtimeEpoch: "epoch_1",
          workspaceId: "workspace_1",
          launch: {
            cwd: "/home/test/project",
            shell: "/bin/bash"
          },
          cols: 120,
          rows: 30,
          env: {
            KMUX_WORKSPACE_ID: "workspace_1",
            KMUX_SURFACE_ID: "surface_1",
            KMUX_SESSION_ID: "session_1",
            TERM_PROGRAM: "kmux"
          }
        }
      },
      {
        type: "input:text",
        sessionId: "session_1",
        text: "codex\r"
      },
      {
        type: "input:key",
        sessionId: "session_1",
        input: {
          key: "Enter",
          text: "\r",
          ctrlKey: true
        }
      },
      {
        type: "snapshot",
        sessionId: "session_1",
        surfaceId: "surface_1",
        requestId: "snapshot_1",
        settleForMs: 120,
        includeRawOutputTail: true
      }
    ];

    expect(JSON.parse(JSON.stringify(requests))).toEqual(requests);
    expect(requests[0]).toMatchObject({
      type: "spawn",
      shellLaunchPolicy: {
        hookEnv: {
          KMUX_SOCKET_PATH: "/run/user/1000/kmux/control.sock",
          KMUX_AGENT_BIN_DIR: "/home/test/.local/share/kmux/hooks",
          KMUX_NODE_PATH: "/opt/kmux/kmux"
        }
      }
    });
  });

  it("keeps control-plane snapshot and notification events serializable", () => {
    const events: PtyEvent[] = [
      {
        type: "snapshot",
        requestId: "snapshot_1",
        payload: {
          surfaceId: "surface_1",
          sessionId: "session_1",
          sequence: uint64(12n),
          vt: "hello",
          cols: 120,
          rows: 30,
          title: "bash",
          cwd: "/home/test/project",
          ports: [],
          unreadCount: 0,
          attention: false,
          rawOutputTail: "hello",
          rawOutputTailTruncated: false,
          rawOutputLogPath: "/home/test/.local/state/kmux/pty-raw/stream.ansi",
          rawOutputIndexPath:
            "/home/test/.local/state/kmux/pty-raw/chunks.jsonl",
          rawOutputLogBytes: 5,
          rawOutputLogChunks: 1
        }
      },
      {
        type: "terminal.notification",
        surfaceId: "surface_1",
        sessionId: "session_1",
        protocol: 9,
        title: "Codex",
        message: "Needs input"
      }
    ];

    expect(JSON.parse(stringifyJson(events))).toMatchObject([
      { type: "snapshot", payload: { sequence: "12" } },
      { type: "terminal.notification" }
    ]);
  });
});

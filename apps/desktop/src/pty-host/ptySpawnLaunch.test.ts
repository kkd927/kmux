import { describe, expect, it } from "vitest";

import type { PtyRequest, ShellLaunchPolicy } from "../shared/ptyProtocol";
import { resolvePtySpawnLaunch } from "./ptySpawnLaunch";

const linuxShellPolicy: ShellLaunchPolicy = {
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

function createSpawnRequest(
  override: Partial<Extract<PtyRequest, { type: "spawn" }>> = {}
): Extract<PtyRequest, { type: "spawn" }> {
  return {
    type: "spawn",
    shellLaunchPolicy: linuxShellPolicy,
    spec: {
      sessionId: "session_1",
      surfaceId: "surface_1",
      runtimeEpoch: "epoch_1",
      workspaceId: "workspace_1",
      launch: {
        cwd: "/home/test/project",
        env: {
          PATH: "/opt/bin:/usr/bin",
          KMUX_SOCKET_PATH: "/launch.sock",
          KMUX_AGENT_BIN_DIR: "/launch/hooks",
          KMUX_NODE_PATH: "/launch/kmux"
        }
      },
      cols: 120,
      rows: 30,
      env: {
        KMUX_SOCKET_PATH: "/session.sock",
        KMUX_AGENT_BIN_DIR: "/session/hooks",
        KMUX_NODE_PATH: "/session/kmux",
        KMUX_WORKSPACE_ID: "workspace_1",
        KMUX_SURFACE_ID: "surface_1",
        KMUX_SESSION_ID: "session_1",
        TERM_PROGRAM: "kmux"
      }
    },
    ...override
  };
}

describe("resolvePtySpawnLaunch", () => {
  it("resolves a pty spawn through ShellLaunchPolicy with authoritative hook env", () => {
    const launch = resolvePtySpawnLaunch(createSpawnRequest(), {
      HOME: "/home/test",
      ELECTRON_RUN_AS_NODE: "1",
      PATH: "/usr/bin",
      KMUX_SOCKET_PATH: "/base.sock",
      KMUX_AGENT_BIN_DIR: "/base/hooks",
      KMUX_NODE_PATH: "/base/kmux"
    });

    expect(launch.shellPath).toBe("/bin/bash");
    expect(launch.args).toEqual([]);
    expect(launch.cwd).toBe("/home/test/project");
    expect(launch.requiresShellReady).toBe(false);
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(launch.env.KMUX_SOCKET_PATH).toBe(
      "/run/user/1000/kmux/control.sock"
    );
    expect(launch.env.KMUX_AGENT_BIN_DIR).toBe(
      "/home/test/.local/share/kmux/hooks"
    );
    expect(launch.env.KMUX_NODE_PATH).toBe("/opt/kmux/kmux");
    expect(launch.env.KMUX_WORKSPACE_ID).toBe("workspace_1");
    expect(launch.env.PATH).toBe(
      "/home/test/.local/share/kmux/wrappers:/opt/bin:/usr/bin"
    );
  });

  it("keeps launch shell overrides while using the policy env contract", () => {
    const request = createSpawnRequest({
      spec: {
        ...createSpawnRequest().spec,
        launch: {
          shell: "/usr/bin/fish",
          args: ["--private"]
        }
      }
    });
    const launch = resolvePtySpawnLaunch(request, {
      HOME: "/home/test",
      PATH: "/usr/bin"
    });

    expect(launch.shellPath).toBe("/usr/bin/fish");
    expect(launch.args).toEqual(["--private"]);
    expect(launch.cwd).toBe("/home/test");
    expect(launch.env.KMUX_SOCKET_PATH).toBe(
      "/run/user/1000/kmux/control.sock"
    );
  });

  it("uses only absolute cwd values for pty spawn launch", () => {
    const trimmedExplicit = resolvePtySpawnLaunch(
      createSpawnRequest({
        spec: {
          ...createSpawnRequest().spec,
          launch: {
            cwd: " /home/test/project "
          }
        }
      }),
      {
        HOME: "/home/test",
        PATH: "/usr/bin"
      }
    );

    expect(trimmedExplicit.cwd).toBe("/home/test/project");

    const homeFallback = resolvePtySpawnLaunch(
      createSpawnRequest({
        spec: {
          ...createSpawnRequest().spec,
          launch: {
            cwd: "relative-project"
          }
        }
      }),
      {
        HOME: " /home/test ",
        PATH: "/usr/bin"
      }
    );

    expect(homeFallback.cwd).toBe("/home/test");

    const noSafeCwd = resolvePtySpawnLaunch(
      createSpawnRequest({
        spec: {
          ...createSpawnRequest().spec,
          launch: {
            cwd: "   "
          }
        }
      }),
      {
        HOME: "relative-home",
        PATH: "/usr/bin"
      }
    );

    expect(noSafeCwd.cwd).toBeUndefined();
  });
});

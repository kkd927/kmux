import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { prepareShellIntegrationLaunch } from "./shellIntegration";
import { buildSessionEnv } from "./sessionEnv";

const defaultHookEnv = {
  KMUX_SOCKET_PATH: "/tmp/kmux.sock",
  KMUX_AGENT_BIN_DIR: "/tmp/kmux-agent-hooks",
  KMUX_NODE_PATH: "/Applications/kmux.app/Contents/MacOS/kmux"
};

describe("buildSessionEnv", () => {
  it("strips inherited Electron runtime flags that break child Electron apps", () => {
    const env = buildSessionEnv({
      baseEnv: {
        ELECTRON_RUN_AS_NODE: "1",
        PATH: "/usr/bin"
      },
      hookEnv: defaultHookEnv,
      sessionEnv: {
        TERM_PROGRAM: "kmux"
      }
    });

    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.TERM_PROGRAM).toBe("kmux");
    expect(env.COLORTERM).toBe("truecolor");
  });

  it("drops shell-managed path variables when launching a default macOS login shell", () => {
    const env = buildSessionEnv({
      baseEnv: {
        PATH: "/usr/local/bin:/usr/bin",
        MANPATH: "/usr/share/man",
        INFOPATH: "/usr/share/info"
      },
      hookEnv: defaultHookEnv,
      sessionEnv: {
        TERM_PROGRAM: "kmux"
      },
      options: {
        stripShellManagedEnv: true
      }
    });

    expect(env.PATH).toBeUndefined();
    expect(env.MANPATH).toBeUndefined();
    expect(env.INFOPATH).toBeUndefined();
    expect(env.TERM_PROGRAM).toBe("kmux");
  });

  it("still allows explicit session env overrides after sanitizing inherited values", () => {
    const env = buildSessionEnv({
      baseEnv: {
        ELECTRON_RUN_AS_NODE: "1",
        TERM_PROGRAM: "Apple_Terminal"
      },
      launchEnv: {
        TERM_PROGRAM: "zsh"
      },
      hookEnv: defaultHookEnv,
      sessionEnv: {
        ELECTRON_RUN_AS_NODE: "1"
      }
    });

    expect(env.TERM_PROGRAM).toBe("zsh");
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("applies documented env precedence before a Linux spawn", () => {
    const env = buildSessionEnv({
      baseEnv: {
        ELECTRON_RUN_AS_NODE: "1",
        PATH: "/usr/bin",
        KMUX_SOCKET_PATH: "/base.sock",
        KMUX_PANE_ID: "pane_base"
      },
      launchEnv: {
        PATH: "/opt/bin:/usr/bin",
        KMUX_SOCKET_PATH: "/launch.sock",
        KMUX_PANE_ID: "pane_launch"
      },
      hookEnv: {
        KMUX_SOCKET_PATH: "/run/user/1000/kmux/control.sock",
        KMUX_AGENT_BIN_DIR: "/home/test/.local/share/kmux/hooks",
        KMUX_NODE_PATH: "/opt/kmux/kmux"
      },
      sessionEnv: {
        KMUX_WORKSPACE_ID: "workspace_1",
        KMUX_SURFACE_ID: "surface_1",
        KMUX_SESSION_ID: "session_1",
        TERM_PROGRAM: "kmux"
      },
      options: {
        agentPath: {
          helperBinDir: "/home/test/.local/share/kmux/hooks",
          wrapperBinDir: "/home/test/.local/share/kmux/wrappers",
          prependWrapperToPath: true
        }
      }
    });

    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.KMUX_SOCKET_PATH).toBe("/run/user/1000/kmux/control.sock");
    expect(env.KMUX_AGENT_BIN_DIR).toBe("/home/test/.local/share/kmux/hooks");
    expect(env.KMUX_NODE_PATH).toBe("/opt/kmux/kmux");
    expect(env.KMUX_PANE_ID).toBeUndefined();
    expect(env.KMUX_WORKSPACE_ID).toBe("workspace_1");
    expect(env.PATH).toBe(
      "/home/test/.local/share/kmux/wrappers:/opt/bin:/usr/bin"
    );
  });

  it("preserves empty PATH entries while moving the wrapper to the front", () => {
    const wrapperBinDir = "/home/test/.local/share/kmux/wrappers";
    const env = buildSessionEnv({
      baseEnv: {
        PATH: `:/opt/bin:${wrapperBinDir}::`
      },
      hookEnv: defaultHookEnv,
      sessionEnv: {
        TERM_PROGRAM: "kmux"
      },
      options: {
        agentPath: {
          helperBinDir: "/home/test/.local/share/kmux/hooks",
          wrapperBinDir,
          prependWrapperToPath: true
        }
      }
    });

    expect(env.PATH).toBe(`${wrapperBinDir}::/opt/bin::`);
  });

  it("keeps shell policy hook env authoritative over launch and session env", () => {
    const env = buildSessionEnv({
      baseEnv: {
        PATH: "/usr/bin",
        KMUX_SOCKET_PATH: "/base.sock",
        KMUX_AGENT_BIN_DIR: "/base/hooks",
        KMUX_NODE_PATH: "/base/kmux"
      },
      launchEnv: {
        KMUX_SOCKET_PATH: "/launch.sock",
        KMUX_AGENT_BIN_DIR: "/launch/hooks",
        KMUX_NODE_PATH: "/launch/kmux"
      },
      hookEnv: {
        KMUX_SOCKET_PATH: "/run/user/1000/kmux/control.sock",
        KMUX_AGENT_BIN_DIR: "/home/test/.local/share/kmux/hooks",
        KMUX_NODE_PATH: "/opt/kmux/kmux"
      },
      sessionEnv: {
        KMUX_SOCKET_PATH: "/session.sock",
        KMUX_AGENT_BIN_DIR: "/session/hooks",
        KMUX_NODE_PATH: "/session/kmux",
        KMUX_WORKSPACE_ID: "workspace_1",
        KMUX_SURFACE_ID: "surface_1",
        KMUX_SESSION_ID: "session_1",
        TERM_PROGRAM: "kmux"
      }
    });

    expect(env.KMUX_SOCKET_PATH).toBe("/run/user/1000/kmux/control.sock");
    expect(env.KMUX_AGENT_BIN_DIR).toBe("/home/test/.local/share/kmux/hooks");
    expect(env.KMUX_NODE_PATH).toBe("/opt/kmux/kmux");
    expect(env.KMUX_WORKSPACE_ID).toBe("workspace_1");
    expect(env.KMUX_SURFACE_ID).toBe("surface_1");
    expect(env.KMUX_SESSION_ID).toBe("session_1");
  });

  it("keeps stable hook and wrapper dirs with macOS shell integration enabled", () => {
    const helperBinDir = "/Users/test/Library/Application Support/kmux/hooks";
    const wrapperBinDir =
      "/Users/test/Library/Application Support/kmux/wrappers";
    const env = buildSessionEnv({
      baseEnv: {
        HOME: "/Users/test",
        PATH: "/usr/bin"
      },
      hookEnv: {
        KMUX_SOCKET_PATH: "/Users/test/.kmux/control.sock",
        KMUX_AGENT_BIN_DIR: helperBinDir,
        KMUX_NODE_PATH: "/Applications/kmux.app/Contents/MacOS/kmux"
      },
      sessionEnv: {
        TERM_PROGRAM: "kmux"
      },
      options: {
        stripShellManagedEnv: true,
        agentPath: {
          helperBinDir,
          wrapperBinDir,
          prependWrapperToPath: true
        }
      }
    });
    const prepared = prepareShellIntegrationLaunch("/bin/zsh", ["-l"], env, {
      enabled: true,
      agentPath: {
        helperBinDir,
        wrapperBinDir,
        prependWrapperToPath: true
      }
    });

    expect(prepared.requiresShellReady).toBe(true);
    expect(prepared.env.KMUX_AGENT_BIN_DIR).toBe(helperBinDir);
    expect(prepared.env.KMUX_AGENT_WRAPPER_BIN_DIR).toBe(wrapperBinDir);
    expect(prepared.env.KMUX_SHELL_INTEGRATION).toBe("1");
    expect(prepared.env.PATH).toBe(wrapperBinDir);
    expect(prepared.env.KMUX_ZSH_INTEGRATION_SCRIPT).toBe(
      join(prepared.env.ZDOTDIR ?? "", "kmux.zsh")
    );
  });
});

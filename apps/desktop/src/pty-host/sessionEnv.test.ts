import {describe, expect, it} from "vitest";

import {buildSessionEnv} from "./sessionEnv";

describe("buildSessionEnv", () => {
  it("strips inherited Electron runtime flags that break child Electron apps", () => {
    const env = buildSessionEnv(
      {
        ELECTRON_RUN_AS_NODE: "1",
        PATH: "/usr/bin"
      },
      undefined,
      {
        TERM_PROGRAM: "kmux"
      }
    );

    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.TERM_PROGRAM).toBe("kmux");
    expect(env.COLORTERM).toBe("truecolor");
  });

  it("drops shell-managed path variables when launching a default macOS login shell", () => {
    const env = buildSessionEnv(
      {
        PATH: "/usr/local/bin:/usr/bin",
        MANPATH: "/usr/share/man",
        INFOPATH: "/usr/share/info"
      },
      undefined,
      {
        TERM_PROGRAM: "kmux"
      },
      {
        stripShellManagedEnv: true
      }
    );

    expect(env.PATH).toBeUndefined();
    expect(env.MANPATH).toBeUndefined();
    expect(env.INFOPATH).toBeUndefined();
    expect(env.TERM_PROGRAM).toBe("kmux");
  });

  it("still allows explicit session env overrides after sanitizing inherited values", () => {
    const env = buildSessionEnv(
      {
        ELECTRON_RUN_AS_NODE: "1",
        TERM_PROGRAM: "Apple_Terminal"
      },
      {
        TERM_PROGRAM: "zsh"
      },
      {
        ELECTRON_RUN_AS_NODE: "1"
      }
    );

    expect(env.TERM_PROGRAM).toBe("zsh");
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
  });
});

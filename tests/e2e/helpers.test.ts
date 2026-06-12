import {
  buildElectronLaunchOptions,
  type KmuxSandbox
} from "./helpers";

const sandbox: KmuxSandbox = {
  profileRoot: "/tmp/kmux-e2e-profile",
  configDir: "/tmp/kmux-e2e-profile/config",
  runtimeDir: "/tmp/kmux-e2e-profile/runtime",
  socketPath: "/tmp/kmux-e2e-profile/runtime/control.sock",
  shellHomeDir: "/tmp/kmux-e2e-profile/home",
  shellHistoryPath: "/tmp/kmux-e2e-profile/home/.zsh_history",
  xdgConfigHome: "/tmp/kmux-e2e-profile/home/.config"
};

const paths = {
  currentDir: "/repo/tests/e2e",
  appRoot: "/repo/apps/desktop",
  cliPath: "/repo/packages/cli/dist/bin.cjs",
  workspaceRoot: "/repo"
};

describe("buildElectronLaunchOptions", () => {
  it("launches the source app through the app root argument", () => {
    const options = buildElectronLaunchOptions({
      sandbox,
      paths,
      env: {
        PATH: "/usr/bin",
        KMUX_E2E_WINDOW_MODE: "visible"
      }
    });

    expect(options.args).toEqual([paths.appRoot]);
    expect(options).not.toHaveProperty("executablePath");
    const launchEnv = options.env ?? {};
    expect(launchEnv).toMatchObject({
      PATH: "/usr/bin",
      NODE_ENV: "test",
      KMUX_E2E_WINDOW_MODE: "visible",
      KMUX_E2E_DISABLE_QUIT_CONFIRM: "1",
      KMUX_CONFIG_DIR: sandbox.configDir,
      KMUX_RUNTIME_DIR: sandbox.runtimeDir,
      HOME: sandbox.shellHomeDir,
      ZDOTDIR: sandbox.shellHomeDir,
      HISTFILE: sandbox.shellHistoryPath,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome
    });
  });

  it("launches packaged executables without Electron app args", () => {
    const packagedPath = "/tmp/kmux-0.3.12-linux-x64.AppImage";
    const options = buildElectronLaunchOptions({
      sandbox,
      paths,
      options: {
        executablePath: packagedPath,
        env: {
          APPIMAGE: packagedPath,
          APPIMAGE_EXTRACT_AND_RUN: "1",
          KMUX_PACKAGED_EXECUTABLE_PATH: packagedPath
        }
      },
      env: {
        PATH: "/usr/bin"
      }
    });

    expect(options.executablePath).toBe(packagedPath);
    expect(options.args).toEqual([]);
    expect(options.args).not.toContain("--no-sandbox");
    const launchEnv = options.env ?? {};
    expect(launchEnv).toMatchObject({
      APPIMAGE: packagedPath,
      APPIMAGE_EXTRACT_AND_RUN: "1",
      KMUX_PACKAGED_EXECUTABLE_PATH: packagedPath
    });
  });
});

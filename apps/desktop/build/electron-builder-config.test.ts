import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as {
  load: (source: string) => unknown;
};
const { getConfig, validateConfiguration } =
  require("app-builder-lib/out/util/config/config") as {
    getConfig: (
      projectDir: string,
      configPath: string,
      configFromOptions: unknown
    ) => Promise<Record<string, unknown>>;
    validateConfiguration: (
      config: Record<string, unknown>,
      debugLogger: unknown
    ) => Promise<void>;
  };
const { DebugLogger } = require("builder-util") as {
  DebugLogger: new (isEnabled: boolean) => unknown;
};
const { LinuxTargetHelper } =
  require("app-builder-lib/out/targets/LinuxTargetHelper") as {
    LinuxTargetHelper: new (packager: unknown) => {
      computeDesktopEntry: (
        targetSpecificOptions: Record<string, unknown>,
        exec?: string | null,
        extra?: Record<string, string>
      ) => Promise<string>;
    };
  };

function readBuilderConfig(): Record<string, unknown> {
  return yaml.load(
    readFileSync("apps/desktop/electron-builder.yml", "utf8")
  ) as Record<string, unknown>;
}

describe("electron builder config", () => {
  it("keeps mac signing under mac config and uses a guarded artifact hook", () => {
    const config = readBuilderConfig();
    const mac = config.mac as Record<string, unknown>;

    expect(config.artifactBuildCompleted).toBe(
      "./build/artifact-build-completed.cjs"
    );
    expect(mac.sign).toBe("./build/custom-mac-sign.cjs");
  });

  it("configures Linux packaging as AppImage-only with desktop identity fields", () => {
    const config = readBuilderConfig();
    const extraResources = config.extraResources as Array<
      Record<string, unknown>
    >;
    const linux = config.linux as Record<string, unknown>;
    const desktop = linux.desktop as Record<string, unknown>;
    const desktopEntry = desktop.entry as Record<string, unknown>;

    expect(config.appId).toBe("dev.kmux.desktop");
    expect(extraResources).toContainEqual({
      from: "build/icon.png",
      to: "notificationIcon.png"
    });
    expect(linux).toMatchObject({
      category: "Development;TerminalEmulator;Utility;",
      icon: "build/icon.png",
      synopsis: "Keyboard-first terminal workspace manager for coding agents",
      description:
        "Run coding agents side by side without losing terminal output continuity.",
      executableName: "kmux",
      artifactName: "${productName}-${version}-linux-${arch}.${ext}",
      target: ["AppImage"]
    });
    expect(desktopEntry).toMatchObject({
      Name: "kmux",
      GenericName: "AI Coding Agent Terminal",
      Comment:
        "Run coding agents side by side without losing terminal output continuity.",
      Icon: "kmux",
      StartupWMClass: "kmux",
      StartupNotify: "true",
      Terminal: "false",
      Keywords: "AI;agent;terminal;developer;coding;"
    });
    expect(desktopEntry).not.toHaveProperty("Categories");
  });

  it("generates Linux desktop entry categories from linux.category", async () => {
    const config = readBuilderConfig();
    const linux = config.linux as Record<string, unknown>;
    const helper = new LinuxTargetHelper({
      appInfo: {
        productName: "kmux",
        description: config.description,
        sanitizedProductName: "kmux"
      },
      executableName: "kmux",
      fileAssociations: [],
      config: {
        mac: config.mac,
        protocols: []
      },
      platformSpecificBuildOptions: {}
    });

    const desktopEntry = await helper.computeDesktopEntry(linux, null, {});

    expect(desktopEntry).toContain(
      "\nCategories=Development;TerminalEmulator;Utility;\n"
    );
    expect(desktopEntry).toContain("\nStartupWMClass=kmux\n");
  });

  it("passes electron-builder config validation", async () => {
    const projectDir = path.resolve("apps/desktop");
    const config = await getConfig(
      projectDir,
      path.join(projectDir, "electron-builder.yml"),
      null
    );

    await expect(
      validateConfiguration(config, new DebugLogger(false))
    ).resolves.toBeUndefined();
  });
});

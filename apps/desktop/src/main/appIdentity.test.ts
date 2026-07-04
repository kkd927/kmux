import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  KMUX_APP_ID,
  KMUX_APP_NAME
} from "./appIdentity";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as {
  load: (source: string) => unknown;
};

function readBuilderConfig(): Record<string, unknown> {
  return yaml.load(
    readFileSync("apps/desktop/electron-builder.yml", "utf8")
  ) as Record<string, unknown>;
}

function readDesktopPackage(): Record<string, unknown> {
  return JSON.parse(
    readFileSync("apps/desktop/package.json", "utf8")
  ) as Record<string, unknown>;
}

describe("desktop app identity", () => {
  it("keeps runtime identity aligned with packaged Linux desktop identity", () => {
    const config = readBuilderConfig();
    const desktopPackage = readDesktopPackage();
    const linux = config.linux as Record<string, unknown>;
    const desktop = linux.desktop as Record<string, unknown>;
    const desktopEntry = desktop.entry as Record<string, unknown>;

    expect(config.appId).toBe(KMUX_APP_ID);
    expect(config.productName).toBe(KMUX_APP_NAME);
    expect(desktopPackage.desktopName).toBe(KMUX_APP_NAME);
    expect(linux.syncDesktopName).toBe(true);
    expect(linux.executableName).toBe(KMUX_APP_NAME);
    expect(desktopEntry.Name).toBe(KMUX_APP_NAME);
    expect(desktopEntry).not.toHaveProperty("StartupWMClass");
  });
});

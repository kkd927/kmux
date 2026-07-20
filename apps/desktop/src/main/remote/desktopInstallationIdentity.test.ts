import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateDesktopInstallationId } from "./desktopInstallationIdentity";

describe("desktop installation identity", () => {
  let sandbox: string;
  let path: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "kmux-desktop-identity-"));
    path = join(sandbox, "private", "desktop-installation.json");
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("durably reuses one installation ID instead of minting one per process", () => {
    const first = loadOrCreateDesktopInstallationId(path, {
      makeInstallationId: () => "desktop_stable"
    });
    const second = loadOrCreateDesktopInstallationId(path, {
      makeInstallationId: () => "desktop_wrong"
    });

    expect(first).toBe("desktop_stable");
    expect(second).toBe(first);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      desktopInstallationId: "desktop_stable"
    });
  });

  it("fails closed for corrupt, over-permissive, and linked identity files", () => {
    loadOrCreateDesktopInstallationId(path, {
      makeInstallationId: () => "desktop_private"
    });
    writeFileSync(path, "{bad-json", { mode: 0o600 });
    expect(() => loadOrCreateDesktopInstallationId(path)).toThrow(
      /valid JSON/u
    );

    writeFileSync(
      path,
      JSON.stringify({ version: 1, desktopInstallationId: "desktop_private" })
    );
    chmodSync(path, 0o644);
    expect(() => loadOrCreateDesktopInstallationId(path)).toThrow(
      /group or other permissions/u
    );

    rmSync(path);
    const outside = join(sandbox, "outside.json");
    writeFileSync(
      outside,
      JSON.stringify({ version: 1, desktopInstallationId: "desktop_outside" })
    );
    symlinkSync(outside, path);
    expect(() => loadOrCreateDesktopInstallationId(path)).toThrow(
      /regular file/u
    );
  });
});

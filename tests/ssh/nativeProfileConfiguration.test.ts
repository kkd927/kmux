import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decodeNativeProfileConfiguration,
  isSharedCiEnvironment,
  verifyNativeProfileRuntimeArtifact
} from "./profile/nativeProfileConfiguration";

const templatePath = new URL(
  "./profile/native-profile.template.json",
  import.meta.url
);

describe("native SSH profile configuration", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["0", false],
    ["false", false],
    ["FALSE", false],
    ["1", true],
    ["true", true],
    ["yes", true]
  ])("classifies CI=%s as shared=%s", (value, expected) => {
    expect(isSharedCiEnvironment(value)).toBe(expected);
  });

  it("keeps the checked-in operator template aligned with the strict decoder", async () => {
    const template = JSON.parse(await readFile(templatePath, "utf8"));

    expect(decodeNativeProfileConfiguration(template)).toEqual(template);
  });

  it.each([
    ["unknown top-level field", { unexpected: true }],
    ["non-boolean shared-host claim", { sharedHost: 0 }],
    ["unsupported artifact", { artifactTarget: "linux-riscv64-musl" }],
    ["relative local artifact", { runtimeArtifactPath: "build/kmuxd" }],
    ["unbound artifact digest", { runtimeSha256: "0".repeat(63) }],
    ["option-like host", { host: "-oProxyCommand=false" }],
    ["relative runtime", { runtimePath: "tmp/kmuxd" }],
    ["remote root", { roots: { stateRoot: "/" } }],
    [
      "duplicate remote roots",
      {
        roots: {
          stateRoot: "/absolute/remote/path/to/kmux/install"
        }
      }
    ],
    ["controlled target ID", { targetId: "target\ninvalid" }],
    ["coerced hardware claim", { hardware: { physicalCpuCores: "8" } }],
    ["negative jitter", { network: { maximumInjectedJitterMs: -1 } }],
    ["relative audit executable", { auditSnapshot: { executable: "audit" } }]
  ])("rejects %s", async (_name, override) => {
    const template = JSON.parse(await readFile(templatePath, "utf8"));
    const candidate = mergeOverride(template, override);

    expect(() => decodeNativeProfileConfiguration(candidate)).toThrow(
      TypeError
    );
  });

  it("binds the configured digest to an executable local artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kmux-native-profile-"));
    try {
      const artifactPath = join(directory, "kmuxd");
      const bytes = Buffer.from("native-profile-artifact", "utf8");
      await writeFile(artifactPath, bytes);
      await chmod(artifactPath, 0o700);
      const template = JSON.parse(await readFile(templatePath, "utf8"));
      const configuration = decodeNativeProfileConfiguration({
        ...template,
        runtimeArtifactPath: artifactPath,
        runtimeSha256: createHash("sha256").update(bytes).digest("hex")
      });

      await expect(
        verifyNativeProfileRuntimeArtifact(configuration)
      ).resolves.toBe(configuration.runtimeSha256);
      await expect(
        verifyNativeProfileRuntimeArtifact({
          ...configuration,
          runtimeSha256: "f".repeat(64)
        })
      ).rejects.toThrow(/does not match configuration/u);

      const symlinkPath = join(directory, "kmuxd-link");
      await symlink(artifactPath, symlinkPath);
      await expect(
        verifyNativeProfileRuntimeArtifact({
          ...configuration,
          runtimeArtifactPath: symlinkPath
        })
      ).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function mergeOverride(
  source: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const merged = structuredClone(source);
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      merged[key] &&
      typeof merged[key] === "object" &&
      !Array.isArray(merged[key])
    ) {
      merged[key] = {
        ...(merged[key] as Record<string, unknown>),
        ...(value as Record<string, unknown>)
      };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

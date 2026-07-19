import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createRemoteRuntimeArtifactManifest,
  nativeRemoteRuntimeTarget,
  parseNativeArtifactAttestation,
  parseRemoteRuntimeArtifactManifest,
  refreshSignedRemoteRuntimeArtifactManifest,
  selectRemoteRuntimeTarget
} from "./remote-runtime-artifact-contract.mjs";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const expectedNativeMatrix = [
  {
    target: "darwin-arm64",
    runner: "macos-15",
    rust_target: "aarch64-apple-darwin"
  },
  {
    target: "darwin-x64",
    runner: "macos-15-intel",
    rust_target: "x86_64-apple-darwin"
  },
  {
    target: "linux-arm64-musl",
    runner: "ubuntu-24.04-arm",
    rust_target: "aarch64-unknown-linux-musl"
  },
  {
    target: "linux-x64-musl",
    runner: "ubuntu-24.04",
    rust_target: "x86_64-unknown-linux-musl"
  }
];

describe("remote runtime artifact contract", () => {
  it("selects only the four accepted OS, architecture, and ABI tuples", () => {
    expect(
      selectRemoteRuntimeTarget({
        platform: "macos",
        arch: "aarch64",
        abi: "native"
      })
    ).toBe("darwin-arm64");
    expect(
      selectRemoteRuntimeTarget({
        platform: "darwin",
        arch: "x86_64",
        abi: "native"
      })
    ).toBe("darwin-x64");
    expect(
      selectRemoteRuntimeTarget({
        platform: "linux",
        arch: "aarch64",
        abi: "musl"
      })
    ).toBe("linux-arm64-musl");
    expect(
      selectRemoteRuntimeTarget({
        platform: "linux",
        arch: "x86_64",
        abi: "musl"
      })
    ).toBe("linux-x64-musl");
    expect(() =>
      selectRemoteRuntimeTarget({
        platform: "linux",
        arch: "x86_64",
        abi: "gnu"
      })
    ).toThrow(/unsupported remote runtime/u);
    expect(() =>
      selectRemoteRuntimeTarget({
        platform: "win32",
        arch: "x64",
        abi: "native"
      })
    ).toThrow(/unsupported remote runtime/u);
  });

  it("uses the actual host tuple without treating emulation as native", () => {
    expect(nativeRemoteRuntimeTarget("darwin", "x64")).toBe("darwin-x64");
    expect(nativeRemoteRuntimeTarget("linux", "arm64")).toBe(
      "linux-arm64-musl"
    );
    expect(nativeRemoteRuntimeTarget("win32", "x64")).toBeUndefined();
  });

  it("rejects manifest drift and unknown fields", () => {
    const manifest = createRemoteRuntimeArtifactManifest({
      target: "linux-x64-musl",
      runtimeVersion: "0.1.0",
      sha256: "a".repeat(64),
      bytes: 123
    });
    expect(parseRemoteRuntimeArtifactManifest(manifest)).toEqual(manifest);
    expect(() =>
      parseRemoteRuntimeArtifactManifest({ ...manifest, arch: "arm64" })
    ).toThrow(/violates its target contract/u);
    expect(() =>
      parseRemoteRuntimeArtifactManifest({ ...manifest, optional: true })
    ).toThrow(/unknown or missing fields/u);
  });

  it("binds cross-host signature attestations to one native artifact hash", () => {
    const expected = {
      target: "darwin-arm64",
      platform: "darwin",
      arch: "arm64",
      sha256: "a".repeat(64)
    };
    const attestation = {
      schemaVersion: 1,
      target: expected.target,
      platform: expected.platform,
      arch: expected.arch,
      sha256: expected.sha256,
      signatureVerified: true,
      nativeCapabilitiesVerified: true,
      nativeParityPassed: true
    };
    expect(parseNativeArtifactAttestation(attestation, expected)).toEqual(
      attestation
    );
    expect(() =>
      parseNativeArtifactAttestation(
        { ...attestation, sha256: "b".repeat(64) },
        expected
      )
    ).toThrow(/attestation is invalid/u);
    expect(() =>
      parseNativeArtifactAttestation(
        { ...attestation, untrusted: true },
        expected
      )
    ).toThrow(/attestation is invalid/u);
  });

  it("rebinds a signed artifact manifest to the final signed bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "kmux-runtime-manifest-"));
    const target = "darwin-x64";
    const directory = join(root, target);
    const executablePath = join(directory, "kmuxd");
    const manifestPath = join(directory, "manifest.json");
    const before = Buffer.from("before-signing");
    const after = Buffer.from("after-developer-id-signing");

    try {
      await chmod(root, 0o700);
      await mkdir(directory, { mode: 0o700 });
      await writeFile(executablePath, before, { mode: 0o700 });
      await writeFile(
        manifestPath,
        `${JSON.stringify(
          createRemoteRuntimeArtifactManifest({
            target,
            runtimeVersion: "0.1.0",
            sha256: createHash("sha256").update(before).digest("hex"),
            bytes: before.byteLength
          }),
          null,
          2
        )}\n`,
        { mode: 0o600 }
      );
      await writeFile(executablePath, after);

      const { manifest } = await refreshSignedRemoteRuntimeArtifactManifest(
        root,
        target
      );
      expect(manifest).toMatchObject({
        target,
        runtimeVersion: "0.1.0",
        sha256: createHash("sha256").update(after).digest("hex"),
        bytes: after.byteLength,
        signed: true
      });
      expect(
        parseRemoteRuntimeArtifactManifest(
          JSON.parse(await readFile(manifestPath, "utf8")),
          target
        )
      ).toEqual(manifest);

      const packagedBytes = Buffer.from("packaged-developer-id-signature");
      await chmod(directory, 0o755);
      await chmod(executablePath, 0o755);
      await chmod(manifestPath, 0o644);
      await writeFile(executablePath, packagedBytes);
      await expect(
        refreshSignedRemoteRuntimeArtifactManifest(root, target)
      ).rejects.toThrow(/artifact directory is not private/u);
      const packaged = await refreshSignedRemoteRuntimeArtifactManifest(
        root,
        target,
        { allowPackagedApplicationPermissions: true }
      );
      expect(packaged.manifest.sha256).toBe(
        createHash("sha256").update(packagedBytes).digest("hex")
      );
      expect((await stat(manifestPath)).mode & 0o777).toBe(0o644);

      await expect(
        refreshSignedRemoteRuntimeArtifactManifest(root, "linux-x64-musl")
      ).rejects.toThrow(/not a signed remote-runtime artifact/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps supplemental CI and release artifact checks on four matching architectures", () => {
    const ci = readWorkflow(".github/workflows/ci.yml");
    const release = readWorkflow(".github/workflows/release-desktop.yml");
    expect(ci.jobs["ssh-native-parity"].strategy.matrix.include).toEqual(
      expectedNativeMatrix
    );
    expect(ci.jobs["ssh-native-parity"].env.RUSTUP_TOOLCHAIN).toBe("1.97.0");
    expect(ci.jobs["ssh-integration-linux"].env.RUSTUP_TOOLCHAIN).toBe(
      "1.97.0"
    );
    expect(
      release.jobs["remote-runtime-artifacts"].strategy.matrix.include
    ).toEqual(expectedNativeMatrix);

    for (const packageJobName of ["package-macos", "package-linux"]) {
      const packageJob = release.jobs[packageJobName];
      expect(packageJob.needs).toContain("remote-runtime-artifacts");
      const download = packageJob.steps.find(
        (step) => step.uses === "actions/download-artifact@v8"
      );
      expect(download?.with).toMatchObject({
        pattern: "remote-runtime-*",
        "merge-multiple": true
      });
      const restore = packageJob.steps.find(
        (step) => step.name === "Restore remote runtime artifacts"
      );
      for (const { target } of expectedNativeMatrix) {
        expect(restore?.run).toContain(target);
      }
      expect(
        packageJob.steps.some(
          (step) =>
            step.run ===
            (packageJobName === "package-linux"
              ? "npm run verify:remote:artifacts:cross-host"
              : "npm run verify:remote:artifacts")
        )
      ).toBe(true);
    }

    const artifactJob = release.jobs["remote-runtime-artifacts"];
    expect(artifactJob.env.RUSTUP_TOOLCHAIN).toBe("1.97.0");
    expect(
      artifactJob.steps.find(
        (step) => step.name === "Preserve remote runtime permissions"
      )?.run
    ).toContain("tar -C remote/kmuxd/dist");
    expect(
      artifactJob.steps.find(
        (step) => step.uses === "actions/upload-artifact@v7"
      )?.with?.path
    ).toContain(".tar");
  });
});

function readWorkflow(path) {
  return yaml.load(readFileSync(path, "utf8"));
}

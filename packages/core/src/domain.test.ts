import {
  decodeLocalPath,
  decodeLocatedPathDto,
  decodeRemotePath,
  decodeWorkspaceLocationDto,
  decodeWorkspaceTarget,
  encodeLocatedPathDto,
  encodeWorkspaceLocationDto,
  localLocatedPath,
  remoteLocatedPath,
  validateRemoteTargetBinding
} from "./domain";

describe("remote target authority codecs", () => {
  it("validates and freezes identity, locator, and observation independently", () => {
    const binding = validateRemoteTargetBinding({
      id: "target_1",
      authority: {
        remoteInstallationId: "installation_1",
        executionNodeId: "node_1",
        authenticatedPrincipal: { uid: 1000, accountName: "developer" }
      },
      locator: {
        profileId: "profile_1",
        effectiveConnectionPolicyHash: "a".repeat(64),
        lastVerifiedAt: "2026-07-17T00:00:00.000Z"
      },
      observation: {
        platform: "linux",
        arch: "x64",
        abi: "musl",
        runtimeVersion: "1.0.0",
        capabilities: ["terminal", "sftp"],
        persistenceLevel: "ssh-disconnect"
      },
      sshHostKeyFingerprint: "SHA256:example",
      firstVerifiedAt: "2026-07-17T00:00:00.000Z"
    });

    expect(binding).toMatchObject({
      id: "target_1",
      authority: { authenticatedPrincipal: { uid: 1000 } },
      locator: { profileId: "profile_1" },
      observation: { capabilities: ["terminal", "sftp"] }
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.authority)).toBe(true);
    expect(Object.isFrozen(binding.observation?.capabilities)).toBe(true);
  });

  it("rejects weak policy identity, unsafe principals, and duplicate capabilities", () => {
    const valid = {
      id: "target_1",
      authority: {
        remoteInstallationId: "installation_1",
        executionNodeId: "node_1",
        authenticatedPrincipal: { uid: 1000, accountName: "developer" }
      },
      locator: {
        profileId: "profile_1",
        effectiveConnectionPolicyHash: "a".repeat(64),
        lastVerifiedAt: "2026-07-17T00:00:00.000Z"
      },
      firstVerifiedAt: "2026-07-17T00:00:00.000Z"
    };

    expect(() =>
      validateRemoteTargetBinding({
        ...valid,
        locator: { ...valid.locator, effectiveConnectionPolicyHash: "weak" }
      })
    ).toThrow(/SHA-256/);
    expect(() =>
      validateRemoteTargetBinding({
        ...valid,
        authority: {
          ...valid.authority,
          authenticatedPrincipal: { uid: 1000, accountName: "bad\nname" }
        }
      })
    ).toThrow(/accountName/);
    expect(() =>
      validateRemoteTargetBinding({
        ...valid,
        observation: {
          platform: "linux",
          arch: "x64",
          abi: "musl",
          runtimeVersion: "1",
          capabilities: ["terminal", "terminal"],
          persistenceLevel: "ssh-disconnect"
        }
      })
    ).toThrow(/duplicates/);
    expect(() =>
      validateRemoteTargetBinding({
        ...valid,
        observation: {
          platform: "linux",
          arch: "x64",
          abi: "musl",
          runtimeVersion: "1",
          capabilities: ["terminal"],
          persistenceLevel: "forever"
        }
      })
    ).toThrow(/persistence level/);
    expect(() =>
      validateRemoteTargetBinding({
        ...valid,
        authority: {
          ...valid.authority,
          authenticatedPrincipal: {
            uid: 0x1_0000_0000,
            accountName: "developer"
          }
        }
      })
    ).toThrow(/uid/);
  });

  it("rejects surplus path and target DTO fields at the domain boundary", () => {
    expect(() =>
      decodeLocatedPathDto({ kind: "local", path: "/tmp", targetId: undefined })
    ).toThrow(/unexpected field/);
    expect(() =>
      decodeWorkspaceTarget({ kind: "ssh", targetId: "target_1", path: "/" })
    ).toThrow(/unexpected field/);
    expect(() =>
      decodeWorkspaceLocationDto({
        target: { kind: "ssh", targetId: "target_1" },
        defaultCwd: "/srv/app",
        fallbackCwd: "/tmp"
      })
    ).toThrow(/unexpected field/);
  });

  it("binds remote path capabilities to exactly one SSH target", () => {
    const targetOne = remoteLocatedPath(
      "target_1",
      decodeRemotePath("/srv/one")
    );
    const targetTwo = remoteLocatedPath(
      "target_2",
      decodeRemotePath("/srv/two")
    );

    expect(encodeLocatedPathDto(targetOne)).toEqual({
      kind: "ssh",
      targetId: "target_1",
      path: "/srv/one"
    });
    expect(() => remoteLocatedPath("target_2", targetOne.path)).toThrow(
      /another target/
    );
    expect(() =>
      encodeLocatedPathDto({
        kind: "ssh",
        targetId: "target_1",
        path: targetTwo.path
      })
    ).toThrow(/bound SSH target/);
    expect(() =>
      encodeLocatedPathDto({
        kind: "ssh",
        targetId: "target_1",
        path: decodeRemotePath("/srv/unbound")
      })
    ).toThrow(/bound SSH target/);
  });

  it("rejects path-brand casts at encoding boundaries", () => {
    const local = localLocatedPath(decodeLocalPath("/tmp/local"));
    const remote = remoteLocatedPath(
      "target_1",
      decodeRemotePath("/srv/remote")
    );

    expect(() =>
      encodeLocatedPathDto({ kind: "local", path: remote.path } as never)
    ).toThrow(/LocalPath/);
    expect(() =>
      encodeWorkspaceLocationDto({
        target: { kind: "ssh", targetId: "target_1" },
        defaultCwd: local.path
      } as never)
    ).toThrow(/RemotePath/);
  });
});

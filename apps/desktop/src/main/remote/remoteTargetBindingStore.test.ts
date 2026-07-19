import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RemoteTargetBinding } from "@kmux/core";

import { createRemoteTargetBindingStore } from "./remoteTargetBindingStore";

describe("remote target binding store", () => {
  let sandbox: string;
  let path: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "kmux-target-bindings-"));
    path = join(sandbox, "remote", "target-bindings.json");
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("persists mutable locator observations without permitting identity replacement", () => {
    const first = createRemoteTargetBindingStore(path);
    first.replace(binding());
    first.replace({
      ...binding(),
      locator: {
        profileId: "profile_2",
        effectiveConnectionPolicyHash: "b".repeat(64),
        lastVerifiedAt: "2026-07-17T01:00:00.000Z"
      },
      observation: {
        platform: "linux",
        arch: "x86_64",
        abi: "musl",
        runtimeVersion: "0.2.0",
        capabilities: ["terminal-v1"],
        persistenceLevel: "ssh-disconnect"
      }
    });

    const restored = createRemoteTargetBindingStore(path);
    expect(restored.get("target_1")).toMatchObject({
      id: "target_1",
      locator: { profileId: "profile_2" },
      observation: {
        runtimeVersion: "0.2.0",
        persistenceLevel: "ssh-disconnect"
      }
    });
    expect(() =>
      restored.replace({
        ...binding(),
        authority: {
          ...binding().authority,
          executionNodeId: "node_other"
        }
      })
    ).toThrow(/cannot be replaced/u);
  });
});

function binding(): RemoteTargetBinding {
  return {
    id: "target_1",
    authority: {
      remoteInstallationId: "installation_1",
      executionNodeId: "node_1",
      authenticatedPrincipal: { uid: 1000, accountName: "kmux" }
    },
    locator: {
      profileId: "profile_1",
      effectiveConnectionPolicyHash: "a".repeat(64),
      lastVerifiedAt: "2026-07-17T00:00:00.000Z"
    },
    firstVerifiedAt: "2026-07-17T00:00:00.000Z"
  };
}

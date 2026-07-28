import { describe, expect, it } from "vitest";

import { describeSshConnectionError } from "./sshConnectionError";

describe("SSH connection error presentation", () => {
  it("removes Electron's remote-method wrapper from user-facing errors", () => {
    expect(
      describeSshConnectionError(
        new Error(
          "Error invoking remote method 'kmux:ssh-connections:save': SecureStorageAccessError: kmux cannot use its secure storage folder because it is owned by another user"
        )
      )
    ).toBe(
      "kmux cannot use its secure storage folder because it is owned by another user"
    );
  });

  it("preserves errors that did not come through the SSH IPC bridge", () => {
    expect(describeSshConnectionError(new Error("Connection failed"))).toBe(
      "Connection failed"
    );
  });
});

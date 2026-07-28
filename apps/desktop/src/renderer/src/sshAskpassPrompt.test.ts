import { describe, expect, it } from "vitest";

import { classifySshAskpassPrompt } from "./sshAskpassPrompt";

describe("SSH askpass prompt classification", () => {
  it("recognizes the bounded OpenSSH first-use host authenticity prompt", () => {
    expect(
      classifySshAskpassPrompt(
        [
          "The authenticity of host '192.168.45.117 (192.168.45.117)' can't be established.",
          "ED25519 key fingerprint is: SHA256:UGsgm186h5zmAWGWQIkQhrVufyvy6vF7zso2i+Clx6k",
          "This key is not known by any other names.",
          "Are you sure you want to continue connecting (yes/no/[fingerprint])?"
        ].join("\n")
      )
    ).toBe("host-authenticity");
  });

  it("does not turn credential or incomplete prompts into trust actions", () => {
    expect(classifySshAskpassPrompt("Password for user@example.com:")).toBe(
      "credential"
    );
    expect(
      classifySshAskpassPrompt(
        [
          "The authenticity of host 'example.com' can't be established.",
          "Are you sure you want to continue connecting (yes/no/[fingerprint])?"
        ].join("\n")
      )
    ).toBe("credential");
  });
});

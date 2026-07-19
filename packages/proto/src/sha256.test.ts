import { IncrementalSha256 } from "./sha256";

describe("IncrementalSha256", () => {
  it("matches standard vectors across arbitrary chunk boundaries", () => {
    const encoder = new TextEncoder();
    expect(new IncrementalSha256().digestHex()).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    const bytes = encoder.encode("abc");
    const digest = new IncrementalSha256()
      .update(bytes.subarray(0, 1))
      .update(bytes.subarray(1))
      .digestHex();
    expect(digest).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("hashes data spanning multiple compression blocks", () => {
    const bytes = new TextEncoder().encode("a".repeat(1_000_000));
    const digest = new IncrementalSha256();
    for (let offset = 0; offset < bytes.length; offset += 777) {
      digest.update(bytes.subarray(offset, offset + 777));
    }
    expect(digest.digestHex()).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
    );
  });
});

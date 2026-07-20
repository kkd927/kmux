import { uint64 } from "./uint64";
import {
  decodeRemoteTerminalWireMessage,
  encodeRemoteFrame,
  encodeRemoteTerminalWireMessage,
  RemoteFrameDecoder
} from "./remoteFrames";

describe("remote wire frames", () => {
  it("decodes fragmented and coalesced bounded frames", () => {
    const first = encodeRemoteFrame(1, new TextEncoder().encode("hello"));
    const second = encodeRemoteFrame(
      2,
      encodeRemoteTerminalWireMessage({
        kind: "output",
        sequence: uint64(9n),
        data: new Uint8Array([1, 2, 3])
      })
    );
    const wire = new Uint8Array(first.byteLength + second.byteLength);
    wire.set(first);
    wire.set(second, first.byteLength);
    const decoder = new RemoteFrameDecoder();

    expect(decoder.push(wire.subarray(0, 3))).toEqual([]);
    const frames = decoder.push(wire.subarray(3));
    expect(frames.map((frame) => frame.kind)).toEqual([1, 2]);
    expect(decodeRemoteTerminalWireMessage(frames[1]!.payload)).toEqual({
      kind: "output",
      sequence: 9n,
      data: new Uint8Array([1, 2, 3])
    });
    expect(() => decoder.finish()).not.toThrow();
  });

  it("round-trips binary input, resize, and exit without number coercion", () => {
    const messages = [
      {
        kind: "input" as const,
        writerLeaseId: "lease_1",
        attachmentId: "attachment_1",
        inputSequence: uint64(9_007_199_254_740_993n),
        data: new Uint8Array([0, 255, 10])
      },
      {
        kind: "resize-request" as const,
        writerLeaseId: "lease_1",
        attachmentId: "attachment_1",
        cols: 120,
        rows: 40
      },
      {
        kind: "exit" as const,
        sequence: uint64(18_446_744_073_709_551_615n),
        exitCode: -1
      }
    ];

    for (const message of messages) {
      expect(
        decodeRemoteTerminalWireMessage(
          encodeRemoteTerminalWireMessage(message)
        )
      ).toEqual(message);
    }
  });

  it("fails closed on unknown, oversized, and truncated frames", () => {
    const unknown = new Uint8Array([0, 0, 0, 1, 99]);
    expect(() => new RemoteFrameDecoder().push(unknown)).toThrow(/kind/);
    const oversized = new Uint8Array([0, 16, 0, 1]);
    expect(() => new RemoteFrameDecoder().push(oversized)).toThrow(/length/);
    const decoder = new RemoteFrameDecoder();
    decoder.push(new Uint8Array([0, 0, 0, 2, 1]));
    expect(() => decoder.finish()).toThrow(/truncated/);
  });
});

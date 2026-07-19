import {
  UINT64_MAX,
  formatUint64Decimal,
  incrementUint64,
  parseUint64Decimal,
  uint64,
  uint64FromBytes,
  uint64ToBytes
} from "./uint64";

describe("Uint64", () => {
  it("keeps in-memory values as branded bigint and JSON as canonical decimal", () => {
    const value = uint64(UINT64_MAX);

    expect(typeof value).toBe("bigint");
    expect(formatUint64Decimal(value)).toBe("18446744073709551615");
    expect(parseUint64Decimal("18446744073709551615")).toBe(value);
    expect(() => parseUint64Decimal("01")).toThrow(/canonical/);
    expect(() => parseUint64Decimal(1)).toThrow(/canonical/);
  });

  it("rejects overflow and preserves network byte order", () => {
    expect(() => uint64(-1n)).toThrow(/between/);
    expect(() => uint64(UINT64_MAX + 1n)).toThrow(/between/);
    expect(() => uint64(1 as never)).toThrow(/between/);
    expect(() => incrementUint64(uint64(UINT64_MAX))).toThrow(/between/);

    const value = uint64(0x0102_0304_0506_0708n);
    expect([...uint64ToBytes(value)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(uint64FromBytes(uint64ToBytes(value))).toBe(value);
  });
});

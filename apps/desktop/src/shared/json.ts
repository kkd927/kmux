/** JSON encodes every internal uint64/bigint as a canonical decimal string. */
export function stringifyJson(
  value: unknown,
  space?: string | number
): string {
  return JSON.stringify(
    value,
    (_key, current: unknown) =>
      typeof current === "bigint" ? current.toString(10) : current,
    space
  );
}

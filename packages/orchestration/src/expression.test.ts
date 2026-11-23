import { describe, expect, it } from "vitest";
import { evaluateRestrictedExpression } from "./expression";

const evaluate = (expression: string, values = {}) =>
  evaluateRestrictedExpression({ expressionVersion: 1, expression, values })
    .value;

describe("restricted expression evaluation", () => {
  it.each([
    ["false && inputs.missing", false],
    ["true || inputs.missing", true],
    ["false && (inputs.missing > 1) || true", true],
    ["true || (false && inputs.missing)", true],
    ["true && false || !false", true],
    ["false || true && 2 > 1", true]
  ])(
    "short-circuits %s without resolving unused data",
    (expression, expected) => {
      expect(evaluate(expression as string)).toBe(expected);
    }
  );

  it.each(["true && inputs.missing", "false || inputs.missing"])(
    "still rejects missing data in an evaluated branch: %s",
    (expression) =>
      expect(() => evaluate(expression)).toThrow(/path .* is missing/u)
  );

  it.each(["true || (", "false && (true >)", "true || false missing"])(
    "validates syntax even in skipped branches: %s",
    (expression) =>
      expect(() => evaluate(expression)).toThrow(/restricted expression/u)
  );

  it("enforces nesting and token bounds before short-circuiting", () => {
    expect(() =>
      evaluate(`true || ${"(".repeat(34)}false${")".repeat(34)}`)
    ).toThrow(/nesting is too deep/u);
    expect(() =>
      evaluate(`true || ${Array(130).fill("false").join(" && ")}`)
    ).toThrow(/too many tokens/u);
  });
});

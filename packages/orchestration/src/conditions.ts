import { conditionInputKey } from "./dataflow";
import { selectConditionPort } from "./expression";
import { canonicalJson } from "./canonical";
import {
  OrchestrationError,
  type ConditionNodeDefinition,
  type JsonValue,
  type WorkflowCondition
} from "./types";

/** Ordered, typed branches share the same admitted inputs as every other node. */
export function selectWorkflowConditionPort(input: {
  config: ConditionNodeDefinition["config"];
  inputs: Readonly<Record<string, JsonValue>>;
  values: JsonValue;
}): string {
  if (!input.config.conditions)
    return selectConditionPort({
      expression: input.config.expression,
      ports: input.config.ports,
      values: input.values
    }).port;
  for (const condition of input.config.conditions) {
    const left = input.inputs[conditionInputKey(condition.key, "left")];
    const right = input.inputs[conditionInputKey(condition.key, "right")];
    if (
      left === undefined ||
      (condition.right &&
        !["is_empty", "is_not_empty", "is_true", "is_false"].includes(
          condition.operator
        ) &&
        right === undefined)
    )
      throw new OrchestrationError("invalid", "Condition input is missing");
    if (matchesCondition(condition, left, right)) return condition.key;
  }
  return input.config.ports.at(-1)!;
}

function matchesCondition(
  condition: WorkflowCondition,
  left: JsonValue,
  right?: JsonValue
): boolean {
  const invalid = (): never => {
    throw new OrchestrationError(
      "invalid",
      `Condition operator '${condition.operator}' received incompatible values`
    );
  };
  const empty = (value: JsonValue): boolean =>
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" &&
      value !== null &&
      Object.keys(value).length === 0);
  switch (condition.operator) {
    case "is_empty":
      return empty(left);
    case "is_not_empty":
      return !empty(left);
    case "is_true":
      return typeof left === "boolean" ? left : invalid();
    case "is_false":
      return typeof left === "boolean" ? !left : invalid();
    case "eq":
    case "neq": {
      if (Array.isArray(left) && Array.isArray(right)) {
        const equal = canonicalJson(left) === canonicalJson(right);
        return condition.operator === "eq" ? equal : !equal;
      }
      if (
        (left !== null && typeof left === "object") ||
        (right !== null && typeof right === "object") ||
        typeof left !== typeof right
      )
        return invalid();
      return condition.operator === "eq" ? left === right : left !== right;
    }
    case "contains":
    case "not_contains": {
      if (Array.isArray(left) && Array.isArray(right)) {
        const found = right.every((expected) =>
          left.some((value) => canonicalJson(value) === canonicalJson(expected))
        );
        return condition.operator === "contains" ? found : !found;
      }
      if (typeof left !== "string" || typeof right !== "string")
        return invalid();
      const found = left.includes(right);
      return condition.operator === "contains" ? found : !found;
    }
    case "in":
    case "nin": {
      if (!Array.isArray(right) || typeof left === "object") return invalid();
      const found = right.some((value) => value === left);
      return condition.operator === "in" ? found : !found;
    }
    default: {
      if (
        typeof left !== typeof right ||
        (typeof left !== "number" && typeof left !== "string") ||
        (typeof right !== "number" && typeof right !== "string")
      )
        return invalid();
      if (condition.operator === "gt") return left > right;
      if (condition.operator === "gte") return left >= right;
      if (condition.operator === "lt") return left < right;
      if (condition.operator === "lte") return left <= right;
      return invalid();
    }
  }
}

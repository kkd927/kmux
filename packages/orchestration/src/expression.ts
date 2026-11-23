import { contentHash } from "./canonical";
import {
  OrchestrationError,
  type ContentHash,
  type JsonPrimitive,
  type JsonValue
} from "./types";

export interface ExpressionEvaluationReceipt {
  readonly expressionVersion: 1;
  readonly expression: string;
  readonly inputHash: ContentHash;
  readonly value: JsonPrimitive;
}

type Token =
  | { readonly kind: "literal"; readonly value: JsonPrimitive }
  | { readonly kind: "path"; readonly value: readonly string[] }
  | {
      readonly kind: "operator";
      readonly value:
        | "("
        | ")"
        | "!"
        | "&&"
        | "||"
        | "=="
        | "!="
        | ">"
        | ">="
        | "<"
        | "<=";
    };

type Expression =
  | Extract<Token, { kind: "literal" | "path" }>
  | { readonly kind: "not"; readonly operand: Expression }
  | {
      readonly kind: "binary";
      readonly operator: Extract<Token, { kind: "operator" }>["value"];
      readonly left: Expression;
      readonly right: Expression;
    };

export function evaluateRestrictedExpression(input: {
  expressionVersion: 1;
  expression: string;
  values: JsonValue;
  maxInputBytes?: number;
  maxTokens?: number;
  maxDepth?: number;
}): ExpressionEvaluationReceipt {
  if (input.expressionVersion !== 1) {
    throw new OrchestrationError(
      "unsupported",
      "restricted expression version is unsupported"
    );
  }
  const maxInputBytes = input.maxInputBytes ?? 256 * 1024;
  if (Buffer.byteLength(JSON.stringify(input.values)) > maxInputBytes) {
    throw new OrchestrationError(
      "invalid",
      "restricted expression input exceeds its size bound"
    );
  }
  const tokens = tokenize(input.expression, input.maxTokens ?? 256);
  let cursor = 0;
  let steps = 0;
  const maxSteps = (input.maxTokens ?? 256) * 4;
  const parse = (minimumPrecedence = 0, depth = 0): Expression => {
    if (depth > (input.maxDepth ?? 32)) {
      throw new OrchestrationError(
        "invalid",
        "restricted expression nesting is too deep"
      );
    }
    if (++steps > maxSteps) {
      throw new OrchestrationError(
        "invalid",
        "restricted expression exceeded its execution bound"
      );
    }
    let left: Expression;
    const first = tokens[cursor++];
    if (!first) throw syntax("expected an operand");
    if (first.kind === "literal" || first.kind === "path") {
      left = first;
    } else if (first.kind === "operator" && first.value === "!") {
      left = { kind: "not", operand: parse(7, depth + 1) };
    } else if (first.kind === "operator" && first.value === "(") {
      left = parse(0, depth + 1);
      const close = tokens[cursor++];
      if (close?.kind !== "operator" || close.value !== ")") {
        throw syntax("expected ')'");
      }
    } else {
      throw syntax("expected an operand");
    }

    while (cursor < tokens.length) {
      const operator = tokens[cursor];
      if (operator.kind !== "operator" || operator.value === ")") break;
      const precedence = operatorPrecedence(operator.value);
      if (precedence < minimumPrecedence) break;
      cursor += 1;
      const right = parse(precedence + 1, depth + 1);
      left = { kind: "binary", operator: operator.value, left, right };
    }
    return left;
  };

  const expression = parse();
  if (cursor !== tokens.length) throw syntax("unexpected trailing expression");
  // Parse the entire expression before resolving any data. Short-circuited
  // branches must still obey the syntax and complexity bounds.
  steps = 0;
  const evaluate = (expression: Expression): JsonPrimitive => {
    if (++steps > maxSteps) {
      throw new OrchestrationError(
        "invalid",
        "restricted expression exceeded its execution bound"
      );
    }
    if (expression.kind === "literal") return expression.value;
    if (expression.kind === "path")
      return resolvePath(input.values, expression.value);
    if (expression.kind === "not") return !truthy(evaluate(expression.operand));
    const left = evaluate(expression.left);
    if (expression.operator === "&&" && !truthy(left)) return false;
    if (expression.operator === "||" && truthy(left)) return true;
    return applyOperator(expression.operator, left, evaluate(expression.right));
  };
  const value = evaluate(expression);
  return {
    expressionVersion: 1,
    expression: input.expression,
    inputHash: contentHash(input.values),
    value
  };
}

export function selectConditionPort(input: {
  expression: string;
  values: JsonValue;
  ports: readonly string[];
}): { readonly port: string; readonly receipt: ExpressionEvaluationReceipt } {
  const receipt = evaluateRestrictedExpression({
    expressionVersion: 1,
    expression: input.expression,
    values: input.values
  });
  const port =
    typeof receipt.value === "string" && input.ports.includes(receipt.value)
      ? receipt.value
      : truthy(receipt.value)
        ? input.ports[0]
        : input.ports[1];
  if (!port) {
    throw new OrchestrationError(
      "invalid",
      "Condition result does not resolve to a declared port"
    );
  }
  return { port, receipt };
}

function tokenize(expression: string, maxTokens: number): Token[] {
  if (expression.length === 0 || expression.length > 4_096) {
    throw syntax("expression length is outside the supported bound");
  }
  const tokens: Token[] = [];
  let cursor = 0;
  const push = (token: Token) => {
    tokens.push(token);
    if (tokens.length > maxTokens) {
      throw new OrchestrationError(
        "invalid",
        "restricted expression has too many tokens"
      );
    }
  };
  while (cursor < expression.length) {
    const remainder = expression.slice(cursor);
    const whitespace = /^\s+/u.exec(remainder);
    if (whitespace) {
      cursor += whitespace[0].length;
      continue;
    }
    const operator = /^(>=|<=|==|!=|&&|\|\||[()!<>])/u.exec(remainder);
    if (operator) {
      push({
        kind: "operator",
        value: operator[0] as Extract<Token, { kind: "operator" }>["value"]
      });
      cursor += operator[0].length;
      continue;
    }
    if (remainder[0] === '"' || remainder[0] === "'") {
      const quote = remainder[0];
      let end = 1;
      let escaped = false;
      while (end < remainder.length) {
        if (!escaped && remainder[end] === quote) break;
        escaped = !escaped && remainder[end] === "\\";
        if (remainder[end] !== "\\") escaped = false;
        end += 1;
      }
      if (end >= remainder.length) throw syntax("unterminated string literal");
      const raw = remainder.slice(0, end + 1);
      let value: string;
      try {
        value =
          quote === '"'
            ? JSON.parse(raw)
            : JSON.parse(
                `"${raw.slice(1, -1).replace(/\\'/gu, "'").replace(/"/gu, '\\"')}"`
              );
      } catch {
        throw syntax("invalid string literal");
      }
      push({ kind: "literal", value });
      cursor += raw.length;
      continue;
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      remainder
    );
    if (number) {
      const value = Number(number[0]);
      if (!Number.isFinite(value)) throw syntax("number must be finite");
      push({ kind: "literal", value });
      cursor += number[0].length;
      continue;
    }
    const keyword = /^(true|false|null)\b/u.exec(remainder);
    if (keyword) {
      push({
        kind: "literal",
        value:
          keyword[0] === "true" ? true : keyword[0] === "false" ? false : null
      });
      cursor += keyword[0].length;
      continue;
    }
    const path = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*/u.exec(
      remainder
    );
    if (path) {
      push({ kind: "path", value: path[0].split(".") });
      cursor += path[0].length;
      continue;
    }
    throw syntax(`unsupported token near '${remainder.slice(0, 16)}'`);
  }
  return tokens;
}

function resolvePath(root: JsonValue, path: readonly string[]): JsonPrimitive {
  let value: JsonValue | undefined = root;
  for (const segment of path) {
    if (
      value === null ||
      Array.isArray(value) ||
      typeof value !== "object" ||
      !(segment in value)
    ) {
      throw new OrchestrationError(
        "invalid",
        `restricted expression path '${path.join(".")}' is missing`
      );
    }
    value = value[segment];
  }
  if (value !== null && typeof value === "object") {
    throw new OrchestrationError(
      "invalid",
      "restricted expression operands must be primitive values"
    );
  }
  return value;
}

function operatorPrecedence(
  operator: Extract<Token, { kind: "operator" }>["value"]
): number {
  if (operator === "||") return 1;
  if (operator === "&&") return 2;
  if (operator === "==" || operator === "!=") return 3;
  if ([">", ">=", "<", "<="].includes(operator)) return 4;
  return -1;
}

function applyOperator(
  operator: Extract<Token, { kind: "operator" }>["value"],
  left: JsonPrimitive,
  right: JsonPrimitive
): JsonPrimitive {
  if (operator === "&&") return truthy(left) && truthy(right);
  if (operator === "||") return truthy(left) || truthy(right);
  if (operator === "==") return left === right;
  if (operator === "!=") return left !== right;
  if (typeof left !== typeof right || left === null || right === null) {
    throw syntax(`operator '${operator}' requires comparable operands`);
  }
  if (
    (typeof left !== "number" && typeof left !== "string") ||
    (typeof right !== "number" && typeof right !== "string")
  ) {
    throw syntax(
      `operator '${operator}' supports only number or string operands`
    );
  }
  if (operator === ">") return left > right;
  if (operator === ">=") return left >= right;
  if (operator === "<") return left < right;
  if (operator === "<=") return left <= right;
  throw syntax(`unsupported operator '${operator}'`);
}

function truthy(value: JsonPrimitive): boolean {
  return Boolean(value);
}

function syntax(message: string): OrchestrationError {
  return new OrchestrationError("invalid", `restricted expression: ${message}`);
}

import type {
  AgentBindingDefinition,
  InputMapping,
  WorkflowNodeDefinition
} from "./types";

// Loop entry data has the same waiting/failure contract as required node inputs.
// Keep iteration outputs (carry.next and accumulator) out of admission: they
// resolve only after the body has run. Condition operands are admitted and
// stored with their attempt; Loop entry dependencies are resolved at startup.
export function admissionInputMappings(
  node: WorkflowNodeDefinition,
  bindings: Readonly<Record<string, AgentBindingDefinition>> = {}
): readonly InputMapping[] {
  const mappings = node.inputMappings ?? [];
  if (node.kind === "agent") {
    const binding = bindings[node.config.agentRef];
    const worktree =
      binding?.worktreePolicy === "from-input"
        ? binding.worktreeInput
        : undefined;
    // Placement is owned by the binding, including when older drafts repeat
    // its target on the node. Admit and resolve the same authoritative input.
    return worktree
      ? [
          ...mappings.filter((mapping) => mapping.target !== worktree.target),
          worktree
        ]
      : mappings;
  }
  if (node.kind === "condition" && node.config.conditions) {
    return [
      ...mappings,
      ...node.config.conditions.flatMap((condition): InputMapping[] => [
        {
          target: conditionInputKey(condition.key, "left"),
          source: condition.left,
          required: true,
          missing: "fail"
        },
        ...(condition.right &&
        !["is_empty", "is_not_empty", "is_true", "is_false"].includes(
          condition.operator
        )
          ? [
              {
                target: conditionInputKey(condition.key, "right"),
                source: condition.right,
                required: true,
                missing: "fail"
              } as InputMapping
            ]
          : [])
      ])
    ];
  }
  if (node.kind !== "loop") return mappings;
  const inputs =
    node.config.mode === "for-each"
      ? [{ target: "config.collection", source: node.config.collection }]
      : (node.config.carry ?? []).map((entry) => ({
          target: `config.carry.${entry.inputId}.initial`,
          source: entry.initial
        }));
  return [
    ...mappings,
    ...inputs.map(
      (input): InputMapping => ({
        ...input,
        required: true,
        missing: "fail"
      })
    )
  ];
}

export function loopIterationOutputMappings(
  node: Extract<WorkflowNodeDefinition, { kind: "loop" }>
): readonly InputMapping[] {
  const outputs =
    node.config.mode === "while"
      ? (node.config.carry ?? []).map((entry) => ({
          target: `config.carry.${entry.inputId}.next`,
          source: entry.next
        }))
      : node.config.accumulator
        ? [
            {
              target: "config.accumulator.source",
              source: node.config.accumulator.source
            }
          ]
        : [];
  return [
    ...outputs,
    ...(node.config.loopOutputs ?? []).map((output) => ({
      target: `config.loopOutputs.${output.name}`,
      source: output.source
    }))
  ].map((output) => ({
    ...output,
    required: true,
    missing: "fail"
  }));
}

export function conditionInputKey(key: string, side: "left" | "right"): string {
  return `condition.${key}.${side}`;
}

import type { LoopNodeDefinition } from "@kmux/orchestration";

/** Keep saved outcome names and advanced settings behind the simple action UI. */
export function setLoopExitAction(
  node: LoopNodeDefinition,
  index: number,
  action: "repeat" | "complete"
): LoopNodeDefinition {
  const config = node.config;
  if (config.mode !== "while" || !config.body.exits[index]) return node;
  const completion =
    config.completedOutcomes.find(
      (outcome) => outcome !== config.repeatOutcome
    ) ?? (config.repeatOutcome === "completed" ? "complete" : "completed");
  return {
    ...node,
    config: {
      ...config,
      completedOutcomes: config.completedOutcomes.includes(completion)
        ? config.completedOutcomes
        : [...config.completedOutcomes, completion],
      body: {
        ...config.body,
        exits: config.body.exits.map((exit, ordinal) =>
          ordinal === index
            ? {
                ...exit,
                outcome: action === "repeat" ? config.repeatOutcome : completion
              }
            : exit
        )
      }
    }
  };
}

import { starterWorkflowDefinition } from "../src/editorDocument";
import type {
  AgentBindingDefinition,
  WorkflowDefinitionV1,
  WorkflowNodeDefinition
} from "../src/types";

// Test-only graph for nested scopes, shared bindings, and bounded review loops.
export function nestedReviewWorkflow(): WorkflowDefinitionV1 {
  const binding = (
    inputId: string,
    loopNodeId: string
  ): AgentBindingDefinition => ({
    agent: {
      kind: "run-input",
      inputId,
      requiredCapabilities: ["terminal", "filesystem-write"]
    },
    capabilities: ["terminal", "filesystem-write"],
    scope: { kind: "loop-iteration", loopNodeId },
    authorityMode: "ambient",
    targetPolicy: "local",
    surfacePolicy: "create-or-reuse",
    sessionPolicy: "reuse",
    worktreePolicy: "current",
    inputMode: "orchestrated"
  });
  const agent = (id: string, agentRef: string): WorkflowNodeDefinition => ({
    id,
    kind: "agent",
    title: id,
    joinPolicy: "all-successful",
    config: {
      version: 1,
      agentRef,
      prompt: "Review the current change.",
      lifecycleMode: "managed",
      coding: false
    }
  });
  const shell = (id: string): WorkflowNodeDefinition => ({
    id,
    kind: "shell",
    title: id,
    config: {
      version: 1,
      command: {
        kind: "structured",
        executable: "/usr/bin/printf",
        args: [{ kind: "literal", value: "{}" }]
      },
      targetPolicy: "local",
      surfacePolicy: "create",
      cwdPolicy: "workspace",
      resultMode: "json-stdout",
      maxOutputBytes: 1024
    }
  });
  const edge = (id: string, from: string, to: string, port?: string) => ({
    id,
    from: { nodeId: from, ...(port ? { port } : {}) },
    to: { nodeId: to }
  });
  const base = starterWorkflowDefinition({
    definitionId: "nested-review",
    name: "Nested review"
  });
  return {
    ...base,
    inputs: [
      "authorAgent",
      "regressionReviewerAgent",
      "sideEffectReviewerAgent",
      "testSecurityReviewerAgent"
    ].map((id) => ({
      id,
      required: true,
      schema: { schema: { type: "string" } }
    })),
    agentBindings: {
      author: binding("authorAgent", "items"),
      "reviewer-a": binding("regressionReviewerAgent", "review-rounds"),
      "reviewer-b": binding("sideEffectReviewerAgent", "review-rounds"),
      "reviewer-c": binding("testSecurityReviewerAgent", "review-rounds")
    },
    nodes: [
      base.nodes[0]!,
      shell("load-items"),
      {
        id: "items",
        kind: "loop",
        title: "Items",
        config: {
          version: 1,
          mode: "for-each",
          collection: { kind: "node-result", nodeId: "load-items" },
          itemInputId: "item",
          maxItems: 10,
          concurrency: 1,
          body: {
            nodeIds: [
              "prepare-worktree",
              "analyze-fix",
              "review-rounds",
              "commit-change",
              "finalize"
            ],
            entryNodeIds: ["prepare-worktree"],
            exits: [{ nodeId: "finalize", outcome: "done" }]
          },
          completedPort: "completed",
          maxReachedPort: "completed"
        }
      },
      shell("prepare-worktree"),
      agent("analyze-fix", "author"),
      {
        id: "review-rounds",
        kind: "loop",
        title: "Review rounds",
        config: {
          version: 1,
          mode: "while",
          maxIterations: 3,
          body: {
            nodeIds: [
              "review-regression",
              "review-side-effects",
              "review-test-security",
              "synthesize-fix",
              "review-result"
            ],
            entryNodeIds: [
              "review-regression",
              "review-side-effects",
              "review-test-security"
            ],
            exits: [
              { nodeId: "review-result", port: "clean", outcome: "clean" },
              { nodeId: "review-result", port: "continue", outcome: "continue" }
            ]
          },
          repeatOutcome: "continue",
          completedOutcomes: ["clean"],
          completedPort: "completed",
          maxReachedPort: "limit",
          maxGate: {
            nodeId: "review-limit",
            retryResolution: "retry",
            completedResolutions: [
              { resolution: "accept", port: "completed" },
              { resolution: "skip", port: "completed" }
            ],
            abortResolution: "abort"
          },
          carry: [
            {
              inputId: "previous",
              initial: { kind: "node-result", nodeId: "analyze-fix" },
              next: { kind: "node-result", nodeId: "synthesize-fix" }
            }
          ]
        }
      },
      agent("review-regression", "reviewer-a"),
      agent("review-side-effects", "reviewer-b"),
      agent("review-test-security", "reviewer-c"),
      agent("synthesize-fix", "author"),
      {
        id: "review-result",
        kind: "condition",
        title: "Review result",
        config: {
          version: 1,
          expressionVersion: 1,
          expression: '"clean"',
          ports: ["clean", "continue"]
        }
      },
      {
        id: "review-limit",
        kind: "human-gate",
        title: "Review limit",
        config: {
          version: 1,
          question: "Continue?",
          resolutions: ["retry", "accept", "skip", "abort"],
          approverPolicy: "local-user"
        }
      },
      shell("commit-change"),
      shell("finalize"),
      base.nodes[1]!
    ],
    edges: [
      edge("start-load", "start", "load-items"),
      edge("load-items", "load-items", "items"),
      edge("items-end", "items", "end", "completed"),
      edge("prepare-analyze", "prepare-worktree", "analyze-fix"),
      edge("analyze-review", "analyze-fix", "review-rounds"),
      edge("review-commit", "review-rounds", "commit-change", "completed"),
      edge("commit-finalize", "commit-change", "finalize"),
      ...[
        "review-regression",
        "review-side-effects",
        "review-test-security"
      ].map((id) => edge(id + "-synthesis", id, "synthesize-fix")),
      edge("synthesis-result", "synthesize-fix", "review-result")
    ]
  };
}

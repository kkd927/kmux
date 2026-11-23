import { deepClone } from "./canonical";
import { starterWorkflowDefinition } from "./editorDocument";
import type { WorkflowDefinitionV1 } from "./types";

export const SHELL_TEMPLATE_ID = "shell-command";

const shellTemplate: WorkflowDefinitionV1 = {
  ...starterWorkflowDefinition({
    definitionId: SHELL_TEMPLATE_ID,
    name: "Shell command"
  }),
  description: "Run a local command or script and capture its result.",
  nodes: [
    { id: "start", kind: "start", title: "Start", config: { version: 1 } },
    {
      id: "command",
      kind: "shell",
      title: "Shell command",
      config: {
        version: 1,
        command: {
          kind: "script",
          script: "printf '%s\\n' 'Hello from Workflow'",
          args: []
        },
        targetPolicy: "local",
        surfacePolicy: "create",
        cwdPolicy: "workspace",
        resultMode: "exit-code",
        maxOutputBytes: 65536
      }
    },
    {
      id: "end",
      kind: "end",
      title: "End",
      config: { version: 1 },
      completionRoot: true
    }
  ],
  edges: [
    {
      id: "start-command",
      from: { nodeId: "start" },
      to: { nodeId: "command" }
    },
    { id: "command-end", from: { nodeId: "command" }, to: { nodeId: "end" } }
  ]
};

export interface BuiltInWorkflowTemplateDescriptor {
  readonly templateId: string;
  readonly name: string;
  readonly description: string;
}

export function listBuiltInWorkflowTemplates(): readonly BuiltInWorkflowTemplateDescriptor[] {
  return [
    {
      templateId: SHELL_TEMPLATE_ID,
      name: shellTemplate.name,
      description: shellTemplate.description!
    }
  ];
}

export function builtInWorkflowTemplate(
  templateId: string
): WorkflowDefinitionV1 | undefined {
  return templateId === SHELL_TEMPLATE_ID
    ? deepClone(shellTemplate)
    : undefined;
}

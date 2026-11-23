import type { WorkflowNodeDefinition } from "@kmux/orchestration";

export const workflowNodeIconUrls: Record<
  WorkflowNodeDefinition["kind"] | "coordinator",
  string | undefined
> = {
  agent: new URL("./assets/workflow/icon-llm.jpg", import.meta.url).href,
  shell: new URL("./assets/workflow/icon-script.png", import.meta.url).href,
  condition: new URL("./assets/workflow/icon-condition.svg", import.meta.url)
    .href,
  loop: new URL("./assets/workflow/icon-loop.jpg", import.meta.url).href,
  start: new URL("./assets/workflow/icon-start.jpg", import.meta.url).href,
  end: new URL("./assets/workflow/icon-end.jpg", import.meta.url).href,
  break: new URL("./assets/workflow/icon-break.jpg", import.meta.url).href,
  continue: new URL("./assets/workflow/icon-continue.jpg", import.meta.url)
    .href,
  "human-gate": undefined,
  coordinator: undefined
};

export const workflowInputIconUrl = new URL(
  "./assets/workflow/icon-variable.png",
  import.meta.url
).href;

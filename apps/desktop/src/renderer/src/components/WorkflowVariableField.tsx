import {
  PrivateScopeProvider,
  PlaygroundEntityContext,
  ScopeProvider,
  getNodeScope,
  useClientContext
} from "@flowgram.ai/free-layout-editor";
import {
  VariableSelector,
  type IJsonSchema
} from "@flowgram.ai/form-materials";
import type { DataSource } from "@kmux/orchestration";
import type { ReactNode } from "react";
import {
  sourceToVariablePath,
  variablePathToSource
} from "../workflowVariables";

export function WorkflowFormScope(props: {
  nodeId: string;
  children: ReactNode;
}): JSX.Element | null {
  const context = useClientContext();
  const node = context.document.getNode(props.nodeId);
  if (!node) return null;
  return (
    <PlaygroundEntityContext.Provider value={node}>
      <ScopeProvider scope={getNodeScope(node)}>{props.children}</ScopeProvider>
    </PlaygroundEntityContext.Provider>
  );
}

export function WorkflowVariableField(props: {
  value?: DataSource;
  onChange: (source: DataSource) => void;
  readonly?: boolean;
  arrayOnly?: boolean;
  privateScope?: boolean;
}): JSX.Element {
  const field = (
    <VariableSelector
      value={sourceToVariablePath(props.value)}
      readonly={props.readonly}
      includeSchema={
        props.arrayOnly
          ? ({ type: "array", extra: { weak: true } } as IJsonSchema)
          : undefined
      }
      onChange={(path) => {
        const source = variablePathToSource(path);
        props.onChange(source ?? { kind: "node-result", nodeId: "" });
      }}
      style={{ width: "100%" }}
    />
  );
  return props.privateScope ? (
    <PrivateScopeProvider>{field}</PrivateScopeProvider>
  ) : (
    field
  );
}

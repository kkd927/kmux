import {
  ASTFactory,
  GlobalScope,
  ScopeChainTransformService,
  FlowNodeScopeType,
  getNodePrivateScope,
  getNodeScope,
  useClientContext
} from "@flowgram.ai/free-layout-editor";
import { JsonSchemaUtils } from "@flowgram.ai/form-materials";
import type { FlowEditorDocumentV1 } from "@kmux/orchestration";
import { useEffect } from "react";
import { workflowInputIconUrl } from "../workflowNodeIcons";
import {
  loopLocalSchema,
  nodeOutputSchema,
  LOOP_LOCAL_VARIABLE_PREFIX,
  WORKFLOW_INPUT_VARIABLE
} from "../workflowVariables";

/** Editor variables describe the canonical result contract; they never execute an Agent. */
export function WorkflowVariableBridge(props: {
  document: FlowEditorDocumentV1;
}): null {
  const context = useClientContext();
  useEffect(() => {
    const transform = context.get<ScopeChainTransformService>(
      ScopeChainTransformService
    );
    if (!transform.hasTransformer("kmux-loop-outputs"))
      transform.registerTransformer("kmux-loop-outputs", {
        transformDeps(scopes, { scope }) {
          const node = scope.meta?.node;
          if (
            node?.flowNodeType === "loop" &&
            scope.meta?.type !== FlowNodeScopeType.private
          )
            return [
              getNodePrivateScope(node),
              ...node.blocks.map((block) => getNodeScope(block))
            ];
          return scopes;
        },
        transformCovers(scopes, { scope }) {
          const node = scope.meta?.node;
          return node?.parent?.flowNodeType === "loop"
            ? [...scopes, getNodeScope(node.parent)]
            : scopes;
        }
      });
    const selectorInputs = new Set(
      Object.values(props.document.workflow.agentBindings).flatMap((binding) =>
        binding.agent.kind === "run-input" ? [binding.agent.inputId] : []
      )
    );
    const inputScope = context.get<GlobalScope>(GlobalScope);
    const inputs = props.document.workflow.inputs.filter(
      (input) => !selectorInputs.has(input.id)
    );
    if (inputs.length)
      inputScope.setVar(
        ASTFactory.createVariableDeclaration({
          key: WORKFLOW_INPUT_VARIABLE,
          meta: { title: "Workflow inputs", icon: workflowInputIconUrl },
          type: JsonSchemaUtils.schemaToAST({
            type: "object",
            properties: Object.fromEntries(
              inputs.map((input) => [
                input.id,
                input.schema?.schema ?? { type: "string" }
              ])
            )
          })
        })
      );
    else inputScope.clearVar();
    for (const entry of props.document.nodes) {
      const node = context.document.getNode(entry.id);
      if (!node) continue;
      const outputSchema = nodeOutputSchema(entry.definition, props.document);
      if (
        entry.definition.resultSchema ||
        Object.keys(outputSchema.properties ?? {}).length
      )
        getNodeScope(node).setVar(
          ASTFactory.createVariableDeclaration({
            key: entry.id,
            meta: {
              title: entry.definition.title,
              icon: node.getNodeRegistry().info?.icon
            },
            type: JsonSchemaUtils.schemaToAST(outputSchema)
          })
        );
      else getNodeScope(node).clearVar();
      if (entry.definition.kind === "loop")
        getNodePrivateScope(node).setVar(
          ASTFactory.createVariableDeclaration({
            key: `${LOOP_LOCAL_VARIABLE_PREFIX}${entry.id}`,
            meta: {
              title: entry.definition.title,
              icon: node.getNodeRegistry().info?.icon
            },
            type: JsonSchemaUtils.schemaToAST(
              loopLocalSchema(entry.definition, props.document)
            )
          })
        );
    }
  }, [context, props.document]);
  return null;
}

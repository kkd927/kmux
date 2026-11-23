import type {
  RendererOrchestrationMethod,
  OrchestrationParams,
  OrchestrationResponse
} from "@kmux/orchestration";

export function orchestration<M extends RendererOrchestrationMethod>(
  method: M,
  ...args: Record<string, never> extends OrchestrationParams<M>
    ? [params?: OrchestrationParams<M>]
    : [params: OrchestrationParams<M>]
): Promise<OrchestrationResponse<M>> {
  // Empty commands may omit their argument; validation and defaults remain at IPC.
  const params = (args[0] ?? {}) as OrchestrationParams<M>;
  return window.kmux.orchestration({ method, params });
}

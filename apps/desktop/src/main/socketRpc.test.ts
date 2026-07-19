import { ZodError } from "zod";

import {
  UnknownSocketMethodError,
  parseSocketEnvelope,
  parseSocketRequest
} from "./socketRpc";

describe("socket rpc parsing", () => {
  it("extracts auth tokens from valid envelopes", () => {
    expect(
      parseSocketEnvelope(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "rpc_1",
          method: "surface.send_text",
          params: {
            surfaceId: "surface_1",
            text: "echo hi",
            authToken: "secret"
          }
        })
      )
    ).toEqual({
      id: "rpc_1",
      method: "surface.send_text",
      params: {
        surfaceId: "surface_1",
        text: "echo hi",
        authToken: "secret"
      },
      authToken: "secret"
    });
  });

  it("rejects invalid envelopes before routing", () => {
    expect(() =>
      parseSocketEnvelope(
        JSON.stringify({
          jsonrpc: "1.0",
          method: "system.ping"
        })
      )
    ).toThrow(ZodError);
  });

  it("rejects unknown methods", () => {
    expect(() => parseSocketRequest("workspace.rename", {}, "rpc_2")).toThrow(
      UnknownSocketMethodError
    );
  });

  it("validates method params strictly", () => {
    expect(() =>
      parseSocketRequest(
        "surface.split",
        {
          paneId: "pane_1",
          direction: "sideways"
        },
        "rpc_3"
      )
    ).toThrow(ZodError);

    expect(() =>
      parseSocketRequest(
        "notification.create",
        {
          title: "hello",
          message: "world",
          extra: true
        },
        "rpc_4"
      )
    ).toThrow(ZodError);
  });

  it("uses the remote byte and identifier bounds for terminal controls", () => {
    expect(
      parseSocketRequest(
        "surface.send_text",
        {
          surfaceId: "surface_1",
          text: "안녕",
          operationId: "operation_1"
        },
        "rpc_terminal_input"
      )
    ).toMatchObject({
      method: "surface.send_text",
      params: { text: "안녕", operationId: "operation_1" }
    });

    expect(() =>
      parseSocketRequest("surface.send_text", {
        text: "가".repeat(22_000)
      })
    ).toThrow(ZodError);
    expect(() =>
      parseSocketRequest("surface.send_key", {
        key: "가".repeat(1_400)
      })
    ).toThrow(ZodError);
    expect(() =>
      parseSocketRequest("surface.send_text", {
        text: "ok",
        operationId: "operation\ninvalid"
      })
    ).toThrow(ZodError);
  });

  it("coerces bounded surface capture limits and rejects overflow", () => {
    expect(
      parseSocketRequest(
        "surface.capture",
        {
          surfaceId: "surface_1",
          captureId: "capture_1",
          lines: "400",
          maxBytes: "8192"
        },
        "rpc_capture"
      )
    ).toMatchObject({
      method: "surface.capture",
      params: {
        captureId: "capture_1",
        lines: 400,
        maxBytes: 8192
      }
    });
    expect(() =>
      parseSocketRequest("surface.capture", {
        lines: 65_537,
        maxBytes: 1024
      })
    ).toThrow(ZodError);
    expect(() =>
      parseSocketRequest("surface.capture", {
        lines: 1,
        maxBytes: 1024 * 1024 + 1
      })
    ).toThrow(ZodError);
  });

  it("accepts surface-scoped split params so moved sessions can resolve their current pane", () => {
    expect(
      parseSocketRequest(
        "surface.split",
        {
          surfaceId: "surface_1",
          sessionId: "session_1",
          direction: "right"
        },
        "rpc_surface_split"
      )
    ).toEqual({
      id: "rpc_surface_split",
      method: "surface.split",
      params: {
        surfaceId: "surface_1",
        sessionId: "session_1",
        direction: "right"
      },
      authToken: undefined
    });
  });

  it("returns typed params without transport-only auth fields", () => {
    expect(
      parseSocketRequest(
        "sidebar.set_progress",
        {
          workspaceId: "workspace_1",
          value: "0.5",
          label: "Halfway",
          authToken: "secret"
        },
        "rpc_5",
        "secret"
      )
    ).toEqual({
      id: "rpc_5",
      method: "sidebar.set_progress",
      params: {
        workspaceId: "workspace_1",
        value: 0.5,
        label: "Halfway"
      },
      authToken: "secret"
    });
  });

  it("accepts agent event params for hook-driven input notifications", () => {
    expect(
      parseSocketRequest(
        "agent.event",
        {
          workspaceId: "workspace_1",
          paneId: "pane_1",
          surfaceId: "surface_1",
          sessionId: "session_1",
          agent: "claude",
          event: "needs_input",
          title: "Claude needs input",
          message: "Approve tool use?",
          details: {
            hook_event_name: "Notification"
          }
        },
        "rpc_6"
      )
    ).toEqual({
      id: "rpc_6",
      method: "agent.event",
      params: {
        workspaceId: "workspace_1",
        paneId: "pane_1",
        surfaceId: "surface_1",
        sessionId: "session_1",
        agent: "claude",
        event: "needs_input",
        title: "Claude needs input",
        message: "Approve tool use?",
        details: {
          hook_event_name: "Notification"
        }
      },
      authToken: undefined
    });
  });

  it("accepts raw agent hook params for main-side normalization", () => {
    expect(
      parseSocketRequest(
        "agent.hook",
        {
          workspaceId: "workspace_1",
          surfaceId: "surface_1",
          agent: "codex",
          hookEvent: "Stop",
          payload: {
            message: "Done"
          }
        },
        "rpc_7"
      )
    ).toEqual({
      id: "rpc_7",
      method: "agent.hook",
      params: {
        workspaceId: "workspace_1",
        surfaceId: "surface_1",
        agent: "codex",
        hookEvent: "Stop",
        payload: {
          message: "Done"
        }
      },
      authToken: undefined
    });
  });
});

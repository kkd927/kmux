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
});

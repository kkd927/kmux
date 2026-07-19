import {
  applyAction,
  createInitialState,
  encodeLocatedPathDto,
  type AppAction
} from "@kmux/core";
import { afterEach, vi } from "vitest";

import { createTerminalBridge } from "./terminalBridge";

describe("terminal bridge", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("fails closed instead of sending an SSH session to the local PTY host", async () => {
    const state = createInitialState();
    const existing = new Set(Object.keys(state.workspaces));
    applyAction(state, {
      type: "workspace.create",
      target: { kind: "ssh", targetId: "target_1" },
      cwd: "/srv/app"
    });
    const workspaceId = Object.keys(state.workspaces).find(
      (id) => !existing.has(id)
    )!;
    const pane = state.panes[state.workspaces[workspaceId].activePaneId];
    const surfaceId = pane.activeSurfaceId;
    const sessionId = state.surfaces[surfaceId].sessionId;
    const onSurfaceInputText = vi.fn();
    const ptyHost = {
      sendText: vi.fn(),
      sendKey: vi.fn(),
      snapshot: vi.fn(),
      sessionRef: vi.fn(() => ({ surfaceId, sessionId, epoch: "epoch_local" }))
    };
    const dispatchAppAction = vi.fn();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      onSurfaceInputText
    });

    expect(bridge.surfaceSessionId(surfaceId)).toBeNull();
    expect(() => bridge.sendText(surfaceId, "whoami\n")).toThrow(
      /target provider/
    );
    expect(() => bridge.sendKeyInput(surfaceId, { key: "Enter" })).toThrow(
      /target provider/
    );
    await expect(bridge.snapshotSurface(surfaceId)).rejects.toThrow(
      /target provider/
    );
    bridge.handlePtyEvent({
      type: "spawned",
      sessionId,
      pid: 1234,
      shellInputReady: true
    });
    bridge.handlePtyEvent({
      type: "exit",
      payload: {
        surfaceId,
        sessionId,
        exitCode: 0
      }
    });
    bridge.handlePtyEvent({
      type: "input.observed",
      session: { surfaceId, sessionId, epoch: "epoch_local" },
      input: { type: "text", text: "local leakage" }
    });
    expect(ptyHost.sendText).not.toHaveBeenCalled();
    expect(ptyHost.sendKey).not.toHaveBeenCalled();
    expect(ptyHost.snapshot).not.toHaveBeenCalled();
    expect(onSurfaceInputText).not.toHaveBeenCalled();
    expect(dispatchAppAction).not.toHaveBeenCalled();
  });

  it("routes BEL events to the terminal bell action", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const sessionId = state.surfaces[surfaceId].sessionId;
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null
    });

    bridge.handlePtyEvent({
      type: "bell",
      surfaceId,
      sessionId,
      title: "shell",
      cwd: "/tmp/project"
    });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "terminal.bell"
    });
  });

  it("drops stale BEL events after a surface session changes", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const oldSessionId = state.surfaces[surfaceId].sessionId;
    state.surfaces[surfaceId] = {
      ...state.surfaces[surfaceId],
      sessionId: "session-restarted"
    };
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null
    });

    bridge.handlePtyEvent({
      type: "bell",
      surfaceId,
      sessionId: oldSessionId,
      title: "old shell"
    });

    expect(dispatchAppAction).not.toHaveBeenCalled();
  });

  it("routes spawned shell input readiness into session.started", () => {
    const state = createInitialState();
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null
    });
    const sessionId = Object.values(state.surfaces)[0].sessionId;

    bridge.handlePtyEvent({
      type: "spawned",
      sessionId,
      pid: 1234,
      shellInputReady: false
    });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "session.started",
      sessionId,
      pid: 1234,
      shellInputReady: false
    });
  });

  it("routes shell.ready into session.shellReady", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const sessionId = state.surfaces[surfaceId].sessionId;
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null
    });

    bridge.handlePtyEvent({
      type: "shell.ready",
      surfaceId,
      sessionId
    });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "session.shellReady",
      sessionId
    });
  });

  it("marks every current session exited when the PTY runtime is lost", () => {
    const state = createInitialState();
    const surface = Object.values(state.surfaces)[0];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>((action) => {
      applyAction(state, action);
    });
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null
    });

    bridge.handlePtyEvent({
      type: "runtime.lost",
      sessions: [
        {
          surfaceId: surface.id,
          sessionId: surface.sessionId,
          epoch: "epoch_lost"
        },
        {
          surfaceId: surface.id,
          sessionId: "session_stale",
          epoch: "epoch_stale"
        }
      ]
    });

    expect(dispatchAppAction).toHaveBeenCalledTimes(1);
    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "session.exited",
      sessionId: surface.sessionId
    });
    expect(state.sessions[surface.sessionId].runtimeStatus.processState).toBe(
      "exited"
    );
  });

  it("coalesces frequent title metadata per surface", () => {
    vi.useFakeTimers();
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const dispatchAppAction = vi.fn((action: AppAction) => {
      applyAction(state, action);
    });
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null
    });

    bridge.handlePtyEvent({
      type: "metadata",
      payload: {
        surfaceId,
        sessionId: state.surfaces[surfaceId].sessionId,
        title: "first"
      }
    });
    bridge.handlePtyEvent({
      type: "metadata",
      payload: {
        surfaceId,
        sessionId: state.surfaces[surfaceId].sessionId,
        title: "second"
      }
    });
    bridge.handlePtyEvent({
      type: "metadata",
      payload: {
        surfaceId,
        sessionId: state.surfaces[surfaceId].sessionId,
        title: "third"
      }
    });

    expect(dispatchAppAction).toHaveBeenCalledTimes(1);
    expect(dispatchAppAction).toHaveBeenLastCalledWith({
      type: "surface.metadata",
      surfaceId,
      title: "first"
    });

    vi.advanceTimersByTime(999);
    expect(dispatchAppAction).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(dispatchAppAction).toHaveBeenCalledTimes(2);
    expect(dispatchAppAction).toHaveBeenLastCalledWith({
      type: "surface.metadata",
      surfaceId,
      title: "third"
    });

    bridge.handlePtyEvent({
      type: "metadata",
      payload: {
        surfaceId,
        sessionId: state.surfaces[surfaceId].sessionId,
        title: "third"
      }
    });
    expect(dispatchAppAction).toHaveBeenCalledTimes(2);
  });

  it("drops stale metadata after a surface session changes", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const oldSessionId = state.surfaces[surfaceId].sessionId;
    state.surfaces[surfaceId] = {
      ...state.surfaces[surfaceId],
      sessionId: "session-restarted"
    };
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null
    });

    bridge.handlePtyEvent({
      type: "metadata",
      payload: {
        surfaceId,
        sessionId: oldSessionId,
        cwd: "/tmp/old",
        title: "old title"
      }
    });

    expect(dispatchAppAction).not.toHaveBeenCalled();
  });

  it("drops pending title metadata when the title reverts to the current value", () => {
    vi.useFakeTimers();
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const dispatchAppAction = vi.fn((action: AppAction) => {
      applyAction(state, action);
    });
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null
    });

    bridge.handlePtyEvent({
      type: "metadata",
      payload: {
        surfaceId,
        sessionId: state.surfaces[surfaceId].sessionId,
        title: "first"
      }
    });
    bridge.handlePtyEvent({
      type: "metadata",
      payload: {
        surfaceId,
        sessionId: state.surfaces[surfaceId].sessionId,
        title: "stale"
      }
    });
    bridge.handlePtyEvent({
      type: "metadata",
      payload: {
        surfaceId,
        sessionId: state.surfaces[surfaceId].sessionId,
        title: "first"
      }
    });

    vi.advanceTimersByTime(1000);

    expect(dispatchAppAction).toHaveBeenCalledTimes(1);
    expect(dispatchAppAction).toHaveBeenLastCalledWith({
      type: "surface.metadata",
      surfaceId,
      title: "first"
    });
  });

  it("does not delay non-title metadata while title metadata is pending", () => {
    vi.useFakeTimers();
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const dispatchAppAction = vi.fn((action: AppAction) => {
      applyAction(state, action);
    });
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null
    });

    bridge.handlePtyEvent({
      type: "metadata",
      payload: {
        surfaceId,
        sessionId: state.surfaces[surfaceId].sessionId,
        title: "first"
      }
    });
    bridge.handlePtyEvent({
      type: "metadata",
      payload: {
        surfaceId,
        sessionId: state.surfaces[surfaceId].sessionId,
        title: "pending"
      }
    });
    bridge.handlePtyEvent({
      type: "metadata",
      payload: {
        surfaceId,
        sessionId: state.surfaces[surfaceId].sessionId,
        cwd: "/tmp/kmux"
      }
    });

    expect(dispatchAppAction).toHaveBeenCalledTimes(2);
    expect(dispatchAppAction).toHaveBeenLastCalledWith({
      type: "surface.metadata",
      surfaceId,
      cwd: "/tmp/kmux",
      attention: undefined,
      unreadDelta: undefined
    });

    vi.advanceTimersByTime(1000);
    expect(dispatchAppAction).toHaveBeenCalledTimes(3);
    expect(dispatchAppAction).toHaveBeenLastCalledWith({
      type: "surface.metadata",
      surfaceId,
      title: "pending"
    });
  });

  it("flushes pending title metadata before session exit", () => {
    vi.useFakeTimers();
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const sessionId = state.surfaces[surfaceId].sessionId;
    const dispatchAppAction = vi.fn((action: AppAction) => {
      applyAction(state, action);
    });
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null
    });

    bridge.handlePtyEvent({
      type: "metadata",
      payload: {
        surfaceId,
        sessionId: state.surfaces[surfaceId].sessionId,
        title: "first"
      }
    });
    bridge.handlePtyEvent({
      type: "metadata",
      payload: {
        surfaceId,
        sessionId: state.surfaces[surfaceId].sessionId,
        title: "final"
      }
    });
    bridge.handlePtyEvent({
      type: "exit",
      payload: {
        surfaceId,
        sessionId,
        exitCode: 0
      }
    });

    expect(dispatchAppAction).toHaveBeenNthCalledWith(2, {
      type: "surface.metadata",
      surfaceId,
      title: "final"
    });
    expect(dispatchAppAction).toHaveBeenNthCalledWith(3, {
      type: "session.exited",
      sessionId,
      exitCode: 0
    });

    vi.advanceTimersByTime(1000);
    expect(dispatchAppAction).toHaveBeenCalledTimes(3);
  });

  it("routes terminal notifications into notification.create", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null
    });

    bridge.handlePtyEvent({
      type: "terminal.notification",
      surfaceId,
      sessionId: surface.sessionId,
      protocol: 777
    });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "notification.create",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      title: surface.title,
      message: encodeLocatedPathDto(surface.cwd).path,
      source: "terminal"
    });
  });

  it("drops stale terminal notifications after a surface session changes", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const oldSessionId = state.surfaces[surfaceId].sessionId;
    state.surfaces[surfaceId] = {
      ...state.surfaces[surfaceId],
      sessionId: "session-restarted"
    };
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null,
      getSurfaceVendor: () => "codex"
    } as never);

    bridge.handlePtyEvent({
      type: "terminal.notification",
      surfaceId,
      sessionId: oldSessionId,
      protocol: 9,
      title: "CodexBar",
      message: "Plan mode prompt: stale"
    });

    expect(dispatchAppAction).not.toHaveBeenCalled();
  });

  it("suppresses visible terminal notifications for the active surface", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null,
      isSurfaceVisibleToUser: () => true
    } as never);

    bridge.handlePtyEvent({
      type: "terminal.notification",
      surfaceId,
      sessionId: surface.sessionId,
      protocol: 777,
      title: "osc777 title",
      message: "osc777 body"
    });

    expect(dispatchAppAction).not.toHaveBeenCalled();
  });

  it("promotes Codex input-required terminal notifications into ui-only agent events", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null,
      getSurfaceVendor: () => "codex"
    } as never);

    bridge.handlePtyEvent({
      type: "terminal.notification",
      surfaceId,
      sessionId: surface.sessionId,
      protocol: 9,
      title: "CodexBar",
      message: "Plan mode prompt: Depth"
    });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "needs_input",
      title: "Codex needs input",
      message: "Plan mode prompt: Depth",
      details: expect.objectContaining({
        uiOnly: true,
        source: "terminal",
        protocol: 9
      })
    });
  });

  it("does not promote Codex terminal notifications that only mention approvals or permissions", () => {
    const messages = [
      "GitHub Actions is not permitted to create or approve pull requests",
      "Workflow permissions"
    ];

    for (const message of messages) {
      const state = createInitialState();
      const surfaceId = Object.keys(state.surfaces)[0];
      const surface = state.surfaces[surfaceId];
      const dispatchAppAction = vi.fn<(action: AppAction) => void>();
      const bridge = createTerminalBridge({
        getState: () => state,
        dispatchAppAction,
        getPtyHost: () => null,
        getSurfaceVendor: () => "codex"
      } as never);

      bridge.handlePtyEvent({
        type: "terminal.notification",
        surfaceId,
        sessionId: surface.sessionId,
        protocol: 9,
        title: "CodexBar",
        message
      });

      expect(dispatchAppAction).not.toHaveBeenCalled();
    }
  });

  it("keeps promoting explicit Codex input prompt notifications", () => {
    const messages = [
      "Plan mode prompt: Depth",
      "Needs input",
      "Waiting for input",
      "Enter to submit answer",
      "Question 1/2: Depth unanswered",
      "Question 1/2: Depth. Enter to submit answer"
    ];

    for (const message of messages) {
      const state = createInitialState();
      const surfaceId = Object.keys(state.surfaces)[0];
      const surface = state.surfaces[surfaceId];
      const pane = state.panes[surface.paneId];
      const dispatchAppAction = vi.fn<(action: AppAction) => void>();
      const bridge = createTerminalBridge({
        getState: () => state,
        dispatchAppAction,
        getPtyHost: () => null,
        getSurfaceVendor: () => "codex"
      } as never);

      bridge.handlePtyEvent({
        type: "terminal.notification",
        surfaceId,
        sessionId: surface.sessionId,
        protocol: 9,
        title: "CodexBar",
        message
      });

      expect(dispatchAppAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "agent.event",
          workspaceId: pane.workspaceId,
          paneId: surface.paneId,
          surfaceId,
          sessionId: surface.sessionId,
          agent: "codex",
          event: "needs_input",
          message
        })
      );
    }
  });

  it("does not promote known non-Codex input phrases as Codex attention", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null,
      getSurfaceVendor: () => "claude"
    } as never);

    bridge.handlePtyEvent({
      type: "terminal.notification",
      surfaceId,
      sessionId: surface.sessionId,
      protocol: 9,
      title: "Claude",
      message: "Needs input"
    });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "notification.create",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      title: "Claude",
      message: "Needs input",
      source: "terminal"
    });
    expect(dispatchAppAction).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent.event",
        agent: "codex"
      })
    );
  });

  it("promotes restored Codex input prompts even before vendor binding is known", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null,
      getSurfaceVendor: () => "unknown"
    } as never);

    bridge.handlePtyEvent({
      type: "terminal.notification",
      surfaceId,
      sessionId: surface.sessionId,
      protocol: 9,
      title: "CodexBar",
      message: "Plan mode prompt: Depth"
    });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "needs_input",
      title: "Codex needs input",
      message: "Plan mode prompt: Depth",
      details: expect.objectContaining({
        uiOnly: true,
        source: "terminal",
        protocol: 9,
        inferredFromUnknownVendor: true
      })
    });
  });

  it("keeps unknown generic terminal prompts on the generic notification path", () => {
    const messages = [
      "Permission required",
      "Needs input",
      "Waiting for input"
    ];

    for (const message of messages) {
      const state = createInitialState();
      const surfaceId = Object.keys(state.surfaces)[0];
      const surface = state.surfaces[surfaceId];
      const pane = state.panes[surface.paneId];
      const dispatchAppAction = vi.fn<(action: AppAction) => void>();
      const bridge = createTerminalBridge({
        getState: () => state,
        dispatchAppAction,
        getPtyHost: () => null,
        getSurfaceVendor: () => "unknown"
      } as never);

      bridge.handlePtyEvent({
        type: "terminal.notification",
        surfaceId,
        sessionId: surface.sessionId,
        protocol: 9,
        title: "tool",
        message
      });

      expect(dispatchAppAction).toHaveBeenCalledWith({
        type: "notification.create",
        workspaceId: pane.workspaceId,
        paneId: surface.paneId,
        surfaceId,
        title: "tool",
        message,
        source: "terminal"
      });
      expect(dispatchAppAction).not.toHaveBeenCalledWith(
        expect.objectContaining({
          type: "agent.event",
          agent: "codex"
        })
      );
    }
  });

  it("marks visible Codex input-required terminal notifications as already visible", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null,
      getSurfaceVendor: () => "codex",
      isSurfaceVisibleToUser: () => true
    } as never);

    bridge.handlePtyEvent({
      type: "terminal.notification",
      surfaceId,
      sessionId: surface.sessionId,
      protocol: 9,
      title: "CodexBar",
      message: "Plan mode prompt: Depth"
    });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "needs_input",
      title: "Codex needs input",
      message: "Plan mode prompt: Depth",
      details: expect.objectContaining({
        uiOnly: true,
        visibleToUser: true
      })
    });
  });

  it("suppresses non-attention Codex terminal chatter notifications", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => null,
      getSurfaceVendor: () => "codex"
    } as never);

    bridge.handlePtyEvent({
      type: "terminal.notification",
      surfaceId,
      sessionId: surface.sessionId,
      protocol: 9,
      title: "kmux",
      message: "Hi. What do you need changed in `kmux`?"
    });

    expect(dispatchAppAction).not.toHaveBeenCalled();
  });

  it("forwards settled diagnostic snapshot options to the PTY host", async () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const ptyHost = {
      snapshot: vi.fn().mockResolvedValue(null)
    };
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction: vi.fn<(action: AppAction) => void>(),
      getPtyHost: () => ptyHost as never
    });

    await bridge.snapshotSurface(surfaceId, {
      settleForMs: 300,
      timeoutMs: 5000
    });

    expect(ptyHost.snapshot).toHaveBeenCalledWith(
      surface.sessionId,
      surfaceId,
      {
        settleForMs: 300,
        timeoutMs: 5000
      }
    );
  });

  it("notifies usage runtime listeners when terminal input text is sent", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const onSurfaceInputText = vi.fn();
    const ptyHost = {
      sendText: vi.fn()
    };
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction: vi.fn<(action: AppAction) => void>(),
      getPtyHost: () => ptyHost as never,
      onSurfaceInputText
    });

    bridge.sendText(surfaceId, "codex exec\r");

    expect(onSurfaceInputText).toHaveBeenCalledWith(surfaceId, "codex exec\r");
    expect(ptyHost.sendText).toHaveBeenCalledWith(
      surface.sessionId,
      "codex exec\r"
    );
  });

  it("observes accepted direct-port input only for the current runtime epoch", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const sessionId = state.surfaces[surfaceId].sessionId;
    const onSurfaceInputText = vi.fn();
    const ptyHost = {
      sessionRef: vi.fn(() => ({
        surfaceId,
        sessionId,
        epoch: "epoch_current"
      }))
    };
    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction: vi.fn<(action: AppAction) => void>(),
      getPtyHost: () => ptyHost as never,
      onSurfaceInputText
    });

    bridge.handlePtyEvent({
      type: "input.observed",
      session: { surfaceId, sessionId, epoch: "epoch_stale" },
      input: { type: "text", text: "stale" }
    });
    bridge.handlePtyEvent({
      type: "input.observed",
      session: { surfaceId, sessionId, epoch: "epoch_current" },
      input: { type: "text", text: "accepted" }
    });

    expect(onSurfaceInputText).toHaveBeenCalledOnce();
    expect(onSurfaceInputText).toHaveBeenCalledWith(surfaceId, "accepted");
  });

  it("clears visible Codex needs-input attention when escape text dismisses the prompt", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendText: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "needs_input",
      message: "Plan mode prompt: Depth",
      details: {
        uiOnly: true,
        visibleToUser: true
      }
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendText(surfaceId, "\u001b");

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.attention.clear",
      surfaceId
    });
    expect(ptyHost.sendText).toHaveBeenCalledWith(surface.sessionId, "\u001b");
  });

  it("clears visible Codex needs-input attention when escape key input is sent", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendKey: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "needs_input",
      message: "Plan mode prompt: Depth",
      details: {
        uiOnly: true,
        visibleToUser: true
      }
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendKeyInput(surfaceId, { key: "Escape" });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.attention.clear",
      surfaceId
    });
    expect(ptyHost.sendKey).toHaveBeenCalledWith(surface.sessionId, {
      key: "Escape"
    });
  });

  it("clears visible Claude needs-input attention when escape text dismisses the prompt", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendText: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "claude",
      event: "needs_input",
      message: "Continue? (Yes, No)"
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendText(surfaceId, "\u001b");

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.attention.clear",
      surfaceId
    });
    expect(ptyHost.sendText).toHaveBeenCalledWith(surface.sessionId, "\u001b");
  });

  it("clears visible Claude needs-input attention when escape key input is sent", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendKey: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "claude",
      event: "needs_input",
      message: "Continue? (Yes, No)"
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendKeyInput(surfaceId, { key: "Escape" });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.attention.clear",
      surfaceId
    });
    expect(ptyHost.sendKey).toHaveBeenCalledWith(surface.sessionId, {
      key: "Escape"
    });
  });

  it("does not clear Claude needs-input attention when the surface is not visible", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendText: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "claude",
      event: "needs_input",
      message: "Continue? (Yes, No)"
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => false
    });

    bridge.sendText(surfaceId, "\u001b");

    expect(dispatchAppAction).not.toHaveBeenCalled();
    expect(ptyHost.sendText).toHaveBeenCalledWith(surface.sessionId, "\u001b");
  });

  it("clears visible Codex needs-input attention when Enter text submits the prompt", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendText: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "needs_input",
      message: "Plan mode prompt: Depth",
      details: {
        uiOnly: true,
        visibleToUser: true
      }
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendText(surfaceId, "\r");

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.attention.clear",
      surfaceId
    });
    expect(ptyHost.sendText).toHaveBeenCalledWith(surface.sessionId, "\r");
  });

  it("clears visible Codex needs-input attention when Enter key input submits the prompt", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendKey: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "needs_input",
      message: "Plan mode prompt: Depth",
      details: {
        uiOnly: true,
        visibleToUser: true
      }
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendKeyInput(surfaceId, { key: "Enter" });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.attention.clear",
      surfaceId
    });
    expect(ptyHost.sendKey).toHaveBeenCalledWith(surface.sessionId, {
      key: "Enter"
    });
  });

  it("clears visible Antigravity needs-input attention when Enter submits the prompt", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendKey: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "antigravity",
      event: "needs_input",
      message: "Tool permission requested: WriteFile"
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendKeyInput(surfaceId, { key: "Enter" });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.attention.clear",
      surfaceId
    });
    expect(ptyHost.sendKey).toHaveBeenCalledWith(surface.sessionId, {
      key: "Enter"
    });
  });

  it("clears visible Claude needs-input attention when Enter submits the prompt", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendKey: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "claude",
      event: "needs_input",
      message: "Continue? (Yes, No)"
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendKeyInput(surfaceId, { key: "Enter" });

    expect(dispatchAppAction).toHaveBeenCalledWith({
      type: "agent.attention.clear",
      surfaceId
    });
    expect(ptyHost.sendKey).toHaveBeenCalledWith(surface.sessionId, {
      key: "Enter"
    });
  });

  it("does not clear Codex needs-input on arrow keys (navigation should not submit)", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendKey: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "needs_input",
      message: "Plan mode prompt: Depth",
      details: {
        uiOnly: true,
        visibleToUser: true
      }
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendKeyInput(surfaceId, { key: "ArrowDown" });

    expect(dispatchAppAction).not.toHaveBeenCalled();
  });

  it("does not clear Codex needs-input via submit when the surface is not visible", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendText: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "needs_input",
      message: "Plan mode prompt: Depth",
      details: {
        uiOnly: true,
        visibleToUser: true
      }
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => false
    });

    bridge.sendText(surfaceId, "\r");

    expect(dispatchAppAction).not.toHaveBeenCalled();
  });

  it("does not clear Codex needs-input on multi-char text that merely ends with a newline (paste / programmatic send)", () => {
    const state = createInitialState();
    const surfaceId = Object.keys(state.surfaces)[0];
    const surface = state.surfaces[surfaceId];
    const pane = state.panes[surface.paneId];
    const dispatchAppAction = vi.fn<(action: AppAction) => void>();
    const ptyHost = {
      sendText: vi.fn()
    };

    applyAction(state, {
      type: "agent.event",
      workspaceId: pane.workspaceId,
      paneId: surface.paneId,
      surfaceId,
      sessionId: surface.sessionId,
      agent: "codex",
      event: "needs_input",
      message: "Plan mode prompt: Depth",
      details: {
        uiOnly: true,
        visibleToUser: true
      }
    });

    const bridge = createTerminalBridge({
      getState: () => state,
      dispatchAppAction,
      getPtyHost: () => ptyHost as never,
      isSurfaceVisibleToUser: () => true
    });

    bridge.sendText(surfaceId, "foo\nbar\n");

    expect(dispatchAppAction).not.toHaveBeenCalled();
    expect(ptyHost.sendText).toHaveBeenCalledWith(
      surface.sessionId,
      "foo\nbar\n"
    );
  });
});

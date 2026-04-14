import {
  buildOsc9Notification,
  buildOsc777Notification,
  parseOsc99Notification
} from "./terminalNotifications";

describe("terminal notification parsing", () => {
  it("uses OSC 9 payload as the notification message", () => {
    expect(buildOsc9Notification("finished", "shell")).toEqual({
      protocol: 9,
      title: "shell",
      message: "finished"
    });
  });

  it("parses OSC 777 notify title and body", () => {
    expect(
      buildOsc777Notification("notify;Build complete;All tasks passed", "shell")
    ).toEqual({
      protocol: 777,
      title: "Build complete",
      message: "All tasks passed"
    });
  });

  it("falls back for OSC 777 when title or body is omitted", () => {
    expect(buildOsc777Notification("notify;;", "shell", "/tmp/project")).toEqual(
      {
        protocol: 777,
        title: "shell",
        message: "/tmp/project"
      }
    );
  });

  it("ignores non-notify OSC 777 commands", () => {
    expect(buildOsc777Notification("set-user-var;foo;bar", "shell")).toBeNull();
  });

  it("buffers OSC 99 titles until the body arrives", () => {
    const titleOnly = parseOsc99Notification("d=0;Build complete", {}, "shell");
    expect(titleOnly.notification).toBeUndefined();
    expect(titleOnly.nextState).toEqual({ pendingTitle: "Build complete" });

    const body = parseOsc99Notification(
      "p=body;All tasks passed",
      titleOnly.nextState,
      "shell"
    );
    expect(body.nextState).toEqual({});
    expect(body.notification).toEqual({
      protocol: 99,
      title: "Build complete",
      message: "All tasks passed"
    });
  });

  it("treats standalone OSC 99 payloads as single notifications", () => {
    const parsed = parseOsc99Notification("job finished", {}, "shell");

    expect(parsed.nextState).toEqual({});
    expect(parsed.notification).toEqual({
      protocol: 99,
      title: "shell",
      message: "job finished"
    });
  });

  it("keeps partial OSC 99 title events silent", () => {
    const parsed = parseOsc99Notification("d=0;Build complete", {}, "shell");

    expect(parsed.notification).toBeUndefined();
  });
});

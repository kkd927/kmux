import type { TerminalNotificationProtocol } from "@kmux/proto";

export interface TerminalNotificationEventPayload {
  protocol: TerminalNotificationProtocol;
  title?: string;
  message?: string;
}

export interface Osc99NotificationState {
  pendingTitle?: string;
}

function normalizeText(value?: string): string | undefined {
  const nextValue = value?.trim();
  return nextValue ? nextValue : undefined;
}

function splitOscPayload(data: string): [string, string] {
  const separatorIndex = data.indexOf(";");
  if (separatorIndex < 0) {
    return [data.trim(), ""];
  }
  return [data.slice(0, separatorIndex).trim(), data.slice(separatorIndex + 1)];
}

export function buildOsc9Notification(
  data: string,
  fallbackTitle: string
): TerminalNotificationEventPayload {
  return {
    protocol: 9,
    title: normalizeText(fallbackTitle),
    message: normalizeText(data)
  };
}

export function buildOsc777Notification(
  data: string,
  fallbackTitle: string,
  fallbackMessage?: string
): TerminalNotificationEventPayload | null {
  const [command, ...parts] = data.split(";");
  if (command.trim() !== "notify") {
    return null;
  }

  return {
    protocol: 777,
    title: normalizeText(parts[0]) ?? normalizeText(fallbackTitle),
    message:
      normalizeText(parts.slice(1).join(";")) ?? normalizeText(fallbackMessage)
  };
}

export function parseOsc99Notification(
  data: string,
  state: Osc99NotificationState,
  fallbackTitle: string
): {
  nextState: Osc99NotificationState;
  notification?: TerminalNotificationEventPayload;
} {
  const trimmed = data.trim();
  if (!trimmed) {
    return { nextState: state };
  }

  const [head, tail] = splitOscPayload(data);

  if (head === "d=0") {
    return {
      nextState: {
        pendingTitle: normalizeText(tail)
      }
    };
  }

  if (head === "p=body") {
    const message = normalizeText(tail);
    const title = state.pendingTitle ?? normalizeText(fallbackTitle);
    return {
      nextState: {},
      notification:
        state.pendingTitle || message
          ? {
              protocol: 99,
              title,
              message
            }
          : undefined
    };
  }

  return {
    nextState: {},
    notification: {
      protocol: 99,
      title: normalizeText(fallbackTitle),
      message: normalizeText(trimmed)
    }
  };
}

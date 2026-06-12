import { Notification } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { logDiagnostics } from "../shared/diagnostics";

export interface NativeNotificationIdentity {
  appId?: string;
  appName?: string;
  iconPath?: string;
  startupWmClass?: string;
}

export interface NativeNotificationPayload {
  title: string;
  body: string;
}

export interface NativeNotificationApi {
  isSupported?: () => boolean;
  new (options: Electron.NotificationConstructorOptions): { show(): void };
}

export interface NativeNotificationShowOptions {
  notificationApi?: NativeNotificationApi;
  diagnosticsScope?: string;
  diagnosticsDetails?: Record<string, unknown>;
  onError?: (error: unknown) => void;
}

export function resolveNotificationIconPath(options: {
  currentDir: string;
  resourcesPath?: string;
  exists?: (filePath: string) => boolean;
}): string | undefined {
  const exists = options.exists ?? existsSync;
  const candidates = [
    ...(options.resourcesPath
      ? [join(options.resourcesPath, "notificationIcon.png")]
      : []),
    join(options.currentDir, "../../build/icon.png")
  ];

  return candidates.find((candidate) => exists(candidate));
}

export function createNativeNotificationIdentity(options: {
  appId: string;
  appName: string;
  iconPath?: string;
  startupWmClass?: string;
}): NativeNotificationIdentity {
  return {
    appId: options.appId,
    appName: options.appName,
    ...(options.iconPath ? { iconPath: options.iconPath } : {}),
    ...(options.startupWmClass
      ? { startupWmClass: options.startupWmClass }
      : {})
  };
}

export function createNativeNotificationOptions(
  payload: NativeNotificationPayload,
  identity: NativeNotificationIdentity = {}
): Electron.NotificationConstructorOptions {
  return {
    title: payload.title,
    body: payload.body,
    ...(identity.iconPath ? { icon: identity.iconPath } : {})
  };
}

export function showNativeNotification(
  payload: NativeNotificationPayload,
  identity: NativeNotificationIdentity = {},
  options: NativeNotificationShowOptions = {}
): boolean {
  const notificationApi = options.notificationApi ?? Notification;
  try {
    if (
      typeof notificationApi.isSupported === "function" &&
      !notificationApi.isSupported()
    ) {
      logNativeNotificationFailure(
        payload,
        identity,
        options,
        "native notifications unsupported"
      );
      return false;
    }
    new notificationApi(createNativeNotificationOptions(payload, identity)).show();
    return true;
  } catch (error) {
    reportNativeNotificationError(options, error);
    logNativeNotificationFailure(payload, identity, options, error);
    return false;
  }
}

function reportNativeNotificationError(
  options: NativeNotificationShowOptions,
  error: unknown
): void {
  try {
    options.onError?.(error);
  } catch (handlerError) {
    logDiagnostics("main.native-notification.error-handler.failed", {
      originalError: formatNativeNotificationError(error),
      error: formatNativeNotificationError(handlerError)
    });
  }
}

function logNativeNotificationFailure(
  payload: NativeNotificationPayload,
  identity: NativeNotificationIdentity,
  options: NativeNotificationShowOptions,
  error: unknown
): void {
  logDiagnostics(options.diagnosticsScope ?? "main.native-notification.failed", {
    ...options.diagnosticsDetails,
    title: payload.title,
    bodyLength: payload.body.length,
    ...formatNativeNotificationIdentityDiagnostics(identity),
    error: formatNativeNotificationError(error)
  });
}

function formatNativeNotificationIdentityDiagnostics(
  identity: NativeNotificationIdentity
): Record<string, unknown> {
  return {
    ...(identity.appId ? { appId: identity.appId } : {}),
    ...(identity.appName ? { appName: identity.appName } : {}),
    ...(identity.startupWmClass
      ? { startupWmClass: identity.startupWmClass }
      : {}),
    hasIcon: Boolean(identity.iconPath),
    ...(identity.iconPath ? { iconPath: identity.iconPath } : {})
  };
}

function formatNativeNotificationError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "unknown native notification error";
}

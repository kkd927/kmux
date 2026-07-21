import {
  makeId,
  type SessionLaunchConfig,
  type SurfaceKind
} from "@kmux/proto";
import type { AppEffect, SessionSpawnEffect } from "@kmux/core";

import type { PtyHostManager } from "../ptyHost";
import type { ShellLaunchPolicy } from "../../shared/ptyProtocol";
import type { LocalPathResolver } from "../targets/targetServiceRegistry";

type TerminalRuntimeEffect = Extract<
  AppEffect,
  { type: "session.spawn" | "session.close" }
>;
type MarkdownRuntimeEffect = Extract<
  AppEffect,
  { type: "surface.runtime.close"; kind: "markdown" }
>;

export interface SurfaceRuntimeContext {
  ptyHost: PtyHostManager | null;
  resolveLocalPath: LocalPathResolver;
  createShellLaunchPolicy(launch: SessionLaunchConfig): ShellLaunchPolicy;
  closeMarkdownSurface(surfaceId: string): void;
}

interface SurfaceRuntimeModule<K extends SurfaceKind> {
  readonly kind: K;
}

const terminalSurfaceRuntimeModule: SurfaceRuntimeModule<"terminal"> & {
  runEffect(
    effect: TerminalRuntimeEffect,
    context: SurfaceRuntimeContext
  ): void;
} = {
  kind: "terminal",
  runEffect(effect, context) {
    if (effect.type === "session.close") {
      context.ptyHost?.send({ type: "close", sessionId: effect.sessionId });
      return;
    }
    const launch = localLaunch(effect, context.resolveLocalPath);
    context.ptyHost?.send({
      type: "spawn",
      spec: {
        sessionId: effect.sessionId,
        surfaceId: effect.surfaceId,
        runtimeEpoch: makeId("epoch"),
        workspaceId: effect.workspaceId,
        launch,
        cols: effect.initialSize.cols,
        rows: effect.initialSize.rows,
        env: effect.sessionEnv
      },
      shellLaunchPolicy: context.createShellLaunchPolicy(launch)
    });
  }
};

const markdownSurfaceRuntimeModule: SurfaceRuntimeModule<"markdown"> & {
  runEffect(
    effect: MarkdownRuntimeEffect,
    context: SurfaceRuntimeContext
  ): void;
} = {
  kind: "markdown",
  runEffect(effect, context) {
    context.closeMarkdownSurface(effect.surfaceId);
  }
};

export const surfaceRuntimeRegistry = {
  terminal: terminalSurfaceRuntimeModule,
  markdown: markdownSurfaceRuntimeModule
} satisfies { [K in SurfaceKind]: SurfaceRuntimeModule<K> };

export function dispatchSurfaceRuntimeEffect(
  effect: AppEffect,
  context: SurfaceRuntimeContext
): boolean {
  if (effect.type !== "session.spawn" && effect.type !== "session.close") {
    if (effect.type !== "surface.runtime.close") return false;
    surfaceRuntimeRegistry[effect.kind].runEffect(effect, context);
    return true;
  }
  surfaceRuntimeRegistry.terminal.runEffect(effect, context);
  return true;
}

function localLaunch(
  effect: SessionSpawnEffect,
  resolveLocalPath: LocalPathResolver
): SessionLaunchConfig {
  if (effect.launch.cwd.kind !== "local") {
    throw new Error(
      "SSH session creation must enter RemoteOperationCoordinator"
    );
  }
  return {
    ...effect.launch,
    cwd: resolveLocalPath(effect.launch.cwd),
    args: effect.launch.args ? [...effect.launch.args] : undefined,
    env: effect.launch.env ? { ...effect.launch.env } : undefined
  };
}

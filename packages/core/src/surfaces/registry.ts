import type { SurfaceKind, SurfaceVmContentMap } from "@kmux/proto";

import type { AppEffect, AppState } from "../index";
import type {
  SurfaceContentOf,
  SurfaceInitMap,
  SurfaceState
} from "./contracts";
import { markdownSurfaceCoreModule } from "./markdown";
import { terminalSurfaceCoreModule } from "./terminal";

export interface SurfaceCreateContext {
  state: AppState;
  workspaceId: string;
  paneId: string;
  surfaceId: string;
  createResourceId(): string;
}

export interface SurfaceCreateResult<K extends SurfaceKind> {
  surface: SurfaceState<K>;
  effects: AppEffect[];
}

export interface SurfaceCoreModule<K extends SurfaceKind> {
  readonly kind: K;
  create(
    context: SurfaceCreateContext,
    init: SurfaceInitMap[K]
  ): SurfaceCreateResult<K>;
  close(state: AppState, surface: SurfaceState<K>): AppEffect[];
  encodeContent(content: SurfaceContentOf<K>): Record<string, unknown>;
  decodeContent(value: unknown): SurfaceContentOf<K>;
  buildVmContent(
    state: AppState,
    surface: SurfaceState<K>
  ): SurfaceVmContentMap[K];
}

export type SurfaceCoreRegistry = {
  [K in SurfaceKind]: SurfaceCoreModule<K>;
};

export const surfaceCoreRegistry = {
  terminal: terminalSurfaceCoreModule,
  markdown: markdownSurfaceCoreModule
} satisfies SurfaceCoreRegistry;

export function surfaceCoreModule<K extends SurfaceKind>(
  kind: K
): SurfaceCoreModule<K> {
  return surfaceCoreRegistry[kind] as SurfaceCoreModule<K>;
}

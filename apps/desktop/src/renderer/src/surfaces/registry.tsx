import { lazy, Suspense, type ComponentType } from "react";
import type { KmuxSettings, SurfaceKind, SurfaceVm } from "@kmux/proto";

import { Codicon } from "../components/Codicon";
import type { SurfaceContextMenuContext } from "../../../shared/surfaceContextMenu";
import type { SurfacePaneProps, SurfaceViewProps } from "./contracts";
import { SurfaceRenderErrorBoundary } from "./SurfaceRenderErrorBoundary";
import { TerminalSurfaceView } from "./TerminalSurfaceView";

const LazyMarkdownSurfaceView = lazy(async () => {
  const module = await import("./MarkdownSurfaceView");
  return { default: module.MarkdownSurfaceView };
});

export interface SurfaceViewModule<K extends SurfaceKind> {
  readonly kind: K;
  readonly Component: ComponentType<SurfaceViewProps<K>>;
  readonly Icon: ComponentType;
  readonly retainWhenHidden?: boolean;
  tabTitle(surface: SurfaceVm<K>): string;
  contextMenu?(
    surface: SurfaceVm<K>,
    settings: KmuxSettings
  ): SurfaceContextMenuContext;
}

const TerminalSurfaceAdapter = ({
  surface,
  surfaces,
  visible,
  ...props
}: SurfaceViewProps<"terminal">): JSX.Element => (
  <TerminalSurfaceView
    {...props}
    focused={props.focused && visible}
    surfaces={surfaces}
    activeSurfaceId={surface.id}
  />
);

const MarkdownSurfaceAdapter = (
  props: SurfaceViewProps<"markdown">
): JSX.Element => (
  <SurfaceRenderErrorBoundary
    fallback={
      <div role="alert" style={{ flex: 1, padding: 24 }}>
        Markdown preview could not be loaded.
      </div>
    }
    resetKey={props.surface.id}
  >
    <Suspense
      fallback={
        <div role="status" style={{ flex: 1, padding: 24 }}>
          Loading Markdown preview…
        </div>
      }
    >
      <LazyMarkdownSurfaceView {...props} />
    </Suspense>
  </SurfaceRenderErrorBoundary>
);

const terminalSurfaceViewModule: SurfaceViewModule<"terminal"> = {
  kind: "terminal",
  Component: TerminalSurfaceAdapter,
  Icon: () => <Codicon name="terminal" />,
  retainWhenHidden: true,
  tabTitle: (surface) => surface.content.runtimeMetadata.cwd ?? surface.title,
  contextMenu: (surface, settings) => ({
    canCopy: true,
    canPaste: true,
    canRestart: surface.content.runtimeStatus !== "pending",
    sessionState: surface.content.runtimeStatus,
    settings: { shortcuts: settings.shortcuts }
  })
};

const markdownSurfaceViewModule: SurfaceViewModule<"markdown"> = {
  kind: "markdown",
  Component: MarkdownSurfaceAdapter,
  Icon: () => <Codicon name="markdown" />,
  tabTitle: (surface) => surface.title
};

export const surfaceViewRegistry = {
  terminal: terminalSurfaceViewModule,
  markdown: markdownSurfaceViewModule
} satisfies { [K in SurfaceKind]: SurfaceViewModule<K> };

type ErasedSurfaceViewModule = {
  readonly kind: SurfaceKind;
  readonly Component: ComponentType<SurfaceViewProps<SurfaceKind>>;
  readonly retainWhenHidden?: boolean;
};

export const surfaceViewModules = Object.values(
  surfaceViewRegistry
) as unknown as readonly ErasedSurfaceViewModule[];

export function surfaceTabChrome(
  surface: SurfaceVm,
  settings: KmuxSettings
): {
  Icon: ComponentType;
  title: string;
  contextMenu?: SurfaceContextMenuContext;
} {
  if (surface.content.kind === "terminal") {
    return {
      Icon: terminalSurfaceViewModule.Icon,
      title: terminalSurfaceViewModule.tabTitle(
        surface as SurfaceVm<"terminal">
      ),
      contextMenu: terminalSurfaceViewModule.contextMenu?.(
        surface as SurfaceVm<"terminal">,
        settings
      )
    };
  }
  return {
    Icon: markdownSurfaceViewModule.Icon,
    title: markdownSurfaceViewModule.tabTitle(surface as SurfaceVm<"markdown">)
  };
}

export function surfaceViewProps(
  module: ErasedSurfaceViewModule,
  props: SurfacePaneProps,
  activeSurface: SurfaceVm,
  retainedSurfaceId?: string
): SurfaceViewProps<SurfaceKind> | null {
  const surfaces = props.surfaces.filter(
    (surface) => surface.content.kind === module.kind
  );
  if (surfaces.length === 0) return null;
  const visible = activeSurface.content.kind === module.kind;
  if (!visible && !module.retainWhenHidden) return null;
  const surface = visible
    ? activeSurface
    : (surfaces.find((entry) => entry.id === retainedSurfaceId) ?? surfaces[0]);
  return { ...props, surface, surfaces, visible };
}

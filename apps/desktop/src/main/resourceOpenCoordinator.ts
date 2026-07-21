import {
  locatedPathForTarget,
  terminalSessionForSurface,
  type AppAction,
  type AppState
} from "@kmux/core";
import { decodeTerminalFileLinkActivationDto, type Id } from "@kmux/proto";

import type { TargetServiceRegistry } from "./targets/contracts";
import { canPreviewMarkdownFile, isMarkdownFileName } from "./terminalFileOpen";

const MAX_MARKDOWN_TITLE_LENGTH = 512;

export interface ResourceActivationSender {
  readonly id: number;
}

export interface ResourceOpenCoordinatorOptions {
  getState(): AppState;
  targetServices: TargetServiceRegistry;
  ownsWindow(sender: ResourceActivationSender, windowId: Id): boolean;
  dispatchAppAction(action: AppAction): void;
}

export class ResourceOpenCoordinator {
  constructor(private readonly options: ResourceOpenCoordinatorOptions) {}

  async activateTerminalFileLink(
    sender: ResourceActivationSender,
    value: unknown
  ): Promise<void> {
    const request = decodeTerminalFileLinkActivationDto(value);
    const state = this.options.getState();
    const sourceSurface = state.surfaces[request.sourceSurfaceId];
    const sourcePane = sourceSurface
      ? state.panes[sourceSurface.paneId]
      : undefined;
    const workspace = sourcePane
      ? state.workspaces[sourcePane.workspaceId]
      : undefined;
    const session = terminalSessionForSurface(state, request.sourceSurfaceId);
    if (
      !sourceSurface ||
      sourceSurface.content.kind !== "terminal" ||
      !sourcePane ||
      !workspace ||
      !session ||
      !this.options.ownsWindow(sender, workspace.windowId)
    ) {
      throw new Error("terminal file-link activation is not authorized");
    }

    const target = workspace.location.target;
    const cwd =
      request.baseCwd === undefined
        ? session.runtimeMetadata.cwd
        : locatedPathForTarget(target, request.baseCwd);
    const files = this.options.targetServices.resolveLocated(target).files;
    const resolved = await files.resolveTerminalPath({
      cwd,
      rawPath: request.rawPath
    });
    if (!resolved) {
      throw new Error("terminal file link is not a Markdown preview target");
    }
    const basename = files.basename(resolved.path);
    if (!isMarkdownFileName(basename)) {
      throw new Error("terminal file link is not a Markdown preview target");
    }
    if (!(await canPreviewMarkdownFile({ files, path: resolved.path }))) {
      throw new Error("Markdown preview target is not a bounded regular file");
    }
    const title = boundedMarkdownTitle(basename);

    this.options.dispatchAppAction({
      type: "surface.open",
      workspaceId: workspace.id,
      init: { kind: "markdown", path: resolved.path, title },
      placement: {
        kind: "right-preview",
        sourceSurfaceId: sourceSurface.id
      }
    });
  }
}

function boundedMarkdownTitle(value: string): string {
  const title = value
    .replace(/[\0\r\n]/gu, " ")
    .trim()
    .slice(0, MAX_MARKDOWN_TITLE_LENGTH);
  if (!title) throw new Error("Markdown preview target has no usable title");
  return title;
}

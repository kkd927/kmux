# 0006: Extensible Surface Architecture and Markdown Preview

- Status: Accepted
- Date: 2026-07-21
- Scope: core state/reducer, persistence, Electron main, renderer, and local/SSH file services

## Context

The current kmux Surface model is tightly coupled to terminals.

- SurfaceState directly owns sessionId and terminal runtime metadata.
- surface.create and pane.split always create a Session.
- surface.close and restore assume that every Surface is a terminal.
- SurfaceVm requires terminal-specific fields.
- Every PaneTree leaf renders TerminalPane.
- The main-process effect runner interprets Surface lifecycle as PTY lifecycle.

Adding Markdown, editor, or web Surfaces to this model would scatter kind-specific branches across layout,
the main runtime, the renderer, and persistence.

The first additional Surface is a Markdown preview.

1. A real Markdown file path printed in a Terminal receives the same affordance as the existing file links.
2. It opens with Command-click on macOS and Control-click on other platforms.
3. When the workspace has one pane, kmux splits the source pane to the right and creates the Markdown Surface
   in the new right pane.
4. When the layout already contains a vertical split, kmux creates and activates a Markdown tab in the
   visually rightmost pane.
5. Markdown is rendered with Streamdown and the code, mermaid, math, and cjk plugins.
6. The behavior is identical in local and SSH workspaces.

Existing split buttons and shortcuts must continue to create a Terminal Surface by default. The internal
split primitive, however, must not be coupled to Terminal creation.

## Relationship to existing ADRs

- [ADR 0002](./0002-electron-xterm-mvp-architecture.md) remains authoritative for the
  control/data/view planes and the Terminal MessagePort data plane.
- [ADR 0005](./0005-ssh-remote-workspaces.md) remains authoritative for TargetServiceRegistry and
  local/SSH routing. This ADR also uses that boundary for document reads.
- Terminal output continuity takes priority over this change.

## Decision summary

Adopt the following model.

```text
Pane
  └─ SurfaceState                       common tab/layout state
       └─ content
            ├─ terminal { sessionId } ───────▶ SessionState
            └─ markdown { file source }

Surface kind                 Surface placement request
────────────                 ─────────────────────────
terminal                     tab
markdown          ×          split(left/right/up/down)
                             right-preview
```

The governing principles are:

1. SurfaceState contains only tab and layout state that every implemented kind actually uses.
2. Kind-specific content is the smallest durable descriptor required by that kind. It references a separate
   resource only when that resource has an independent identity or lifecycle.
3. Terminal Session runtime state lives in the existing AppState Session collection. Markdown loading and
   rendering state stays outside AppState.
4. Surface kind and placement are independent axes.
5. Core, main, and renderer each have a compile-time closed registry for their own responsibilities.
6. Shell and layout code call registries instead of branching on kind.
7. Bulk Terminal bytes and document bodies never enter AppState, ShellPatch, or snapshot persistence.

## Non-goals

This ADR does not prebuild the following:

- runtime or third-party Surface plugins
- editor or web Surfaces
- untitled or stream document sources
- a shared Document resource or reference counting across Surfaces
- Markdown tab reuse or deduplication
- generic dirty-buffer recovery
- generic WebContents keep-alive policy

Future editor and web implementations must be addable through the same maps and three registries, but fields
and hooks that have no current use are not introduced in advance.

## State model

### Surface content map

State-side Surface contracts live in packages/core/src/surfaces/contracts.ts because persisted content and
trusted creation input may contain core domain types such as LocatedPath. Proto owns only the shared
SurfaceKind literal union plus wire DTOs and renderer VM contracts. Proto must not import core.

Use the terms content or descriptor rather than payload. Content is the kind-specific durable portion stored
directly in SurfaceState.

```ts
// packages/proto/src/surfaces/contracts.ts
export type SurfaceKind = "terminal" | "markdown";

// packages/core/src/surfaces/contracts.ts
export interface TerminalSurfaceContent {
  kind: "terminal";
  sessionId: Id;
}

export interface MarkdownFileSource {
  kind: "file";
  path: LocatedPath;
}

export interface MarkdownSurfaceContent {
  kind: "markdown";
  source: MarkdownFileSource;
}

export type SurfaceContentMap = {
  terminal: TerminalSurfaceContent;
  markdown: MarkdownSurfaceContent;
};

export type SurfaceContentOf<K extends SurfaceKind = SurfaceKind> =
  SurfaceContentMap[K];

export type SurfaceContent = SurfaceContentOf;
```

SurfaceContentMap preserves the correlation between K and the content, module, and VM types. Registry
dispatch must not repeatedly reconstruct that relationship with Extract-based conditional types.

SurfaceKind and SurfaceContentMap are closed types rather than open interfaces. SurfaceContentOf indexes the
map with SurfaceKind, so adding a literal without its content entry fails to compile. Add a kind only in the
same change that adds its core, main, and renderer implementations and its decoder.

### SurfaceState

SurfaceState contains only state shared by every Surface tab.

```ts
export interface SurfaceState<K extends SurfaceKind = SurfaceKind> {
  id: Id;
  paneId: Id;
  title: string;
  titleLocked: boolean;
  unreadCount: number;
  attention: boolean;
  content: SurfaceContentOf<K>;
}
```

Do not put the following in the common SurfaceState fields:

- cwd, branch, gitRepository, or ports
- Terminal runtimeStatus, pid, exitCode, or shellInputReady
- Markdown body, revision, load status, or renderer cache
- editor dirty state
- web navigation state
- React component or scroll state

Do not introduce a shared SurfaceContext wrapper. Values meaningful to only one kind belong to that kind's
content, resource state, runtime service, or VM content.

### SessionState

SessionState is a Terminal-only resource state. Keep the existing name and the top-level sessions map to
avoid an unnecessary rename and any Terminal data-plane change.

```ts
export interface TerminalRuntimeMetadata {
  cwd: LocatedPath;
  branch?: string;
  gitRepository?: LocatedWorkspaceGitRepositoryMetadata;
  ports: number[];
}

export interface SessionState {
  id: Id;
  surfaceId: Id;
  launch: StoredSessionLaunchConfig;
  agentSessionRef?: AgentSessionRef;
  authToken: string;
  runtimeStatus: SessionRuntimeStatus;
  remoteRuntime?: RemoteSessionRuntimeState;
  shellInputReady: boolean;
  pid?: number;
  exitCode?: number;
  runtimeMetadata: TerminalRuntimeMetadata;
}
```

Terminal Surface and Session remain one-to-one.

- Surface is the tab and layout identity.
- Session is the PTY/SSH process, restore, authentication, and runtime-metadata identity.
- PTY host and remote events continue to resolve Sessions by sessionId.
- Moving or dragging a Surface does not recreate SessionState.

The existing surface.metadata action and bridge protocol may retain their names for compatibility. The
reducer verifies that the target Surface is terminal, resolves content.sessionId, and updates the Session's
runtimeMetadata. Centralize existing surface.cwd call sites through these core helpers:

```ts
terminalSessionForSurface(
  state: AppState,
  surfaceId: Id,
): SessionState | undefined;

terminalRuntimeMetadataForSurface(
  state: AppState,
  surfaceId: Id,
): TerminalRuntimeMetadata | undefined;
```

runtimeMetadata.cwd must target the same workspace target as the Session's Surface.

### Markdown state and runtime ownership

A v1 Markdown Surface stores its verified file source directly in content. It does not allocate another
top-level resource or opaque resource ID. Surface and Markdown file source are one-to-one, and each click
creates a new Surface even when another Surface already references the same path.

The source path must target the same workspace target as the Surface. Validate this invariant during trusted
creation and snapshot decode.

Document text, loading, offline/error state, revisions, watchers, and polling timers are runtime-only. They
travel through DocumentService and the renderer document cache and never enter AppState or ShellPatch.

```ts
export interface AppState {
  // existing collections
  surfaces: Record<Id, SurfaceState>;
  sessions: Record<Id, SessionState>;
}
```

### Surface VM

The renderer VM also separates common tab chrome from kind-specific content.

```ts
export interface SurfaceVmCommon {
  id: Id;
  paneId: Id;
  title: string;
  titleLocked: boolean;
  unreadCount: number;
  attention: boolean;
}

export interface TerminalSurfaceVmContent {
  kind: "terminal";
  sessionId: Id;
  runtimeStatus: SessionRuntimeStatusDto;
  shellInputReady: boolean;
  exitCode?: number;
  runtimeMetadata: TerminalRuntimeMetadataDto;
}

export interface MarkdownSurfaceVmContent {
  kind: "markdown";
}

export type SurfaceVmContentMap = {
  terminal: TerminalSurfaceVmContent;
  markdown: MarkdownSurfaceVmContent;
};

export type SurfaceVm<K extends SurfaceKind = SurfaceKind> = SurfaceVmCommon & {
  content: SurfaceVmContentMap[K];
};
```

Terminal UI that displays cwd, branch, repository, or ports reads them from terminal VM content. Existing
workspace-summary code must read the representative Terminal Session's runtimeMetadata rather than a
representative Surface.

Markdown VM content carries no file path or runtime status. The renderer subscribes with the common
SurfaceVmCommon.id, and Main derives the authorized source from current core state.

## Kind registries

Do not create a cross-process plugin object. Each layer owns a registry containing only its responsibilities.

### Core registry

packages/core/src/surfaces/registry.ts owns state transitions, persistence codecs, and VM projection.

```ts
export interface SurfaceCreateContext {
  state: AppState;
  workspaceId: Id;
  paneId: Id;
  surfaceId: Id;
  createResourceId(): Id;
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
```

The core reducer and kind modules follow the existing in-place mutation style. They never return a
replacement AppState. The common reducer handles pane membership, tab order, focus, and placement. A create
module may mutate only kind-owned resource state and returns the Surface to insert plus effects. Close mutates
kind-owned resource state when applicable and returns effects.

Expand the module contract only when an implemented kind needs additional behavior.

### Main runtime effects

apps/desktop/src/main/appRuntime.ts dispatches all Electron/main runtime effects with one exhaustive switch
over AppEffect.type.

- Terminal effects call the existing PTY host and remote session coordinator.
- Markdown effects remove active DocumentService subscriptions when a Surface disappears.

Preserve existing session.spawn/session.close payloads and execution order. The implementation may keep a
flat AppEffect union or use a kind envelope, but the following contracts are normative:

- An effect contains enough self-contained data to run after its Surface has been removed from state.
- One central appRuntime dispatcher calls the runtime registry.
- Renderer and layout code never call runtime services directly.
- Do not add a generic bulk Surface data channel.

Terminal retains ADR 0002's MessagePort. Markdown uses a separate bounded document event channel.

### Renderer view registry

apps/desktop/src/renderer/src/surfaces/registry.ts owns React views and focus ownership.

```ts
export interface SurfaceViewModule<K extends SurfaceKind> {
  readonly kind: K;
  readonly Component: React.ComponentType<SurfaceViewProps<K>>;
  readonly Icon: React.ComponentType<SurfaceIconProps<K>>;

  ownsChord?(context: SurfaceChordContext<K>, chord: KeyboardChord): boolean;

  requestFocus?(surfaceId: Id): void;
}

export type SurfaceViewRegistry = {
  [K in SurfaceKind]: SurfaceViewModule<K>;
};
```

TypeScript checks registry completeness. The shell does not know xterm textarea classes or Markdown DOM
structure.

### Adding another kind

Add a new kind as one complete, compiling change containing:

1. the shared SurfaceKind literal, core SurfaceContentMap and SurfaceInitMap entries, and the proto
   SurfaceVmContentMap entry
2. a core module and exact persistence decoder
3. a main runtime module and any required data/security boundary
4. a renderer view module and focus/retention policy
5. durable create, close, and restore contracts

If this requires a kind switch in PaneTree, SurfacePane, or the drag protocol, first improve the missing
registry extension point.

## Surface creation and split

### SurfaceInit

SurfaceInit requests creation of a new Surface and any kind-owned resource it requires. It is distinct from
persisted content.

```ts
export interface TerminalSurfaceInit {
  kind: "terminal";
  launch?: SessionLaunchRequest;
}

export interface MarkdownSurfaceInit {
  kind: "markdown";
  path: LocatedPath;
  title: string;
}

export type SurfaceInitMap = {
  terminal: TerminalSurfaceInit;
  markdown: MarkdownSurfaceInit;
};

export type SurfaceInit<K extends SurfaceKind = SurfaceKind> =
  SurfaceInitMap[K];
```

The Markdown create module stores the verified LocatedPath directly in Surface content and uses the bounded
title already derived by Main from FileProvider.basename(path). It creates no Session or other top-level
resource state.

Untrusted renderer and CLI DTOs are separate from SurfaceInit. Only a trusted request that has passed a
decoder and main-process authorization is converted to core SurfaceInit.

### Placement request

```ts
export type SurfacePlacementRequest =
  | {
      kind: "tab";
      paneId: Id;
    }
  | {
      kind: "split";
      paneId: Id;
      direction: SplitDirection;
    }
  | {
      kind: "right-preview";
      sourceSurfaceId: Id;
    };

export interface SurfaceOpenAction {
  type: "surface.open";
  workspaceId: Id;
  init: SurfaceInit;
  placement: SurfacePlacementRequest;
}
```

right-preview is an open-time placement policy, not a persisted layout type. Before mutating state, the
reducer resolves it to an existing pane or a concrete split plan.

surface.open is initially a trusted internal action. Do not expose arbitrary kind or path input through
PUBLIC_RENDERER_ACTION_TYPES.

### Existing behavior compatibility

Normalize existing actions to canonical surface.open requests.

```ts
// Existing surface.create
{
  init: { kind: "terminal", ...existingLaunchFields },
  placement: { kind: "tab", paneId }
}

// Existing pane.split
{
  init: { kind: "terminal", ...existingLaunchFields },
  placement: { kind: "split", paneId, direction }
}
```

Existing buttons, shortcuts, and CLI calls therefore continue to create a Terminal in local and SSH
workspaces.

workspace.create first creates the Workspace and initial pane scaffold, then calls the same internal Terminal
Surface creation path used by surface.open before the reducer transaction completes. It must not retain a
second implementation that directly constructs SurfaceState and SessionState.

| Direction | New pane position | Pane tree axis |
| --------- | ----------------- | -------------- |
| left      | left of source    | vertical       |
| right     | right of source   | vertical       |
| up        | above source      | horizontal     |
| down      | below source      | horizontal     |

### Atomic open

openSurfaceAtPlacement performs the following in one reducer transaction:

1. Validate workspace, pane, and source-Surface identity.
2. Resolve the placement request to a concrete target pane or split plan.
3. When needed, call the layout-only createSplitPaneLeaf.
4. Call the kind module's create method to create Surface, resource, and effects.
5. Add the Surface to the target pane.
6. Update the target pane's activeSurfaceId and the workspace activePaneId.
7. Produce one ShellPatch and persistence schedule.

Never leave behind an intermediate empty pane or temporary Terminal. If any creation step throws, restore the
prior pane tree, pane membership, and newly allocated resources before rethrowing.

Split the current splitPane responsibility as follows:

```ts
createSplitPaneLeaf(
  state: AppState,
  paneId: Id,
  direction: SplitDirection,
): { newPaneId: Id };

openSurfaceAtPlacement(
  state: AppState,
  action: SurfaceOpenAction,
): AppEffect[];
```

moveSurfaceToSplit is not a creation API. It moves an existing Surface ID into a new pane leaf while
preserving its content and kind-owned runtime identity.

## Markdown right-preview placement

A Markdown file click opens trusted MarkdownSurfaceInit with right-preview placement and the source Surface
ID.

The placement algorithm is:

1. If the workspace has one pane, split the source pane to the right.
2. If the workspace has multiple panes but no vertical axis, split the source pane to the right.
3. If any vertical axis exists, use computePaneRects to select the visually rightmost pane.
4. When selecting an existing pane, append the Markdown Surface as its final tab.
5. Activate the target pane and new Markdown Surface so it is immediately visible.

Resolve rightmost ties in this order:

1. greatest x + width
2. greatest vertical overlap with the source pane
3. current active pane
4. earliest pane-tree traversal order

When the source pane is already rightmost, the Markdown tab may be added to that same pane. This directly
implements the product rule to use the rightmost pane when a vertical split exists.

Reuse the existing pane.split ratio, minimum size, and tree-normalization rules.

Every click creates a new Markdown Surface with its own inline file source. This implementation does not
deduplicate tabs or introduce shared document identity.

Initial Markdown Surface values:

- title: the bounded FileProvider.basename(path) supplied in trusted MarkdownSurfaceInit
- titleLocked: false
- unreadCount: 0
- attention: false

Markdown does not increment unreadCount or attention in v1. File changes are observed only while the Surface
is visible, and loading/offline/error presentation is renderer-local.

## Common Surface behavior

### Drag and split move

- Tab reorder and cross-pane drag move only the Surface ID.
- A split drop calls createSplitPaneLeaf and then moves the existing Surface.
- Terminal sessionId and Markdown file source remain unchanged.
- Do not recreate the resource process, file subscription, or renderer cache.

### Close

Common close orchestration first computes the Surfaces to close and the resulting pane/workspace state, then
calls each kind module's close method.

- Terminal close uses the existing Session removal and session.close effect.
- Markdown has no core resource collection to remove. Its close module returns a self-contained runtime
  cleanup effect containing kind and surfaceId; Main uses it to authoritatively cancel any active
  DocumentService subscription. Renderer unsubscribe is not the sole cleanup path.
- close others, pane close, and workspace close use the same path.

Common close code never reads surface.content.sessionId directly.

### Restore

Restore proceeds in this order:

1. Decode or migrate the snapshot.
2. Restore pane tree, tab order, Surfaces and their content, Session resources, and active IDs.
3. Terminal uses the existing respawn/reconnect path.
4. Markdown has no eager core or main restore effect.
5. DocumentService derives the restored file source and reads it when the visible Markdown Surface subscribes.

A missing Markdown file or offline SSH target does not remove the Surface or layout. Display an error or
offline view and allow retry.

### Terminal Session restart

The existing surface.restartSession action name may remain for compatibility, but every authorization and
reducer boundary must verify that the target Surface is terminal before resolving content.sessionId.

Restart keeps the Surface ID and replaces only its Session. When creating the new Session:

- copy the previous Session's runtimeMetadata as last-known cwd, branch, repository, and ports
- preserve the current launch behavior; changing restart cwd semantics is outside this ADR
- reset process-specific fields such as pid, exitCode, runtimeStatus, and shellInputReady
- update Terminal content.sessionId to the new Session ID
- let authoritative metadata from the new process replace the copied runtimeMetadata when it arrives

This preserves existing sidebar metadata and new-Surface cwd inheritance during a behavior-neutral Terminal
refactor. surface.restartSession against Markdown or any future non-Terminal kind is rejected without
mutation or runtime effects.

## Terminal Markdown file activation

### Link detection

Reuse the current terminalFileLinks path parser, wrapped-line handling, cwd marker, and modifier interaction.

A Markdown preview candidate must satisfy:

- the resolved extension is .md or .markdown
- extension matching is case-insensitive
- target FileProvider.stat reports a regular file
- size does not exceed the Markdown read limit

Existing external-open behavior remains unchanged for non-Markdown file links.

- macOS: show underline/pointer while Command is held; activate on Command-click
- other platforms: show underline/pointer while Control is held; activate on Control-click

### Main trust boundary

The renderer sends only the following DTO through kmux:resource:activate-terminal-file-link:

```ts
export interface TerminalFileLinkActivationDto {
  sourceSurfaceId: Id;
  rawPath: string;
  baseCwd?: string;
}
```

ResourceOpenCoordinator revalidates on activation:

1. Decode exact keys and verify that the sender owns the source Surface's window.
2. Confirm that sourceSurfaceId identifies an existing Terminal Surface and resolve its SessionState.
3. Resolve the workspace target and SessionState.runtimeMetadata.cwd.
4. Normalize optional baseCwd only as a LocatedPath for that same target.
5. Resolve rawPath again through the existing target file resolver.
6. Recheck extension, regular-file type, and size, then derive a bounded title with FileProvider.basename.
7. Dispatch internal surface.open with the verified LocatedPath and derived title.

The renderer cannot select a target ID or trusted LocatedPath. A display path returned during hover is never
treated as authorization.

## DocumentService

Electron main owns DocumentService and the exact-decoded kmux:document:subscribe,
kmux:document:unsubscribe, and kmux:document:event channels. It uses the target-bound files facade from
TargetServiceRegistry.

### FileProvider extension

Add stat so existence, type, and size can be checked without reading the whole file.

```ts
export interface FileMetadata {
  kind: "file" | "directory" | "other";
  size: number;
  modifiedAtMs?: number;
}

export interface FileProvider<TPath extends LocalPath | RemotePath> {
  stat(path: TPath): Promise<FileMetadata | null>;
  read(path: TPath, options: { maxBytes: number }): Promise<Uint8Array>;

  // existing path/open methods remain
}
```

- The local provider uses fs.stat and a bounded filesystem read.
- The remote provider uses SFTP stat and a bounded read.
- The TargetServiceRegistry files facade accepts LocatedPath and selects the correct provider.

### Read policy

The initial implementation default is below. It is not part of the persistence schema or Surface
abstraction and may be tuned from measurements.

```ts
export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
```

- Read regular files only.
- Check both stat size and actual byte length.
- Strip a UTF-8 BOM.
- Decode UTF-8 in fatal mode and show an explicit error for invalid input.
- Send only decoded text, original byteLength, and revision to the renderer.

DocumentService sends all Markdown runtime state through one bounded channel.

```ts
export type MarkdownDocumentErrorCode =
  | "missing"
  | "too-large"
  | "invalid-encoding"
  | "read-failed";

export type MarkdownDocumentEvent =
  | { type: "loading"; surfaceId: Id; revision: number }
  | {
      type: "snapshot";
      surfaceId: Id;
      revision: number;
      text: string;
      byteLength: number;
    }
  | { type: "offline"; surfaceId: Id; revision: number }
  | {
      type: "error";
      surfaceId: Id;
      revision: number;
      errorCode: MarkdownDocumentErrorCode;
    };
```

The body and these runtime events never enter AppState, ShellPatch, or persisted snapshots. Snapshot text is
bounded by MAX_MARKDOWN_BYTES, and every event variant has an exact channel decoder.

### Subscription and updates

The renderer subscribes with the surfaceId of a visible Markdown Surface.

- Main resolves kind, content.source.path, workspace, and target directly from current state.
- Main verifies that the sender webContents owns the Surface's window.
- Renderer never receives filesystem/SFTP access, credentials, or target-selection authority.
- Duplicate subscribe is idempotent.
- Hidden or closed Surfaces unsubscribe.
- Surface removal authoritatively cancels its active subscription in Main even if renderer unsubscribe is
  delayed or never arrives.
- Destroying webContents cleans up every subscription owned by that sender.
- Every event is keyed by surfaceId and a monotonically increasing revision. DocumentService drops stale
  asynchronous read completions, and the renderer ignores an event whose revision is not newer than the last
  accepted event for that Surface.
- ShellPatch carries no Markdown loading, revision, offline, or error state, so there is no cross-channel
  ordering contract.

For local files, debounce fs.watch events briefly and reread the current snapshot. A low-cost stat
reconciliation may cover rename and missed-event cases.

SSH v1 uses SFTP stat polling while a visible subscription exists.

- The initial polling interval is one second.
- Metadata changes trigger a bounded read.
- Periodic bounded reconciliation prevents coarse mtime resolution from permanently missing a change.
- Hidden or closed Surfaces do not poll.
- Transient failures back off and mark the document offline.
- Reconnection triggers an immediate retry.

If a previous successful snapshot exists when the target goes offline, retain the body and show an offline
banner. If the first read fails or the file is missing, too large, or invalid UTF-8, show an error view.

Do not stage SSH Markdown into a local temporary file because that breaks remote update and restore identity.
stageForLocalOpen remains exclusive to the existing external-open path.

### Target routing

Route Surface runtime by both kind and workspace target.

| Surface kind | Local workspace    | SSH workspace              |
| ------------ | ------------------ | -------------------------- |
| terminal     | local PTY host     | remote session coordinator |
| markdown     | local FileProvider | remote FileProvider/SFTP   |

An SSH workspace alone does not route Markdown surface.open into remote Session lifecycle. A Markdown
Surface is not a kmuxd Session entity.

## Renderer structure

Separate the common SurfacePane shell from the Terminal and Markdown view modules currently combined in
TerminalPane.

PaneTree leaves render SurfacePane.

SurfacePane owns:

- the tab strip and active Surface
- drag/drop and split-drop targets
- common header/chrome
- focus handoff
- active-view registry dispatch

TerminalSurfaceView retains the existing xterm lifecycle, stream router, warm-widget LRU, and attach/detach
ordering. Phase 1 moves this code without redesigning it.

MarkdownSurfaceView subscribes and renders only while visible. It owns text, revision, loading, offline,
error, and scroll state in a renderer-local cache keyed by surfaceId. Preserve the last successful body while
showing an offline banner and preserve scroll position.

Workspace, pane, and Surface shortcuts continue to work while focus is inside the Markdown viewport. Escape
returns focus to the SurfacePane shell.

## Streamdown renderer

MarkdownSurfaceView uses [Streamdown](https://github.com/vercel/streamdown).

Add these apps/desktop runtime dependencies:

- streamdown
- @streamdown/code
- @streamdown/mermaid
- @streamdown/math
- @streamdown/cjk
- katex
- rehype-harden

Configure plugins as follows:

```tsx
const plugins = {
  code,
  mermaid,
  math,
  cjk
};

<Streamdown
  plugins={plugins}
  skipHtml
  parseIncompleteMarkdown={isUpdating}
  isAnimating={isUpdating}
  rehypePlugins={[
    defaultRehypePlugins.sanitize,
    [
      harden,
      {
        allowedProtocols: ["http", "https", "mailto"],
        allowedLinkPrefixes: ["*"],
        allowedImagePrefixes: [],
        allowDataImages: false
      }
    ]
  ]}
  mermaid={{
    config: {
      startOnLoad: false,
      securityLevel: "strict"
    }
  }}
>
  {markdown}
</Streamdown>;
```

### Bundle and rendering isolation

- Dynamically import MarkdownSurfaceView and its plugins.
- Do not statically include Streamdown, Shiki, or Mermaid in the Terminal renderer startup path.
- Render only visible Markdown Surfaces.
- Coalesce file updates to avoid unnecessary repeated parsing.
- Isolate render failures in the affected Surface's error boundary.
- Never synchronously run Markdown parsing or rendering from a Terminal MessagePort callback.

Profile opening Markdown, code, and Mermaid beside a high-output Terminal. If main-thread stalls violate the
product requirement, add parsing/highlighting isolation as a separate measured change.

### CSS isolation

Apply the Tailwind v4 source scan required by Streamdown only to a Markdown-specific CSS entry; global
Tailwind or preflight could change xterm and existing UI styles.

- Do not import preflight.
- Include Streamdown core and all four plugin dist directories in @source.
- Import streamdown/styles.css and katex/dist/katex.min.css from the Markdown entry.
- Scope Markdown selectors beneath .kmuxMarkdownSurface.
- Map Streamdown tokens to kmux theme CSS variables.
- Apply KaTeX styles only inside the Markdown scope.

Do not change global xterm font, line-height, selection, textarea, or canvas styles.

### Link and image policy

- Do not render raw HTML.
- Reject javascript, file, and data protocols.
- Block remote and data images in v1.
- Route http, https, and mailto links through the existing safe external-open path.
- Resolve fragment-only links only within the current Markdown document.
- If relative .md/.markdown links are supported, revalidate them in main relative to the source document
  directory and apply the same Markdown-open policy.
- Never navigate the renderer location directly.

Upstream references:

- [Streamdown security](https://streamdown.ai/docs/security)
- [code plugin](https://streamdown.ai/docs/plugins/code)
- [Mermaid plugin](https://streamdown.ai/docs/plugins/mermaid)
- [math plugin](https://streamdown.ai/docs/plugins/math)
- [CJK plugin](https://streamdown.ai/docs/plugins/cjk)

## Persistence and migration

Increase SNAPSHOT_STORE_VERSION in packages/persistence/src/index.ts from 2 to 3.

- The reader explicitly accepts version 3 and migrates versions 1 and 2 as legacy Terminal snapshots.
- The writer emits only version 3.

### Persisted data

Persist:

- common SurfaceState and its content descriptor
- Session descriptor and runtime restore state
- Session runtimeMetadata: cwd, branch, gitRepository, and ports
- Markdown file source inline in Markdown Surface content
- pane tree, tab order, and active pane/Surface IDs

Do not persist:

- document body
- document revision, load, or error runtime state
- watchers, subscriptions, or polling timers
- renderer scroll, DOM, or plugin state
- live Terminal transport or MessagePort

### Legacy Surface migration

```ts
surface.content = {
  kind: "terminal",
  sessionId: legacySurface.sessionId
};

session.runtimeMetadata = {
  cwd: legacySurface.cwd,
  branch: legacySurface.branch,
  gitRepository: legacySurface.gitRepository,
  ports: legacySurface.ports
};
```

After exact legacy decode, remove sessionId and Terminal metadata from the Surface. Migration preserves
existing Surface, pane, and Session IDs, tab order, and active IDs. No documents collection is introduced.

### Incompatible snapshot policy

Do not silently fall back to Terminal, drop only the offending Surface, or reinterpret malformed content.
Preserve kind-specific exact decoders and existing collection/string limits.

Snapshot loading distinguishes missing state from incompatible state. An unsupported envelope version,
unknown Surface kind, malformed kind content, or invalid cross-reference rejects the entire snapshot and
reports an incompatible result rather than null/missing.

When startup receives an incompatible result:

1. leave the original snapshot bytes at statePath untouched
2. start a clean recovery state with a visible incompatibility notification
3. disable automatic and shutdown snapshot writes for that run so the incompatible file cannot be overwritten
4. keep replacement or archival outside automatic startup and persistence behavior; any reset flow must be an
   explicit user action that preserves or archives the original first

This policy must land with the version-3 reader. It protects forward-version and unknown-kind snapshots from
the current load-null-then-save behavior. Silently dropping one Surface is not allowed because it can leave
pane membership and active IDs inconsistent and can convert a recoverable snapshot into permanent data loss.

## Current-code change map

| Area                                                                                     | Required change                                                                                                                          |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| packages/core/src/{index.ts,surfaces/\*}                                                 | Add state-side maps and registries; canonicalize create/split/close/workspace.create; guard restart/metadata; project VMs and decode v3. |
| packages/proto/src/surfaces/contracts.ts + packages/persistence/src/index.ts             | Own kind/wire/VM contracts; add v1/v2 migration, v3 writing, and the incompatible-load result.                                           |
| apps/desktop/src/main/{appRuntime.ts,surfaces/\*,documentService.ts}                     | Dispatch kind runtimes and add the bounded surface-keyed Markdown event service.                                                         |
| apps/desktop/src/main/{metadataRuntime,usageRuntime,worktreeRuntime}.ts + main/remote/\* | Use Terminal metadata helpers and route/authorize Session operations only for Terminal.                                                  |
| apps/desktop/src/main/{targets/\*,terminalFileOpen.ts}                                   | Add local/SSH stat, bounded read/watch/poll, and ResourceOpenCoordinator validation.                                                     |
| apps/desktop/src/renderer/src/{components,terminalFileLinks,surfaces}                    | Extract SurfacePane/TerminalSurfaceView and add Markdown activation/view registry.                                                       |
| apps/desktop/package.json + electron.vite.config.ts                                      | Add Streamdown plugins and scoped CSS build.                                                                                             |

Re-export new files from package entries while progressively reducing the monolithic index.ts files.

## Implementation phases

### Phase 1: Terminal-only structural refactor

1. Add the terminal-only maps/registries, minimal SurfaceState, SurfacePane, and TerminalSurfaceView.
2. Move Terminal metadata into SessionState and route metadata, remote lifecycle, and restart through Terminal
   guards/helpers.
3. Extract the layout-only split helper and canonicalize surface.create, pane.split, and workspace.create.
4. Add snapshot v3 migration and the incompatible-snapshot write guard.

Exit criteria:

- Existing local/SSH Surface behavior, PTY MessagePort, and warm-widget behavior are unchanged.
- Migration preserves IDs, and restart preserves metadata until the new process reports it.
- Incompatible snapshots remain untouched and cannot be overwritten automatically.

### Phase 2: Markdown document runtime

1. Add Markdown content/init/VM map entries, exact decoder, core/main modules, and a minimal renderer placeholder
   entry in the same compiling change.
2. Add local and SSH implementations of FileProvider.stat.
3. Add bounded DocumentService and the surface-keyed document event channel.
4. Add local watch and visible-only SSH polling.
5. Connect authoritative close cleanup, offline, retry, and restored-Surface subscription behavior.

### Phase 3: Markdown activation and placement

1. Add ResourceOpenCoordinator.
2. Connect Terminal Markdown candidate validation and click activation.
3. Add right-preview placement policy to the core reducer.
4. Connect one-pane, horizontal-only, and existing-vertical layouts.

### Phase 4: Streamdown renderer

1. Replace the Phase 2 placeholder with the lazy Streamdown MarkdownSurfaceView.
2. Connect code, Mermaid, math, and CJK plugins.
3. Add scoped Tailwind and KaTeX styles.
4. Apply hardening and safe-link policy.
5. Implement loading, offline, error, and scroll behavior.

## Verification

Following AGENTS.md, automate only durable behavior.

### Core and persistence

- A v1/v2 Surface migrates to v3 terminal content and Session runtimeMetadata.
- Surface, pane, and Session IDs and tab order are preserved.
- Existing pane.split creates a Terminal Surface and Session locally and over SSH.
- workspace.create uses the same Terminal creation path and still creates exactly one Surface and Session.
- surface.restartSession rejects non-Terminal Surfaces and preserves last-known runtimeMetadata for Terminal.
- Markdown split/open creates neither a Session nor a remote Session operation.
- Surface content remains stable after drag or split move; Terminal sessionId is unchanged.
- Closing a pane or workspace cleans up Terminal resources and Markdown subscriptions exactly once.
- Unsupported versions and unknown kinds reject the whole snapshot without overwriting the original file.

### Placement

- One pane splits the source to the right.
- A horizontal-only layout splits the source to the right.
- An existing vertical layout uses the geometrically rightmost pane.
- Rightmost tie-breaking is deterministic.
- The target pane and Markdown Surface become active and visible.

### Main, document, and SSH

- Local/SSH stat validates file type and size.
- .md/.markdown detection is case-insensitive.
- Directory, missing, oversized, and invalid UTF-8 inputs are rejected.
- Activation resolves again from the source Terminal target and cwd.
- Renderer cannot inject another target or trusted path.
- Hidden or closed Markdown Surfaces do not watch or poll.
- Surface removal stops Main-owned subscriptions even when renderer unsubscribe is absent.
- Out-of-order document reads and events cannot replace a newer renderer snapshot or status.
- SSH disconnect/reconnect preserves the same Surface.

### Security

- Raw HTML and unsafe protocols cannot execute.
- Remote and data images are blocked by default.
- The document IPC size bound is enforced.
- Relative and external links never navigate the renderer directly.

### Terminal continuity

- Opening Markdown beside a running Terminal preserves its Session and stream attachment.
- SurfacePane extraction does not lose or duplicate output buffers during switch, split, or restore.
- Hidden-Terminal retention and attach/detach ordering remain unchanged.
- Global pane/Surface shortcuts work while Markdown has focus.

Verify Streamdown theme, Mermaid layout, KaTeX baseline, and CJK wrapping visually. Do not add pixel-level
tests.

## Consequences

- New kinds reuse layout behavior while keeping kind-specific state and data planes isolated behind the three
  registries.
- Local and SSH Markdown share the file-service contract without entering Terminal Session lifecycle.
- Costs are the v3 migration, three registries, DocumentService/SSH polling, and the Streamdown/CSS bundle.
- An incompatible snapshot makes persistence read-only for that run to protect the original file.

## Rejected alternatives

### SurfaceContext on every Surface

cwd, branch, repository, and ports are Terminal runtime metadata. Putting them on every Surface creates
meaningless fields and permits invalid target/path combinations, so they move to SessionState.

### Nesting SessionState inside Terminal content

PTY/SSH events, restore, and the data plane operate by sessionId. Nesting requires rebuilding a sessionId
lookup index and couples layout updates to runtime updates. Surface content stores only a sessionId reference.

### Scattered switches or runtime plugins

Scattered kind switches create omission risk, while runtime plugins conflict with the current decoder and
security model. Use compile-time closed registries in each layer.

### Terminal-specific or two-step split creation

Coupling pane creation to Session creation forces alternate paths; exposing split then create separately also
permits empty panes, temporary Terminals, and persistence races. Keep layout creation generic and surface.open
atomic.

### Document body in AppState or ShellPatch

Large text would pass through reducer cloning, persistence, and control-plane patching and interfere with
Terminal workflows. Use a bounded document channel.

### Prebuilding future document/editor abstractions

A top-level DocumentState for v1 Markdown would add an internal ID, collection codec, reference-integrity
checks, and lifecycle bookkeeping without an independent runtime identity or sharing requirement. Store the
file source in Markdown content. Add a Document resource, untitled/stream sources, reference counting, and
dirty recovery only when an actual editor, shared-buffer, or stream requirement defines their lifecycle.

## Completion

Implementation is complete when the verification contracts above pass, including the Terminal continuity
gate.

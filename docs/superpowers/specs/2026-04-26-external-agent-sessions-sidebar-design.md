# External Agent Sessions Sidebar Design

Date: 2026-04-26

## Goal

Add a `Sessions` tab beside the existing right-sidebar `Usage` view so kmux can show local AI-agent session history from Codex, Gemini, and Claude, then resume a selected session inside kmux.

The Sessions view should feel like a compact VS Code-style recent-session list:

- newest sessions first across all supported vendors
- a vendor pill on the left of each title
- a short title or summary
- relative time on the right
- paged loading through a bottom "more" control

## Scope

In scope:

- Show all discoverable local Codex, Gemini, and Claude Code sessions in one unified list.
- Page the list in the renderer by increasing a visible count, initially showing a bounded batch.
- Resume a session by creating a new kmux workspace and launching the vendor resume command in its first surface.
- Keep all filesystem scanning and session parsing in `electron-main`.

Out of scope for the first slice:

- Editing, deleting, or pinning external sessions.
- Full transcript preview.
- Syncing with cloud-only Claude Desktop chats.
- Detecting every possible external app state or preventing all duplicate resumes.

## Sources

The main process should discover sessions from these local stores when present:

- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- Gemini: `~/.gemini/tmp/<project>/chats/session-*` plus project root hints from `~/.gemini/history/<project>/.project_root`
- Claude Code: `~/.claude/projects/<encoded-cwd>/*.jsonl`

Codex title extraction should prefer the first user message in the JSONL. Gemini should prefer `summary`, then the first user message. Claude Code should follow the same pattern when local JSONL sessions exist. If no safe title can be extracted, use the vendor and session short id.

## Main Process Design

Add an `externalSessionIndexer` module under `apps/desktop/src/main`.

It should expose a small read-only API:

- `listExternalAgentSessions(options?: { limit?: number })`
- `resumeExternalAgentSession(sessionKey: string)`

The indexer returns sanitized view models only:

```ts
type ExternalAgentSessionVm = {
  key: string;
  vendor: "codex" | "gemini" | "claude";
  vendorLabel: "CODEX" | "GEMINI" | "CLAUDE";
  title: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  relativeTimeLabel: string;
  canResume: boolean;
  resumeCommandPreview: string;
};
```

The renderer must not read home-directory session files directly. The indexer should avoid returning raw prompts, transcript bodies, tool output, auth tokens, or file contents beyond the short title.

## Resume Design

Resuming a row should flow through `electron-main` so app state remains single-writer:

1. Renderer invokes `kmux:external-sessions:resume` with the session key.
2. Main resolves the indexed session and validates that the vendor command is available enough to launch.
3. Main creates a new workspace named from the session title.
4. Main launches the first surface with the vendor resume command:
   - Codex: `codex resume <sessionId>`
   - Gemini: `gemini --resume <sessionId>`
   - Claude: `claude --resume <sessionId>`
5. The workspace becomes active and the terminal attaches normally.

To support this, core session creation needs a small extension that allows a workspace or surface to specify `SessionLaunchConfig.args` and a title, without letting the renderer own PTY lifetime.

## Renderer Design

Replace the single `UsageDashboard` right-sidebar state with a right-panel container that supports tabs:

- `Usage`
- `Sessions`

The existing titlebar right-sidebar button should open the right panel. When open, the tab state chooses which view is displayed.

The Sessions tab should render a dense list:

- vendor pill fixed-width enough for `GEMINI`
- one-line title with ellipsis
- right-aligned relative time
- optional muted cwd basename under the title if it fits cleanly
- disabled or muted rows only when a session is discovered but cannot be resumed
- bottom "더보기" control that increases visible rows by a fixed page size

The list should stay keyboard and pointer friendly: rows are buttons, Enter/Space activate, hover and focus states are visible, and text must not overlap the time column.

## Performance

The first implementation can rescan on demand when the Sessions tab opens and when the user refreshes or reopens the panel. It should cap parsed files to a reasonable recent window or result limit before doing expensive title extraction.

Parsing should be bounded:

- read only the first relevant records needed for metadata/title
- avoid full transcript parsing unless required by a vendor format
- sort by file mtime or known updated timestamp
- return a capped result set to the renderer

## Validation

Targeted checks:

- unit tests for Codex, Gemini, and Claude session parsing
- unit tests for unified sorting and safe title fallback
- reducer/runtime tests for creating a workspace with a resume launch command
- renderer tests for tab switching, paging, row labels, and disabled state

Runtime validation:

- open Sessions tab
- verify mixed vendor rows render in newest-first order
- click a Codex or Gemini row
- verify a new workspace is created
- verify the terminal runs the expected resume command
- verify existing Usage tab still renders

Broader checks after implementation:

- `npm run test`
- `npm run lint`
- `npm run build`
- relevant Playwright interaction coverage for the right sidebar and resume flow

## Risks

- Vendor storage formats are not guaranteed stable.
- Session files may contain sensitive transcript data; only sanitized metadata should cross IPC.
- Claude Desktop app sessions may not map to Claude Code CLI resume sessions.
- Resuming the same external session in multiple places may have vendor-specific behavior.

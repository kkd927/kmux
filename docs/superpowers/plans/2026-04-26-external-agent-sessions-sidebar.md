# External Agent Sessions Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-sidebar `Sessions` tab that lists local Codex, Gemini, and Claude Code sessions newest-first and resumes a selected session in a new kmux workspace.

**Architecture:** `electron-main` owns all home-directory scanning and resume orchestration. Shared proto types describe sanitized session view models, core creates workspaces with explicit launch configs, and the renderer only requests session lists/resume by opaque key.

**Tech Stack:** Electron IPC, TypeScript, React, Vitest, existing kmux core reducer, node-pty launch config.

---

## File Structure

- Modify `packages/proto/src/index.ts`
  - Add `ExternalAgentSessionVm`, `ExternalAgentSessionsSnapshot`, `ExternalAgentSessionResumeResult`, and launch request types.
- Modify `packages/core/src/index.ts`
  - Allow `workspace.create` and `surface.create` to carry a `SessionLaunchConfig` plus explicit title for the first surface.
- Modify `packages/core/src/index.test.ts`
  - Cover workspace creation with a resume launch command.
- Create `apps/desktop/src/main/externalSessions.ts`
  - Discover, parse, sanitize, sort, and key local external agent sessions.
- Create `apps/desktop/src/main/externalSessions.test.ts`
  - Cover Codex, Gemini JSON, Gemini JSONL, Claude JSONL, sorting, title fallback, and resume command previews.
- Modify `apps/desktop/src/main/appRuntime.ts`
  - Add runtime methods for listing and resuming external sessions through core actions.
- Modify `apps/desktop/src/main/ipcHandlers.ts`
  - Register `kmux:external-sessions:get` and `kmux:external-sessions:resume`.
- Modify `apps/desktop/src/main/index.ts`
  - Instantiate the external session service and pass handlers into IPC registration.
- Modify `apps/desktop/src/preload/index.ts`
  - Expose `getExternalAgentSessions()` and `resumeExternalAgentSession(key)`.
- Modify `apps/desktop/src/renderer/src/global.d.ts`
  - Type the new preload APIs.
- Create `apps/desktop/src/renderer/src/hooks/useExternalAgentSessions.ts`
  - Fetch Sessions data when the tab mounts.
- Create `apps/desktop/src/renderer/src/components/ExternalSessionsPanel.tsx`
  - Render the compact list, vendor pills, relative time, cwd hint, disabled state, and `더보기`.
- Modify `apps/desktop/src/renderer/src/components/RightSidebarHost.tsx`
  - Add optional tab controls while preserving the existing Usage layout.
- Modify `apps/desktop/src/renderer/src/components/UsageDashboard.tsx`
  - Let the parent provide the right-sidebar shell so Usage can live under shared tabs.
- Modify `apps/desktop/src/renderer/src/App.tsx`
  - Track `activeRightPanel: "usage" | "sessions" | null`, open the right panel, render tabs.
- Modify `apps/desktop/src/renderer/src/styles/App.module.css`
  - Add dense Sessions list styles and right-sidebar tab styles.
- Add or update renderer tests near `apps/desktop/src/renderer/src/components`.
  - Cover tab switching, paging, vendor labels, and resume click wiring.

## Task 1: Shared Types And Core Launch Support

**Files:**
- Modify: `packages/proto/src/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/index.test.ts`

- [ ] **Step 1: Write failing core tests**

Add tests that create a workspace with an explicit launch command:

```ts
it("creates a workspace with an explicit initial session launch", () => {
  const state = createInitialState("/bin/zsh");
  const effects = applyAction(state, {
    type: "workspace.create",
    name: "Resume Codex session",
    cwd: "/Users/test/project",
    launch: {
      cwd: "/Users/test/project",
      shell: "codex",
      args: ["resume", "session-123"],
      title: "Resume Codex session"
    }
  });

  const workspace = Object.values(state.workspaces).find(
    (entry) => entry.name === "Resume Codex session"
  );
  expect(workspace).toBeTruthy();
  const pane = state.panes[workspace!.activePaneId];
  const surface = state.surfaces[pane.activeSurfaceId];
  const session = state.sessions[surface.sessionId];

  expect(surface.title).toBe("Resume Codex session");
  expect(session.launch).toMatchObject({
    cwd: "/Users/test/project",
    shell: "codex",
    args: ["resume", "session-123"],
    title: "Resume Codex session"
  });
  expect(effects).toContainEqual(
    expect.objectContaining({ type: "session.spawn" })
  );
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm run test -- packages/core/src/index.test.ts -t "explicit initial session launch"
```

Expected: TypeScript or test failure because `workspace.create` does not accept `launch`.

- [ ] **Step 3: Add proto types**

Add these exports to `packages/proto/src/index.ts`:

```ts
export type ExternalAgentSessionVendor = "codex" | "gemini" | "claude";

export interface ExternalAgentSessionVm {
  key: string;
  vendor: ExternalAgentSessionVendor;
  vendorLabel: "CODEX" | "GEMINI" | "CLAUDE";
  title: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  relativeTimeLabel: string;
  canResume: boolean;
  resumeCommandPreview: string;
}

export interface ExternalAgentSessionsSnapshot {
  sessions: ExternalAgentSessionVm[];
  updatedAt: string;
}

export interface ExternalAgentSessionResumeResult {
  workspaceId: string;
  surfaceId: string;
}
```

- [ ] **Step 4: Extend core actions and creation helpers**

Update `packages/core/src/index.ts` so `workspace.create` and `surface.create` can carry `launch?: SessionLaunchConfig`. Use the existing default shell launch when `launch` is absent.

Key implementation points:

```ts
| {
    type: "workspace.create";
    name?: string;
    cwd?: string;
    launch?: SessionLaunchConfig;
  }
| {
    type: "surface.create";
    paneId: Id;
    title?: string;
    cwd?: string;
    launch?: SessionLaunchConfig;
  }
```

When creating the first workspace surface or a new surface, derive:

```ts
const launch = sanitizeSessionLaunchConfig(action.launch, {
  cwd: launchCwd,
  shell: state.settings.shell || process.env.SHELL,
  title
});
```

Then store `launch` on the new session and keep the surface title from `launch.title ?? title`.

- [ ] **Step 5: Run targeted core tests**

Run:

```bash
npm run test -- packages/core/src/index.test.ts -t "explicit initial session launch"
```

Expected: PASS.

## Task 2: External Session Indexer

**Files:**
- Create: `apps/desktop/src/main/externalSessions.ts`
- Test: `apps/desktop/src/main/externalSessions.test.ts`

- [ ] **Step 1: Write parser tests**

Create fixtures with temporary directories. Tests should assert:

```ts
expect(snapshot.sessions.map((session) => session.vendor)).toEqual([
  "codex",
  "gemini",
  "claude"
]);
expect(snapshot.sessions[0]).toMatchObject({
  vendorLabel: "CODEX",
  title: "Fix terminal focus",
  canResume: true,
  resumeCommandPreview: "codex resume codex-session"
});
```

Also assert title fallback:

```ts
expect(fallback.title).toBe("GEMINI abcdef12");
```

- [ ] **Step 2: Run parser tests to verify failure**

Run:

```bash
npm run test -- apps/desktop/src/main/externalSessions.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement indexer API**

Create `apps/desktop/src/main/externalSessions.ts` with:

```ts
export interface ExternalSessionIndexerOptions {
  homeDir: string;
  now?: () => Date;
  maxFilesPerVendor?: number;
}

export interface ExternalSessionResumeSpec {
  key: string;
  vendor: ExternalAgentSessionVendor;
  title: string;
  cwd?: string;
  launch: SessionLaunchConfig;
}

export function createExternalSessionIndexer(
  options: ExternalSessionIndexerOptions
): {
  listExternalAgentSessions(): ExternalAgentSessionsSnapshot;
  resolveExternalAgentSession(key: string): ExternalSessionResumeSpec | null;
}
```

Implementation rules:

- use `readdirSync`, `statSync`, and `readFileSync`
- parse only bounded recent files per vendor
- return sanitized titles capped around 96 characters
- generate stable keys as `${vendor}:${sessionId}`
- build resume specs:
  - Codex: `{ shell: "codex", args: ["resume", sessionId], cwd, title }`
  - Gemini: `{ shell: "gemini", args: ["--resume", sessionId], cwd, title }`
  - Claude: `{ shell: "claude", args: ["--resume", sessionId], cwd, title }`

- [ ] **Step 4: Run parser tests**

Run:

```bash
npm run test -- apps/desktop/src/main/externalSessions.test.ts
```

Expected: PASS.

## Task 3: IPC And Resume Runtime

**Files:**
- Modify: `apps/desktop/src/main/appRuntime.ts`
- Modify: `apps/desktop/src/main/ipcHandlers.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/src/global.d.ts`
- Test: `apps/desktop/src/main/appRuntime.test.ts`
- Test: `apps/desktop/src/main/ipcHandlers.test.ts`

- [ ] **Step 1: Write runtime resume test**

Add a test that stubs an external session resolver and asserts dispatching resume creates a new workspace with the expected launch command.

Expected state assertions:

```ts
expect(createdWorkspace.name).toBe("Fix terminal focus");
expect(createdSession.launch).toMatchObject({
  shell: "codex",
  args: ["resume", "codex-session"],
  cwd: "/tmp/project"
});
```

- [ ] **Step 2: Wire runtime methods**

Add app runtime methods:

```ts
function getExternalAgentSessions(): ExternalAgentSessionsSnapshot {
  return options.externalSessionIndexer.listExternalAgentSessions();
}

function resumeExternalAgentSession(
  key: string
): ExternalAgentSessionResumeResult {
  const spec = options.externalSessionIndexer.resolveExternalAgentSession(key);
  if (!spec) {
    throw new Error("External session not found");
  }
  dispatchAppAction({
    type: "workspace.create",
    name: spec.title,
    cwd: spec.cwd,
    launch: spec.launch
  });
  const state = getState();
  const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
  const paneId = state.workspaces[workspaceId].activePaneId;
  const surfaceId = state.panes[paneId].activeSurfaceId;
  return { workspaceId, surfaceId };
}
```

- [ ] **Step 3: Add IPC handlers**

In `ipcHandlers.ts`, add options and handlers:

```ts
getExternalAgentSessions: () => ExternalAgentSessionsSnapshot;
resumeExternalAgentSession: (
  key: string
) => ExternalAgentSessionResumeResult;
```

```ts
ipcMain.handle("kmux:external-sessions:get", () =>
  options.getExternalAgentSessions()
);
ipcMain.handle("kmux:external-sessions:resume", (_event, key: string) =>
  options.resumeExternalAgentSession(key)
);
```

- [ ] **Step 4: Expose preload and renderer types**

Add to preload:

```ts
getExternalAgentSessions(): Promise<ExternalAgentSessionsSnapshot> {
  return ipcRenderer.invoke("kmux:external-sessions:get");
},
resumeExternalAgentSession(
  key: string
): Promise<ExternalAgentSessionResumeResult> {
  return ipcRenderer.invoke("kmux:external-sessions:resume", key);
}
```

Add matching entries to `global.d.ts`.

- [ ] **Step 5: Run targeted main tests**

Run:

```bash
npm run test -- apps/desktop/src/main/appRuntime.test.ts apps/desktop/src/main/ipcHandlers.test.ts
```

Expected: PASS.

## Task 4: Renderer Tabs And Sessions List

**Files:**
- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Modify: `apps/desktop/src/renderer/src/components/RightSidebarHost.tsx`
- Modify: `apps/desktop/src/renderer/src/components/UsageDashboard.tsx`
- Create: `apps/desktop/src/renderer/src/components/ExternalSessionsPanel.tsx`
- Create: `apps/desktop/src/renderer/src/hooks/useExternalAgentSessions.ts`
- Modify: `apps/desktop/src/renderer/src/styles/App.module.css`
- Test: `apps/desktop/src/renderer/src/components/ExternalSessionsPanel.test.tsx`

- [ ] **Step 1: Write renderer tests**

Test expectations:

```tsx
expect(screen.getByRole("tab", { name: "Usage" })).toBeInTheDocument();
expect(screen.getByRole("tab", { name: "Sessions" })).toBeInTheDocument();
expect(screen.getByText("CODEX")).toBeInTheDocument();
expect(screen.getByText("Fix terminal focus")).toBeInTheDocument();
expect(screen.getByRole("button", { name: /더보기/ })).toBeInTheDocument();
```

Clicking a row:

```ts
await user.click(screen.getByRole("button", { name: /Fix terminal focus/ }));
expect(window.kmux.resumeExternalAgentSession).toHaveBeenCalledWith(
  "codex:codex-session"
);
```

- [ ] **Step 2: Implement external sessions hook**

Create a hook that fetches once when mounted and exposes:

```ts
{
  snapshot,
  loading,
  error,
  refresh
}
```

Use `window.kmux.getExternalAgentSessions()`.

- [ ] **Step 3: Implement `ExternalSessionsPanel`**

Render rows as buttons, use `PAGE_SIZE = 30`, and increase visible count on `더보기`.

Row structure:

```tsx
<button className={styles.externalSessionRow} disabled={!session.canResume}>
  <span className={styles.externalSessionVendor}>{session.vendorLabel}</span>
  <span className={styles.externalSessionCopy}>
    <span className={styles.externalSessionTitle}>{session.title}</span>
    {session.cwd ? <span>{basename(session.cwd)}</span> : null}
  </span>
  <span className={styles.externalSessionTime}>
    {session.relativeTimeLabel}
  </span>
</button>
```

- [ ] **Step 4: Add right-sidebar tabs**

Update `RightSidebarHost` to accept:

```ts
tabs?: Array<{ key: string; label: string }>;
activeTab?: string;
onSelectTab?: (key: string) => void;
```

Render them as `role="tablist"` and `role="tab"` buttons in the header.

- [ ] **Step 5: Integrate into `App.tsx`**

Change:

```ts
type RightPanelKind = "usage" | "sessions" | null;
```

When the existing right-sidebar titlebar button opens, default to `"usage"`. Render a shared `RightSidebarHost` with tabs and either `UsageDashboard` or `ExternalSessionsPanel`.

- [ ] **Step 6: Add styles**

Add CSS classes:

```css
.rightSidebarTabs {}
.rightSidebarTab {}
.externalSessionsPanel {}
.externalSessionRow {}
.externalSessionVendor {}
.externalSessionTitle {}
.externalSessionTime {}
.externalSessionsMoreButton {}
```

Ensure one-line title truncation, fixed time column, and visible focus.

- [ ] **Step 7: Run renderer tests**

Run:

```bash
npm run test -- apps/desktop/src/renderer/src/components/ExternalSessionsPanel.test.tsx
```

Expected: PASS.

## Task 5: End-To-End Checks

**Files:**
- Test or inspect: existing Playwright e2e setup under `tests/e2e`

- [ ] **Step 1: Run targeted unit tests**

Run:

```bash
npm run test -- packages/core/src/index.test.ts apps/desktop/src/main/externalSessions.test.ts apps/desktop/src/main/appRuntime.test.ts apps/desktop/src/main/ipcHandlers.test.ts apps/desktop/src/renderer/src/components/ExternalSessionsPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run broad project checks**

Run:

```bash
npm run test
npm run lint
npm run build
```

Expected: all PASS.

- [ ] **Step 3: Runtime validation**

Start the app:

```bash
npm run dev
```

Manual/user-like checks:

- Open the right sidebar.
- Select `Sessions`.
- Confirm Codex and Gemini rows appear newest-first.
- Click `더보기` and confirm another page of rows appears without layout shift.
- Click a Codex or Gemini row.
- Confirm a new workspace is created and the visible terminal starts the expected resume command.
- Switch back to `Usage` and confirm the existing dashboard still renders.

## Self-Review

- Spec coverage: The plan covers unified all-local listing, vendor labels, title extraction, relative time, `더보기` paging, main-process parsing, sanitized IPC, workspace creation, and resume launch.
- Placeholder scan: No `TBD`, `TODO`, or vague implementation placeholders remain.
- Type consistency: Shared proto names are used consistently across main, preload, and renderer tasks.

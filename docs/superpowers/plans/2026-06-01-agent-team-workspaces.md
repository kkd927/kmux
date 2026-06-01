# Agent Team Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the native kmux Agent Team Workspace MVP with alias routing, worktree-enforced presets, route logs, bounded surface capture/read, and pty-host input acknowledgement.

**Architecture:** Team state lives in the core reducer and is exposed through typed protocol contracts. Routing and worktree orchestration run in `electron-main`, while terminal capture and input acknowledgement run in `pty-host`. The renderer displays and initiates team workflows but does not own team state.

**Tech Stack:** TypeScript, Electron, xterm.js headless terminal state, node-pty, Vitest, commander, Unix domain socket JSON-RPC.

---

## Scope Check

This is a narrow MVP, coupled by one contract: a native team workspace maps
member aliases to stable kmux surfaces and avoids unsafe shared writes by
default. The work is split into tasks that each produce testable behavior:

1. Protocol contracts
2. Core reducer state
3. Surface capture and pty-host input acknowledgement
4. Main-process team runtime and socket methods
5. CLI team commands
6. Renderer entry points
7. Worktree-enforced preset behavior
8. E2E coverage and docs

The MVP intentionally excludes the fake `tmux` shim and file-edit broadcast.
Those are post-MVP candidates after native usage is validated.

## File Structure

- Modify `packages/proto/src/index.ts`
  - Team state, route request/result, capture request/result, and send result types.
- Modify `apps/desktop/src/main/socketRpc.ts`
  - Validate new socket methods.
- Modify `apps/desktop/src/main/socketServer.ts`
  - Dispatch new team and surface methods.
- Modify `packages/core/src/index.ts`
  - Store team metadata, create team workspaces, update route logs, clean up member targets.
- Modify `packages/core/src/index.test.ts`
  - Reducer tests for team state and cleanup.
- Modify `apps/desktop/src/pty-host/index.ts`
  - Capture plain text from the headless terminal buffer.
- Modify `apps/desktop/src/pty-host/index.test.ts`
  - Capture behavior and bounded line tests.
- Modify `apps/desktop/src/main/ptyHost.ts`
  - Request/response bridge for capture and pty-host acknowledged writes.
- Modify `apps/desktop/src/main/terminalBridge.ts`
  - Surface-level capture and pty-host input acknowledgement helpers.
- Modify `apps/desktop/src/main/terminalBridge.test.ts`
  - Tests for missing, exited, and live targets.
- Create `apps/desktop/src/main/teamRuntime.ts`
  - Team creation, route resolution, reset, and worktree policy orchestration.
- Create `apps/desktop/src/main/teamRuntime.test.ts`
  - Unit tests for route success, failed targets, and worktree policy.
- Modify `apps/desktop/src/main/appRuntime.ts`
  - Wire team runtime into socket capabilities.
- Modify `apps/desktop/src/main/index.ts`
  - Wire team runtime into main process handlers.
- Modify `packages/cli/src/bin.ts`
  - Add `kmux team ...` commands.
- Modify `packages/cli/src/bin.test.ts`
  - CLI command serialization tests.
- Modify `apps/desktop/src/renderer/src/App.tsx`
  - Add command palette entry for team workspace creation.
- Modify `apps/desktop/src/renderer/src/components/WorkspaceCard.tsx`
  - Show compact team member count and status when available.
- Modify `apps/desktop/src/preload/index.ts`
  - Expose renderer-to-main team workspace creation helper.
- Modify `apps/desktop/src/renderer/src/global.d.ts`
  - Type the new preload helper.
- Modify `apps/desktop/src/main/ipcHandlers.ts`
  - Register trusted renderer IPC for team workspace creation.
- Modify `docs/product-spec.md`
  - Add team workflow scope.
- Create `tests/e2e/kmux-agent-team-workspace.spec.ts`
  - End-to-end team workspace smoke coverage.

## Task 1: Add Protocol Contracts and Socket Schemas

**Files:**

- Modify: `packages/proto/src/index.ts`
- Modify: `apps/desktop/src/main/socketRpc.ts`
- Test: `apps/desktop/src/main/socketRpc.test.ts`

- [ ] **Step 1: Add proto types**

Add these exported types near the existing terminal and workspace protocol
types in `packages/proto/src/index.ts`:

```ts
export type TeamMemberVendor = "claude" | "codex" | "gemini";
export type TeamMemberWorktreePolicy = "shared" | "dedicated" | "read_only";
export type TeamRouteStatus = "sent" | "failed";

export interface TeamMemberVm {
  id: Id;
  alias: string;
  displayName: string;
  role: string;
  vendor: TeamMemberVendor;
  worktreePolicy: TeamMemberWorktreePolicy;
  surfaceId?: Id;
  sessionId?: Id;
}

export interface TeamRouteTargetResult {
  alias: string;
  surfaceId?: Id;
  sessionId?: Id;
  requestId?: Id;
  acceptedAt?: string;
  status: "sent" | "failed";
  error?: string;
}

export interface TeamRouteLogEntry {
  id: Id;
  workspaceId: Id;
  target: string;
  messagePreview: string;
  status: TeamRouteStatus;
  targets: TeamRouteTargetResult[];
  metadata?: Record<string, string>;
  createdAt: string;
}

export interface TeamWorkspaceVm {
  id: Id;
  presetId: string;
  members: TeamMemberVm[];
  routeLogs: TeamRouteLogEntry[];
}

export interface TeamWorkspaceCreateRequest {
  name?: string;
  cwd?: string;
  presetId?: string;
}

export interface TeamSendRequest {
  workspaceId?: Id;
  target: string;
  text: string;
}

export interface TeamSendResult {
  status: TeamRouteStatus;
  route: TeamRouteLogEntry;
}

export interface SurfaceSendTextResult {
  ok: boolean;
  surfaceId: Id;
  sessionId: Id;
  requestId: Id;
  acceptedAt: string;
}

export interface SurfaceCaptureRequest {
  surfaceId?: Id;
  maxLines?: number;
  trim?: "none" | "right" | "both";
}

export interface SurfaceCaptureAuthContext {
  surfaceId?: Id;
  authToken?: string;
  maxLines?: number;
  trim?: "none" | "right" | "both";
}

export interface SurfaceCaptureResult {
  surfaceId: Id;
  sessionId: Id;
  sequence: number;
  cols: number;
  rows: number;
  text: string;
}

export interface InputAckPayload {
  requestId: Id;
  surfaceId: Id;
  sessionId: Id;
  acceptedAt: string;
  ok: boolean;
  error?: string;
}
```

- [ ] **Step 2: Add socket parser tests**

Add tests in `apps/desktop/src/main/socketRpc.test.ts`:

```ts
it("parses team send requests", () => {
  expect(
    parseSocketRequest("team.send", {
      workspaceId: "workspace_1",
      target: "developer",
      text: "Run the focused tests"
    })
  ).toMatchObject({
    method: "team.send",
    params: {
      workspaceId: "workspace_1",
      target: "developer",
      text: "Run the focused tests"
    }
  });
});

it("rejects empty team send targets", () => {
  expect(() =>
    parseSocketRequest("team.send", {
      target: "",
      text: "hello"
    })
  ).toThrow();
});

it("rejects broadcast targets in the MVP", () => {
  expect(() =>
    parseSocketRequest("team.send", {
      target: "all",
      text: "Report status"
    })
  ).toThrow();
});

it("parses bounded surface capture requests", () => {
  expect(
    parseSocketRequest("surface.capture", {
      surfaceId: "surface_1",
      maxLines: 80,
      trim: "right"
    })
  ).toMatchObject({
    method: "surface.capture",
    params: {
      surfaceId: "surface_1",
      maxLines: 80,
      trim: "right"
    }
  });
});
```

- [ ] **Step 3: Extend socket schemas**

In `apps/desktop/src/main/socketRpc.ts`, add schemas for:

```ts
const teamTargetSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((target) => target.toLowerCase() !== "all", {
    message: "broadcast routing is deferred from the MVP"
  });
const captureTrimSchema = z.enum(["none", "right", "both"]);

"team.workspace_create": z
  .object({
    name: z.string().optional(),
    cwd: z.string().optional(),
    presetId: z.string().min(1).optional()
  })
  .strict(),
"team.list": z
  .object({
    workspaceId: z.string().min(1).optional()
  })
  .strict(),
"team.send": z
  .object({
    workspaceId: z.string().min(1).optional(),
    target: teamTargetSchema,
    text: z.string().min(1)
  })
  .strict(),
"team.reset_member": z
  .object({
    workspaceId: z.string().min(1).optional(),
    alias: teamTargetSchema
  })
  .strict(),
"surface.capture": z
  .object({
    surfaceId: z.string().min(1).optional(),
    maxLines: z.coerce.number().int().min(1).max(5000).optional(),
    trim: captureTrimSchema.optional()
  })
  .strict(),
```

- [ ] **Step 4: Run parser tests**

Run:

```bash
npm run test -- apps/desktop/src/main/socketRpc.test.ts
```

Expected: tests pass after schema implementation.

- [ ] **Step 5: Commit**

```bash
git add packages/proto/src/index.ts apps/desktop/src/main/socketRpc.ts apps/desktop/src/main/socketRpc.test.ts
git commit -m "feat: add team workspace socket contracts"
```

## Task 2: Add Core Team State and Reducer Actions

**Files:**

- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/index.test.ts`

- [ ] **Step 1: Write reducer tests**

Add tests in `packages/core/src/index.test.ts` that assert:

```ts
it("creates a team workspace with stable member aliases", () => {
  const state = createInitialState();
  const members = makeResolvedDefaultTeamMembers("/repo");
  const effects = applyAction(state, {
    type: "team.workspace.create",
    name: "agent team",
    presetId: "default",
    cwd: "/repo",
    members
  });
  const workspace =
    state.workspaces[state.windows[state.activeWindowId].activeWorkspaceId];
  expect(workspace.team?.members.map((member) => member.alias)).toEqual([
    "lead",
    "developer",
    "reviewer"
  ]);
  expect(effects.some((effect) => effect.type === "session.spawn")).toBe(true);
});

it("records team route logs without mutating terminal state", () => {
  const state = createInitialState();
  applyAction(state, {
    type: "team.workspace.create",
    presetId: "default",
    cwd: "/repo",
    members: makeResolvedDefaultTeamMembers("/repo")
  });
  const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
  applyAction(state, {
    type: "team.route.record",
    workspaceId,
    target: "developer",
    messagePreview: "Run tests",
    targets: [{ alias: "developer", status: "sent" }]
  });
  expect(state.workspaces[workspaceId].team?.routeLogs[0]).toMatchObject({
    target: "developer",
    status: "sent",
    messagePreview: "Run tests"
  });
});

it("clears team member target when a mapped surface closes", () => {
  const state = createInitialState();
  applyAction(state, {
    type: "team.workspace.create",
    presetId: "default",
    cwd: "/repo",
    members: makeResolvedDefaultTeamMembers("/repo")
  });
  const workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
  const member = state.workspaces[workspaceId].team!.members.find(
    (entry) => entry.alias === "developer"
  )!;
  applyAction(state, { type: "surface.close", surfaceId: member.surfaceId! });
  const nextMember = state.workspaces[workspaceId].team!.members.find(
    (entry) => entry.alias === "developer"
  )!;
  expect(nextMember.surfaceId).toBeUndefined();
  expect(nextMember.sessionId).toBeUndefined();
});
```

- [ ] **Step 2: Add state and action types**

In `packages/core/src/index.ts`, add internal state types and actions:

```ts
interface ResolvedTeamMemberSpec {
  alias: string;
  displayName: string;
  role: string;
  vendor: TeamMemberVendor;
  worktreePolicy: TeamMemberWorktreePolicy;
  rolePrompt: string;
  launch: SessionLaunchConfig;
}

interface TeamMemberState {
  id: Id;
  alias: string;
  displayName: string;
  role: string;
  vendor: TeamMemberVendor;
  worktreePolicy: TeamMemberWorktreePolicy;
  rolePrompt: string;
  surfaceId?: Id;
  sessionId?: Id;
}

interface TeamWorkspaceState {
  id: Id;
  presetId: string;
  members: TeamMemberState[];
  routeLogs: TeamRouteLogEntry[];
}
```

Extend `WorkspaceState`:

```ts
team?: TeamWorkspaceState;
```

Extend `AppAction`:

```ts
| {
    type: "team.workspace.create";
    name?: string;
    cwd?: string;
    presetId?: string;
    members: ResolvedTeamMemberSpec[];
  }
| {
    type: "team.route.record";
    workspaceId: Id;
    target: string;
    messagePreview: string;
    targets: TeamRouteTargetResult[];
  }
| { type: "team.member.bindSurface"; workspaceId: Id; alias: string; surfaceId: Id; sessionId: Id }
```

- [ ] **Step 3: Implement creation from resolved member specs**

Add a test helper in `packages/core/src/index.test.ts`:

```ts
function makeResolvedDefaultTeamMembers(cwd: string): ResolvedTeamMemberSpec[] {
  return [
    {
      alias: "lead",
      displayName: "Lead",
      role: "Coordinator",
      vendor: "claude",
      worktreePolicy: "read_only",
      rolePrompt: "Coordinate the team without editing files.",
      launch: { cwd, initialInput: "claude\r", title: "Lead" }
    },
    {
      alias: "developer",
      displayName: "Developer",
      role: "Implementation",
      vendor: "codex",
      worktreePolicy: "dedicated",
      rolePrompt: "Implement scoped changes.",
      launch: {
        cwd: `${cwd}-developer`,
        initialInput: "codex\r",
        title: "Developer"
      }
    },
    {
      alias: "reviewer",
      displayName: "Reviewer",
      role: "Review",
      vendor: "claude",
      worktreePolicy: "dedicated",
      rolePrompt: "Review changes.",
      launch: {
        cwd: `${cwd}-reviewer`,
        initialInput: "claude\r",
        title: "Reviewer"
      }
    }
  ];
}
```

The core reducer should create surfaces and sessions from the resolved member
specs using the existing session spawn effect path. It must not allocate
worktrees or choose default presets. Keep member `surfaceId` and `sessionId`
aligned with the created surface and session.

- [ ] **Step 4: Implement route log reducer behavior**

Compute route log status from target results:

```ts
function routeStatusForTargets(
  targets: TeamRouteTargetResult[]
): TeamRouteStatus {
  const sent = targets.filter((target) => target.status === "sent").length;
  if (targets.length > 0 && sent === targets.length) {
    return "sent";
  }
  return "failed";
}
```

Keep only the newest 100 route logs per team workspace.

- [ ] **Step 5: Update close cleanup**

When `surface.close`, `surface.closeOthers`, `pane.close`, or
`workspace.close` removes a surface, clear the corresponding team member
`surfaceId` and `sessionId`. Do not delete the member record.

- [ ] **Step 6: Run reducer tests**

Run:

```bash
npm run test -- packages/core/src/index.test.ts
```

Expected: team tests pass and existing reducer tests still pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/index.test.ts
git commit -m "feat: add native team workspace state"
```

## Task 3: Add Surface Capture and Pty-Host Input Acknowledgement

**Files:**

- Modify: `packages/proto/src/index.ts`
- Modify: `apps/desktop/src/pty-host/index.ts`
- Modify: `apps/desktop/src/main/ptyHost.ts`
- Modify: `apps/desktop/src/main/terminalBridge.ts`
- Modify: `apps/desktop/src/main/socketServer.ts`
- Test: `apps/desktop/src/pty-host/index.test.ts`
- Test: `apps/desktop/src/main/terminalBridge.test.ts`
- Test: `apps/desktop/src/main/socketServer.test.ts`

- [ ] **Step 1: Add pty request and event contracts**

Extend `PtyRequest` so text and key input carry request ids, and add capture:

```ts
| { type: "input:text"; sessionId: Id; surfaceId: Id; requestId: Id; text: string }
| {
    type: "input:key";
    sessionId: Id;
    surfaceId: Id;
    requestId: Id;
    input: TerminalKeyInput;
  }
| {
    type: "capture";
    sessionId: Id;
    surfaceId: Id;
    requestId: Id;
    maxLines?: number;
    trim?: "none" | "right" | "both";
  }
```

Extend `PtyEvent`:

```ts
| { type: "input:ack"; payload: InputAckPayload }
| { type: "capture"; requestId: Id; payload: SurfaceCaptureResult }
```

- [ ] **Step 2: Add capture helper tests**

In `apps/desktop/src/pty-host/index.test.ts`, cover a pure helper exported for
test and one integration-style capture helper:

```ts
it("trims captured lines on the right", () => {
  expect(trimCapturedLine("hello   ", "right")).toBe("hello");
});

it("preserves captured lines when trim is none", () => {
  expect(trimCapturedLine("hello   ", "none")).toBe("hello   ");
});

it("returns the bottom bounded captured lines", () => {
  expect(
    formatCapturedLines(["one", "two", "three"], {
      maxLines: 2,
      trim: "right"
    })
  ).toBe("two\nthree");
});
```

- [ ] **Step 3: Implement plain-text capture in pty-host**

Add helpers in `apps/desktop/src/pty-host/index.ts`:

```ts
export function trimCapturedLine(
  line: string,
  trim: "none" | "right" | "both"
): string {
  if (trim === "right") {
    return line.replace(/\s+$/u, "");
  }
  if (trim === "both") {
    return line.trim();
  }
  return line;
}
```

Use the headless terminal buffer to collect bounded lines. Flush the output
batcher before reading so capture observes parsed output. Capture semantics are:

- read `record.terminal.buffer.active`
- include scrollback for the normal buffer by using buffer base/length
- return bottom `maxLines` logical lines
- return the current alternate buffer contents when the alternate buffer is
  active
- set `sequence` to `record.parsedSequence` after flushing
- return plain text without VT escape sequences

- [ ] **Step 4: Add main bridge capture API**

Expose a promise-based `captureSurface(surfaceId, options)` in
`apps/desktop/src/main/terminalBridge.ts`. It should:

- resolve the surface and session
- reject if the session is missing or exited
- send a pty `capture` request
- resolve when the matching capture event returns
- time out with a clear error after 1500 ms

- [ ] **Step 5: Return pty-host input acknowledgement from socket sends**

Change `surface.send_text` handling in `apps/desktop/src/main/socketServer.ts`
to await `terminalBridge.sendText` and return the pty-host ack:

```ts
{
  ok: true,
  surfaceId,
  sessionId,
  requestId,
  acceptedAt: new Date().toISOString()
}
```

For missing targets, exited sessions, or pty-host negative ack, return a
JSON-RPC error rather than `{ ok: true }`.

- [ ] **Step 6: Add terminal bridge tests**

Add tests in `apps/desktop/src/main/terminalBridge.test.ts` for:

- capture rejects missing surface
- capture rejects exited session
- pty-host input acknowledgement includes surface id, session id, and request id
- missing session write produces a negative pty-host ack
- socket `surface.capture` rejects requests without the matching
  `KMUX_AUTH_TOKEN`, even when `socketMode` is `allowAll`
- socket `surface.capture` with omitted `surfaceId` resolves the target surface
  from `KMUX_AUTH_TOKEN`, not the UI active surface
- socket `surface.capture` with a mismatched `KMUX_AUTH_TOKEN` cannot capture a
  different target surface

- [ ] **Step 7: Run tests**

Run:

```bash
npm run test -- apps/desktop/src/pty-host/index.test.ts apps/desktop/src/main/terminalBridge.test.ts apps/desktop/src/main/socketServer.test.ts
```

Expected: capture and pty-host acknowledgement tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/proto/src/index.ts apps/desktop/src/pty-host/index.ts apps/desktop/src/pty-host/index.test.ts apps/desktop/src/main/ptyHost.ts apps/desktop/src/main/terminalBridge.ts apps/desktop/src/main/terminalBridge.test.ts apps/desktop/src/main/socketServer.ts apps/desktop/src/main/socketServer.test.ts
git commit -m "feat: add surface capture and input acknowledgements"
```

## Task 4: Add Main-Process Team Runtime and Socket Methods

**Files:**

- Create: `apps/desktop/src/main/teamRuntime.ts`
- Create: `apps/desktop/src/main/teamRuntime.test.ts`
- Modify: `apps/desktop/src/main/socketServer.ts`
- Modify: `apps/desktop/src/main/appRuntime.ts`

- [ ] **Step 1: Write team runtime tests**

Create `apps/desktop/src/main/teamRuntime.test.ts` with tests for:

```ts
it("routes a message to one team member alias", async () => {
  const sent: Array<{ surfaceId: string; text: string }> = [];
  const runtime = createTeamRuntime({
    getState: () => stateWithTeam,
    dispatch,
    sendSurfaceText: async (surfaceId, text) => {
      sent.push({ surfaceId, text });
      return {
        ok: true,
        surfaceId,
        sessionId: "session_developer",
        requestId: "input_1",
        acceptedAt: "2026-06-01T00:00:00.000Z"
      };
    }
  });
  const result = await runtime.send({
    workspaceId: "workspace_team",
    target: "developer",
    text: "Run tests"
  });
  expect(result.status).toBe("sent");
  expect(sent).toEqual([
    { surfaceId: "surface_developer", text: "Run tests\r" }
  ]);
  expect(result.route.targets[0]).toMatchObject({
    alias: "developer",
    status: "sent",
    surfaceId: "surface_developer",
    sessionId: "session_developer",
    requestId: "input_1",
    acceptedAt: "2026-06-01T00:00:00.000Z"
  });
});

it("rejects broadcast targets in the MVP", async () => {
  await expect(
    runtime.send({
      workspaceId: "workspace_team",
      target: "all",
      text: "Report status"
    })
  ).rejects.toThrow(/broadcast/i);
});

it("records a failed route when the target alias is missing", async () => {
  const result = await runtime.send({
    workspaceId: "workspace_team",
    target: "missing",
    text: "Report status"
  });
  expect(result.status).toBe("failed");
  expect(result.route.targets[0]).toMatchObject({
    alias: "missing",
    status: "failed"
  });
});
```

- [ ] **Step 2: Implement `createTeamRuntime`**

The runtime interface:

```ts
export interface TeamRuntime {
  createWorkspace(
    request: TeamWorkspaceCreateRequest
  ): Promise<{ workspaceId: Id }>;
  list(workspaceId?: Id): TeamWorkspaceVm | null;
  send(request: TeamSendRequest): Promise<TeamSendResult>;
  resetMember(request: {
    workspaceId?: Id;
    alias: string;
  }): Promise<{ ok: true; oldSurfaceId?: Id; newSurfaceId: Id }>;
}
```

Route resolution rules:

- default workspace is the active workspace
- `target === "all"` is rejected in the MVP because broadcast is deferred
- alias matching is exact and case-insensitive
- message text is normalized to end in `\r`
- missing members produce failed target results
- successful targets copy `surfaceId`, `sessionId`, `requestId`, and
  `acceptedAt` from the pty-host input acknowledgement
- every send dispatches `team.route.record`

Reset rules:

- resolve the member by alias
- create a replacement surface/session in the same workspace
- keep the old surface open so the transcript remains available
- rebind the member alias to the replacement surface/session
- add a route log entry with `metadata.oldSurfaceId`,
  `metadata.newSurfaceId`, and `metadata.newSessionId`

- [ ] **Step 3: Wire socket methods**

In `apps/desktop/src/main/socketServer.ts`, add cases:

```ts
case "team.workspace_create":
  return this.options.team.createWorkspace(request.params);
case "team.list":
  return this.options.team.list(request.params.workspaceId);
case "team.send":
  return this.options.team.send(request.params);
case "team.reset_member":
  return this.options.team.resetMember(request.params);
case "surface.capture":
  return this.options.captureSurface({
    surfaceId: request.params.surfaceId,
    authToken: request.authToken,
    maxLines: request.params.maxLines,
    trim: request.params.trim
  });
```

`captureSurface` must resolve omitted `surfaceId` from `authToken`, not from the
UI active surface. It must reject requests with no auth token or a token that
does not match the target surface/session, even when `socketMode` is
`allowAll`. Add the required option callbacks to the socket server constructor
and app runtime wiring.

- [ ] **Step 4: Run runtime and socket tests**

Run:

```bash
npm run test -- apps/desktop/src/main/teamRuntime.test.ts apps/desktop/src/main/socketServer.test.ts
```

Expected: all new route cases pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/teamRuntime.ts apps/desktop/src/main/teamRuntime.test.ts apps/desktop/src/main/socketServer.ts apps/desktop/src/main/socketServer.test.ts apps/desktop/src/main/appRuntime.ts
git commit -m "feat: add team routing runtime"
```

## Task 5: Add `kmux team` CLI Commands

**Files:**

- Modify: `packages/cli/src/bin.ts`
- Test: `packages/cli/src/bin.test.ts`

- [ ] **Step 1: Add CLI tests**

Add tests that assert command serialization:

```ts
it("sends team messages", async () => {
  const result = await runCli([
    "team",
    "send",
    "--target",
    "developer",
    "--text",
    "Run tests"
  ]);
  expect(result.requests[0]).toMatchObject({
    method: "team.send",
    params: {
      target: "developer",
      text: "Run tests"
    }
  });
});

it("creates a team workspace", async () => {
  const result = await runCli([
    "team",
    "create",
    "--name",
    "agent team",
    "--preset",
    "default"
  ]);
  expect(result.requests[0]).toMatchObject({
    method: "team.workspace_create",
    params: {
      name: "agent team",
      presetId: "default"
    }
  });
});
```

- [ ] **Step 2: Add CLI commands**

In `packages/cli/src/bin.ts`, add:

```ts
const team = program.command("team");
team
  .command("create")
  .option("--name <name>")
  .option("--cwd <cwd>")
  .option("--preset <presetId>", "default")
  .action(async (options) =>
    print(
      await sendRpc("team.workspace_create", {
        name: options.name,
        cwd: options.cwd,
        presetId: options.preset
      })
    )
  );
team
  .command("list")
  .option("--workspace <workspaceId>")
  .action(async (options) =>
    print(await sendRpc("team.list", { workspaceId: options.workspace }))
  );
team
  .command("send")
  .requiredOption("--target <target>")
  .requiredOption("--text <text>")
  .option("--workspace <workspaceId>")
  .action(async (options) =>
    print(
      await sendRpc("team.send", {
        workspaceId: options.workspace,
        target: options.target,
        text: options.text
      })
    )
  );
team
  .command("reset")
  .requiredOption("--alias <alias>")
  .option("--workspace <workspaceId>")
  .action(async (options) =>
    print(
      await sendRpc("team.reset_member", {
        workspaceId: options.workspace,
        alias: options.alias
      })
    )
  );
```

- [ ] **Step 3: Run CLI tests**

Run:

```bash
npm run test -- packages/cli/src/bin.test.ts
```

Expected: CLI tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/bin.ts packages/cli/src/bin.test.ts
git commit -m "feat: add team CLI commands"
```

## Task 6: Add Renderer Entry Points

**Files:**

- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Modify: `apps/desktop/src/renderer/src/components/WorkspaceCard.tsx`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/src/global.d.ts`
- Modify: `apps/desktop/src/main/ipcHandlers.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/appRuntime.ts`
- Test: existing renderer tests where affected

- [ ] **Step 1: Add command palette item**

In `apps/desktop/src/renderer/src/App.tsx`, add a palette item:

```ts
{
  id: "create-team-workspace",
  label: "Create agent team",
  subtitle: "Start a worktree-enforced multi-agent workspace",
  run: () => void window.kmux.createTeamWorkspace({ presetId: "default" })
}
```

- [ ] **Step 2: Add preload and IPC helper**

In `apps/desktop/src/preload/index.ts`, expose:

```ts
createTeamWorkspace(payload: { name?: string; cwd?: string; presetId?: string }) {
  return ipcRenderer.invoke("kmux:team:create-workspace", payload);
}
```

In `apps/desktop/src/renderer/src/global.d.ts`, add the matching method to
`window.kmux`.

In `apps/desktop/src/main/ipcHandlers.ts`, register:

```ts
ipcMain.handle(
  "kmux:team:create-workspace",
  (_event, payload: { name?: string; cwd?: string; presetId?: string }) =>
    options.createTeamWorkspace(payload)
);
```

Thread `createTeamWorkspace` through the IPC handler options from
`apps/desktop/src/main/index.ts` and `apps/desktop/src/main/appRuntime.ts`.

- [ ] **Step 3: Show team count on workspace card**

Add a compact label for team workspaces:

```text
team: 3 members
```

Expose `row.team.memberCount` from the core workspace row selector and only
render the label when that value is greater than zero.

- [ ] **Step 4: Run renderer tests**

Run:

```bash
npm run test -- apps/desktop/src/renderer/src
```

Expected: renderer tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/App.tsx apps/desktop/src/renderer/src/components/WorkspaceCard.tsx apps/desktop/src/preload/index.ts apps/desktop/src/renderer/src/global.d.ts apps/desktop/src/main/ipcHandlers.ts apps/desktop/src/main/index.ts apps/desktop/src/main/appRuntime.ts
git commit -m "feat: expose team workspace creation in renderer"
```

## Task 7: Add Worktree-Enforced Team Preset Behavior

**Files:**

- Modify: `apps/desktop/src/main/teamRuntime.ts`
- Modify: `apps/desktop/src/main/worktreeRuntime.ts` only if a reusable helper is required
- Test: `apps/desktop/src/main/teamRuntime.test.ts`

- [ ] **Step 1: Add worktree policy tests**

Add tests:

```ts
const capturedDispatches: AppAction[] = [];

it("uses the workspace cwd for read-only coordinator members", async () => {
  const result = await runtime.createWorkspace({
    name: "team",
    cwd: "/repo",
    presetId: "default"
  });
  const team = runtime.list(result.workspaceId)!;
  expect(
    team.members.find((member) => member.alias === "lead")?.worktreePolicy
  ).toBe("read_only");
  expect(capturedDispatches[0]).toMatchObject({
    type: "team.workspace.create",
    members: expect.arrayContaining([
      expect.objectContaining({
        alias: "lead",
        launch: expect.objectContaining({ cwd: "/repo" })
      })
    ])
  });
});

it("allocates dedicated worktree cwd for dedicated members", async () => {
  const result = await runtime.createWorkspace({
    name: "team",
    cwd: "/repo",
    presetId: "default"
  });
  const team = runtime.list(result.workspaceId)!;
  expect(
    team.members.find((member) => member.alias === "developer")?.worktreePolicy
  ).toBe("dedicated");
  expect(capturedDispatches[0]).toMatchObject({
    type: "team.workspace.create",
    members: expect.arrayContaining([
      expect.objectContaining({
        alias: "developer",
        launch: expect.objectContaining({
          cwd: expect.stringContaining("/.kmux/worktrees/")
        })
      })
    ])
  });
});

it("fails workspace creation when a dedicated worktree cannot be allocated", async () => {
  const runtime = createTeamRuntime({
    ...baseOptions,
    allocateWorktree: async () => {
      throw new Error("git worktree failed");
    }
  });
  await expect(
    runtime.createWorkspace({
      name: "team",
      cwd: "/repo",
      presetId: "default"
    })
  ).rejects.toThrow(/worktree/i);
  expect(capturedDispatches).not.toContainEqual(
    expect.objectContaining({ type: "team.workspace.create" })
  );
});
```

- [ ] **Step 2: Implement launch input per member**

For each member, build `SessionLaunchConfig.initialInput` as:

```ts
function buildAgentLaunchInput(member: TeamMemberVm): string {
  const command =
    member.vendor === "claude"
      ? "claude"
      : member.vendor === "codex"
        ? "codex"
        : "gemini";
  return `${command}\r`;
}
```

Keep the first implementation conservative: launch the agent command and record
role metadata in kmux. Do not inject role prompts into agent stdin in this task.
Role prompt delivery will be a later explicit feature after vendor-specific
startup behavior is tested.

- [ ] **Step 3: Add dedicated worktree allocation**

For `dedicated` members, resolve or allocate the worktree cwd in `teamRuntime`
before dispatching `team.workspace.create`. The core action receives resolved
member specs with final `launch.cwd` values and creates sessions only after that
resolution is complete. If allocation fails, fail workspace creation before
dispatch and return an actionable error. Do not create a write-capable member in
the shared cwd as a fallback.

- [ ] **Step 4: Run team runtime tests**

Run:

```bash
npm run test -- apps/desktop/src/main/teamRuntime.test.ts apps/desktop/src/main/worktreeRuntime.test.ts
```

Expected: team worktree policy tests pass and existing worktree tests still
pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/teamRuntime.ts apps/desktop/src/main/teamRuntime.test.ts apps/desktop/src/main/worktreeRuntime.ts
git commit -m "feat: apply worktree policy to team presets"
```

## Deferred Work: Fake tmux Compatibility Shim

The fake `tmux` shim is intentionally outside this MVP. Revisit it only after
the native Team Workspace workflow has been used as a daily driver and there is
clear evidence that Claude Code Agent Teams users want tmux-compatible
automation inside kmux.

If it is added later, keep these constraints:

- implement it as an adapter over native `surfaceId`/`sessionId`, never as core
  product state
- scope adapter pane tokens by the invoking surface/session auth token
- support only the validated command subset
- fail loudly for unsupported tmux commands
- reuse `surface.capture` auth and pty-host input acknowledgement

## Task 8: Add E2E Coverage and Docs

**Files:**

- Create: `tests/e2e/kmux-agent-team-workspace.spec.ts`
- Modify: `docs/product-spec.md`
- Modify: `docs/development.md`
- Modify: `README.md` only if the feature is ready for user-facing release notes

- [ ] **Step 1: Add e2e smoke flow**

The e2e test should:

1. Launch kmux.
2. Create a team workspace.
3. Assert three member surfaces exist: `lead`, `developer`, and `reviewer`.
4. Send a message to `developer`.
5. Capture the developer surface and assert the text appears.
6. Switch away and back to the workspace.
7. Assert terminal bodies are still nonblank and the active surface is stable.

- [ ] **Step 2: Update product spec**

Add a section under Feature Scope:

```markdown
### Agent Team Workspaces

- Create a team workspace from a built-in preset
- Map team member aliases to stable surfaces
- Route messages to one member by alias
- Record route logs with delivery status
- Default write-capable members to dedicated worktrees
- Fail workspace creation if dedicated worktree allocation fails
- Provide bounded terminal capture for automation
- Require matching auth tokens for terminal capture over the socket API
- Acknowledge input only after the pty-host receives a live-session write request
```

- [ ] **Step 3: Run full verification**

Run:

```bash
npm run test
npm run build
npm run test:e2e
```

Expected: all verification commands pass.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/kmux-agent-team-workspace.spec.ts docs/product-spec.md docs/development.md README.md
git commit -m "test: cover agent team workspace workflow"
```

## Self-Review

- Spec coverage: ADR MVP requirements map to Tasks 1 through 8.
- Deferred scope: fake tmux and broadcast are explicitly non-MVP and have no
  implementation checkboxes in this plan.
- Type consistency: team member, route log, capture, and send result names are consistent across proto, core, main, CLI, and renderer tasks.
- Scope control: fake tmux, Telegram/PWA bridges, iTerm compatibility, and broadcast routing are intentionally excluded from the MVP. They should build on the native socket APIs only after native Team Workspace usage is validated.

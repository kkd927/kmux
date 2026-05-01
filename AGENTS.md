# AGENTS.md

## kmux focus

`kmux` is a terminal app for working with coding AI agents such as Claude Code, Codex CLI, and Gemini CLI.

The product should prioritize reliable multi-surface agent workflows: agent output must stay stable, readable, and unbroken while users switch surfaces, split panes, restore sessions, and keep multiple agent conversations running side by side.

When changing terminal, pane, surface, restore, or rendering behavior, treat coding-agent output continuity as a primary product requirement.

## Bug and issue workflow

For bugs, regressions, and "something is broken" tasks, follow this loop exactly:

1. Lock the reproduction first.
   - Capture an exact reproduction script: CLI command, Playwright scenario, failing test, or precise manual steps with expected vs actual behavior.
   - If the issue is not reproducible yet, stop and ask the user for concrete reproduction steps. Do not guess at causes and do not start writing speculative tests.
2. Trace the real failing boundary.
   - Use logs, instrumentation, debugger output, or targeted code tracing to identify the owning layer and the actual root cause.
   - Do not mistake a symptom for a root cause.
3. Fix the root cause.
   - Prefer the correct ownership boundary and data flow.
   - Avoid band-aids such as sleeps, retries, guard-only patches, UI-only masking, or state duplication unless the user explicitly accepts a temporary workaround.
4. Verify with the same reproduction.
   - Re-run the exact same script or steps used to reproduce the issue.
   - The task is not done because new tests pass; it is done only when the original reproduction no longer fails and the affected behavior works end-to-end.
5. Add regression coverage only if it protects the real contract exposed by the reproduction.

Hard bans:

- No speculative "probably this" fixes without a locked repro or direct evidence.
- No "tests passed so I'm done" while the original issue has not been rechecked.
- No test padding that papers over the fact the bug still reproduces.

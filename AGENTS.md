# AGENTS.md

## kmux focus

`kmux` is a terminal app for working with coding AI agents such as Claude Code, Codex CLI, and Gemini CLI.

The product should prioritize reliable multi-surface agent workflows: agent output must stay stable, readable, and unbroken while users switch surfaces, split panes, restore sessions, and keep multiple agent conversations running side by side.

When changing terminal, pane, surface, restore, or rendering behavior, treat coding-agent output continuity as a primary product requirement.

## Test discipline

Do not add or expand automated tests merely because code changed. Tests are for behavior important enough that CI should prevent it from regressing.

- Do not add tests for trivial visual or mechanical edits such as pixel-level spacing, alignment, colors, copy changes, simple element moves, or removal of UI that has no meaningful behavioral contract.
- Add tests for significant logic and durable contracts such as state transitions, data transformations, persistence and restore behavior, process or session lifecycle, security boundaries, error handling, and regressions that would materially affect users.
- For minor UI changes, use proportionate visual or manual verification when useful instead of encoding incidental markup, text, or CSS details into CI.
- When removing behavior, remove obsolete tests and fixtures. Do not replace them with negative assertions unless absence is itself a meaningful product requirement or a credible regression risk.
- Test a rule at the layer that owns it. Avoid duplicating the same assertion across normalization, state, and rendering layers.
- Prefer observable outcomes over implementation details. Keep every assertion relevant to the behavior named by the test.

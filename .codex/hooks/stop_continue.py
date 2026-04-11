#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from pathlib import Path


REPO_CODE_PREFIXES = (
    "apps/",
    "packages/",
    "scripts/",
    "tests/",
)

REPO_CODE_FILES = {
    "package.json",
    "package-lock.json",
    "cmux.png",
    "playwright.config.ts",
    "tsconfig.json",
    "tsconfig.base.json",
    "eslint.config.js",
    "eslint.config.mjs",
}

DESKTOP_RUNTIME_PREFIXES = (
    "apps/desktop/src/main/",
    "apps/desktop/src/preload/",
    "apps/desktop/src/pty-host/",
    "apps/desktop/src/renderer/",
    "packages/core/",
    "packages/proto/",
    "packages/persistence/",
    "packages/metadata/",
    "packages/cli/",
    "packages/ui/",
    "tests/e2e/",
)

VISUAL_PREFIXES = (
    "apps/desktop/src/renderer/",
    "packages/ui/",
    "tests/e2e/",
)

DESKTOP_RUNTIME_FILES = {
    "package.json",
    "playwright.config.ts",
    "scripts/capture-reference-scene.mjs",
    "scripts/capture-live-cmux-scene.mjs",
}

VISUAL_FILES = {
    "cmux.png",
    "playwright.config.ts",
    "scripts/capture-reference-scene.mjs",
    "scripts/capture-live-cmux-scene.mjs",
}

CODE_SUFFIXES = (
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
)


def run(cmd, cwd):
    completed = subprocess.run(
        cmd,
        cwd=cwd,
        text=True,
        capture_output=True,
    )
    output = (completed.stdout or "") + (completed.stderr or "")
    return completed.returncode, output


def repo_root_from(cwd):
    code, output = run(["git", "rev-parse", "--show-toplevel"], cwd)
    if code == 0:
        return output.strip(), True
    return cwd, False


def changed_files(cwd, git_available):
    paths = set()

    if not git_available:
        return []

    commands = [
        ["git", "diff", "--name-only"],
        ["git", "diff", "--cached", "--name-only"],
        ["git", "ls-files", "--others", "--exclude-standard"],
    ]

    for cmd in commands:
        code, output = run(cmd, cwd)
        if code != 0:
            continue
        for line in output.splitlines():
            line = line.strip()
            if line:
                paths.add(line)

    return sorted(paths)


def is_repo_code_path(path):
    if path in REPO_CODE_FILES:
        return True
    if path.startswith(REPO_CODE_PREFIXES):
        return True
    return path.endswith(CODE_SUFFIXES) and not path.startswith(".codex/")


def touches_desktop_runtime(path):
    if path in DESKTOP_RUNTIME_FILES:
        return True
    return path.startswith(DESKTOP_RUNTIME_PREFIXES)


def touches_visual_surface(path):
    if path in VISUAL_FILES:
        return True
    return path.startswith(VISUAL_PREFIXES)


def validate_required_patterns(path, patterns):
    text = path.read_text(encoding="utf-8")
    missing = [pattern for pattern in patterns if pattern not in text]
    if missing:
        raise ValueError(f"missing required content: {', '.join(missing)}")
    if text.count('"""') % 2 != 0:
        raise ValueError("unbalanced triple quotes")


def validate_project_codex_config(repo_root):
    config_path = Path(repo_root) / ".codex/config.toml"
    validate_required_patterns(
        config_path,
        [
            'model = "gpt-5.4"',
            'model_reasoning_effort = "xhigh"',
            'approval_policy = "on-request"',
            'sandbox_mode = "workspace-write"',
            "[features]",
            "codex_hooks = true",
            "[agents]",
            "max_threads = 6",
            "max_depth = 1",
        ],
    )


def validate_project_agents(repo_root):
    agent_dir = Path(repo_root) / ".codex/agents"
    required_agents = {
        "electron-pro.toml",
        "electron-debugger.toml",
        "reviewer.toml",
        "test-automator.toml",
        "qa-expert.toml",
        "ui-designer.toml",
    }

    present = {path.name for path in agent_dir.glob("*.toml")}
    missing = sorted(required_agents - present)
    if missing:
        raise ValueError(f"missing agent files: {', '.join(missing)}")

    required_keys = [
        "name = ",
        "description = ",
        "model = ",
        "model_reasoning_effort = ",
        "sandbox_mode = ",
        'developer_instructions = """',
    ]

    for filename in required_agents:
        validate_required_patterns(agent_dir / filename, required_keys)


def live_cmux_app_path():
    env_path = os.environ.get("KMUX_CMUX_APP_PATH")
    if env_path:
        return Path(env_path)
    return Path("/Applications/cmux.app")


def has_live_cmux():
    app_path = live_cmux_app_path()
    executable_path = app_path / "Contents" / "MacOS" / "cmux"
    return app_path.exists() and executable_path.exists()


def meta_checks(repo_root, changed, git_available):
    checks = []
    meta_paths = {
        "AGENTS.md",
        ".codex/config.toml",
        ".codex/hooks.json",
        ".codex/hooks/stop_continue.py",
    }

    if (not git_available) or any(path in meta_paths or path.startswith(".codex/agents/") for path in changed):
        checks.append(
            (
                "validate kmux codex config",
                [sys.executable, str(Path(repo_root) / ".codex/hooks/stop_continue.py"), "--self-check"],
            )
        )

    return checks


def automated_checks(changed, git_available):
    checks = []

    needs_core = (not git_available) or any(is_repo_code_path(path) for path in changed)
    needs_runtime = (not git_available) or any(touches_desktop_runtime(path) for path in changed)

    if needs_core:
        checks.append(("npm run test", ["npm", "run", "test"]))
        checks.append(("npm run lint", ["npm", "run", "lint"]))

    if needs_runtime:
        checks.append(("npm run build", ["npm", "run", "build"]))

    return checks


def run_checks(repo_root, checks):
    failed = []
    for label, cmd in checks:
        code, output = run(cmd, repo_root)
        if code != 0:
            failed.append((label, output[-4000:]))
    return failed


def print_json(payload):
    json.dump(payload, sys.stdout)


def self_check(repo_root):
    validate_project_codex_config(repo_root)
    validate_project_agents(repo_root)

    hooks_path = Path(repo_root) / ".codex/hooks.json"
    json.loads(hooks_path.read_text(encoding="utf-8"))

    py_compile_cmd = [sys.executable, "-m", "py_compile", str(Path(repo_root) / ".codex/hooks/stop_continue.py")]
    code, output = run(py_compile_cmd, repo_root)
    if code != 0:
        raise ValueError(output.strip() or "failed to compile stop_continue.py")


def main():
    cwd = os.getcwd()

    if len(sys.argv) > 1 and sys.argv[1] == "--self-check":
        repo_root, _ = repo_root_from(cwd)
        try:
            self_check(repo_root)
        except Exception as exc:  # pragma: no cover - defensive guard for hook runtime
            print(str(exc), file=sys.stderr)
            return 1
        return 0

    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        payload = {}

    cwd = payload.get("cwd") or cwd
    repo_root, git_available = repo_root_from(cwd)
    changed = changed_files(repo_root, git_available)

    checks = []
    checks.extend(meta_checks(repo_root, changed, git_available))
    checks.extend(automated_checks(changed, git_available))

    failed = run_checks(repo_root, checks)

    if failed:
        changed_summary = ", ".join(changed) if changed else "(git change detection unavailable; ran conservative checks)"
        summary = "\n\n".join(
            f"[FAILED] {label}\n{output}".rstrip() for label, output in failed
        )
        print_json(
            {
                "decision": "block",
                "reason": (
                    "The task is not complete yet. Re-enter the implement -> verify -> repair loop. "
                    "Do not stop until the relevant kmux checks pass. "
                    "Use visual parity capture as an explicit follow-up step when the task requires design or cmux comparison.\n\n"
                    f"Changed files: {changed_summary}\n\n"
                    f"{summary}"
                ),
            }
        )
        return 0

    print_json({"continue": True})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

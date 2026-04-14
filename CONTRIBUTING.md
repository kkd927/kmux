# Contributing To kmux

Thanks for your interest in contributing.

## Before You Start

- Read the product scope in [docs/product-spec.md](./docs/product-spec.md).
- Read the architecture decision in [docs/adr/0002-electron-xterm-mvp-architecture.md](./docs/adr/0002-electron-xterm-mvp-architecture.md).
- For larger changes, open an issue or discussion before starting implementation.

## Local Setup

```bash
npm install
npm run dev
```

Additional contributor workflow notes live in [docs/development.md](./docs/development.md).

## What Good Contributions Look Like

- Keep changes scoped to one clear problem.
- Preserve the main architecture boundaries.
- Add or update tests when behavior changes.
- Update docs when the user experience or developer workflow changes.
- Avoid unrelated cleanup in the same pull request.

## Validation Expectations

Before opening a pull request, run the narrowest relevant checks first and then the broader project checks that apply:

- `npm run test`
- `npm run lint`
- `npm run build`
- `npm run test:e2e` for UI, runtime, automation, or restore changes

## Pull Request Checklist

- Explain what changed and why.
- Call out any user-facing impact.
- Mention the checks you ran.
- Note any follow-up work or known limitations.

## Ground Rules

- Be respectful and constructive.
- Keep security-sensitive details out of public issues and pull requests.
- By contributing, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

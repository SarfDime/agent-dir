# Workflow

Scoped from AGENTS.md. Read this when branching, opening a PR or merging.

## Model

feature branch -> PR -> main -> release workflow -> npm and GitHub release

## Rules

- Develop on a short-lived feature, fix or docs branch.
- Open pull requests directly into `main`.
- CI runs on pushes to `main` and on pull requests targeting `main`.
- Do not push to `main` or bypass branch protection.
- Do not create or recreate a permanent `staging` branch. Use pull requests, CI and deployment previews for integration.
- The maintainer may merge their own PRs, but `main` stays PR-only.

## Pull request checklist

- The change is focused on one concern.
- The checks in docs/AGENTS-VALIDATION.md pass locally.
- Commit messages follow docs/AGENTS-COMMITS.md.
- The security invariants in AGENTS.md are intact.

## Merging

Merge only when the required `Check` status is green and the required review is approved. A failing check is never bypassed.

# Commits

Scoped from AGENTS.md. Read this when writing commit messages or judging release impact.

semantic-release derives the next version from Conventional Commit history.

| Commit | Release |
|---|---|
| `fix: ...` | patch |
| `feat: ...` | minor |
| `feat!: ...` | major |
| `BREAKING CHANGE:` footer | major |
| `docs:`, `test:`, `chore:`, `refactor:`, `ci:` | none by default |

## Rules

- The commit type must describe the actual change. Never change the type to force a release.
- This repository explicitly sets `fix(ci)` to no release. A CI-only repair must not create a package release.
- A breaking change needs both `!` and a `BREAKING CHANGE:` footer explaining the migration.
- One logical change per commit; keep the subject imperative and under about 72 characters.
- The automated release commit is `chore(release): X.Y.Z [skip ci]`. Never create or edit one by hand.

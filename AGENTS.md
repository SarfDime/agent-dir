# Agent instructions for agent-dir

## Project workflow

This repository uses a protected two-branch release flow:

    feature/* → PR → staging → promotion PR → main → Release workflow → npm/GitHub release

- Do normal development on a feature branch.
- Open pull requests into `staging`.
- CI runs on pull requests targeting `staging` and `main`.
- Promote `staging` to `main` through a pull request.
- Do not push directly to `main` or `staging`.
- Do not merge a feature branch directly into `main`.
- Do not bypass branch protection.
- The repository maintainer may merge their own PRs, but protected branches remain PR-only.

## Before opening or merging a PR

Run the same checks used by CI:

    npm run check
    npm test
    npm pack --dry-run

Review the `npm pack --dry-run` file list for accidental source-only files, credentials, local configuration, or development artifacts.

Keep changes focused. Preserve the authentication model, project-root filesystem safety, command allowlists, and non-shell command execution.

## Release rules

Releases are fully automated by `.github/workflows/publish.yml`.

That workflow runs only after a push to `main`. It installs dependencies, runs the checks and package dry-run, then runs semantic-release.

The release workflow is the only normal publishing path.

### Never do these for a normal release

- Do not manually edit `package.json` or `package-lock.json` to bump the version.
- Do not run `npm publish` locally.
- Do not create or move `vX.Y.Z` tags manually.
- Do not create GitHub Releases manually for a normal release.
- Do not rename `.github/workflows/publish.yml`; npm Trusted Publishing is tied to this workflow identity.
- Do not use arbitrary commit messages such as `bump version` to force a release.
- Do not push directly to `main`.

## Conventional Commits

semantic-release determines the next version from commit history:

| Commit | Release |
|---|---|
| `fix: ...` | patch |
| `feat: ...` | minor |
| `feat!: ...` | major |
| `BREAKING CHANGE:` footer | major |
| `docs:`, `test:`, `chore:`, `refactor:`, `ci:` | no release by default |

This repository explicitly treats `fix(ci)` as no release. CI-only fixes must not be used to create package releases.

## What an agent should do when asked to publish

1. Make the code/documentation changes.
2. Run `npm run check`, `npm test`, and `npm pack --dry-run`.
3. Commit with the correct Conventional Commit type.
4. Push the feature branch.
5. Open a PR to `staging`.
6. Wait for CI to pass and merge the PR into `staging`.
7. Open/promote `staging` into `main`.
8. Wait for the main-branch CI check and merge the promotion PR.
9. Verify the `Release` workflow completed.
10. Verify the resulting npm version, Git tag, and GitHub Release when semantic-release determined a release was required.

If the change is not release-worthy, follow the same branch/PR flow but do not artificially change the commit type just to publish.

## Release troubleshooting

A failed release workflow does not automatically mean a new version is needed.

Before retrying or changing release metadata, inspect the Release workflow, semantic-release output, current package version, latest release tag, and published npm version.

Never create a replacement tag or manually bump the version to recover from a failed workflow without first establishing the actual release state.

See `docs/RELEASING.md` for the detailed release procedure and invariants.
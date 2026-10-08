# Releasing agent-dir

This document is the authoritative maintainer/agent procedure for publishing `agent-dir`.

## Architecture

    feature/*
        │
        ├── PR → staging
        │        └── CI
        │
        └── promotion PR → main
                 └── CI
                      │
                      ▼
            .github/workflows/publish.yml
                      │
                      ├── npm run check
                      ├── npm test
                      ├── npm pack --dry-run
                      └── npm run release
                             │
                             └── semantic-release
                                  ├── determine SemVer
                                  ├── update package.json/package-lock.json
                                  ├── commit release
                                  ├── create vX.Y.Z tag
                                  ├── create GitHub Release
                                  └── publish npm package

`main` and `staging` are protected. Normal human and agent changes reach them through pull requests.

## Release source of truth

- `.releaserc.json` — semantic-release configuration
- `.github/workflows/publish.yml` — production release workflow
- `package.json` — package metadata and release script
- npm Trusted Publishing/OIDC — npm authentication for GitHub Actions

The workflow filename `publish.yml` is intentional. Do not rename it. npm Trusted Publishing is configured against the workflow identity.

The semantic-release repository URL uses SSH: `git@github.com:SarfDime/agent-dir.git`.

The release workflow uses the repository's release SSH key to allow semantic-release to update protected `main` with its release commit/tag.

## Normal release procedure

### 1. Make the change

Work on a feature branch. Keep the change focused. Use a Conventional Commit message whose type reflects the intended release impact.

Examples: `fix: handle tunnel reconnect`, `feat: add project snapshots`, `feat!: change authentication protocol`.

Do not manually edit the package version.

### 2. Validate locally

    npm run check
    npm test
    npm pack --dry-run

`npm pack --dry-run` is important: inspect the file list and make sure the package does not contain credentials, local configuration, development-only files, or other unintended content.

### 3. Merge through staging

Push the feature branch and open a PR targeting `staging`.

The required CI check is `Check`. It runs `npm ci`, `npm run check`, `npm test`, and `npm pack --dry-run`.

Do not bypass a failing check. After checks pass, merge the PR into `staging`.

### 4. Promote staging to main

Create a promotion PR: `staging → main`.

CI runs again because `main` is also a pull-request target. Merge only after the required `Check` status is green.

### 5. Let GitHub Actions publish

The merge to `main` creates a push to `main`, which starts `.github/workflows/publish.yml`.

The workflow validates the package again and invokes `npm run release`.

Do not run `npm publish` locally and do not manually create a release tag.

semantic-release reads the Conventional Commit history since the previous release and decides whether a release is required.

## Version rules

| Change | Version impact |
|---|---|
| `fix:` | patch |
| `feat:` | minor |
| `feat!:` | major |
| `BREAKING CHANGE:` footer | major |
| `docs:` | none |
| `test:` | none |
| `chore:` | none |
| `refactor:` | none |
| `ci:` | none |

There is an explicit semantic-release rule: `fix(ci)` has `release: false`.

A CI-only repair can be promoted to `main` without creating a package release. Do not change its commit type merely to force publication.

## What semantic-release changes

When a release is required, semantic-release is responsible for:

- calculating the next SemVer version;
- updating `package.json`;
- updating `package-lock.json`;
- creating the release commit with `[skip ci]`;
- creating the `vX.Y.Z` Git tag;
- creating the GitHub Release;
- publishing the package to npm.

The release commit is `chore(release): <version> [skip ci]`. The release commit itself must not start another release cycle.

## npm authentication

npm publishing is performed by GitHub Actions using npm Trusted Publishing/OIDC.

The workflow requests `id-token: write`. Do not add an npm token to the workflow unless the publishing architecture is deliberately changed and reconfigured.

Do not expose or print npm credentials.

`GITHUB_TOKEN` is separate from npm authentication and is used by semantic-release for GitHub release operations. The repository currently supplies the release workflow's GitHub credential through the `RELEASE_TOKEN` Actions secret.

## Protected-branch automation

The release workflow needs to write the semantic-release commit/tag back to `main`, even though normal pushes to `main` are blocked.

That automation is authorized separately through the release SSH deploy key stored in the `RELEASE_DEPLOY_KEY_B64` Actions secret.

Do not remove or replace this mechanism casually. If it must change, verify the complete release flow and npm Trusted Publishing configuration before merging the change.

The intended security boundary is:

- humans/agents: PR-only changes;
- release automation: narrowly authorized to perform the semantic-release update on `main`.

## How to verify a release

After a release-worthy change reaches `main`, verify:

1. The `Release` workflow completed successfully.
2. semantic-release reported the expected next version.
3. The repository has a matching `vX.Y.Z` tag.
4. The GitHub Release exists for that tag.
5. npm reports the expected package version.
6. `package.json` and `package-lock.json` on `main` contain the released version after the release commit.

The package version and release tag must agree: `package.json version = X.Y.Z` and `Git tag = vX.Y.Z`.

## When a release does not happen

A successful `Release` workflow can legitimately produce no release when commits since the previous release contain no release-worthy Conventional Commit.

Examples: `docs: update README`, `test: add regression coverage`, `chore: update development tooling`, `fix(ci): correct workflow configuration`.

Do not interpret a successful workflow with no release as a publishing failure.

## Release failure recovery

When a release fails:

1. Inspect the exact failing workflow step.
2. Determine whether semantic-release calculated a release.
3. Check the latest Git tag.
4. Check the current npm published version.
5. Check whether a GitHub Release was created.
6. Check whether the release commit was created.
7. Only then decide whether another change or rerun is appropriate.

Do not manually bump the version, move/delete/recreate an existing release tag, run `npm publish` from a workstation, create a second tag for the same version, or rewrite commit history just to make semantic-release produce a version.

If a release was partially created, reconcile the actual Git/npm/GitHub state before making another release attempt.

## CI workflow constraints

`.github/workflows/ci.yml` runs for pull requests targeting `staging` and `main`.

Its concurrency key must remain safe for both PR events and any diagnostic/manual event that may temporarily be introduced:

    group: ci-${{ github.event.pull_request.number || github.ref }}

Do not replace this with a direct `pull_request.number` reference.

The production release workflow intentionally runs only on pushes to `main`:

    on:
      push:
        branches:
          - main

Keep release execution serialized:

    concurrency:
      group: release
      cancel-in-progress: false

## Files an agent should inspect first

    AGENTS.md
    docs/RELEASING.md
    .releaserc.json
    package.json
    .github/workflows/ci.yml
    .github/workflows/publish.yml
    .github/CONTRIBUTING.md

Do not assume the release process from generic npm conventions. This repository's protected-branch and Trusted Publishing configuration is intentional.
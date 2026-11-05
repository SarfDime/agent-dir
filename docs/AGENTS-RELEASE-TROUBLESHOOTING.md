# Release troubleshooting

Scoped from AGENTS.md. Read this when a release failed, looked wrong or appeared not to happen.

## A failed workflow is not proof a new version is needed

Establish the actual state before changing anything:

1. Read the exact failing workflow step.
2. Check whether semantic-release calculated a release.
3. Check the latest Git tag.
4. Check the currently published npm version.
5. Check whether a GitHub Release exists.
6. Check whether the release commit exists on `main`.
7. Check `package.json` and `package-lock.json` on `main`.

Only then decide whether to rerun or change something.

## A successful run with no release is normal

No release-worthy Conventional Commit since the previous release means no version. `docs:`, `test:`, `chore:`, `refactor:`, `ci:` and `fix(ci)` do not publish.

## Never do these

- Do not manually bump the version.
- Do not move, delete or recreate an existing release tag.
- Do not create a second tag for the same version.
- Do not run `npm publish` from a workstation.
- Do not rewrite commit history to make semantic-release produce a version.

If a release was partially created, reconcile the real Git, npm and GitHub state first. A blocked GitHub Actions runner is not a reason to publish manually: verify the npm version first.

See docs/RELEASING.md for the authoritative recovery procedure.

# Publishing

Scoped from AGENTS.md. Read this when a change should reach npm or GitHub releases.

## Path

Releases are fully automated by `.github/workflows/publish.yml`, which runs only after a push to `main`. It installs dependencies, runs the checks and package dry-run, then runs semantic-release. That workflow is the only normal publishing path.

## Procedure

1. Make the code or documentation change on a branch.
2. Run `npm run check`, `npm test` and `npm pack --dry-run` (docs/AGENTS-VALIDATION.md).
3. Commit with the correct Conventional Commit type (docs/AGENTS-COMMITS.md).
4. Push the branch and open a PR targeting `main` (docs/AGENTS-WORKFLOW.md).
5. Merge after the required `Check` status is green and the review is approved.
6. Verify the `Release` workflow completed.
7. Verify the npm version, Git tag and GitHub Release when semantic-release produced a release.

## Never do these

- Do not edit `package.json` or `package-lock.json` to bump the version.
- Do not run `npm publish` locally.
- Do not create, move or delete `vX.Y.Z` tags by hand.
- Do not create GitHub Releases by hand for a normal release.
- Do not rename `.github/workflows/publish.yml`: npm Trusted Publishing is bound to that workflow identity.
- Do not use arbitrary commit messages such as `bump version` to force a release.
- Do not push to `main`.

## Not release-worthy

A change that does not need a release still goes through the same branch and PR flow. Do not inflate the commit type to publish it.

See docs/RELEASING.md for the full invariants and credential boundaries.

# Validation

Scoped from AGENTS.md. Read this before opening or merging a PR.

## Commands

    npm run check
    npm test
    npm pack --dry-run

`npm run check` runs Biome over TypeScript and JSON plus `tsc --noEmit`. `npm test` builds and runs the node test suite.

## Targeted validation

Prefer the narrowest check that answers the question. A type or lint question is answered by `npm run check`, not by the full suite. CI runs the same three commands on pushes to `main` and on pull requests.

## Package review

Inspect the `npm pack --dry-run` file list for credentials, local configuration, source-only files and development artifacts. This is the last cheap place to catch a packaging mistake.

## Formatting scope

Biome covers TypeScript and JSON only. Markdown and `.serena/` are excluded in `biome.json` on purpose: Biome rewrites every table cell width, so a one-cell doc edit produces a whole-file diff. Keep docs out of the formatter and keep `npm run check` green.

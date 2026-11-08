# Future watchlist

This file tracks only work that still needs future evidence or action. Completed audit findings and refactor
phases have been removed. Repository checks and the completed changes are covered by the test suite and
project documentation.

## After release: establish a clean baseline

After `feature/mcp-refactor` is released, collect a fresh telemetry window from the current build and compare
`toolSetHash` before comparing tool-list size or behavior. Keep the sample attributable to the current
build; do not combine it with older sessions. Profiles use whichever build was opened, so old version
labels describe old sessions and do not require a per-profile build investigation.

Use the fresh window to assess the existing reliability and output-size targets against ordinary use.
Separate deliberate validation, truncation, and stress probes from normal-use rates, and report sample
counts and denominators. Do not treat the small stress-test run as a representative performance baseline.

## Measurement-gated improvements

Do not implement these without the stated evidence:

| Item | Revisit when |
| --- | --- |
| Stream `telemetry_analytics` reads (O-2.05) | Analytics latency exceeds about one second on a large telemetry store. |
| Asynchronous telemetry appends (O-2.11) | A measurable request-latency effect is found, or a deliberate durability trade-off is approved. |
| Watcher-based file indexing (O-4.11) | Measurements on a large repository justify the added invalidation complexity. |

## Release watch-out

Removing the `validate` tool is a breaking change. Follow [RELEASING.md](./RELEASING.md): preserve the
release-worthy commit history when merging, or ensure a squash commit uses `feat!` and a `BREAKING CHANGE:`
footer so semantic-release makes the required major release.

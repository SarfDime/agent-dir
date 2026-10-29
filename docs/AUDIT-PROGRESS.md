# Agent Dir: open issues

This file lists only what is still open from the 2026-10-18 efficiency and reliability audit. Everything
that was completed is in the git history, in `docs/MIGRATION.md`, and in the 2026-10-29 cost audit at
`docs/AUDIT-EFFICIENCY.md`; the long per-phase tables were removed on 2026-10-29 because they described
work that had already shipped.

Status: `[~]` partial, `[!]` blocked on a decision, `[-]` deferred. Priority: P1 high, P2 medium, P3
exploratory. Effort: S under a day, M 1-3 days, L more.

Standing constraints, unchanged: MCP `2025-11-25` compatibility is mandatory and `2026-07-28` stays
supported; keep the authentication model, project-root filesystem safety, command allowlists and non-shell
execution intact; `feature/*` → PR → `main`, never push to `main`; run `npm run check`, `npm test` and
`npm pack --dry-run` before a PR; breaking changes use `feat!:` / `BREAKING CHANGE:` and versions are never
hand-bumped.

## Code and measurement

| ID   | Pri | Eff | What remains | What would close it |
| --- | --- | --- | --- | --- |
| 2.09 | P1 | M | Typed error classes instead of message matching. `policy_denied`, `not_found`, `invalid_input`, `unavailable_integration`, `unknown_tool` and `timeout` are already classified first, but by matching our own strings. | Throw typed errors from the tools and map them in one place. No user-visible change expected, so it needs no behavioural window. |
| 2.05 | P2 | M | Streaming analytics reader. Retention, file-level filtering, side-effect-free reads and `prune` are in place; `telemetry_analytics` still loads the filtered files into memory, bounded by the retention cap. | Measure analytics latency above ~1 s on a large store, then stream. Without that measurement this is speculative. |
| 2.11 | P3 | S | Asynchronous telemetry appends. Directory creation and chmod already happen once per file; appends are still synchronous. | A measured latency effect, or an explicit decision to trade durability for speed. |
| 4.11 | P3 | M | Watcher-based file index. The 2 s cached file list is in place. | A measurement on a large repository that justifies the invalidation complexity; none exists yet. |
| 6.03 | P1 | S | Behavioural re-baseline. Structural metrics are done; the numbers in `docs/AUDIT-EFFICIENCY.md` are the freshest behavioural measurement available, but they mix builds (versions 1.1.1 to 1.3.0). | Run the same aggregation on a window produced only by the current build, and compare `toolSetHash` first. |

## Execution policy and tool surface

| ID   | Pri | Eff | What remains | What would close it |
| --- | --- | --- | --- | --- |
| 4c-1 | P1 | M | Ignored trees are invisible to `search_code` and `find_files`: `node_modules`, `dist`, `build`, `coverage`, `target` and everything `.gitignore`d. `read_range` can still open a known path, so only discovery is missing. | An `includeIgnored` option on both tools, or a documented decision that vendored code is out of scope. |
| 4c-2 | P2 | S | `git grep` and `git log -S` bypass the removal of shell search commands while `git` stays allowed. | `commandPolicy.rules.git` with `denySubcommands: ["grep"]` and `denyOptions: ["-S", "-G"]`, plus a test. |
| 4c-3 | P2 | S | One query per `search_code` call. Several unrelated patterns need several round trips; agents currently batch them into `run_command_batch`. | A `queries: string[]` argument that returns labelled result groups. |
| 4c-4 | P3 | S | `docs/CONFIGURATION.md` still shows `--command grep,find,rg,git` in its example, which contradicts the recommendation to drop them. | Update the example once the §4c decision is applied to a real profile. |

## Decisions still standing

- D-02: an OS sandbox stays a separate future enhancement, not part of the guardrail model. It needs
  bubblewrap or a container runtime on the host; the allowlist is documented as a guardrail, not a security
  boundary (see `SECURITY.md`).
- Declined: a tree-sitter or ast-grep symbol index. Re-adding an AST parser reintroduces the dependency this
  release removed, and CodeGraph covers structural navigation where it is installed. Revisit only with
  evidence that `find_symbol` misses real cases in a project without CodeGraph.

## Where the detail lives

- `docs/AUDIT-EFFICIENCY.md`: the 2026-10-29 cost audit, which supersedes the metrics in the old sections.
- `docs/MIGRATION.md`: every breaking change of the 2.0 line.
- `docs/telemetry.md`: levels, the privacy allowlist invariant, guidance experiments, how to read a window.
- `docs/CONFIGURATION.md`: profiles, command policy, protected paths.

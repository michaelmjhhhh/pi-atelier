# Sidebar height fitting — issue #59

Scope: replace render-based height measurement in `src/sidebar.ts`. No changes to Git scheduling, snapshot caching, telemetry, TODO policy or panel presentation.

## Implementation

`composeGroups()` previously called `renderGroups()` after every candidate removal to obtain a line count, then the caller painted the final selection again. It now counts content rows and adds three decoration rows for each contiguous panel: header, bottom border and trailing blank line.

The row count is independent of width because panel rows are truncated, not wrapped. Adjacent groups share decoration only when both panel title and panel ID match. Unpanelled groups interrupt adjacency and contribute only their content rows. Empty groups are filtered before measurement.

The drop-selection loop is unchanged: required groups are retained, equal ranks retain their original tie order, and matching nonempty names are removed together (including the two `workspaceCore` groups). After each removal the remaining row metadata is recounted, so panel disappearance or newly adjacent groups cannot leave stale decoration counts. `renderGroups()` runs once after selection, and the existing dock still clips required content when necessary.

Selection retains O(G²) worst-case bookkeeping over G groups. It no longer does repeated painting proportional to the candidate text volume. This small change avoids adding persistent caches or a more complex incremental layout structure; the measured result already meets the issue's initial target.

## Reproduction

The focused, opt-in probe uses the same 0/8/64-panel fixture as the original exploration. It transpiles source into a temporary directory, uses the installed Pi dependencies, and removes temporary files on completion. `--ref` loads source from a Git commit without changing the checkout. It performs no TUI correctness assertions, opens no interactive session and starts no Git worktree inspection.

From the repository root:

```sh
node scripts/benchmark-sidebar.mjs --ref 2cf8e77047a32d7a61c4dfffdac4e00c7834cc59
node scripts/benchmark-sidebar.mjs
```

Environment: Node 22.22.2, macOS arm64, Pi 0.84.0. Fixed 40-column × 40-row sidebar; inert snapshot; identity theme functions; color disabled; fixed clock; three warmups followed by ten samples per case. Each contributed panel contains 24 rows with a short prefix followed by 140 `x` characters. Setup/transpilation is excluded from timings. Each invocation prints its source revision, environment and individual timing samples.

## Observed results

| Contributed panels | Before median | After median | Before range | After range |
| --- | --- | --- | --- | --- |
| 0 | 0.6544 ms | 0.6230 ms | 0.6408–0.8516 ms | 0.5919–0.8382 ms |
| 8 | 3.3537 ms | 0.9535 ms | 3.1223–3.7833 ms | 0.9003–1.4607 ms |
| 64 | 76.9954 ms | 3.8883 ms | 73.1661–82.1194 ms | 3.6997–4.0917 ms |

In this probe the 8-panel median fell about 71.6% and the 64-panel median about 94.9%. The 64-panel case is an allowed maximum stress case, not typical usage. The built-in-only difference is small and should not be treated as a demonstrated improvement. These are isolated rendering timings, not whole-Pi CPU, memory, battery or end-to-end terminal latency measurements.

## Verification

`npm run check` passed: typecheck, lint, format, all 18 existing test files / 454 tests, and package-content verification. No new TUI unit/e2e tests were added, per AGENTS.md. Existing Sidebar checks include visibility/order, height-dependent dropping, compact widths, activity and required content. Manual verification of this change remains pending; acceptance of PR #58 does not validate this change.

Open an ephemeral session with only the checkout extension:

```sh
./node_modules/.bin/pi --no-session --no-extensions -e ./extensions/index.ts
```

Manual TODO:

- [ ] In regular and fullscreen modes, shorten and expand the terminal height. Confirm the same content drops first and borders/spacers remain intact.
- [ ] Repeatedly drag the sidebar divider and cross the 39/40-column compact-layout threshold. Confirm resize guidance, padding and clipping remain correct.
- [ ] Hide and reorder panels in Settings; verify displayed order and absence of blank/orphaned panel frames.
- [ ] With TODOs, workspace changes and live tool activity, check both running and settled layouts, especially at small heights. Workspace identity and its primary Pulse rows should retain their existing joint drop behavior.
- [ ] If contributed panels are available, check multiple panels sharing a title but using different IDs; they must keep separate frames. Include Unicode/ANSI text and enough panels to force dropping.
- [ ] At very small heights, confirm required-content clipping and the minimum available-panel fallback remain unchanged.

# Workspace Pulse clean fast path — issue #61

## Change

`inspectWorkspacePulse()` returns zero line/binary changes directly when valid porcelain status contains no tracked changes. It still discovers the repository and reads status on every inspection, retaining branch, relative directory and untracked counts. Clean and untracked-only inspections use two Git commands instead of four.

All tracked records retain the existing HEAD-tree and rename-aware diff path, including staged changes, conflicts, changed submodules and first-commit additions. Empty/untracked-only unborn repositories take the fast path. A cancellation check after status prevents reporting a successful clean result after cancellation even when an executor resolves normally.

There is no discovery cache, cadence change, new watcher or change to turn-end freshness. Like the existing sequential inspection, status and diff are not an atomic filesystem snapshot; this fast path describes the state observed by status.

## Reproduce

Run from the repository root with dependencies installed:

```sh
node scripts/benchmark-workspace.mjs --ref 60377680972be1012b7568cf19d3b7f988603d61 > /tmp/workspace-before.json
node scripts/benchmark-workspace.mjs > /tmp/workspace-after.json
```

The probe transpiles real inspection source and uses a Node `execFile` adapter, not Pi's exact process wrapper. It reads the current checkout and creates isolated temporary fixtures, then removes them. Setup/transpilation is excluded. JSON includes individual samples, command timings/counts and environment. Do not run other checks concurrently with timing measurements.

Fixtures contain 10,000 tracked files of 100 lines each. The dirty case appends 100 lines to 100 tracked files. The untracked-only case restores tracked content and adds 5,000 files. Measurements use three warmups and 15 sequential samples per case, with warm filesystem caches.

## Results

Environment: Node v22.22.2, macOS arm64, Apple Git 2.50.1. Baseline source is commit `60377680972be1012b7568cf19d3b7f988603d61`; after is this change. Timings are wall time including process launch and output parsing, not child CPU, battery or memory measurements.

| Workload | Commands before → after | Median before → after | Median reduction | Before min–max | After min–max |
| --- | --- | --- | --- | --- | --- |
| current-checkout | 4 → 4 | 37.27 → 38.70 ms | -3.8% | 36.73–44.02 ms | 37.64–43.21 ms |
| 10000-tracked-clean | 4 → 2 | 56.41 → 29.74 ms | 47.3% | 55.56–60.23 ms | 28.96–76.67 ms |
| 10000-tracked-100-modified | 4 → 4 | 67.11 → 66.78 ms | 0.5% | 66.04–110.72 ms | 66.31–70.84 ms |
| 10000-tracked-5000-untracked | 4 → 2 | 60.57 → 33.53 ms | 44.6% | 60.03–68.11 ms | 32.86–37.05 ms |

The clean and untracked-only fixtures reduce median inspection time by approximately 47% and 45%. The tracked-dirty path has no intended speedup; its fixture median is effectively unchanged. The checkout contained implementation edits during both runs and therefore used four commands; its small timing variation is not evidence of a systematic regression. Outliers remain (including a 76.67 ms optimized clean sample); these runs do not establish tail-latency improvement or whole-session energy savings.

## Validation

`npm run check` passes all 18 test files / 462 tests, typecheck, lint, formatting and package verification. Eight new non-TUI inspection tests exercise two-command clean/untracked-only paths with and without commits, cancellation during status, and full inspection for a lone staged change, conflict or changed submodule. Existing coverage retains rename/binary aggregation, unborn additions and coordinator lifecycle behavior. No TUI tests were added.

Optional manual smoke check (not yet performed):

```sh
./node_modules/.bin/pi --no-session --no-extensions -e ./extensions/index.ts
```

- In a clean repository, confirm Workspace Pulse is clean after a turn.
- Add an untracked file: confirm its count updates with zero tracked line changes.
- Edit/stage a tracked file: confirm tracked and line counts update; revert and confirm clean state returns.
- Disable/re-enable Atelier and switch sessions: confirm stale workspace data does not overwrite the active session.

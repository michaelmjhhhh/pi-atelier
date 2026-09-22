# Contributing to Pi Atelier

## Scope and setup

- Open an issue before non-trivial work: new behavior, configuration, public/runtime integration, or architecture changes. Typo/docs-only fixes and narrowly scoped, obvious bug fixes may go directly to a PR; ask in an issue when unsure.
- Fork from current `main`, keep each PR to one coherent change, and rebase before review. Do not change `AGENTS.md`, `.agents/`, or `.claude/` unless the agreed issue explicitly requires it.
- Node.js `22.19.0` or newer and Pi `0.84.0` or newer are required; UI validation needs an interactive terminal.

```sh
npm install
git remote add upstream https://github.com/michaelmjhhhh/pi-atelier.git # once; skip if configured
git fetch upstream main
git rebase upstream/main
```

## Validation and pull requests

Run the complete gate before opening or updating any PR, including docs-only changes:

```sh
npm run check
git diff --check upstream/main...HEAD
```

`check` runs strict TypeScript checking, Biome format checking, Vitest, and package-content verification. The diff check covers committed changes against updated `main`; also run `git diff --check` for uncommitted edits.

Preserve useful existing tests. For non-TUI behavior changes, add regression coverage through public/runtime seams where practical, or explain the gap. Relevant cases include persisted `false` values and defaults, malformed/error payloads, empty/hidden states, session transitions, and stale events.

For TUI changes (sidebar, footer, menus, or overlays), **do not add unit or e2e tests**. Run existing checks and provide a manual TODO checklist, observed results, and a screenshot/recording or attached artifact. State terminal dimensions, OS, Pi version, and scenario. Start an ephemeral session with only the checkout extension to avoid conflicts with installed extensions:

```sh
./node_modules/.bin/pi --no-session --no-extensions -e ./extensions/index.ts
```

Use the PR template to record the problem/solution, issue link when required, validation, and any configuration, documentation, or compatibility impact. For user-visible changes, update `README.md` and `CHANGELOG.md` under `Unreleased` when applicable. Keep pending validation explicit. Conventional commit subjects are optional.

Maintainers own merging and releases. Contributors must not publish packages, change release versions, create tags/releases, or edit publishing credentials.

## Performance probes

These optional scripts compare the checkout with the original optimization baselines without changing the checkout. Run measurements sequentially, without concurrent checks. They transpile source into temporary directories using installed dependencies, exclude setup from timings, report samples/environment, and clean up afterward. Historical results remain in Git history; they do not establish current performance or completed manual QA.

**Sidebar height fitting (#59):** baseline `2cf8e77047a32d7a61c4dfffdac4e00c7834cc59`.

```sh
node scripts/benchmark-sidebar.mjs --ref 2cf8e77047a32d7a61c4dfffdac4e00c7834cc59
node scripts/benchmark-sidebar.mjs
```

The probe measures isolated rendering at 40 columns × 40 rows with 0/8/64 contributed panels (24 rows each, short prefix plus 140 `x` characters), an inert snapshot, identity theme functions, color disabled, and a fixed clock. It uses three warmups and ten samples per case, opens no TUI, performs no TUI assertions or Git inspection, and does not measure whole-Pi CPU, memory, battery, or terminal latency. The 64-panel case is maximum stress, not typical use; historical built-in-only variation did not demonstrate a speedup. Original measurements used Node 22.22.2, macOS arm64, and Pi 0.84.0.

**Workspace Pulse clean fast path (#61):** baseline `60377680972be1012b7568cf19d3b7f988603d61`.

```sh
node scripts/benchmark-workspace.mjs --ref 60377680972be1012b7568cf19d3b7f988603d61 > /tmp/workspace-before.json
node scripts/benchmark-workspace.mjs > /tmp/workspace-after.json
```

The probe inspects the current checkout and temporary fixtures with 10,000 tracked files of 100 lines each: clean; 100 tracked files each appended with 100 lines; and restored tracked content plus 5,000 untracked files. It uses three warmups and 15 sequential samples with warm filesystem caches. JSON includes command timings/counts. It uses Node `execFile`, not Pi's exact process wrapper; wall time includes process launch and output parsing, not child CPU, battery, or memory. Historical runs used Node 22.22.2, macOS arm64, and Apple Git 2.50.1. Clean/untracked-only cases use two Git commands; tracked-dirty cases retain four and have no intended speedup. Outliers and a dirty checkout prevent claims about tail latency, systematic checkout regressions, or whole-session energy savings. Status and diff are sequential observations, not an atomic filesystem snapshot.

### Pending manual performance checks

The original reports left these checks unfinished; prior PR acceptance and automated checks do not complete them. Use the isolated session above.

- [ ] In regular and fullscreen modes, shorten/expand terminal height; verify drop order and intact borders/spacers. At very small heights, verify required-content clipping and the minimum available-panel fallback.
- [ ] Repeatedly drag the sidebar divider across the 39/40-column compact threshold; verify resize guidance, padding, and clipping.
- [ ] Hide/reorder panels in Settings; verify order and no blank/orphaned frames.
- [ ] With TODOs, workspace changes, and live tool activity, check running and settled layouts at small heights. Workspace identity and primary Pulse rows must retain their joint drop behavior.
- [ ] If contributed panels are available, verify separate frames for equal titles with different IDs, Unicode/ANSI text, and enough panels to force dropping. Use only explicitly selected, nonconflicting fixture extensions in a separate run.
- [ ] In a clean repository, verify Workspace Pulse is clean after a Turn; add an untracked file and verify its count with zero tracked line changes.
- [ ] Edit/stage a tracked file, verify tracked/line counts, then revert and verify clean state returns.
- [ ] Disable/re-enable Atelier and switch sessions; verify stale workspace data cannot overwrite the active session.

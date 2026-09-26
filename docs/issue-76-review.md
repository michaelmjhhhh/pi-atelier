# PR #77 regression and mergeability audit

Reviewed 2026-09-26: PR head `a8b8759`, integrated with main `371b847`.

## Findings and resolution

- GitHub reported a merge conflict. The conflicting root-menu assertion now preserves main's removal of Actions and this PR's Manual status label.
- Added the missing Unreleased changelog entry.
- Restored the existing visibility-toggle test's original purpose through the new Sidebar submenu. No new TUI tests were added.
- Independent Standards and Spec reviews found no concrete introduced TUI regression. The remaining visual checks below are not established by static review or the automated gate.

## Validation

`npm run check` passed: TypeScript, Biome formatting, 478 existing tests in 20 files, and package verification. `git diff --check` passed.

Environment: macOS 26.3 (25D125), arm64, Node 22.22.2, Pi 0.84.0. The default Homebrew Node was unusable due to a missing simdjson dylib; checks used the installed fnm Node 22 runtime. Dependencies were reused from the existing checkout after a fresh install stalled. No application source changes were needed during this audit.

Manual interaction with real Pi PTYs, always 40 rows:

| Scenario | Observed result |
| --- | --- |
| Regular and fullscreen, Auto, 140 → 123 → 131 → 132 columns | Sidebar shown → hidden → hidden → shown; main pane reclaimed the width |
| Regular, Off → Manual → On at 132 columns | Hidden state retained until explicit On |
| Regular, Manual, 91 → 92 columns | Hidden → shown at minimum sidebar width |
| Fullscreen, Auto, Ctrl+Shift+R | Warning to select Manual; no resize gesture |
| Fullscreen, Manual, Ctrl+Shift+R → Left → Escape | Resize guidance shown, width grew one column, then restored |
| Fullscreen, active Manual resize, 132 → 91 → 132 columns | Gesture cancelled; guidance removed; subsequent command input worked |
| Fullscreen, Off → Auto at 132 columns | Remained hidden |
| Exit both sessions using Ctrl+D | Process exited normally and emitted cursor restoration |

[Terminal output excerpts](issue-76-terminal-excerpts.txt) preserve selected emitted lines with ANSI removed. They are not full screenshots and do not establish native graphics or clipboard behavior.

Start an isolated temporary session from this checkout:

```sh
./node_modules/.bin/pi --no-session --no-extensions -e ./extensions/index.ts --tui-mode regular
```

Repeat with `--tui-mode fullscreen`. Only the checkout extension is loaded.

## Remaining manual TODO

- [ ] In Herdr on the target laptop, resize panes during streaming and confirm reading comfort.
- [ ] Check native images and subagent plots, transcript selection/copy, modal dialogs, cursor placement, and short terminal heights across collapse/reopen.
- [ ] Check mouse dragging/release, Enter commit, and mode changes during a live resize gesture; verify preferred width survives each transition.
- [ ] Verify live TODO/activity/contributed-panel data after reopening, complete hidden TODO output, and session switch/reload/disable/enable cleanup.
- [ ] Exercise F6 → Controls → Sidebar and startup visibility disabled through the UI.

No GitHub CI checks were attached to the reviewed head. Local validation is the automated evidence; this audit does not claim full visual coverage.

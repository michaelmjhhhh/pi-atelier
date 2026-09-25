# Issue #76: responsive sidebar

Source: https://github.com/michaelmjhhhh/pi-atelier/issues/76
Branch: `feat/76-responsive-sidebar`
Status: implemented; updated after user feedback to exactly two modes, Auto and Manual. Target-laptop visual verification remains pending.

## Approved behavior

Mode and the display switch are independent session settings.

- Auto is the startup mode. `showSidebarOnStartup` controls whether the display switch starts on or off; its existing boolean format is unchanged.
- Auto reserves 80 main-pane columns plus the preferred sidebar width. With the default width of 44, collapse below 124 and reopen at 132. The 8-column margin prevents flicker. First valid width after enabling or explicit mode selection uses the 124-column threshold.
- Auto disables interactive width adjustment. The resize shortcut explains how to switch to Manual.
- Manual restores manual width adjustment and preserves the hard layout safety minimum: 64 main-pane columns plus at least 28 sidebar columns. An enabled sidebar hides below 92 and returns at 92.
- `/atelier sidebar auto|manual` changes only the mode, preserving width and the display switch.
- `/atelier sidebar on|off` changes only the display switch, preserving the mode. Bare `/atelier sidebar` toggles this switch, including when automatically collapsed.
- A manually hidden sidebar stays hidden through terminal resizing and mode changes. Explicitly show it to resume the chosen mode.
- Control Center offers Auto / Manual plus a separate Show sidebar / Hide sidebar action. Its status distinguishes mode, manually hidden, and hidden by terminal width.
- In Manual, Enter or mouse release commits width; Escape restores the previous width. If the terminal becomes too narrow during a resize, cancel and release input capture.
- Preferred width survives terminal clamping, hide/show, and mode changes. Auto uses that width: a 60-column sidebar gives collapse/reopen thresholds of 140/148.
- Automatic transitions are silent, reclaim the entire sidebar width, and preserve live data. Sidebar animation pauses while width-hidden.
- New TODO output stays complete while the sidebar is hidden. Previously abbreviated transcript results are not rewritten.
- Mode, width, and current visibility choices remain session-scoped. No new persisted config or migration.

Use terminal columns reported to Pi, not physical screen size. Herdr and other terminal hosts must report changed pane dimensions; Atelier cannot infer occlusion from an overlay that leaves terminal dimensions unchanged.

## Implementation

- `src/split-pane.ts` owns mode, display enablement, preferred width, hysteresis, resolved geometry, and Manual-only resize eligibility.
- Regular rendering, fullscreen layout visibility, selection clipping, image composition, and divider hit-testing use the same width policy. Fullscreen HStack retains the existing allocation with equivalent clamping.
- `src/sidebar.ts` keeps the mounted overlay and data alive while automatically collapsed. Explicit hide and teardown close the overlay without changing mode.
- `extensions/index.ts` separates mode commands from visibility commands, initializes Auto independently of startup visibility, and checks actual presentation before abbreviating TODO results.
- `src/menu.ts` exposes the two modes and the independent display switch. README and usage documentation describe those semantics.

Do not add terminal polling or a separate SIGWINCH listener. Reuse existing resize/render callbacks. Invalid dimensions must not overwrite preferred width or automatic expansion history.

## Verification

Per AGENTS.md, no new TUI unit or e2e tests. Existing fixture/setup/assertion changes reflect the revised interface and Manual-only resizing. Run `npm run check` for TypeScript, formatting, the existing suite, and package verification.

Start an ephemeral session with only this checkout's extension:

```sh
./node_modules/.bin/pi --no-session --no-extensions -e ./extensions/index.ts
```

Use `--tui-mode regular` or `--tui-mode fullscreen` to check each renderer. The explicit extension loads while discovery is disabled, avoiding the installed Atelier conflict.

Manual TODO:

- [ ] Auto startup: at 124 or more the default sidebar shows; at 123 it hides. Once hidden, 131 remains hidden and 132 reopens.
- [ ] In Auto, Ctrl+Shift+R warns to select Manual and does not capture mouse/input or change width.
- [ ] Select Manual, adjust width with arrows and dragging, then commit and cancel. Verify input capture releases correctly.
- [ ] Return to Auto: preferred width is unchanged and terminal resizing uses its corresponding thresholds.
- [ ] In both modes, turn the display switch off, enlarge the terminal, and switch modes: the sidebar must stay hidden until explicitly shown.
- [ ] Bare toggle while auto-collapsed switches display off; toggling again enables Auto and still respects available space.
- [ ] Manual mode stays visible at 100, hides at 91, and returns at 92. Width preference survives clamping.
- [ ] Switch Manual → Auto during an active resize: cancel the gesture cleanly, restore uncommitted width, and release input capture.
- [ ] Exercise the same actions via F6 → Controls → Sidebar; startup visibility false still starts hidden in Auto.
- [ ] Resize Herdr's sidebar on the 14-inch laptop and assess reading comfort during idle and streaming.
- [ ] Check images, transcript selection/copy, modal overlays, short heights, and cursor behavior while collapsing/reopening.
- [ ] Hidden TODO results remain complete; activity, Workspace Pulse, and contributed panels are current on reopening.
- [ ] Session switch, reload, disable/enable, and exit leave no stale overlay or captured input.

Earlier terminal verification confirmed 140 → 123 → 131 → 132 collapse/reopening in both Pi 0.84.0 renderers. The two-mode refinement requires the updated manual checks above; earlier three-mode observations do not establish the new command semantics.


Two-mode refinement verification: the existing 466-test suite, typecheck, formatting, and package verification pass. In an ephemeral Pi 0.84.0 fullscreen PTY, Auto rejected Ctrl+Shift+R with the Manual-mode instruction; Off retained Auto while hidden; switching to Manual retained hidden state; explicit On showed it; Manual accepted keyboard resizing and commit; switching back to Auto succeeded. Target-laptop visual checks and the remaining matrix are still pending.

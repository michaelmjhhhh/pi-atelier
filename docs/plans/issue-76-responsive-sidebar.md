# Issue #76: responsive sidebar implementation plan

Status: approved and implemented on `feat/76-responsive-sidebar`; target-laptop visual verification remains pending.
Source: https://github.com/michaelmjhhhh/pi-atelier/issues/76
Reviewed against local HEAD `e56e720` (0.11.2), Pi dependencies 0.84.0.

## Assessment

This is a useful refinement of existing responsive behavior. `src/split-pane.ts` already hides the sidebar below 92 terminal columns: a 64-column minimum main pane plus a 28-column minimum sidebar. The preferred sidebar width is 44, with a maximum of 72. Above 92, the sidebar can shrink to preserve only 64 columns for the main pane. That avoids overflow but can still make agent output uncomfortable to read.

Use the terminal width available to Pi, not physical screen dimensions. Herdr opening its sidebar should be handled by the same terminal resize path as window resizing or a multiplexer split, provided the host reports its changed pane dimensions. No Herdr integration is needed. If the host overlays content without resizing the terminal, Atelier cannot infer that occlusion from terminal columns.

The issue has no comments or acceptance criteria beyond automatic collapse/expansion and retaining manual control. The user approved the product choices below before implementation.

## Approved behavior

Separate session intent (`auto`, `on`, `off`) from actual presentation (`shown`, `auto-collapsed`, `too-narrow`, `off`). Do not overload one boolean for both.

- Default to `auto` when `showSidebarOnStartup` is true. Preserve false as `off`.
- In auto mode, reserve 80 columns for the main pane and the user's preferred sidebar width. With the default width of 44, collapse below 124 columns.
- Reopen an automatically collapsed sidebar at 132 columns: the collapse threshold plus an 8-column margin. Between those thresholds retain the previous automatic state. This avoids flicker near the cutoff.
- On the first valid width of a session, show at 124 or more; below that start collapsed. Entering auto explicitly uses the same initial rule.
- Compute thresholds from preferred width, not temporarily clamped effective width. A preferred width of 60 gives thresholds of 140/148. Preserve preferred width through terminal resizing and collapse/reopening.
- `/atelier sidebar on` explicitly pins the sidebar open, using the existing 64-column main-pane safety minimum and 28–72 sidebar limits. It can still hide below 92, and reappears when that hard minimum fits again.
- `/atelier sidebar off` stays off through all terminal resizes.
- Add `/atelier sidebar auto` to restore automatic behavior.
- Keep the bare command as a toggle of actual presentation: shown → off; hidden → on. Below the hard minimum, explain that the sidebar is enabled but cannot fit. The response should mention the auto command when a manual override replaces auto mode.
- In Control Center, provide explicit Auto / On / Off choices and show both intent and presentation, for example `Auto · hidden: narrow terminal`. Do not display `Off` for automatic collapse.
- Manual choices remain session-scoped. Keep the existing startup preference and configuration format; no migration or new persisted threshold settings in this first version. Clarify its label/help: enabled means automatic at startup.
- Automatic transitions are silent, reclaim all sidebar space, and preserve live sidebar data. No animation, notification on each resize, or collapsed rail.

The 80-column budget and 8-column margin are initial tuning values. Validate readability and reopening behavior in the target laptop setup before release; no physical display size guarantees a particular number of terminal columns.

## Implementation sequence

### 1. Centralize geometry and automatic state

In `src/split-pane.ts`, replace scattered visibility decisions with one internal layout resolution that provides visibility, reason, main width, and effective sidebar width. Keep mode, preferred width, and automatic expansion state owned here. Expose only mode control and a presentation snapshot needed by the sidebar controller.

Preserve the existing hard safety limits separately from the new comfort budget. Validate widths before changing automatic state; transient invalid dimensions must not overwrite preferred width or expansion history. Repeated resolution of the same dimensions must be idempotent.

Every consumer must use the same resolved geometry: regular render adapter, overlay visibility/width, fullscreen HStack, fullscreen selection clipping, image compositor, and resize hit-testing. Evaluate using the outer terminal width, never the already reduced main-pane width. Do not let the HStack allocate a different width from the selection/image paths. Avoid a render loop caused by requesting a render inside every visibility query.

Use the existing render/resize callbacks; do not add terminal polling or a separate SIGWINCH listener. Confirm a resize while idle is sufficient to recompute the layout in both Pi modes.

### 2. Integrate lifecycle, resize, and data consumers

In `src/sidebar.ts`, retain the mounted sidebar while auto-collapsed. Calling the existing `hide()` for an automatic collapse would destroy its overlay lifecycle and erase user intent. Only explicit off, teardown, or failure should close that lifecycle.

Replace the misleading `isVisible()` implementation, which currently returns `enabled`, with explicit intent and presentation access. Audit every caller before changing its meaning. Provide presentation from the attached terminal's current outer width, including safe behavior before attachment.

Pause sidebar-only animation while it is width-hidden; resume on visibility transitions, including idle terminal expansion. Continue ingesting activity, TODO, and contributed-panel data while hidden. Coordinate transition notification with existing render scheduling to avoid recursive redraws.

Interactive sidebar resizing is an explicit manual override to `on`. Capture the original mode and preferred width before starting. Commit keeps the chosen width and on mode; Escape restores both. If the terminal becomes too narrow during the gesture, cancel cleanly, restore the captured preference/mode, and release mouse/input capture. Terminal-driven clamping must not become a new preferred width. Resize hit-testing must use the effective divider position.

In `extensions/index.ts`, use actual presentation when deciding whether new TODO results can be abbreviated to `see sidebar`; preserve full output when the sidebar is hidden. Keep data updates independent of presentation. Existing abbreviated transcript results cannot be expanded retroactively by this change; document that limit rather than mutating historical tool results.

### 3. Expose controls and document compatibility

- `extensions/index.ts`: parse `auto`, update usage/help and completion entries if present, initialize startup mode, and distinguish hidden-by-width from off in resize guidance.
- `src/menu.ts`: extend SidebarControls with mode/presentation access and replace the ambiguous binary control with explicit choices. Clarify startup preference messaging.
- `README.md` and `docs/usage.md`: document defaults, thresholds, manual overrides, automatic restoration, and the fact that on still obeys the hard safety limit.
- Extend the manual verification documentation with the matrix below. Record final tuned values and observed results.

This fits one implementation PR. Keep it independent of the uncommitted performance work and avoid restructuring the renderer adapters beyond what shared geometry requires.

## Verification and release gate

Per AGENTS.md, add no TUI unit or e2e tests. Run existing checks (`npm run check`); if existing assertions encode superseded behavior, update only those expectations needed to express the agreed behavior. Do not treat passing tests as evidence of live terminal correctness.

After implementation, launch from this checkout:

```sh
./node_modules/.bin/pi --no-session --no-extensions -e /Users/michael/pi-atelier/extensions/index.ts
```

Pi documents that `--no-extensions` disables discovery while explicit `-e` still loads, and `--no-session` prevents saving the session. This loads only the checkout's extension and avoids the installed Atelier conflict. Verified against installed 0.84.0 README and current upstream CLI documentation: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md

Manual TODO, in both regular and fullscreen modes:

- [ ] Default auto startup: 123 columns hidden; 124 shown. A hidden startup at 123 must expand at 132.
- [ ] From shown: 124 stays shown, 123 collapses; then 124–131 stay hidden and 132 reopens. Repeated movement around each threshold must not flicker.
- [ ] Show/hide Herdr's sidebar on the 14-inch laptop, resize the terminal, and change terminal font size. Confirm the main output is comfortable and recovery occurs while idle as well as streaming.
- [ ] On remains shown at 100 columns with safe clamping; 91 hides, 92 reopens. Off remains hidden even at 200 columns. Auto restores automatic policy.
- [ ] Bare toggle and Control Center behave consistently when automatically hidden, manually off, shown, and below the hard minimum. Startup false remains respected after a new session.
- [ ] Resize to preferred widths 28, 44, 60, and 72; return to auto and verify the corresponding thresholds. Shrink and expand the terminal without losing preferred width.
- [ ] Mouse and keyboard resizing: commit, Escape, terminal shrink during drag, and subsequent normal typing/selection. No stuck input or mouse capture.
- [ ] Collapse/reopen while streaming text, showing an image, selecting/copying transcript text, or opening/closing F6/settings overlays. No stale gutter, overlap, copied sidebar text, lost focus, or cursor corruption.
- [ ] Hidden TODO results retain full output; live activity, Workspace Pulse, and contributed panels show current data on reopening. Sidebar animation stops while hidden and restarts when appropriate.
- [ ] Session switch, reload, disable/enable, and exit clean up correctly; short terminal heights and invalid/transient dimensions do not corrupt layout.

## Observed implementation verification

- `npm run check` passed: TypeScript, formatting, all 466 existing tests across 18 files, and package verification (27 files). No new TUI tests were added; existing setup/assertions were adjusted for the changed contract.
- Opened ephemeral Pi 0.84.0 sessions with extension discovery disabled and only this checkout explicitly loaded. Exercised both fullscreen and regular renderers through a real PTY.
- In both renderers, started at 140 columns with the sidebar shown, shrank to 123 (hidden), expanded to 131 (still hidden), then 132 (shown). Observed terminal output and pane content during idle resizes.
- In fullscreen mode, explicit Off stayed hidden when expanded to 160; explicit On showed at 100; returning to Auto at 100 hid the sidebar and reported the width reason. Both sessions exited cleanly.
- Two-axis review: no documented-standard violations or confirmed spec defects. Consolidated the mouse resize update path with keyboard width updates following one maintainability suggestion.

These observations cover basic live terminal behavior, not the full manual checklist above. Target-laptop/Herdr readability, mouse gestures, image/selection interactions, streaming, and the remaining edge cases still require manual visual verification before release.

# Pi Atelier Resizable Split Sidebar Design

## Summary

Replace the visually overlapping sidebar behavior with an extension-only split presentation. Pi Atelier will continue using Pi's supported right-edge overlay for the sidebar, but it will temporarily wrap the active TUI renderer so Pi's normal workspace renders into the columns remaining to the left of the sidebar. The result is a non-overlapping main pane and sidebar without modifying Pi source code.

The sidebar width is adjustable in a temporary Resize mode entered with `Ctrl+Shift+R`. Mouse reporting is enabled only during that mode. Dragging the divider resizes the sidebar, releasing the mouse accepts the width and exits Resize mode, and normal terminal text selection remains unaffected outside that short interaction.

This design deliberately uses a version-sensitive runtime integration: `TUI.render` is publicly accessible on the TUI object supplied to extension component factories, but wrapping it is not a documented Pi extension API. The integration must therefore fail safely, restore the original renderer on every cleanup path, and be documented as dependent on Pi's current TUI structure.

## Context and Motivation

The current sidebar is a full-height, non-capturing overlay. Pi first renders its workspace at the full terminal width and then composites the overlay into the rightmost 44 columns. The sidebar therefore replaces characters that Pi already rendered, as seen in wide tool output, messages, editor borders, and the footer.

A true root-level split would normally make the main pane and sidebar siblings in a horizontal layout. OpenCode, OpenTUI, and Ink use this pattern: the main pane grows into the available space while the sidebar receives a fixed width. Pi's documented extension API does not expose a root-layout slot or a width-reserving side pane, and this project will not modify Pi source code.

Atelier can nevertheless achieve the same visible result by combining two mechanisms available at runtime:

1. Render Pi's normal component tree at `terminalWidth - sidebarWidth`.
2. Keep the sidebar in Pi's existing right-edge overlay layer.

Because the base content no longer extends under the overlay, the two regions do not overlap.

## Goals

- Prevent the sidebar from covering conversation, tool, editor, or footer content.
- Reflow Pi's normal workspace into the width remaining beside the sidebar.
- Keep the implementation entirely inside Pi Atelier.
- Preserve normal editor focus and Pi keyboard behavior while the sidebar is visible.
- Allow users to resize the sidebar by dragging the divider in a temporary Resize mode.
- Leave normal terminal text selection unchanged outside Resize mode.
- Provide keyboard resize controls and a cancel path.
- Cleanly restore Pi rendering, input handling, and terminal mouse state across every lifecycle path.
- Keep the split mechanism isolated from sidebar business data and rendering.

## Non-goals

- Modifying or forking Pi or `@earendil-works/pi-tui`.
- Creating a second Ghostty pane or a second Pi process.
- Reproducing Ghostty's native hover cursor over the divider.
- Enabling terminal mouse reporting while Resize mode is inactive.
- Supporting multiple sidebars or arbitrary multi-pane layouts.
- Reparenting Pi's root TUI component tree.
- Making sidebar content interactive.
- Persisting sidebar width across Pi processes in the first release.
- Supporting draggable resizing in non-TUI modes.

## User Experience

### Normal split view

The sidebar retains the existing command and menu controls:

```text
/atelier sidebar
/atelier sidebar on
/atelier sidebar off
```

When the sidebar is enabled and the terminal is sufficiently wide, the layout is:

```text
┌──────────────────── Pi workspace ────────────────────┬─ Atelier sidebar ────────┐
│ Conversation, tools, editor, and footer reflow here  │ PROJECT                  │
│ without extending beneath the sidebar                │ pi-atelier               │
│                                                      │                          │
│                                                      │ AGENT                    │
│                                                      │ gpt-5.6-sol              │
└──────────────────────────────────────────────────────┴──────────────────────────┘
```

The divider is the first column rendered by the sidebar and remains visually distinct from its content.

Default and bounded dimensions are:

- Default sidebar width: 44 columns, including the divider.
- Minimum sidebar width: 28 columns.
- Maximum sidebar width: 72 columns.
- Minimum main-pane width: 64 columns.

The effective maximum sidebar width is the smaller of 72 and `terminalWidth - 64`. If the terminal cannot fit the 64-column main pane plus the 28-column sidebar, the visual sidebar auto-hides and Pi immediately returns to full-width rendering. The sidebar remains logically enabled and reappears when the terminal is wide enough.

Width changes apply only to the current TUI session. A new or replacement session starts at 44 columns.

### Entering Resize mode

`Ctrl+Shift+R` enters Resize mode only when all of the following are true:

- Pi is in TUI mode.
- The Atelier sidebar is logically enabled.
- The terminal is wide enough to show the split.
- No Resize mode is already active.

If any condition is false, Atelier shows a concise warning and does not enable mouse reporting.

While Resize mode is active:

- The footer or sidebar displays a visible `RESIZE` state.
- The divider uses a stronger active style.
- SGR button-event mouse reporting is enabled.
- Atelier consumes mouse escape sequences so they cannot enter the editor.
- Normal Pi keyboard shortcuts remain available except for keys explicitly handled by Resize mode.

Resize mode is intentionally temporary. Atelier never tracks mouse hover while idle and cannot display Ghostty's native resize-pointer icon because the divider is a terminal character rather than a native window boundary.

### Mouse resizing

The extension enables these terminal modes while Resize mode is active:

```text
CSI ? 1002 h   button-event mouse tracking
CSI ? 1006 h   SGR extended mouse coordinates
```

The terminal reports presses, button-held motion, and releases as SGR mouse sequences. Atelier starts a resize drag only when the primary-button press lands on the current divider column. During the drag, the width is derived from the current terminal width and the one-based mouse x coordinate, then clamped to the sidebar and main-pane bounds.

Behavior:

- Press divider and drag: update width live.
- Release after dragging: accept current width and exit Resize mode.
- Press outside divider: leave width unchanged and exit Resize mode.
- Terminal resize during drag: recompute and clamp using the new terminal width.
- Malformed or unrelated input: ignore safely without changing width.

When Resize mode exits, Atelier disables the mouse modes it enabled and removes its temporary input interception. Ghostty returns to normal text-selection behavior.

### Keyboard resizing

Resize mode also supports:

- `Left`: increase sidebar width by 1 column.
- `Right`: decrease sidebar width by 1 column.
- `Shift+Left`: increase sidebar width by 4 columns.
- `Shift+Right`: decrease sidebar width by 4 columns.
- `Enter`: accept the current width and exit.
- `Escape`: restore the width captured on entry and exit.

Left expands the right sidebar because it moves the divider toward the left; Right contracts it. Every update uses the same bounds as mouse resizing.

## Architecture

### New `src/split-pane.ts`

This module owns the generic, extension-local split and resize mechanism. It must not depend on `AtelierRuntime`, sidebar snapshots, metrics, Git state, tools, or palette roles.

It exposes a narrow controller interface such as:

```ts
interface SplitPaneController {
  attach(tui: TUI): void;
  show(): void;
  hide(): void;
  beginResize(): void;
  finishResize(): void;
  cancelResize(): void;
  setSidebarWidth(width: number): void;
  getSidebarWidth(): number;
  isActive(): boolean;
  isResizing(): boolean;
  requestRender(): void;
  dispose(): void;
}
```

Exact method names may change during planning, but the responsibilities and boundaries remain fixed.

The controller receives:

- Default, minimum, and maximum sidebar widths.
- Minimum main-pane width.
- A terminal-input subscription function.
- A callback for Resize mode state changes.
- An error callback.

It owns:

- The current session-scoped sidebar width.
- The pre-resize width used by cancel.
- The active drag state.
- The current TUI reference.
- The original and wrapped render functions.
- The temporary input unsubscribe callback.
- Mouse reporting enablement state.

### Render-width shim

On attachment, the controller captures the active TUI object. When the split is visually active, it wraps the instance's `render` method.

Conceptually:

```ts
const originalRender = tui.render.bind(tui);
const wrappedRender = (terminalWidth: number): string[] => {
  const reserved = computeReservedWidth(terminalWidth);
  return originalRender(terminalWidth - reserved);
};
```

The existing Pi overlay compositor still receives the real terminal dimensions and positions the sidebar against the right edge. Only the base component tree sees the reduced main-pane width.

The implementation must account for method identity and repeated lifecycle operations:

- A TUI instance is attached at most once per controller.
- `show`, `hide`, and `dispose` are idempotent.
- Hiding or auto-hiding the split makes the wrapper delegate at full width.
- Disposal restores the original renderer only if `tui.render` still equals Atelier's wrapper.
- If another extension replaces `tui.render` after Atelier, Atelier must not overwrite that later wrapper during cleanup.
- Atelier must not recursively call its own wrapper.

Wrapping `render` rather than moving `tui.children` preserves Pi's existing component ownership, focus graph, editor container, footer/header/widget lifecycle, and overlay implementation.

### Existing `src/sidebar.ts`

Sidebar snapshot construction and content rendering remain unchanged except where width assumptions must become dynamic.

The sidebar controller will compose the existing overlay lifecycle with the split-pane controller:

- Showing the sidebar activates width reservation and creates the overlay.
- Hiding the sidebar removes the overlay, exits Resize mode, and returns Pi to full-width rendering.
- The overlay options become a function so width and terminal constraints are evaluated at render time.
- The sidebar's first column remains the visual divider.
- Resize state changes the divider styling without making sidebar content focusable.
- `requestRender` updates both the sidebar overlay and the base TUI.

The logical enabled state remains distinct from responsive visibility. When the terminal is too narrow, both width reservation and overlay visibility are inactive while logical enablement remains true.

### `extensions/index.ts`

The extension entry point owns integration with the Pi session lifecycle:

- Capture the current session's TUI reference from an existing component factory that Pi invokes with the TUI object, preferably the Atelier footer factory already installed during `session_start`.
- Attach the split controller only to the current lifecycle generation.
- Register `Ctrl+Shift+R` as the Resize-mode shortcut.
- Route sidebar show/hide, menu actions, and render invalidation through the composed controller.
- Exit Resize mode before disabling Atelier, hiding the sidebar, replacing a session, reloading, or shutting down.
- Reject stale event contexts and stale TUI references using the existing lifecycle-generation checks.

The shortcut is registered once per extension runtime, following the existing fallback/error behavior used for Atelier shortcuts.

## Input and Mouse Handling

Resize mode uses `ctx.ui.onTerminalInput()` rather than replacing the focused editor. The listener parses complete SGR mouse sequences already assembled by Pi's stdin buffering.

The listener follows these rules:

- Outside Resize mode, no resize listener or mouse modes are active.
- During Resize mode, recognized mouse sequences are consumed.
- Explicit Resize-mode keyboard controls are consumed.
- Unrelated keyboard input continues to Pi.
- Key-release events do not cause duplicate resize actions.
- Mouse tracking is disabled before the input listener is removed, and both operations are idempotent.

Because terminal mouse modes are process-global, Atelier must never leave them enabled after Resize mode. The controller records whether it emitted each enable sequence and emits the corresponding disable sequence exactly once:

```text
CSI ? 1002 l
CSI ? 1006 l
```

## State and Data Flow

```text
Ctrl+Shift+R
      │
      ▼
SplitPaneController.beginResize()
      │
      ├─ capture starting width
      ├─ enable mouse reporting
      ├─ install temporary input listener
      ├─ mark RESIZE state
      └─ request base + sidebar render

mouse drag / arrow key
      │
      ▼
clamp proposed width
      │
      ├─ update session width
      ├─ overlay options return new width
      ├─ base render receives smaller/larger width
      └─ request render

release / Enter / Escape
      │
      ▼
finish or cancel
      │
      ├─ optionally restore starting width
      ├─ disable mouse reporting
      ├─ remove listener
      ├─ clear RESIZE state
      └─ request render
```

No sidebar business state flows into the split module. The sidebar receives only current width and resize-state information needed for presentation.

## Error Handling and Cleanup

- If no current TUI instance is available, sidebar activation fails with one concise warning and leaves Pi unchanged.
- If the controller cannot safely install or identify its render wrapper, it refuses activation rather than stacking an unknown mutation.
- A render-wrapper exception triggers error reporting and best-effort restoration of full-width Pi rendering.
- Snapshot/render errors inside the sidebar retain the existing bounded fallback UI and do not disable the main pane.
- Every Resize-mode exit path disables mouse reporting and removes the input listener.
- Sidebar hide, `/atelier disable`, session replacement, reload, and shutdown all cancel Resize mode before disposing presentation resources.
- `dispose()` is safe after partial initialization and safe to call repeatedly.
- Cleanup never restores an old renderer over a newer third-party renderer.
- Invalid width values, non-finite values, and terminal shrink events are clamped to safe bounds.
- If responsive constraints cannot fit both panes, the main pane receives full width.

## Compatibility and Documentation

README documentation must state:

- The split is implemented entirely by Pi Atelier and does not patch files on disk.
- It relies on the current runtime shape of Pi's TUI and may require updates when Pi changes its renderer internals.
- Resize mode is temporary because persistent terminal mouse tracking would interfere with ordinary text selection.
- Ghostty's native split hover cursor cannot be reproduced inside a PTY character grid.
- The supported Pi peer dependency range must be tightened if testing shows the render behavior is version-specific.

The changelog entry should identify the new non-overlapping layout, session-scoped resizable width, and `Ctrl+Shift+R` interaction.

## Testing

### New `tests/split-pane.test.ts`

Use a lightweight fake TUI and terminal to verify:

- Main content renders at terminal width minus the reserved sidebar width.
- Hiding the sidebar restores full-width rendering.
- The default width is 44.
- Sidebar width clamps to 28–72.
- The effective maximum preserves at least 64 main columns.
- A terminal narrower than 92 columns receives no width reservation.
- Responsive hide and restore do not change logical enablement.
- Repeated attach, show, hide, begin, cancel, and dispose calls are idempotent.
- Disposal restores the original renderer.
- Disposal does not overwrite a third-party renderer installed after Atelier.
- Wrapping cannot recurse into itself.
- `Ctrl+Shift+R` enters Resize mode only when the split is visible.
- Mouse reporting enable and disable sequences are paired exactly once.
- Divider press and motion update width using one-based SGR coordinates.
- Mouse release accepts the width and exits Resize mode.
- Press outside the divider exits without changing width.
- Arrow keys adjust by one column.
- Shift-arrow keys adjust by four columns.
- Enter accepts and Escape restores the entry width.
- Malformed mouse sequences do not change state.
- Terminal resize during interaction reclamps width.
- Resize exit removes the temporary input listener.
- Partial initialization and error cleanup restore safe terminal state.

### Existing tests

Update `tests/sidebar.test.ts` and `tests/extension.test.ts` to cover:

- Dynamic overlay width.
- Active and inactive divider styling.
- Split and overlay visibility use the same responsive predicate.
- Sidebar commands and menu actions activate and deactivate width reservation.
- `/atelier disable` exits Resize mode and removes the sidebar presentation.
- Session replacement and shutdown restore rendering and mouse state.
- Stale session contexts cannot resize the active session.
- `NO_COLOR`, live activity, animation, snapshot, Git, usage, tools, and error behavior remain intact.

### Verification

Run:

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
npm run check:pack
npm pack --dry-run
```

The final implementation is complete only when the full `npm run check` pipeline and package dry run pass.

## Acceptance Criteria

- The visible sidebar never covers Pi workspace content.
- Pi messages, tools, editor, and footer reflow when sidebar width changes.
- The implementation changes only Pi Atelier files and does not patch Pi source or installed packages.
- The sidebar defaults to 44 columns and remains within 28–72 columns while preserving a 64-column main pane.
- Narrow terminals automatically return Pi to full-width rendering.
- `Ctrl+Shift+R` enters a temporary Resize mode.
- Dragging the divider resizes live; releasing accepts and exits.
- Arrow and Shift-arrow controls resize predictably; Enter accepts and Escape cancels.
- Normal mouse text selection is unaffected outside Resize mode.
- Resize mode cannot leak mouse reporting or input listeners.
- Hiding, disabling, replacing, reloading, or shutting down restores safe full-width rendering.
- Cleanup does not overwrite later third-party renderer changes.
- Width remains session-scoped and resets for new sessions.
- README and changelog document behavior, limitations, compatibility, and controls.
- All repository and package verification commands pass.

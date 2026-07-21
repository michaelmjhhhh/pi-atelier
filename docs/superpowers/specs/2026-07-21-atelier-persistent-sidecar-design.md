# Pi Atelier Persistent Sidecar Design

## Summary

Replace the focused `/atelier sidebar` modal with a persistent, non-capturing right-edge sidecar. The sidecar remains visible while the user types and operates Pi, and it can be toggled through both slash commands and the Atelier menu.

Pi's public extension API does not provide a layout region that reserves width and reflows the conversation. The sidecar therefore uses the closest supported behavior: a non-capturing overlay attached flush to the right edge. It covers the rightmost terminal columns rather than creating a true application-level split.

## Goals

- Keep the editor and normal Pi keyboard controls active while the sidebar is visible.
- Make the panel feel attached to the workspace rather than like a detached modal.
- Provide obvious on/off controls through commands and the Atelier menu.
- Automatically hide the sidecar on narrow terminals and restore it when widened.
- Preserve the existing information architecture, live updates, error fallback, palette, and `NO_COLOR` behavior.

## Non-goals

- Modifying Pi core to implement a true width-reserving split layout.
- Mouse interaction or a clickable terminal button.
- Persisting sidebar visibility across Pi sessions.
- Making sidebar fields editable.
- Changing footer enable/disable semantics.

## Interaction

The following commands control one session-scoped sidecar:

```text
/atelier sidebar
/atelier sidebar on
/atelier sidebar off
```

- `/atelier sidebar` toggles the sidecar.
- `/atelier sidebar on` shows it and is idempotent when already enabled.
- `/atelier sidebar off` hides it and is idempotent when already disabled.
- Other sidebar arguments show concise usage guidance.

The main `/atelier` menu includes a dynamic row:

```text
Sidebar: Off    Show the live session sidecar
```

or:

```text
Sidebar: On     Hide the live session sidecar
```

The menu and commands call the same controller so visibility cannot diverge.

The sidecar starts disabled in every new Pi session. It does not capture focus. `Escape`, `q`, `Ctrl+C`, typing, and application shortcuts continue to belong to Pi rather than the sidecar.

## Layout

On terminals at least 88 columns wide, the sidecar uses a 44-column, right-centered overlay with no outer margin:

```ts
{
  anchor: "right-center",
  width: 44,
  margin: 0,
  nonCapturing: true,
  visible: (termWidth) => termWidth >= 88
}
```

Removing the margin makes the panel read as an attached sidecar rather than a floating card. Modal-only help text such as `esc/q close` is removed.

Below 88 columns, the overlay's `visible` callback hides it automatically. The sidecar remains logically enabled, so widening the terminal restores it without another command. Explicitly turning it off removes the overlay instance.

Conceptual layout:

```text
┌──────────────────────────── Pi workspace ───────────────────────┬─ PI ATELIER ─────────┐
│                                                                │ PROJECT              │
│ Conversation, tools, and editor remain interactive             │ pi-atelier           │
│                                                                │ ◆ main · modified    │
│                                                                │                      │
│                                                                │ AGENT                │
│                                                                │ gpt-5.6-sol         │
│                                                                │ ● READY              │
│                                                                │                      │
│                                                                │ CONTEXT              │
│                                                                │ 32k / 400k   8.1%   │
└────────────────────────────────────────────────────────────────┴──────────────────────┘
```

## Architecture

### Sidebar controller

`src/sidebar.ts` will expose a session-scoped sidecar controller with these behaviors:

- `show()` creates one fresh non-capturing overlay when disabled.
- `hide()` permanently removes the active overlay through its overlay handle.
- `toggle()` switches between enabled and disabled states.
- `isVisible()` reports the logical enabled state for menu copy.
- `requestRender()` rerenders the active component when live data changes.
- `dispose()` removes the overlay and clears retained callbacks during shutdown.

`show()`, `hide()`, and `dispose()` are idempotent. Hiding and showing again creates a fresh component rather than reusing a disposed overlay reference.

The controller receives snapshot/config getters and owns only presentation lifecycle. Snapshot construction and rendering remain independent and testable.

### Extension integration

`extensions/index.ts` creates the controller after the Atelier runtime starts. Existing lifecycle events route sidebar invalidation through the controller. Session shutdown disposes it before runtime state is cleared.

The `/atelier` command parser recognizes `sidebar`, `sidebar on`, and `sidebar off`. Bare `/atelier` still opens the menu, while `enable` and `disable` continue to control only the footer.

### Menu integration

`openAtelierMenu` receives a narrow sidebar-control interface:

```ts
interface SidebarControls {
  isVisible(): boolean;
  toggle(): void;
}
```

The root selection list computes its Sidebar row each time it opens so the label and description reflect current state. Selecting the row toggles the controller and returns to the menu loop.

## Data and Rendering

The existing `SidebarSnapshot`, snapshot builder, section layout, sanitization, width-safe framing, context thresholds, error fallback, and fixed Midnight Spectrum remain unchanged.

The modal footer hint is removed. The component no longer defines a close-key handler because a non-capturing overlay must not consume editor input.

Live data refresh remains event-driven for activity, turns, model selection, thinking level, compaction, session information, Git state, and extension statuses.

## Error Handling and Cleanup

- Snapshot and configuration failures continue to render a framed, width-bounded error state.
- Showing while already enabled and hiding while disabled are no-ops.
- An unavailable TUI context produces the existing warning and no controller state change.
- Session shutdown invokes `dispose()` before clearing runtime references.
- Footer disable does not hide the sidecar.
- Sidebar hide does not disable the footer.
- `NO_COLOR` continues to suppress custom RGB output.

## Testing

Tests will cover:

- Toggle behavior for `/atelier sidebar`.
- Explicit, idempotent `on` and `off` arguments.
- Usage guidance for invalid arguments.
- Dynamic `Sidebar: On/Off` menu copy.
- Menu and command use of the same controller.
- `anchor: "right-center"`, width `44`, margin `0`, and `nonCapturing: true`.
- Auto-hide below 88 columns and automatic restoration above it.
- Absence of a close-key handler and modal help text.
- Live render invalidation while enabled.
- Session shutdown disposal.
- Independence from footer enable/disable.
- Existing snapshot, rendering, width, error, Git, palette, and `NO_COLOR` tests.

The complete `npm run check` and `npm pack --dry-run` verification must pass before integration.

## Acceptance Criteria

- `/atelier sidebar` toggles a persistent right-edge sidecar.
- `/atelier sidebar on` and `/atelier sidebar off` work idempotently.
- The Atelier menu exposes accurate `Sidebar: On/Off` control.
- The editor remains focused and usable while the sidecar is enabled.
- The sidecar has no floating outer margin and does not show modal close instructions.
- It auto-hides below 88 terminal columns and restores when widened.
- Visibility is session-scoped and starts disabled.
- Shutdown removes the active overlay safely.
- Footer controls remain independent.
- Existing information, live updates, error fallback, privacy, palette, and `NO_COLOR` behavior remain intact.
- All repository and package checks pass.

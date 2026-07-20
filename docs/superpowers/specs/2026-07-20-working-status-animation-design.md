# Working Status Animation Design

## Goal

Give Pi Atelier’s activity status a Claude Code–style sense of motion while an agent work cycle is running, without changing the idle state or sacrificing responsive layout behavior.

## Approved behavior

- Idle remains `● READY` in blue, upright, and static.
- A work cycle continues to select one working phrase when it starts and retains that phrase until the cycle settles.
- In Gallery and Balanced modes, the working activity renders as a normal leading bullet followed by the phrase and dots together in italics.
- The working phrase and dots use Atelier orange (`#FF9F43`).
- The dots animate every 400 ms through `...` → `..` → `.` → repeat.
- Focus mode and narrower layouts retain the existing compact, static activity bullet. They do not display the phrase or animated dots.
- Warning and error activity rendering is unchanged.

## Architecture

Animation is owned by the footer component rather than `AtelierRuntime`.

The runtime remains responsible for semantic activity state and stable working-phrase selection. The footer component owns only transient presentation state:

- current dot-frame index,
- one optional animation timer,
- transition detection between visible working animation and all non-animated states.

This keeps animation mechanics out of application state and avoids creating new `AtelierState` objects every 400 ms.

## Rendering flow

1. `AtelierRuntime.setActivity("working")` selects and stores one working phrase, as it does today.
2. The footer renders the current state and responsive mode.
3. When the full working activity is visible, the component ensures its 400 ms timer is running.
4. Each timer tick advances the frame index and requests a TUI redraw.
5. The activity renderer combines:
   - a normally styled orange bullet,
   - a space,
   - the orange working phrase plus the current dot frame wrapped together with `theme.italic()`.
6. When the state stops working, the responsive mode hides the full activity, or the component is disposed, the timer stops.
7. The next visible working cycle starts from `...`.

The pure footer-line renderer accepts the current dot frame as presentation input so width behavior and exact output remain deterministic in unit tests.

## Lifecycle and cleanup

- A footer component may own at most one animation timer.
- Idle rendering never starts a timer.
- Compact activity rendering never starts a timer.
- Leaving the visible working state clears the timer and resets the frame index.
- `dispose()` clears the timer and unsubscribes from branch updates exactly once.
- Timer callbacks check disposal state before requesting a redraw.
- Theme invalidation does not own animation state; every render reapplies current theme colors and italic styling.

## Color and styling

The existing working palette role changes from purple to Atelier orange (`#FF9F43`). This reuses an established palette color and preserves Atelier’s documented no-yellow rule.

Only the working phrase and animated dots are italicized. The leading bullet remains upright. Idle, warning, and error labels retain their current styling.

## Responsive behavior

Existing responsive priorities remain authoritative:

- **Gallery and Balanced:** show and animate the full working activity.
- **Focus:** show only the existing static colored activity bullet.
- **Telemetry and Safe:** omit activity as they do today.

The animation must not cause wrapping or exceed the supplied terminal width. Since the frames shrink from three columns to one, layout calculations use the currently rendered frame and continue to pass through ANSI-aware truncation.

## Testing

Use deterministic component tests with fake timers to verify:

- the initial frame is `...`,
- frames advance to `..`, `.`, and back to `...` at exact 400 ms intervals,
- the selected working phrase remains unchanged across animation redraws,
- the phrase and dots share italic styling while the bullet does not,
- the working activity uses orange,
- idle and compact modes do not animate,
- returning to idle stops and resets animation,
- disposal clears the timer and prevents subsequent redraw requests,
- branch unsubscription still occurs exactly once,
- all existing responsive width guarantees remain true for every frame.

Existing activity, state, palette, footer, extension, and package checks must continue to pass.

## Out of scope

- Making animation timing configurable.
- Adding yellow to the Atelier palette.
- Animating idle, warning, or error states.
- Changing the built-in Pi streaming indicator.
- Displaying the working phrase at narrower responsive breakpoints.

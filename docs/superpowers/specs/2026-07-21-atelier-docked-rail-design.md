# Pi Atelier Docked Rail Design

## Summary

Redesign the persistent Pi Atelier sidecar so it reads as a full-height docked information rail rather than a centered floating card. The rail remains a non-capturing overlay because Pi's public extension API cannot reserve application layout width, but it will be attached to the terminal's top-right edge, render to terminal height, use a continuous divider, and present a clearer information hierarchy.

The redesign also introduces a distinctive pixel-style PI monogram and simplifies the Session section.

## Root Cause

The current implementation still looks floating for three concrete reasons:

1. `anchor: "right-center"` centers a content-height overlay vertically.
2. `frameRows()` draws rounded top, side, and bottom borders around the content.
3. The component renders only its content rows; `maxHeight: "100%"` limits height but does not force full terminal height.

The Session section is visually noisy because it renders an unavailable name row, a long session-file path, and entry/persistence metadata as separate lines. The title is plain centered text and lacks a recognizable Pi Atelier identity.

## Goals

- Make the sidecar appear attached to the terminal's right edge from top to bottom.
- Preserve normal editor focus and non-capturing behavior.
- Add a distinctive, elegant pixel PI monogram.
- Reorganize information into a calm, sectioned rail.
- Make usage metrics easier to scan.
- Simplify session information to a compact summary.
- Preserve live updates, lifecycle safety, responsive auto-hide, error handling, palette behavior, and `NO_COLOR` support.

## Non-goals

- Modifying Pi core to create a true width-reserving split pane.
- Changing the sidecar's command or menu controls.
- Adding persistent visibility configuration.
- Adding new data sources, network requests, telemetry, or dependencies.
- Displaying the raw session-file path in the rail.

## Visual Structure

Conceptual output:

```text
Conversation remains interactive             │ ▛▀▜  ▀█▀
                                              │ ▙▄▟   █
                                              │ ▌     █
                                              │   ATELIER
                                              │
                                              │ PROJECT ───────────
                                              │ pi-atelier
                                              │ ~/pi-atelier
                                              │ ◆ main  •  clean
                                              │
                                              │ AGENT ─────────────
                                              │ gpt-5.6-sol
                                              │ openai-codex  medium
                                              │ ● READY
                                              │
                                              │ CONTEXT ───────────
                                              │ 6.8k / 272k    2.5%
                                              │ ██░░░░░░░░░░░░░░░░░░
                                              │ auto compact
                                              │
                                              │ SESSION ───────────
                                              │ 6 entries  •  persisted
                                              │
                                              │ USAGE ──────────────
                                              │ INPUT       OUTPUT
                                              │ 7.2k        60
                                              │ CACHE       HIT
                                              │ 5.6k        83.0%
                                              │ COST        ACCESS
                                              │ $0.040      subscription
                                              │
                                              │ TOOLS & STATUS ─────
                                              │ 4 / 7 active
                                              │
                                              │
```

## Visual Rules

- Use one continuous left divider on every rendered row.
- Do not draw top, right, bottom, or rounded borders.
- Fill the available terminal height with divided blank rows.
- Use intentional blank space between sections.
- Render section headings in uppercase muted text with a trailing thin rule.
- Use aligned two-column usage metrics instead of crowded sentences.
- Omit unavailable optional rows when omission is clearer than `—`.
- Retain `—` only where a required field needs an explicit unavailable value.

## PI Brand Mark

The selected brand treatment is:

```text
▛▀▜  ▀█▀
▙▄▟   █
▌     █
  ATELIER
```

The mark uses Pi Atelier's existing accent roles:

- Purple for the P form and ATELIER title
- Blue for the I stem or supporting detail
- Amber as a restrained highlight

The `NO_COLOR` path uses theme-native neutral and semantic roles and emits no custom RGB.

## Information Architecture

### Project

- Project directory name
- Home-shortened working path
- Git branch and clean/modified state

### Agent

- Model identifier
- Provider and thinking level
- Current activity

### Context

- Used tokens, context window, and percentage on one aligned row
- Twenty-cell progress bar
- Automatic or manual compaction mode

### Session

- Session name only when non-empty
- Entry count and persisted/ephemeral state on one row
- No raw session-file path
- No placeholder row when the name is unavailable

### Usage

Three aligned two-column pairs:

- Input / Output
- Cache / Hit
- Cost / Access

Labels are muted uppercase; values use their established palette roles.

### Tools and Status

- Active versus available tool count
- Sanitized extension status rows when vertical space permits

## Overlay Configuration

The sidecar overlay becomes:

```ts
{
  anchor: "top-right",
  width: 44,
  maxHeight: "100%",
  margin: 0,
  nonCapturing: true,
  visible: (termWidth) => termWidth >= 88
}
```

The width threshold and logical visibility behavior remain unchanged.

## Rendering Architecture

`createSidebarComponent` receives a live height getter:

```ts
getHeight(): number
```

The controller supplies `() => tui.terminal.rows` from the custom component factory. This reads the current height on every render, so terminal resizing requires no separate stored dimensions.

Rendering is separated into focused helpers:

- `renderBrandMark()`
- `renderProjectSection()`
- `renderAgentSection()`
- `renderContextSection()`
- `renderSessionSection()`
- `renderUsageSection()`
- `renderStatusSection()`
- `renderDock()`

Each section returns unframed content rows. `renderDock()` performs the final layout:

1. Select rows according to available terminal height.
2. ANSI-safely truncate each content row to `width - 2`.
3. Prefix each row with the styled divider and one space.
4. Pad with divided blank rows to the requested height.
5. Ensure every line is at most the supplied width.

The existing snapshot and controller lifecycle remain authoritative and unchanged.

## Short-Terminal Priorities

If terminal height cannot contain every row, remove lower-priority content from the bottom in this order:

1. Individual extension status details
2. Tool count section
3. Usage section details
4. Session section details

The PI mark, Project, Agent, and Context remain highest priority. The final row count never exceeds terminal height.

## Error Handling

Snapshot, configuration, or rendering failures use a docked error state:

```text
│ PI ATELIER
│ Sidebar unavailable
│ <sanitized error>
│
│
```

The error state follows the same live height, continuous divider, padding, width, and `NO_COLOR` rules. It never falls back to rounded framing.

## Lifecycle and Controls

The current controller behavior remains unchanged:

- `/atelier sidebar` toggles.
- `/atelier sidebar on` and `/atelier sidebar off` are idempotent.
- The Atelier menu exposes dynamic On/Off state.
- The overlay does not capture keyboard focus.
- It starts disabled in each session.
- It auto-hides below 88 columns.
- Session reload and shutdown dispose stale resources safely.
- Footer enable/disable remains independent.

## Testing

Tests will verify:

- `anchor: "top-right"`, width `44`, margin `0`, and `nonCapturing: true`
- Exact terminal-height output
- A continuous left divider on every row
- Absence of rounded box borders
- Pixel PI monogram and ATELIER title
- Section heading rules and organized spacing
- Aligned two-column usage metrics
- Compact session summary without raw file path or empty-name row
- Short-terminal priority dropping
- Live height changes across renders
- ANSI-safe width limits
- Docked error rendering
- Existing command/menu toggle, lifecycle generation, reload, shutdown, responsive visibility, palette, `NO_COLOR`, privacy, and package behavior

Full `npm run check` and `npm pack --dry-run` verification are required before integration.

## Acceptance Criteria

- The sidecar is attached to the top-right edge and visually fills terminal height.
- Every row has one continuous left divider and no rounded outer frame.
- The PI pixel monogram and ATELIER title are prominent and elegant.
- Information is organized as a sectioned rail with readable spacing.
- Session information is compact and excludes the raw session path.
- Usage metrics use aligned two-column pairs.
- Short terminals drop low-priority sections without exceeding height.
- Rendering remains ANSI-width safe and responsive to live terminal resizing.
- Error states use the same docked visual structure.
- Existing controls, lifecycle safety, focus behavior, `NO_COLOR`, privacy, and packaging remain correct.
- All repository and package checks pass.

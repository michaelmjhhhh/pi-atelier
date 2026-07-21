# Pi Atelier Sidebar Design

## Summary

Pi Atelier will add a read-only, live session-information sidebar opened with `/atelier sidebar`. The panel will complement the existing footer and menu by presenting useful details that do not fit in the responsive one-line status rail.

The existing commands remain unchanged:

- `/atelier` opens the control menu.
- `/atelier enable` enables the footer.
- `/atelier disable` disables the footer.
- `/atelier sidebar` opens the new information panel.

## Goals

- Present project, agent, context, session, usage, tool, and extension-status information in one organized view.
- Match Pi Atelier's fixed dark Midnight Spectrum and editorial visual language.
- Update the displayed information while the panel is open.
- Preserve useful behavior on narrow terminals.
- Keep sidebar rendering and data assembly isolated from menu and footer implementation details.

## Non-goals

- Editing settings from the sidebar.
- Replacing the existing Atelier menu.
- Keeping the editor interactive while the sidebar owns focus.
- Network requests, telemetry, or new persistent state.
- Displaying speculative data that Pi does not expose reliably.

## Interaction

Running `/atelier sidebar` opens a focused overlay. On wide terminals, it is anchored at the right and occupies approximately 38–44 columns. On terminals below the sidebar breakpoint, it falls back to a centered, near-full-width modal.

The panel is read-only. `Escape`, `q`, or `Ctrl+C` closes it and restores normal editor interaction. Only one sidebar may be open at a time. Resizing the terminal recomputes the layout and truncation.

The sidebar is available only in TUI mode. Other modes show a concise warning instead of attempting custom rendering.

## Information Architecture

The panel contains the following sections.

### Project

- Project directory name
- Shortened working-directory path
- Git branch
- Tracked clean or modified state

### Agent

- Provider
- Model identifier
- Thinking level
- Current Atelier activity state

### Context

- Used context tokens
- Model context window
- Context percentage
- Auto-compaction state
- Compact progress bar

Context values use the existing configured warning and danger thresholds.

### Session

- Session display name, when available
- Shortened session file path
- Persisted or ephemeral status
- Entry count on the active branch

### Usage

- Cumulative input tokens
- Cumulative output tokens
- Cache usage and hit percentage
- Estimated cumulative cost
- OAuth subscription-backed access state

### Tools and Status

- Active tool count
- Total available tool count
- Extension status messages

Unavailable values render as `—`. Long values are sanitized and ANSI-safe truncated to the component's inner width.

## Visual Direction

The sidebar uses a compact editorial hierarchy rather than selectable menu rows:

- Strong Pi Atelier title and thin framed border
- Uppercase, subdued section labels
- Comfortable blank-line spacing between groups
- Bright values with muted supporting labels
- A small context progress bar
- Minimal geometric ornaments

It reuses the fixed Midnight Spectrum from the footer:

- Blue for context and ready state
- Purple for output and menu accents
- Cyan for cache information
- Amber for activity, cost, and warnings
- Red for danger and errors
- Neutral gray for labels and unavailable values

`NO_COLOR` continues to use Pi's neutral and semantic theme roles.

Conceptual layout:

```text
╭─ PI ATELIER ─────────────────╮
│ SESSION OVERVIEW             │
│                              │
│ PROJECT                      │
│ pi-atelier                   │
│ ~/projects/pi-atelier        │
│ ◆ main  •  modified          │
│                              │
│ AGENT                        │
│ gpt-5.6-sol                  │
│ openai  •  medium            │
│ ● WORKING                    │
│                              │
│ CONTEXT                      │
│ 50k / 400k           12.5%   │
│ ███░░░░░░░░░░░░░░░░░         │
│                              │
│ SESSION                      │
│ Release preparation          │
│ 38 entries  •  persisted     │
│                              │
│ USAGE                        │
│ in 50k  out 1.9k  cache 96%  │
│ cost $0.479  •  subscription │
│                              │
│ TOOLS & STATUS               │
│ 8 / 12 active               │
│ ✓ extension status           │
│                              │
│ esc/q close                  │
╰──────────────────────────────╯
```

## Architecture

### `src/sidebar.ts`

This module owns the sidebar feature through four explicit seams:

- `buildSidebarSnapshot(...)` gathers display-ready source values without rendering them.
- `renderSidebarLines(...)` converts a snapshot into width-bounded styled lines.
- `createSidebarComponent(...)` handles rendering, invalidation, and close keys.
- `openAtelierSidebar(...)` configures and opens the responsive overlay.

The module will define a `SidebarSnapshot` type containing only data needed by the view. Rendering will not call Git, access the filesystem, or mutate runtime state.

### `extensions/index.ts`

The extension command router recognizes the `sidebar` action and calls `openAtelierSidebar(...)`. Existing menu, enable, and disable behavior remains intact.

The extension tracks a sidebar-specific render callback while the overlay is open. Existing lifecycle handlers request both footer and sidebar renders after relevant changes. Session shutdown clears both callbacks and closes or invalidates sidebar resources safely.

### Existing runtime and utilities

The sidebar consumes current `AtelierRuntime` state for model, thinking, activity, metrics, and tracked dirty state. It uses `SessionManager` for session identity and active-branch metadata, and `ExtensionAPI` for tool counts.

Palette and metric formatting are reused from the existing modules. Sidebar-specific border, progress-bar, grouping, and path-shortening logic remains local to `src/sidebar.ts`.

## Data Flow and Refresh

Each render requests a fresh `SidebarSnapshot` from current extension and runtime state. The panel does not maintain a second authoritative copy of session data.

The open panel is invalidated after:

- Agent activity starts or settles
- A turn ends
- Model or thinking level changes
- Session information changes
- Compaction completes
- Git state refreshes
- Extension statuses or branch data change when exposed by the active footer data source

The component calls `tui.requestRender()` only after invalidation-relevant events or terminal-driven rendering changes.

## Error Handling

- Missing session files are shown as ephemeral sessions.
- Missing names, Git branches, statuses, context values, and usage values render as `—` or are omitted when a count is clearer.
- Git refresh failures preserve safe fallback state and never prevent the sidebar from opening.
- Unexpected snapshot failures show a minimal framed error state and remain closable.
- Every rendered line is truncated to the width supplied by the TUI.
- Overlay lifecycle references are discarded after closure and are never reused.

## Testing

Unit tests will verify:

- Snapshot construction with complete metadata
- Snapshot construction with missing and ephemeral metadata
- Session active-branch entry counts
- Tool active and available counts
- Wide and narrow overlay option selection
- ANSI-safe line-width limits
- Long model, path, session, branch, and status truncation
- Context normal, warning, and danger presentation
- `NO_COLOR` behavior through the shared palette
- `Escape`, `q`, and `Ctrl+C` close handling
- `/atelier sidebar` routing
- Preservation of `/atelier`, `/atelier enable`, and `/atelier disable`
- Live invalidation and shutdown cleanup

The full existing `npm run check` verification remains required before release.

## Acceptance Criteria

- `/atelier sidebar` opens a right-side information overlay in TUI mode.
- The overlay presents all core overview sections using currently available local data.
- The panel visually matches the footer's fixed Midnight Spectrum.
- Values update while the panel remains open.
- Narrow terminals receive a centered responsive fallback.
- Every output line respects the supplied terminal width.
- The panel closes with `Escape`, `q`, and `Ctrl+C`.
- Existing Atelier commands and footer behavior remain unchanged.
- All tests and package checks pass.

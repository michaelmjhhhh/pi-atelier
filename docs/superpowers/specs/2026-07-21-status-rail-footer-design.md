# Status Rail Footer Redesign

**Date:** 2026-07-21  
**Status:** Design approved; written specification awaiting review

## Goal

Redesign Pi Atelier's one-line footer so it feels calm, readable, and visually deliberate without removing its useful content. The new presentation must improve hierarchy, grouping, labels, and color restraint while preserving existing metrics, commands, configuration, privacy behavior, and TUI compatibility.

## Problem

The current footer presents telemetry as a long sequence of similarly weighted, saturated values. Input, output, cache, cost, context, and menu affordance compete for attention. Abbreviations such as `R`, `CH`, and symbolic context notation require interpretation, while the lack of clear grouping makes the footer harder to scan than its content warrants.

## Design Direction

The approved direction is **Quiet Utility**, expressed as a **Status Rail**:

```text
● Working · gpt-5.5 · high · main              in 35k  out 803  cache 94%  $0.27  ctx 12%  ⌥A
```

The signature is an asymmetric two-zone rail: human-readable agent state and workspace identity on the left, stable operational telemetry on the right. Agent state is the first visual anchor. Everything else is quieter.

## Visual System

### Semantic color roles

The footer derives colors from the active Pi theme rather than using a fixed rainbow palette:

- **Accent:** activity indicator and active state label
- **Primary text:** metric values and important workspace values
- **Muted text:** metric labels, separators, thinking level, and secondary metadata
- **Warning:** elevated context usage and dirty-worktree marker
- **Error:** dangerous context usage and error activity

Warning and error colors are reserved for state that requires attention. Input, output, cache, cost, and normal context values do not receive separate hues.

When color is unavailable, hierarchy remains understandable through wording, spacing, and ordering.

### Typography and symbols

The terminal's active typeface remains authoritative. Hierarchy uses theme styling rather than font changes:

- Activity indicator and label are bold and accent-emphasized; warning and error replace the accent with their semantic state color.
- Metric labels are muted; values use primary text.
- Numeric values remain compact and stable.
- The default presentation removes the ornamental Atelier brand mark.
- `·` is used sparingly within the workspace zone; broad spacing groups telemetry.
- The dirty-worktree marker is a warning-colored `*`.

## Layout

### Left zone: state and workspace

Reading order:

1. Activity indicator and label
2. Model
3. Thinking level
4. Git branch and optional dirty marker

Example:

```text
● Working · gpt-5.5 · high · main*
```

The activity indicator and label use the accent and form the dominant anchor. Model, thinking level, and branch are progressively quieter.

### Right zone: telemetry and menu

Reading order:

1. Input tokens
2. Output tokens
3. Cache-hit percentage
4. Cost and subscription status
5. Context usage
6. Menu shortcut

Example:

```text
in 35k  out 803  cache 94%  $0.27  ctx 12%  ⌥A
```

Labels use readable words instead of cryptic prefixes. The right edge stays stable so repeated glances land on predictable information.

The default `editorial` presentation uses cache-hit percentage as its cache signal because it is the most immediately useful value. The `classic` preset retains detailed cache read/write counts. Full context may append the existing automatic-compaction marker when space permits; compact context omits it. Existing metric collection and calculation do not change.

## Responsive Behavior

The footer remains exactly one line and never wraps. It simplifies by removing lower-priority items rather than compressing them into ambiguous abbreviations.

Representative layouts:

```text
Wide
● Working · gpt-5.5 · high · main       in 35k  out 803  cache 94%  $0.27  ctx 12%  ⌥A

Medium
● Working · gpt-5.5                     in 35k  out 803  cache 94%  ctx 12%  ⌥A

Narrow
● Working                                      cache 94%  ctx 12%  ⌥A

Minimum
● Working                                              ctx 12%
```

Optional information is removed in this order:

1. Git branch and thinking level
2. Cost
3. Model
4. Input and output counts
5. Cache
6. Menu shortcut

Activity state and context health survive the longest. If the terminal is too narrow to show both fully, each uses an explicit compact form before ANSI-aware truncation is applied as a final safety measure.

The existing named width modes may remain as implementation details, but the visible behavior must follow this priority model rather than exposing abrupt stylistic changes between modes.

## Motion

Only working activity animates:

```text
● Working…
● Working..
● Working.
```

No telemetry value pulses, shifts, or changes color decoratively. Warning and error states update immediately without changing layout dimensions. Existing animation lifecycle requirements remain: animate only when the working label is visible, stop when hidden or settled, and dispose timers during teardown.

## Configuration and Presets

- The Status Rail becomes the default `editorial` presentation.
- Existing segment visibility and ordering remain supported within each semantic zone; state/workspace items always occupy the left zone and telemetry/menu items the right zone.
- `minimal` and `classic` presets remain available and retain their intent.
- Density settings may affect spacing and optional detail, but not semantic hierarchy.
- Ornament settings remain compatible; the default editorial presentation does not require a brand ornament.
- Existing `/atelier`, `/atelier enable`, `/atelier disable`, and shortcut behavior do not change.
- Existing persistence, trusted-project configuration, and menu actions do not change.

## Rendering Architecture

`src/footer.ts` should construct semantic footer items before applying styling. Each item should describe:

- Stable identifier
- Human-readable label and value
- Left or right zone
- Semantic visual role
- Full and compact representations where necessary
- Removal priority
- Configuration/availability condition

A layout composer should:

1. Build configured and available items.
2. Measure the complete left and right zones with ANSI-aware width utilities.
3. Remove optional items in the approved priority order until both zones fit.
4. Preserve spacing between zones and right-align telemetry when width permits.
5. Apply compact forms only where they remain understandable.
6. Truncate only as a final safety fallback.

`src/palette.ts` should expose semantic presentation roles rather than assigning a unique fixed RGB color to every metric category.

No runtime metric, Git, session, or configuration data flow changes are required.

## Error and Unavailable States

- Unavailable values display as a muted em dash.
- Warning and danger thresholds continue to use configured values.
- Unknown compaction state remains muted and must not resemble an alert.
- Missing model or Git information removes that item cleanly without leaving separators.
- Renderer failures or malformed optional strings must not cause wrapping or corrupt terminal control sequences.

## Validation

Automated tests must cover:

- Representative wide, medium, narrow, and minimum layouts
- Stable left/right composition and right alignment
- Approved information-removal priority
- Human-readable labels
- One-line rendering and ANSI-safe width limits
- Theme-derived accent, neutral telemetry, warning, error, and monochrome fallback roles
- Context threshold state changes
- Missing/unavailable metrics and workspace information
- Working animation visibility, timer lifecycle, and disposal
- Existing segment, density, ornament, and preset compatibility
- Existing menu, configuration, and extension lifecycle behavior

Manual validation should render the footer with at least one dark and one light Pi theme and compare the same session at representative terminal widths.

## Non-goals

- Changing metric calculations or usage collection
- Adding a second footer line
- Redesigning the `/atelier` overlay menu in this change
- Adding new telemetry or network access
- Replacing Pi's terminal typeface
- Removing existing commands or privacy guarantees

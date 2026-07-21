# Pi Atelier Quiet Utility Rail Design

## Summary

Refine the docked sidebar into a quiet, information-first utility rail modeled on strong open-source TypeScript TUIs. Remove persistent branding and decorative cyber-style elements. Preserve the existing full-height, non-capturing dock and its live data, but establish hierarchy through spacing, typography, alignment, and restrained semantic color.

This design supersedes the brand-mark portions of `2026-07-21-atelier-docked-rail-design.md`.

## Goals

- Make information easier to scan without competing with the Pi conversation.
- Remove the PI/ATELIER brand block from normal and error states.
- Reduce decorative glyphs and full-width ornamental rules.
- Use color only to communicate meaning or state.
- Keep the rail responsive, width-safe, non-capturing, and lifecycle-safe.

## Non-goals

- Modifying Pi core or reserving terminal layout width.
- Adding interaction, navigation, dependencies, telemetry, or new data sources.
- Changing commands, menu behavior, width `44`, or the `88`-column visibility threshold.
- Replacing the existing theme and `NO_COLOR` palette infrastructure.

## Visual Structure

```text
│ PROJECT
│ pi-atelier
│ ~/pi-atelier
│ main · modified
│
│ AGENT
│ gpt-5.6-sol
│ openai-codex · medium
│ Working · gitifying
│
│ CONTEXT
│ 32k / 400k                         8.1%
│ ███░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
│ auto compact
│
│ SESSION
│ Sidebar implementation
│ 38 entries · persisted
│
│ USAGE
│ INPUT                 OUTPUT
│ 50.0k                 1.9k
│ CACHE                 HIT
│ 100.0k                96.0%
│ COST                  ACCESS
│ $0.479                subscription
│
│ TOOLS
│ 8 / 12 active
│ tests passing
```

## Visual Rules

- Keep one muted continuous left divider and no outer frame.
- Begin immediately with Project; render no logo, wordmark, banner, or decorative spacer.
- Section headings are muted uppercase labels without trailing rules.
- Separate sections with exactly one blank divided row when space permits.
- Use `·` as the only inline separator.
- Remove the Git diamond, activity bullet, and status checkmarks.
- Primary text is neutral. Purple is limited to model/branch identity, blue to healthy context or ready state, amber/red to warning and error states.
- Context values align percentage to the right edge when width permits; the bar uses the full content width.
- Optional empty rows and unavailable optional sections are omitted rather than rendered as placeholders.

## Information Hierarchy

1. **Project** — name, shortened path, branch and clean/modified state.
2. **Agent** — model, provider/thinking, and activity/working label.
3. **Context** — usage/window, right-aligned percentage, full-width bar, compaction mode.
4. **Session** — optional name and compact entry/persistence row.
5. **Usage** — aligned Input/Output, Cache/Hit, and Cost/Access pairs.
6. **Tools** — active count followed by plain sanitized extension statuses.

Project, Agent, and Context remain required. Optional groups drop in the existing order: extension statuses, Tools, Usage, Session.

## Rendering Architecture

Keep `SidebarSnapshot`, controller lifecycle, and the final `renderDock()` boundary. Refactor only row helpers:

- `headingRow()` emits the muted label only.
- `gitRow()` emits branch and state without decorative glyphs.
- `agentRows()` emits title-case semantic activity without a bullet.
- `contextRows()` uses a reusable left/right alignment helper and a full-width bar.
- `toolsRows()` uses a `TOOLS` heading; status rows are plain text with semantic color.
- `renderSidebarError()` begins with `Sidebar unavailable` and sanitized detail, with no brand text.

The compositor still emits exactly terminal height, prefixes every row with the divider, truncates ANSI-safely, and respects width zero/negative guards.

## Error Handling

```text
│ Sidebar unavailable
│ <sanitized detail>
│
```

Errors retain exact-height padding, width safety, continuous divider, and neutral output. No PI Atelier branding appears.

## Testing

- Representative 44x36 no-color snapshot for hierarchy, spacing, and alignment.
- Assert absence of `PI ATELIER`, `ATELIER`, brand glyphs, heading rules, Git diamond, activity bullet, and status checkmarks.
- Verify right-aligned context percentage and full-width context bar.
- Verify empty/available status behavior and short-height drop priorities.
- Preserve exact-height, divider, width, live-resize, error, palette, `NO_COLOR`, command, lifecycle, and package tests.
- Run `npm run check`, `npm pack --dry-run`, and `git diff --check`.

## Acceptance Criteria

- The rail reads as a calm utility surface rather than a branded cyber dashboard.
- No persistent brand icon or title appears.
- Hierarchy comes from labels, whitespace, and alignment—not ornamental rules or glyphs.
- Semantic states remain immediately recognizable with and without color.
- Core information remains visible on short terminals, and all current lifecycle/privacy guarantees remain intact.
- Repository and package verification pass.

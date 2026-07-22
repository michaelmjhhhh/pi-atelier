# Changelog

## Unreleased

## 0.2.0 — 2026-07-22

- Reorder the sidebar around agent status, a compact context meter, and a merged workspace summary for faster scanning.
- Hide unavailable usage metrics and routine healthy extension statuses while surfacing explicit warning/error alerts.
- Collapse active tool names by default, automatically hide expanded names below 40 columns, and add a persistent command/menu toggle.
- Add a unified compact mode below 40 columns that reflows Agent, Workspace, Usage, Context, and Tools instead of truncating dense rows.
- Size paired metrics and tool columns from their content so wide sidebars do not introduce oversized empty gaps.
- Drop Tools, Usage, then Workspace as terminal height contracts.
- Reserve footer ellipsis width so working-state animation never shifts the model or following workspace text.

## 0.1.6

- Reflow Pi beside the sidebar with an extension-only, non-overlapping split presentation.
- Add session-scoped sidebar resizing through temporary `Ctrl+Shift+R` mouse and keyboard controls.
- Keep the visible sidebar width synchronized while resizing and make divider dragging tolerant of near misses.
- Remove the compaction-mode label from the sidebar context section.

## 0.1.5

- Add a packaged live-sidebar demo image and explicit sidebar toggle instructions.
- Update npm metadata to describe both the status rail and live activity sidebar.
- Show exact activated Pi tool names in a compact two-column sidebar list.
- Wire live Pi run, turn, and tool events into the sidebar while keeping the footer compact and free of tool history.
- Refine the full-height sidebar into a quiet, information-first utility rail with restrained semantic color and clearer alignment.
- Convert `/atelier sidebar` into a session-scoped, non-capturing right-edge sidecar with command and menu on/off controls.

## 0.1.4

- Replace the ASCII preview with the current Pi Atelier screenshot on GitHub and npm.

## 0.1.2

- Animate the visible work-cycle phrase with orange italics and a shrinking three-to-one ellipsis.

## 0.1.1

- Replace the fixed `WORKING` footer label with one stable, randomly selected activity phrase per work cycle.

## 0.1.0

- Add the blue-purple-orange Midnight Amethyst palette with neutral `NO_COLOR` fallback.
- Add semantic jewel-tone telemetry colors and five deterministic responsive layouts.
- Add a wide dual-zone instrument rail with elastic workspace/telemetry alignment.
- Add responsive editorial-luxe Pi footer.
- Preserve Pi usage, cache, cost, subscription, context, and compaction metrics.
- Add model, thinking-level, tool, display, and safe session controls.
- Add editorial, minimal, and classic presets.
- Add layered user and trusted-project JSON configuration.
- Add width, lifecycle, failure, privacy, and package contract tests.
- Require Pi 0.80.7+ and Node.js 22.19+.

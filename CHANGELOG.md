# Changelog

## Unreleased

- Add a global **Sidebar on startup** setting that is saved to user configuration while preserving session-scoped Sidebar on/off controls.
- Harden Atelier lifecycle teardown for session-owned overlays, exception-safe cleanup, stale Sidebar snapshots, candidate startup failures, and deferred Display saves.

## 0.7.2 — 2026-08-06

- Restore the non-overlapping Sidebar split in both Pi 0.84 renderer modes while retaining the non-capturing overlay as the content and safe fallback seam.
- Reserve regular-mode columns through the concrete `TuiMainScreen` prototype instead of capturing Pi 0.84's stable Proxy method, avoiding the recursive render path that caused startup hangs and sustained CPU usage.
- Reserve fullscreen columns by wrapping Pi's existing layout root in an `HStack`, preserving the transcript viewport, editor, status area, scrolling, and Sidebar width without replacing `render`.
- Restore fullscreen divider dragging by temporarily prioritizing Resize input ahead of Pi's viewport text-selection listener; remove that listener when Resize ends so ordinary selection remains unchanged.
- Keep the main pane at least 64 columns wide, auto-hide the Sidebar below 92 terminal columns, reconcile regular/fullscreen renderer replacements after hide/show, restore owned renderer/layout adaptations during disposal, and fall back without modification on unsupported renderers.
- Add Pi 0.84 regressions for the real regular renderer, fullscreen `renderLayoutFrame`, stable Proxy replacement, resizing and rollback, narrow terminals, adapter restoration, unsupported fallbacks, bounded rendering, and idle CPU safety.

## 0.7.1 — 2026-08-06

- Restore compatibility with Pi 0.84 by removing the recursive private TUI renderer wrapper and keeping the sidebar on Pi's supported non-capturing overlay seam.
- Test against Pi Coding Agent and Pi TUI 0.84, including the stable proxied TUI reference introduced for runtime renderer switching.
- Add a global, ordered Sidebar panel layout with draft editing, Save/Undo/default restore, unavailable-panel retention, and a namespaced structured contribution protocol.
- Route built-in TODOS through the same ordered composition while preserving legacy parsing, hidden state, branch changes, and safe output collapse.
- Add a global user Agent-panel visibility preference with persisted settings and independent Agent/TODOS rendering.
- Add a TODOS sidebar panel for legacy Pi `todo` details and the optional `@juicesharp/rpiv-todo` task format, without installing or requiring that extension.
- Show task progress and status indicators while keeping TODO state aligned with session initialization and session-tree branch changes.
- Preserve valid hidden updates, clear valid empty lists, collapse only visible/enabled successful results containing recognized tasks, and leave errors or malformed results fully visible.

## 0.7.0 — 2026-07-30

- Add the responsive Display Settings Workspace with the real Status Rail preview, continuous preset/density/Segment editing, provenance, Session overrides, one-step Undo, Revert, and atomic User-default Save.
- Replace the mixed root menu with a partitioned Atelier Control Center for Settings, Controls, and Actions, and add the direct `/atelier display` route.
- Keep legacy `segments`, `ornament`, and `showExtensionStatuses` configuration load-compatible while making normalized `segmentLayout` the sole Brand and Statuses visibility source.
- Add an opt-in `performance` Status Rail segment for live TTFT and estimated/final TPS, while preserving the existing default presets.

## 0.6.0 — 2026-07-29

- Add Workspace Pulse to summarize whole-worktree tracked changes, text additions/removals, count-only untracked files, binary files, changed submodules, and conflicts.
- Keep inspecting, clean, non-repository, unavailable, and stale workspace states explicit while preserving the footer's compact dirty marker.
- Refresh Workspace Pulse after debounced tool activity, Turn boundaries, and branch changes without polling, file watching, test execution, or untracked-content reads.

## 0.5.0 — 2026-07-27

- Keep fixed TTFT and TPS rows in the always-visible Activity panel, using `~` placeholders before values are available and `~`-marked live TPS estimates corrected from final usage when each response ends.
- Start the session-scoped sidebar shown whenever Pi Atelier initializes, while preserving explicit on/off controls and narrow-terminal auto-hiding.

## 0.4.0 — 2026-07-27

- Add best-effort native completion notifications on macOS and Windows when a Pi turn settles or the explicit ask-user tool requests input; failures remain silent without a Terminal fallback.
- Add a default-on, user-persisted completion notification toggle to the Atelier menu.
- Keep notification content limited to project, session, and operational status.

## 0.3.0 — 2026-07-23

- Redesign the sidebar as a responsive panel dashboard with terminal-native framed sections and clearer metric alignment.
- Add the Midnight Jewel treatment with semantic sapphire, amethyst, cyan, amber, and red panel crowns.
- Add a subtle pulsing Agent jewel during active runs while keeping all other panels visually stable.
- Introduce mixed typographic hierarchy for provider, thinking, and access metadata without changing sidebar behavior.
- Add repository-local engineering skills and agent conventions for issue tracking, triage labels, and domain documentation.
- Remove the legacy Superpowers plans and specifications.

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

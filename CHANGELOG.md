# Changelog

## Unreleased

- Automatically collapse the Sidebar when terminal width is limited and restore it when space returns. Add independent Auto/Manual modes and show/hide controls; preserve preferred width and full TODO output while collapsed ([#76](https://github.com/michaelmjhhhh/pi-atelier/issues/76)).

## 0.12.0 — 2026-09-26

- Keep sidebar plot space reserved while a dialog covers it, instead of switching smooth native curves into character staircases. Restore the plot after the dialog closes.

- Remove the Control Center Actions page, including session details, rename and compaction prompts, and the unused `showSessionActions` setting.
- Open the subagent graph directly from Control Center → Subagent usage, with the same session and trust checks as `/atelier usage`.
- Inspect individual reply points in `/atelier usage` with `[` / `]`: highlight the selected observation and show elapsed time, cumulative cost and that reply’s cost.

- Add a graph-only SUBAGENTS panel and framed `/atelier usage` view, with distinct per-child colors, numbered paginated legends, real observation markers and keyboard focus. Plot every readable child history without a six-curve display cap. Kitty-compatible terminals render anti-aliased curves; other terminals retain a text fallback ([#69](https://github.com/michaelmjhhhh/pi-atelier/issues/69)).
- Preserve distinct same-millisecond replies and receipt-only continuation histories; remove the extra 32-source cutoff while retaining byte limits and explicit partial-data status.
- Read owner-validated pi-subagents accounting events for reply-level cost history, reconcile completed curves against saved metadata, deduplicate repeated references and refresh only while background work is active. Main-agent usage stays separate.

## 0.11.2 — 2026-09-25

- Restore the terminal cursor after Sidebar cleanup when Pi has already stopped its renderer ([#72](https://github.com/michaelmjhhhh/pi-atelier/issues/72)).
- Use F6 as the default Control Center shortcut on macOS and Windows, avoiding Option-key text input on macOS. Keyboards with media keys may require Fn+F6 on either platform. Migrate saved Alt+A settings to F6 when loading configuration and stop registering Alt+A. Other custom shortcuts remain available alongside F6 ([#73](https://github.com/michaelmjhhhh/pi-atelier/issues/73)).

## 0.11.1 — 2026-09-24

- Clarify Sidebar metrics with aligned labels and values while retaining separate colored, rounded panels. Remove duplicate idle status, label Git/session/tool details, and show context usage with a continuous fractional-fill meter. Trim metadata before clipping core panels in very short terminals ([#70](https://github.com/michaelmjhhhh/pi-atelier/issues/70)).

## 0.11.0 — 2026-09-23

- Add a global **Font mode** setting with a Plain text option for terminals without Nerd Fonts. Replace footer icons with labels and ordinary separators across the composer, complete footer, and display preview; preserve the default Nerd Font mode. Set `"nerdFont": false` in user configuration to use Plain text on startup ([#67](https://github.com/michaelmjhhhh/pi-atelier/issues/67)).
- Integrate an original prompt-style session strip into the composer's top border, with colored model/workspace/Git groups, optional Nerd Font icons, and context percentage/capacity. Keep measured usage and timing in a quiet row below, preserve editor scroll hints, and fall back to the complete footer when the composer is unavailable or too narrow.
- Exclude Sidebar text from fullscreen screen selection and copy when a mouse drag starts outside the transcript, including in the editor or Sidebar. Preserve transcript scrolling and modal selection.

## 0.10.3 — 2026-09-22

- Skip redundant HEAD and diff commands in Workspace Pulse when no tracked files have changed, preserving untracked-file reporting ([#61](https://github.com/michaelmjhhhh/pi-atelier/issues/61)).
- Measure Sidebar height from row counts instead of repeatedly painting discarded panels, preserving panel order and existing content priorities ([#59](https://github.com/michaelmjhhhh/pi-atelier/issues/59)).
- Suspend Git inspections, usage/history scans, and streaming token estimates while Atelier is disabled; cancel pending work, reject stale inspection results, and reconcile once on re-enable ([#57](https://github.com/michaelmjhhhh/pi-atelier/issues/57)). Preserve run/tool bookkeeping and reset partially observed response timing.
- Fix Display Revert followed by Undo restoring an earlier Sidebar edit instead of the Display override.
- Consolidate configuration resolution and dialog lifecycle handling, use one internal Sidebar visibility layout, and remove unused runtime options and redundant snapshot copying. Legacy persisted Sidebar visibility settings remain supported.

## 0.10.2 — 2026-09-21

- Preserve Sidebar text and borders beside inline images in regular and fullscreen mode ([#53](https://github.com/michaelmjhhhh/pi-atelier/issues/53)).
- Temporarily hide visible transcript images while settings and other capturing overlays are open, then restore them on close without changing image data or reserved layout space. This behavior has been manually verified and accepted by the maintainer.

## 0.10.1 — 2026-09-04

- Remove unused internal formatters, configuration helpers, preview hooks, and legacy menu interfaces without changing the active UI or persisted configuration formats.
- Simplify Sidebar panel identity and share TODO detail extraction across live updates and session reconstruction.
- Replace redundant tests with active-path coverage, including concrete split-pane renderer installation and restoration.

## 0.10.0 — 2026-08-28

- Keep the Sidebar calm during an active Turn: Activity shows current work instead of a tool log, extra live tools fold into one row, and TODOS lists only the in-progress task.
- Drop the idle full-height dock rule so the split meets the rounded panels cleanly; the warning divider appears only while resizing.

## 0.9.0 — 2026-08-28

- Frame the composer with a rounded box and inner padding while preserving Pi's thinking-level and bash-mode border colors, and dim Status Rail identity separators to emphasize activity.
- Keep Sidebar content out of fullscreen transcript selection and copy by rendering it as a separate split-layout child; this raises the minimum supported Pi version to 0.84.0.
- Delay Workspace Pulse Git inspections until Pi trusts the project.
- Normalize UI-facing Windows paths to forward slashes while preserving valid POSIX backslashes.

## 0.8.2 — 2026-08-19

- Coalesce and serialize Workspace Pulse inspection requests so short Turns avoid duplicate Git work and overlapping inspections no longer run concurrently.
- Preserve live tool-driven Workspace Pulse updates while guaranteeing a fresh inspection at Turn end and preventing retired sessions from publishing stale results.

## 0.8.1 — 2026-08-12

- Preserve fullscreen transcript mouse-wheel scrolling after Sidebar resize and visibility changes by leaving Pi's persistent mouse reporting enabled.
- Simplify the README.

## 0.8.0 — 2026-08-07

- Add a global **Sidebar on startup** setting that is saved to user configuration while preserving session-scoped Sidebar on/off controls.
- Harden Atelier lifecycle teardown for session-owned overlays, exception-safe cleanup, stale Sidebar snapshots, candidate startup failures, and deferred Display saves.
- Simplify Sidebar context rendering, contributed-panel validation, and Sidebar undo bookkeeping without changing behavior.

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

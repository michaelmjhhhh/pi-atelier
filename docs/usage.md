# Usage guide

[Back to the README](../README.md)

## Subagent usage

The **SUBAGENTS** panel shows only cost curves and matching colored, numbered legends. Each curve represents a separate child execution, including repeated names such as `scout`. All readable child histories share the graph; children awaiting their first accounting event do not yet have a curve. Colors extend beyond the initial palette instead of repeating every six children. The sidebar bounds legend height only; its curve count includes every plotted child. The horizontal axis is elapsed seconds since each child started, and the vertical axis is its cumulative reported cost. Token tables, individual cost labels and metadata details are omitted.

Open `/atelier` (or F6) → **Subagent usage**, or run `/atelier usage`, for a larger graph inside a padded, rounded border. Use Left/Right to emphasize one child, A to restore all colors, Up/Down or Page Up/Down to page through long legends, and Escape to close. Use `[` / `]` to inspect the previous/next actual reply point on the selected child. The highlighted marker matches a readout of elapsed time, cumulative cost and the increase charged by that reply; the synthetic zero baseline is excluded. Selecting a child starts at its latest recorded point and automatically reveals its legend page; paging legends never removes curves. Both entry points share the same trust, enabled-state and session-lifetime checks. Closing the graph opened from Control Center returns to its menu. It is a snapshot: close and reopen to refresh. The graph fits the available space without scrolling; very small terminals show a resize hint.

Kitty-compatible terminals, including Ghostty, display a transparent native PNG with thin anti-aliased curves, minimal axes and markers at actual reply observations. Monotone interpolation connects real observations without exceeding their endpoints; it does not represent measured intermediate billing. No external image program or new dependency is required. The image is cached until data, focus or dimensions change. While a capturing dialog is visible, the sidebar reserves the plot space and shows a short close-dialog hint, retaining its title and legend. Closing the dialog restores the plot; temporary occlusion never triggers the character fallback. This prevents background images from covering menus. Other terminals use connected character strokes. With colors disabled, numbered legends and the expanded view's focus controls still identify the children.

Curve data comes from owner-validated background `events.jsonl` files: only assistant `message_end` accounting records with the matching child run, step and agent are accepted. The reader projects timestamps and `usage.cost.total`; event content and tool arguments are discarded. Streaming `message_update` is absent from these producer logs, so curves update when replies finish, not on each token. Saved `_meta.json` remains authoritative for reconciliation; event costs are never added to saved accounting totals. If a completed history disagrees with its saved cost, that curve is unavailable. Missing/unknown costs and read limits are marked partial, not filled with made-up spend. Foreground runs without these background artifacts retain saved statistics but have no reconstructed curve.

History reads are bounded to 2 MiB per event file and 8 MiB per refresh, within the bounded session-owned artifact discovery. There is no additional 32-source history cap. Background work triggers serialized refreshes every 1.5 seconds while active; refreshes stop when it settles, Atelier is disabled/disposed, or workspace trust is revoked. No idle polling is added. In short terminals the sidebar graph is removed as a whole; open `/atelier usage` for the larger view. Nerd Font off uses basic characters in the text fallback.

Use Settings → Display to reorder or hide the `subagents` panel. **USAGE and the footer still show main-agent usage; SUBAGENTS shows child cost histories separately.** Tool-result totals are not added again. Unavailable or unknown costs are not replaced with zero. Thinking-level attribution is not included.

Only runs referenced by the current session's subagent tool results, `bg_wait` completions, slash results or observed async completion events are eligible. For async workflows, the session-owned `status.json` and workflow receipt map the root run to its child and continuation run IDs; these files provide identity; saved subtotals still come from `_meta.json` and curves use the numeric event records described above. Reads use explicit metadata paths plus the producer's session, project and temporary artifact directories. Diagnostic event logs are parsed for curve accounting; standalone transcripts and output logs are not read, and no network request is made. Metadata inspection requires a trusted project. Async events must belong to the active session, using the producer’s session-file-path identity or Pi’s UUID. Ownerless child-status hints only request a refresh of a root already referenced by this session; the lifecycle file is checked for ownership before child IDs are accepted. Atelier retains only run IDs and metadata paths as custom session entries, so references survive reload; the metadata files remain owned by pi-subagents.

Missing, disabled, expired, malformed or unreadable metadata is reported as unavailable rather than zero spend. The graph covers discovered readable histories, not a guarantee of every nested or historical task. Directory/file read limits produce an explicit partial indicator. File reads happen during session/turn refresh, coalesced async start/child-status/completion events or `/atelier usage`, never in the render loop. Active-only curve refreshes stop when background work settles.

Compatibility was checked against pi-subagents source `2e9c51bada2da6a9ba73b6973e1545a9afa0d057` (repository package 0.71.0). Its metadata is enabled by default but can be disabled or cleaned up. Current upstream develops against Pi 0.87.0 and declares pi-ai >=0.86.1; use a compatible Pi host for combined manual testing. Atelier keeps its own >=0.84.0 baseline.

## Terminal font

Without a Nerd Font, open `/atelier` → **Settings → Font mode** and select **Plain text**. This replaces session-strip and footer icons with text labels and ordinary separators while preserving colors, metrics, and responsive layout. The change applies immediately and is saved as a global user preference; project settings and display presets cannot override it. Ordinary Unicode borders remain, so a standard monospace font such as macOS Menlo is sufficient.

Alternatively, add `"nerdFont": false` to `~/.pi/agent/pi-atelier.json` and run `/reload`. Atelier does not attempt to detect installed fonts.

The default **Nerd Font** mode requires a Nerd Font selected in your terminal. macOS does not include Nerd Fonts by default. Install one with [Homebrew](https://formulae.brew.sh/cask/font-jetbrains-mono-nerd-font):

```sh
brew install --cask font-jetbrains-mono-nerd-font
```

Then select **JetBrainsMono Nerd Font Mono** in your terminal's font settings. Installing the font alone does not select it for the terminal. On other platforms, install a font from [Nerd Fonts downloads](https://www.nerdfonts.com/font-downloads) and select it in the same way.

Atelier does not bundle or install fonts or change terminal settings. If icons appear as boxes or missing symbols, select **Plain text** or configure a Nerd Font.

### Plain text preview

![Plain text session strip with model, workspace, Git, context, and usage labels](images/plain-text-footer-session.png)

## Sidebar, selection, and images

The sidebar starts visible and hides when the terminal is too narrow. Press `Ctrl+Shift+R` to resize it.

Its separate colored, rounded panels use aligned labels and values for model configuration, response timing, Git changes, session storage, usage, and enabled tools. Context usage has a continuous progress track with fractional fill, a right-aligned percentage, and a quieter token count. In short terminals, optional details are removed first; metadata then contracts to retain the core Agent, Activity, and Context panels.

In Pi fullscreen TUI mode, the sidebar is rendered as a separate split-layout child so transcript selection and copy stay scoped to Pi output. Mouse drags starting in the editor or sidebar also exclude sidebar text from screen selection and copy when no modal is open. Regular TUI mode remains terminal-native, so a rectangular terminal selection can still include sidebar text.

Inline images remain visible beside the sidebar. While settings or another capturing overlay is open, visible transcript images temporarily hide to keep the panel readable; closing the panel restores them without changing image data or layout space.

The TODO panel supports Pi `todo` results and the optional `@juicesharp/rpiv-todo` extension.

## Status rail and responsive layout

The composer's top border holds activity, model/thinking, workspace and Git (controlled by the Git segment), and context percentage/capacity in one continuous strip. Violet model text, cyan workspace text, and blue Git text distinguish the groups; context turns amber/red at the configured thresholds. Narrow layouts shorten long names and remove secondary detail before dropping model identity.

The quieter row below shows measured token usage, cache, cost, and response timing. Unmeasured telemetry stays hidden. In Nerd Font mode, [prompt icons](https://starship.rs/presets/nerd-font) identify model, thinking, workspace, Git, input/output, cache, latency, throughput, and context. Plain text mode uses labels such as `git`, `ctx`, `in`, `out`, `TTFT`, and `TPS`. Display presets, visibility, and ordering still apply within each row.

The composer retains its rounded frame, input padding, scroll indicators, and Pi's thinking-level/bash-mode border colors. When a Pi selector replaces the composer, the terminal is below 12 rows tall, or the editor is too narrow for the inset strip, Atelier falls back to the complete status rail below.

Pi supports one custom footer and one custom editor at a time. Extension load order determines which chrome is visible.

## Disabling and re-enabling

Disabling Atelier hides its UI, pauses usage/history scans and streaming estimates, cancels pending workspace refreshes, and aborts active Git inspection. Small run/tool bookkeeping continues. Re-enabling refreshes usage, TODOs, and workspace state once; show the sidebar again with `/atelier sidebar on`. If a response spans a disabled interval, its TTFT/TPS remains unavailable until the next provider request rather than reporting partial timing.

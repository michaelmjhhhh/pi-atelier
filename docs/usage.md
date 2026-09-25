# Usage guide

[Back to the README](../README.md)

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

The sidebar starts in **Auto** mode, using the width available to Pi. Opening a terminal host's sidebar or narrowing its pane causes Atelier to adapt when that host reports the changed terminal dimensions.

- **Auto** reserves 80 columns for the main pane plus your preferred sidebar width. With the default 44-column sidebar, it collapses below 124 columns and reopens at 132. Between those thresholds it keeps its previous state to avoid flicker. On initial startup or explicit entry into Auto, it shows at 124 or more.
- **On** keeps the sidebar shown whenever at least 64 main-pane columns and 28 sidebar columns fit. It can shrink temporarily and hides below 92 columns, then returns at 92.
- **Off** stays hidden through all terminal resizes.

Use `/atelier sidebar auto|on|off` or **F6 → Controls → Sidebar** to choose a mode for this session. Bare `/atelier sidebar` turns a shown sidebar off, or pins a hidden sidebar on. **Settings → Sidebar on startup** chooses Auto or Off for future sessions using the existing `showSidebarOnStartup` boolean; it does not change the current mode.

Press `Ctrl+Shift+R` to resize a visible sidebar with the arrow keys or by dragging its divider. Enter or mouse release commits the width and selects On mode; Escape restores the previous width and mode. Shrinking the terminal below the hard minimum cancels resizing and releases input capture. Your preferred width survives ordinary terminal resizing. Returning to Auto uses that width for its thresholds: a 60-column sidebar collapses below 140 and reopens at 148.

Automatically hiding the sidebar reclaims its entire width and preserves live data. Sidebar animation pauses while hidden. New TODO results retain their full output while the sidebar is hidden; earlier results already abbreviated to “see sidebar” are not rewritten.

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

Disabling Atelier hides its UI, pauses usage/history scans and streaming estimates, cancels pending workspace refreshes, and aborts active Git inspection. Small run/tool bookkeeping continues. Re-enabling refreshes usage, TODOs, and workspace state once; restore the sidebar with `/atelier sidebar auto` or `/atelier sidebar on`. If a response spans a disabled interval, its TTFT/TPS remains unavailable until the next provider request rather than reporting partial timing.

# Pi Atelier

A responsive status rail and activity sidebar for [Pi](https://pi.dev).

[![Pi Atelier demo](https://raw.githubusercontent.com/michaelmjhhhh/pi-atelier/main/assets/demo.png?v=0.10.0)](https://github.com/michaelmjhhhh/pi-atelier/releases/download/v0.10.0/demo.mp4)

[Watch the demo](https://github.com/michaelmjhhhh/pi-atelier/releases/download/v0.10.0/demo.mp4)

## Features

- Prompt-style session strip built into the composer, with optional Nerd Font icons and compact telemetry below
- Live agent, tool, context, workspace, usage, and TODO information, kept compact while a Turn is running
- Model, thinking-level, and tool controls
- Configurable display presets, segments, and sidebar panels
- Session details, rename, and compaction actions
- Completion notifications on macOS and Windows
- No telemetry or external network requests

## Requirements

- Pi 0.84.0 or newer
- Node.js 22.19.0 or newer
- Interactive TUI mode
- A monospace terminal font; the default icon mode needs a [Nerd Font](#terminal-font), while Plain text mode works without one

## Install

```bash
pi install npm:pi-atelier
```

Run a local checkout without installing it:

```bash
pi -e ./pi-atelier
```

Pi packages run with your system permissions. Review third-party source before installation.

### Terminal font

Without a Nerd Font, open `/atelier` → **Settings → Font mode** and select **Plain text**. This replaces session-strip and footer icons with text labels and ordinary separators while preserving colors, metrics, and responsive layout. The change applies immediately and is saved as a global user preference; project settings and display presets cannot override it. Ordinary Unicode borders remain, so a standard monospace font such as macOS Menlo is sufficient.

Alternatively, add `"nerdFont": false` to `~/.pi/agent/pi-atelier.json` and run `/reload`. Atelier does not attempt to detect installed fonts.

The default **Nerd Font** mode requires a Nerd Font selected in your terminal. macOS does not include Nerd Fonts by default. Install one with [Homebrew](https://formulae.brew.sh/cask/font-jetbrains-mono-nerd-font):

```sh
brew install --cask font-jetbrains-mono-nerd-font
```

Then select **JetBrainsMono Nerd Font Mono** in your terminal's font settings. Installing the font alone does not select it for the terminal. On other platforms, install a font from [Nerd Fonts downloads](https://www.nerdfonts.com/font-downloads) and select it in the same way.

Atelier does not bundle or install fonts or change terminal settings. If icons appear as boxes or missing symbols, select **Plain text** or configure a Nerd Font.

## Use

Open the control center:

```text
/atelier
```

Default shortcut: `alt+a`

The control center includes display settings, sidebar controls, model and tool selection, session details, rename, and compaction.

Commands:

```text
/atelier display            # display settings
/atelier sidebar            # toggle sidebar
/atelier sidebar on|off     # set sidebar visibility
/atelier sidebar tools      # toggle tool names
/atelier enable|disable     # set extension state
```

Disabling Atelier hides its UI, pauses usage/history scans and streaming estimates, cancels pending workspace refreshes, and aborts active Git inspection. Small run/tool bookkeeping continues. Re-enabling refreshes usage, TODOs, and workspace state once; show the sidebar again with `/atelier sidebar on`. If a response spans a disabled interval, its TTFT/TPS remains unavailable until the next provider request rather than reporting partial timing.

The sidebar starts visible and hides when the terminal is too narrow. Press `Ctrl+Shift+R` to resize it.

In Pi fullscreen TUI mode, the sidebar is rendered as a separate split-layout child so transcript selection and copy stay scoped to Pi output. Mouse drags starting in the editor or sidebar also exclude sidebar text from screen selection and copy when no modal is open. Regular TUI mode remains terminal-native, so a rectangular terminal selection can still include sidebar text.

Inline images remain visible beside the sidebar. While settings or another capturing overlay is open, visible transcript images temporarily hide to keep the panel readable; closing the panel restores them without changing image data or layout space.

The TODO panel supports Pi `todo` results and the optional `@juicesharp/rpiv-todo` extension.

Status rail presets:

- **editorial**: default layout
- **minimal**: compact layout
- **classic**: detailed telemetry

The composer's top border holds activity, model/thinking, workspace and Git (controlled by the Git segment), and context percentage/capacity in one continuous strip. Violet model text, cyan workspace text, and blue Git text distinguish the groups; context turns amber/red at the configured thresholds. Narrow layouts shorten long names and remove secondary detail before dropping model identity.

The quieter row below shows measured token usage, cache, cost, and response timing. Unmeasured telemetry stays hidden. In Nerd Font mode, [prompt icons](https://starship.rs/presets/nerd-font) identify model, thinking, workspace, Git, input/output, cache, latency, throughput, and context. Plain text mode uses labels such as `git`, `ctx`, `in`, `out`, `TTFT`, and `TPS`. Display presets, visibility, and ordering still apply within each row.

The composer retains its rounded frame, input padding, scroll indicators, and Pi's thinking-level/bash-mode border colors. When a Pi selector replaces the composer, the terminal is below 12 rows tall, or the editor is too narrow for the inset strip, Atelier falls back to the complete status rail below.

Pi supports one custom footer and one custom editor at a time. Extension load order determines which chrome is visible.

## Configuration

User configuration:

```text
~/.pi/agent/pi-atelier.json
```

Trusted project configuration:

```text
<project>/.pi/pi-atelier.json
```

Project settings override user settings. Session changes override both. Global font mode, sidebar startup, and notification preferences remain user-only.

```json
{
  "preset": "editorial",
  "nerdFont": true,
  "shortcut": "alt+a",
  "density": "comfortable",
  "contextWarning": 70,
  "contextDanger": 90,
  "showSidebarOnStartup": true,
  "showSidebarToolNames": false,
  "completionNotifications": true
}
```

Use **Settings → Display** to reorder or hide status rail segments and sidebar panels. Undo restores the latest Display or Sidebar edit, including a Display Revert. Legacy user settings `showSidebarAgent` and `showSidebarTodos` remain supported when `sidebarPanelLayout` is absent.

## Privacy

Pi Atelier:

- Does not collect telemetry or analytics
- Does not store prompts, responses, credentials, or session content
- Uses read-only Git inspection for workspace status only after the project is trusted
- Does not read untracked file contents
- Reads project configuration only for trusted projects
- Does not include prompts or responses in notifications

## Troubleshooting

- Shortcut unavailable: use `/atelier`, change `shortcut`, then run `/reload`.
- Status rail missing: use TUI mode and check for another custom footer.
- Missing icon glyphs: choose **Settings → Font mode: Plain text**, or select a Nerd Font in your terminal settings.
- Metric mismatch: token and cost totals cover the session; context usage covers the current model context.

## Development

```bash
git clone https://github.com/michaelmjhhhh/pi-atelier.git
cd pi-atelier
npm install
npm run check
./node_modules/.bin/pi --no-session --no-extensions -e ./extensions/index.ts
```

See [CONTRIBUTING.md](https://github.com/michaelmjhhhh/pi-atelier/blob/main/CONTRIBUTING.md).

## License

MIT

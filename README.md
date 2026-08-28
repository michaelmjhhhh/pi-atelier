# Pi Atelier

A responsive status rail and activity sidebar for [Pi](https://pi.dev).

[![Pi Atelier demo](https://raw.githubusercontent.com/michaelmjhhhh/pi-atelier/main/docs/demo.png)](https://github.com/michaelmjhhhh/pi-atelier/releases/download/v0.3.0/demo.mp4)

[Watch the demo](https://github.com/michaelmjhhhh/pi-atelier/releases/download/v0.3.0/demo.mp4)

## Features

- Responsive one-line status rail
- Live agent, tool, context, workspace, usage, and TODO information
- Model, thinking-level, and tool controls
- Configurable display presets, segments, and sidebar panels
- Session details, rename, and compaction actions
- Completion notifications on macOS and Windows
- No telemetry or external network requests

## Requirements

- Pi 0.84.0 or newer
- Node.js 22.19.0 or newer
- Interactive TUI mode

## Install

```bash
pi install npm:pi-atelier
```

Run a local checkout without installing it:

```bash
pi -e ./pi-atelier
```

Pi packages run with your system permissions. Review third-party source before installation.

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

The sidebar starts visible and hides when the terminal is too narrow. Press `Ctrl+Shift+R` to resize it.

In Pi fullscreen TUI mode, the sidebar is rendered as a separate split-layout child so transcript selection and copy stay scoped to Pi output. Regular TUI mode remains terminal-native, so a rectangular terminal selection can still include sidebar text.

The TODO panel supports Pi `todo` results and the optional `@juicesharp/rpiv-todo` extension.

Status rail presets:

- **editorial**: default layout
- **minimal**: compact layout
- **classic**: detailed telemetry

The composer uses a rounded frame with inner padding. Thinking-level and bash-mode still color that frame through Pi.

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

Project settings override user settings. Session changes override both. Global sidebar and notification preferences remain user-only.

```json
{
  "preset": "editorial",
  "shortcut": "alt+a",
  "density": "comfortable",
  "contextWarning": 70,
  "contextDanger": 90,
  "showSidebarOnStartup": true,
  "showSidebarToolNames": false,
  "completionNotifications": true
}
```

Use **Settings → Display** to reorder or hide status rail segments and sidebar panels.

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
- Metric mismatch: token and cost totals cover the session; context usage covers the current model context.

## Development

```bash
git clone https://github.com/michaelmjhhhh/pi-atelier.git
cd pi-atelier
npm install
npm run check
npx --no-install pi -e .
```

See [CONTRIBUTING.md](https://github.com/michaelmjhhhh/pi-atelier/blob/main/CONTRIBUTING.md).

## License

MIT

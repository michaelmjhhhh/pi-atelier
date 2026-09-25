# Pi Atelier

[![npm version](https://img.shields.io/npm/v/pi-atelier)](https://www.npmjs.com/package/pi-atelier)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/michaelmjhhhh/pi-atelier/blob/main/LICENSE)
[![Pi compatibility: 0.84.0 or newer](https://img.shields.io/badge/Pi-%3E%3D0.84.0-violet)](#requirements)

Keep model, context, Git status, usage, and tool activity visible while you work in [Pi](https://pi.dev).

Pi Atelier adds a responsive status rail to the composer and a live activity sidebar to your terminal.

[Quick start](#quick-start) · [Features](#features) · [Use](#use) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting)

[![Pi Atelier status rail and activity sidebar demo](https://raw.githubusercontent.com/michaelmjhhhh/pi-atelier/main/assets/demo.png?v=0.10.0)](https://github.com/michaelmjhhhh/pi-atelier/releases/download/v0.10.0/demo.mp4)

[Watch the demo (v0.10.0)](https://github.com/michaelmjhhhh/pi-atelier/releases/download/v0.10.0/demo.mp4)

## Quick start

Install the extension:

```bash
pi install npm:pi-atelier
```

Start Pi, then open the control center:

```text
/atelier
```

You can also press **F6** on macOS and Windows (**Fn+F6** on keyboards with media keys). If icons appear as boxes, select **Settings → Font mode → Plain text**. For icon setup, see [Terminal font](#terminal-font).

Pi packages run with your system permissions. Review third-party source before installation.

### Requirements

- Pi 0.84.0 or newer
- Node.js 22.19.0 or newer
- Interactive TUI mode
- A monospace terminal font; use Plain text mode or select a Nerd Font for icons

### Terminal font

Plain text mode works with a standard monospace font and preserves colors, metrics, and responsive layout. The default Nerd Font mode requires a Nerd Font selected in your terminal settings.

See the [font setup guide and Plain text preview](https://github.com/michaelmjhhhh/pi-atelier/blob/main/docs/usage.md#terminal-font) for installation instructions and configuration details.

## Features

- **Session visibility:** model, thinking level, context, token usage, cost, and session details in a compact status rail and sidebar.
- **Live activity:** agent and tool activity, TODOs, response timing, and completion notifications on macOS and Windows.
- **Workspace context:** workspace identity and read-only Git status alongside your session.
- **Personalization:** display presets, configurable segments and panels, optional Nerd Font icons, and model and tool controls.

No telemetry or external network requests. See [Privacy](#privacy).

## Use

Open `/atelier` or press **F6** to change display settings, control the sidebar, select models and tools, rename the session, or compact it.

```text
/atelier display            # display settings
/atelier sidebar             # toggle sidebar visibility
/atelier sidebar auto|manual # choose sidebar mode
/atelier sidebar on|off      # show/hide without changing mode
/atelier sidebar tools      # toggle tool names
/atelier enable|disable     # set extension state
```

The sidebar starts in **Auto** mode: it collapses when space is tight and reopens when there is room. At the default width, it collapses below 124 terminal columns and reopens at 132. Auto disables manual width adjustment. Choose **Manual** to adjust a visible sidebar with `Ctrl+Shift+R`. Showing or hiding the sidebar is independent of its mode; a manually hidden sidebar stays hidden when the terminal grows. See the [usage guide](docs/usage.md#sidebar-selection-and-images) for details. Its TODO panel supports Pi `todo` results and the optional `@juicesharp/rpiv-todo` extension.

Choose a status rail preset in the display settings:

| Preset | Layout |
| --- | --- |
| **editorial** | Default layout |
| **minimal** | Compact layout |
| **classic** | Detailed telemetry |

Pi supports one custom footer and one custom editor at a time. Extension load order determines which chrome is visible.

See the [usage guide](https://github.com/michaelmjhhhh/pi-atelier/blob/main/docs/usage.md) for responsive layout, selection and copy, inline images, and disable/re-enable behavior.

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
  "shortcut": "f6",
  "density": "comfortable",
  "contextWarning": 70,
  "contextDanger": 90,
  "showSidebarOnStartup": true,
  "showSidebarToolNames": false,
  "completionNotifications": true
}
```

Use **Settings → Display** to reorder or hide status rail segments and sidebar panels. Undo restores the latest Display or Sidebar edit, including a Display Revert. Legacy user settings `showSidebarAgent` and `showSidebarTodos` remain supported when `sidebarPanelLayout` is absent.

## Troubleshooting

- Shortcut unavailable: use `/atelier`, change `shortcut`, then run `/reload`. The default is `f6` on both macOS and Windows; keyboards with media keys may require Fn+F6 on either platform. Saved `alt+a` settings now resolve to `f6`; Alt+A is no longer registered. Other custom `shortcut` settings add an alternative binding alongside F6. Other extensions or terminal key mappings can still intercept F6.
- Status rail missing: use TUI mode and check for another custom footer.
- Missing icon glyphs: choose **Settings → Font mode: Plain text**, or select a Nerd Font in your terminal settings.
- Metric mismatch: token and cost totals cover the session; context usage covers the current model context.

## Privacy

Pi Atelier:

- Does not collect telemetry or analytics
- Does not store prompts, responses, credentials, or session content
- Uses read-only Git inspection for workspace status only after the project is trusted
- Does not read untracked file contents
- Reads project configuration only for trusted projects
- Does not include prompts or responses in notifications

## Development

```bash
git clone https://github.com/michaelmjhhhh/pi-atelier.git
cd pi-atelier
npm install
npm run check
./node_modules/.bin/pi --no-session --no-extensions -e ./extensions/index.ts
```

See [CONTRIBUTING.md](https://github.com/michaelmjhhhh/pi-atelier/blob/main/CONTRIBUTING.md).

The command above opens a temporary session with only the checkout's extension loaded, avoiding conflicts with an installed copy.

## License

[MIT](https://github.com/michaelmjhhhh/pi-atelier/blob/main/LICENSE)

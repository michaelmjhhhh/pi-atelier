<div align="center">

# Pi Atelier

**A responsive status rail and live activity sidebar for [Pi](https://pi.dev).**

Keep model, context, Git status, usage, and tool activity in view while you work.

[![npm](https://img.shields.io/npm/v/pi-atelier?style=flat-square&logo=npm&logoColor=white&label=npm&labelColor=1e1e2e&color=cb3837)](https://www.npmjs.com/package/pi-atelier)
[![Downloads](https://img.shields.io/npm/dm/pi-atelier?style=flat-square&logo=npm&logoColor=white&label=downloads&labelColor=1e1e2e&color=f5c26b)](https://www.npmjs.com/package/pi-atelier)
[![Pi](https://img.shields.io/badge/Pi-%E2%89%A5%200.84.0-a78bfa?style=flat-square&labelColor=1e1e2e)](#requirements)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.19.0-5fb85f?style=flat-square&logo=nodedotjs&logoColor=white&labelColor=1e1e2e)](#requirements)
[![Telemetry](https://img.shields.io/badge/telemetry-none-56d4dd?style=flat-square&labelColor=1e1e2e)](#privacy)
[![License](https://img.shields.io/badge/license-MIT-f472b6?style=flat-square&labelColor=1e1e2e)](https://github.com/michaelmjhhhh/pi-atelier/blob/main/LICENSE)

[Quick start](#quick-start) · [Features](#features) · [Usage](#usage) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting) · [Privacy](#privacy)

[![Pi Atelier status rail and activity sidebar demo](https://raw.githubusercontent.com/michaelmjhhhh/pi-atelier/main/assets/demo.png?v=0.15.0)](https://github.com/michaelmjhhhh/pi-atelier/releases/download/v0.10.0/demo.mp4)

<sub>▶ <a href="https://github.com/michaelmjhhhh/pi-atelier/releases/download/v0.10.0/demo.mp4">Watch the demo (v0.10.0)</a></sub>

</div>

## Quick start

```bash
pi install npm:pi-atelier
```

Start Pi and open the control center with `/atelier` or **F6** (**Fn+F6** on keyboards with media keys).

> [!TIP]
> If icons render as boxes, choose **Settings → Font mode → Plain text**, or select a Nerd Font in your terminal. See [Terminal font](#terminal-font).

> [!NOTE]
> Atelier uses the core packages of the running Pi host. Its npm peers are optional so installing it never pulls in a second copy of Pi; update Pi itself separately. Pi packages run with your system permissions, so review third-party source before installing.

### Requirements

| | |
| --- | --- |
| Pi | 0.84.0 or newer |
| Node.js | 22.19.0 or newer |
| Mode | Interactive TUI |
| Font | Any monospace font (Plain text mode) or a Nerd Font (icons) |

### Terminal font

Plain text mode works with any monospace font and keeps colors, metrics, and the responsive layout. The default Nerd Font mode needs a Nerd Font, such as one from [nerdfonts.com](https://www.nerdfonts.com), selected in your terminal. Switch in **Settings → Font mode**.

## Features

| | |
| --- | --- |
| **Session visibility** | Model, thinking level, context, token usage, cost, and session details in a compact status rail and sidebar. |
| **Live activity** | Agent and tool activity, TODOs, response timing, and completion notifications on macOS and Windows. |
| **Workspace context** | Workspace identity and read-only Git status next to your session. |
| **Subagent costs** | Colored per-child cost curves from pi-subagents accounting events, with matching legends and real observation markers. `/atelier usage` opens a larger framed graph with keyboard focus and per-reply costs. Kitty-compatible terminals get native graphics; others get text strokes. |
| **Personalization** | Display presets, configurable segments and panels, optional Nerd Font icons, and model and tool controls. |
| **Extensible sidebar** | Other extensions can add their own panels. See [Sidebar panels from other extensions](#sidebar-panels-from-other-extensions). |

No telemetry and no external network requests. See [Privacy](#privacy).

## Usage

Open `/atelier` or press **F6** to change display settings, control the sidebar, select models and tools, or view subagent usage.

```text
/atelier display              display settings
/atelier usage                subagent cost graph
/atelier sidebar              toggle sidebar visibility
/atelier sidebar auto|manual  choose sidebar mode
/atelier sidebar on|off       show or hide without changing mode
/atelier sidebar tools        toggle tool names
/atelier enable|disable       set extension state
```

### Sidebar

| Mode | Behavior |
| --- | --- |
| **Manual** (default) | Resize with `Ctrl+Shift+R`, then the arrow keys or by dragging the divider. Enter or mouse release confirms; Escape cancels. Hides below 92 columns and returns at 92. |
| **Auto** | Collapses when space is tight and reopens when there is room. At the default width it collapses below 124 columns and reopens at 132. Manual resizing is disabled. |

- Showing or hiding is independent of the mode. A manually hidden sidebar stays hidden when the terminal grows.
- The preferred width survives terminal resizes and mode changes.
- Mode, width, and visibility are session-scoped. The startup visibility preference is set in Settings.
- The TODO panel supports Pi `todo` results and the optional `@juicesharp/rpiv-todo` extension. Hidden TODO results keep their full output.

### Status rail presets

| Preset | Layout |
| --- | --- |
| **editorial** | Default layout |
| **minimal** | Compact layout |
| **classic** | Detailed telemetry |

Pi supports one custom footer and one custom editor at a time. Extension load order decides which one is visible.

## Configuration

| Scope | Path |
| --- | --- |
| User | `~/.pi/agent/pi-atelier.json` |
| Project (trusted only) | `<project>/.pi/pi-atelier.json` |

Project settings override user settings, and session changes override both. Font mode, sidebar startup, and notification preferences are user-only.

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

Use **Settings → Display** to reorder or hide status rail segments and sidebar panels. Undo restores the latest Display or Sidebar edit, including a Display Revert. The legacy user settings `showSidebarAgent` and `showSidebarTodos` still apply when `sidebarPanelLayout` is absent.

### Sidebar panels from other extensions

Another extension can add a panel through Pi's event bus. `registerSidebarPanel` publishes the panel and answers discovery requests, so either extension may load first:

```ts
import { registerSidebarPanel } from "pi-atelier/extensions/index.ts";

const panel = registerSidebarPanel(pi, {
	id: "vendor:queue",
	title: "Queue",
	rows: ["2 queued", { text: "1 failed", role: "error" }],
});
panel.update({ id: "vendor:queue", title: "Queue", rows: ["idle"] });
panel.dispose();
```

- Panel IDs are namespaced (`vendor:name`).
- New panels start hidden; enable them in **Settings → Display**.
- Titles and rows are plain text. Terminal sequences are stripped and oversized payloads are rejected (see the exported `SIDEBAR_PANEL_MAX_*` limits).
- Extensions that cannot import the helper can emit the exported `SidebarPanelEvent` types on the `pi-atelier:sidebar-panels` channel directly.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Shortcut does nothing | Use `/atelier`, change `shortcut`, then run `/reload`. The default is `f6` on macOS and Windows; media-key keyboards may need Fn+F6. Saved `alt+a` settings resolve to `f6` and Alt+A is no longer registered. Other custom shortcuts add a binding alongside F6. Other extensions or terminal key mappings can still intercept F6. |
| Status rail missing | Use TUI mode and check for another extension's custom footer. |
| Icons render as boxes | Choose **Settings → Font mode → Plain text**, or select a Nerd Font in your terminal. |
| Metrics disagree | Token and cost totals cover the session; context usage covers the current model context. |

## Privacy

Pi Atelier:

- Collects no telemetry or analytics.
- Does not store prompts, responses, or credentials, and keeps them out of notifications.
- Inspects Git read-only, and only after the project is trusted. Never reads untracked file contents.
- Reads project configuration only for trusted projects.
- For subagent usage, reads local metadata and owner-validated diagnostic event logs. It keeps only numeric cost and time projections in memory and saves only run IDs and artifact paths in the Pi session. Prompt and reply content in those logs is discarded. Active background runs refresh until they settle.

## Development

```bash
git clone https://github.com/michaelmjhhhh/pi-atelier.git
cd pi-atelier
npm ci
npm run check
./node_modules/.bin/pi --no-session --no-extensions -e ./extensions/index.ts
```

### Contributed panels draw, they do not narrate

`tests/renderer-semantics-guard.test.ts` asserts that the sidebar renderer never
*authors* display text that belongs to whoever produced the panel. A fallback
label, a default section title or a placeholder for a missing value would make
the two hosts disagree while every other test still passed — that is the
failure the guard exists to prevent.

The list of reserved words comes from `tests/fixtures/sidepanel-semantics.json`,
a generated snapshot of the shared semantics contract. It is vendored (not
imported) so this repository stays clonable on its own; the bridge verifies the
copy is byte-identical to the module it came from.

Glyphs are exempt here and banned in the bridge: drawing a `█`/`✓` is this
layer's job, while delegating the drawing is the translator's.

The same snapshot carries the view contract, generated from Magic Context's own
declarations, plus the ledger of fields consumers deliberately drop and why.
That ledger is the only hand-written part of it, so this repo checks it can
still mean something: every acknowledgement must point at something the
recorded shape declares, and none may still be offered to consumers.

To refresh it after a producer change, run `npm run update:semantics` in
`omp-sidepanel-bridge` from the monorepo root — it rewrites both copies.

The last command opens a temporary session with only the checkout's extension loaded, so it does not conflict with an installed copy.

See [CONTRIBUTING.md](https://github.com/michaelmjhhhh/pi-atelier/blob/main/CONTRIBUTING.md).

<details>
<summary>Validation and dependency notes</summary>

`npm run check` includes a dependency audit and a clean install of the packed extension, so it needs npm registry access. The install check verifies that Atelier adds no runtime dependencies and loads through the development Pi host. Run `npm run check:audit` or `npm run check:install` on their own to investigate dependency warnings. Warnings in an existing Pi installation can also come from the host or other installed packages; Atelier's checks cover only its own dependency trees.

Development stays on Pi 0.84.0 to check the minimum supported API. A scoped npm override patches that host's pinned `undici` dependency to 8.10.2. Remove the override when the development baseline moves to a compatible Pi release with patched `undici`. Root overrides do not apply to consumers or update their Pi hosts.

</details>

## License

[MIT](https://github.com/michaelmjhhhh/pi-atelier/blob/main/LICENSE)

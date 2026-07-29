# Pi Atelier

A responsive status rail and live activity sidebar for [Pi](https://pi.dev).

Pi Atelier replaces Pi's default footer with a calm Status Rail and adds an optional docked sidebar for live agent, turn, tool, context, session, and project information.

Wide terminals use two stable zones: agent state and workspace identity stay left, while readable telemetry is right-aligned. The extension always uses its fixed dark Midnight Spectrum—blue input/context, purple output/menu, cyan cache, amber cost/working, and red danger—regardless of the selected Pi theme.

## Demo

[![Pi Atelier demo showing the full live activity sidebar and status rail footer](https://raw.githubusercontent.com/michaelmjhhhh/pi-atelier/main/docs/demo.png)](https://github.com/michaelmjhhhh/pi-atelier/releases/download/v0.3.0/demo.mp4)

[Watch the full-quality 74-second demo](https://github.com/michaelmjhhhh/pi-atelier/releases/download/v0.3.0/demo.mp4) — the large video is hosted as a GitHub Release asset so it does not bloat Git clones or the npm package.

### Interface details

<table>
  <tr>
    <th width="72%">Status Rail and Atelier menu access</th>
    <th width="28%">Live Activity Sidebar</th>
  </tr>
  <tr>
    <td valign="top"><img src="https://raw.githubusercontent.com/michaelmjhhhh/pi-atelier/main/assets/status-rail.png" alt="Pi Atelier status rail and menu shortcut"></td>
    <td valign="top"><img src="https://raw.githubusercontent.com/michaelmjhhhh/pi-atelier/main/assets/preview.png" alt="Pi Atelier live activity sidebar"></td>
  </tr>
</table>

### Fixed Dark Midnight Spectrum

Pi Atelier has one visual palette. Selecting a light, dark, or custom Pi theme does not change the footer's colors: labels, workspace text, metric values, state anchors, warnings, and errors all retain the same dark-style treatment. With `NO_COLOR`, the footer emits no custom RGB and uses theme-native neutral and semantic roles.

## Features

- Preserves cumulative input, output, cache-read, cache-write, cache-hit, cost, subscription, context, and compaction information
- Responsive one-line layout that never wraps
- Model and thinking-level controls
- Searchable tool controls
- Editorial, minimal, and classic display presets
- Session details, renaming, and safe compaction controls
- Default-on, session-scoped, non-capturing docked information rail with live run, turn, tool, response-performance, and Workspace Pulse activity
- Completion notifications when a turn settles or Pi explicitly requests user input
- Fixed dark Midnight Spectrum across every selected theme, with a `NO_COLOR` fallback
- User and trusted-project configuration
- No telemetry or external network requests

## Requirements

- Pi `0.80.7` or newer
- Node.js `22.19.0` or newer
- Interactive TUI mode

## Install

```bash
pi install npm:pi-atelier
```

Try a checkout without installing it permanently:

```bash
pi -e ./pi-atelier
```

Pi packages execute with your full system permissions. Review third-party source before installation.

## Local development

```bash
git clone https://github.com/michaelmjhhhh/pi-atelier.git
cd pi-atelier
npm install
npm run check
pi -e .
```

## Footer anatomy

- `in` cumulative input tokens
- `out` cumulative output tokens
- `cache` latest cache-hit percentage in the editorial preset
- `read`, `write`, and `hit` detailed cache telemetry in the classic preset
- `$` cumulative estimated cost
- `(sub)` OAuth subscription-backed access
- `ctx` context utilization
- `(auto)` automatic context compaction
- `*` tracked working-tree changes

`READY` remains fixed when idle. During each work cycle, the working label is selected once from a playful built-in phrase set—such as `KNEADING`, `MOONWALKING`, or `PONDERING`—and remains stable until the cycle ends. When the full activity label fits, its ellipsis shrinks from `...` to `..` to `.` every 400 ms. The ellipsis reserves its maximum width so the model and following workspace text remain stationary. Narrower terminals use the compact, static `WORKING` label.

## Menu

Open Pi Atelier with:

```text
/atelier
```

The default shortcut is `alt+a`. The menu contains:

- **Model** — choose an authenticated model or thinking level
- **Tools** — search and toggle active Pi tools
- **Display** — switch presets and save user defaults
- **Session** — inspect, rename, or compact the current session
- **Sidebar** — show or hide the docked information rail and expand or collapse tool-name details
- **Completion notifications** — enable or disable native system notifications on macOS and Windows

Additional commands:

```text
/atelier disable
/atelier enable
```

## Sidebar

The sidebar starts closed by default. Use these commands or the `alt+a` settings menu to control it for the current session. Set `sidebarOpen` to `true` in user configuration to open it automatically in future sessions:

```text
/atelier sidebar       # toggle between shown and hidden
/atelier sidebar on    # show it; safe to repeat
/atelier sidebar off   # hide it; safe to repeat
/atelier sidebar tools  # toggle active tool-name details
/atelier sidebar tools on|off
```

You can also press `alt+a` to access separate sidebar visibility and tool-detail controls from the menu. When enabled, the session-scoped rail attaches to the top-right, fills the terminal height, and stays visible without taking editor focus.

The scan-first hierarchy leads with agent state and model, followed by a compact segmented context meter and a merged workspace summary. Workspace Pulse summarizes the entire Git worktree containing Pi's current directory: tracked changes, text additions and removals, and count-only untracked files. Binary files, changed submodules, and unresolved conflicts appear only when present; the first inspection, clean, unavailable, stale, and non-repository states remain explicit rather than being inferred from missing data. Pulse refreshes after tool activity, Turn boundaries, and branch changes without polling or watching external editor activity. It does not run tests, read untracked contents, change completion notifications, or add detail to the footer's existing dirty marker.

Below 40 sidebar columns, a unified compact mode stacks Agent and Workspace metadata, uses inline Usage pairs, and collapses tool details so important values remain complete instead of truncating. At wider sizes, paired metrics and tool columns use intrinsic content measurements rather than stretching gaps across the available width. Usage appears only when token or cost data exists. Access type remains visible with the agent metadata. Active tool names are collapsed by default behind the tool count and can be expanded through the command or menu; that preference is saved to user configuration. Expanded names automatically collapse below 40 sidebar columns and reappear when widened. Routine healthy extension statuses stay hidden, while warnings and errors appear as explicit alerts.

## Completion notifications

Completion notifications are enabled by default and are event-driven rather than time-based. Atelier notifies when Pi reaches `agent_settled`, meaning no automatic retry, compaction retry, or queued continuation remains. When `@juicesharp/rpiv-ask-user-question` is installed, Atelier also listens to its stable blocked-state event and notifies only after its questionnaire is actually waiting for an answer. Notifications contain only project, session, and operational status; prompt and assistant-response content is never included.

macOS and Windows receive best-effort native system notifications through `osascript` or PowerShell. Other platforms do not receive completion notifications. Native notification processes are detached, time-bounded, and fail silently if unavailable; Atelier does not add a Terminal notification or fallback.

On macOS, `osascript` notifications are attributed to Script Editor. They respect the user's Script Editor notification settings and active Focus modes, so users may need to allow Script Editor notifications or add it to the active Focus mode's allowed apps.

Use `/atelier` or `alt+a` to disable or re-enable completion notifications. The preference is saved to user configuration.

The Activity panel always reserves fixed rows for the run summary and response performance. Before a value is available it displays `TTFT ~ · TPS ~`, so those metrics never shift position or disappear as requests start or terminal height changes. During an agent run, the sidebar also adds information the compact footer intentionally omits: current one-based turn, elapsed run time, active parallel tool calls, the three most recent tool results, per-tool durations, and total done/failed tool counts. TTFT runs from provider request dispatch to the first generated response content. During streaming, TPS updates from Pi's conservative output-token estimate and carries a `~` marker; after the response ends, final output usage replaces the estimate and removes the marker. The footer remains a stable one-line status rail and never repeats tool names, tool history, or response-performance metrics.

The sidebar uses a non-overlapping split presentation: Pi's workspace reflows into the columns to the left of the rail instead of rendering underneath it. It starts at 44 columns, can be resized between 28 and 72 columns, always preserves at least 64 columns for Pi, and auto-hides below 92 terminal columns.

Press `Ctrl+Shift+R` to enter temporary Resize mode. The Pi workspace and sidebar resize together continuously. Drag from the divider or either adjacent column and release to accept; clicks elsewhere leave Resize mode active. Use Left/Right for one-column adjustments, Shift+Left/Shift+Right for four-column adjustments, Enter to accept, or Escape to restore the previous width. Mouse reporting is active only during Resize mode, so ordinary terminal text selection is unchanged at all other times.

The split is implemented entirely inside Pi Atelier by wrapping the active TUI renderer at runtime; no Pi files are modified. This is a version-sensitive integration with Pi's current TUI structure and may require compatibility updates when Pi changes its renderer internals. A terminal character divider cannot display Ghostty's native hover resize cursor.

## Configuration

User configuration:

```text
~/.pi/agent/pi-atelier.json
```

Trusted project configuration:

```text
<project>/.pi/pi-atelier.json
```

Project settings override user settings only after Pi trusts the project. Most menu changes apply to the current session; **Save as user default** writes display configuration atomically. Sidebar tool details and completion notifications are saved immediately so those preferences survive future sessions. Completion notifications are a global user preference, so project and session configuration cannot override that setting. Pi Atelier never modifies project configuration from the menu.

Complete example:

```json
{
  "preset": "editorial",
  "shortcut": "alt+a",
  "segments": [
    "brand",
    "activity",
    "metrics",
    "context",
    "model",
    "git",
    "statuses",
    "menu"
  ],
  "density": "comfortable",
  "ornament": "none",
  "contextWarning": 70,
  "contextDanger": 90,
  "currencyDecimals": 3,
  "showExtensionStatuses": true,
  "showSessionActions": true,
  "sidebarOpen": false,
  "showSidebarToolNames": false,
  "completionNotifications": true
}
```

Unknown or invalid values are ignored with one warning. The required `metrics` and `context` segments are restored if omitted. The editorial preset always suppresses the brand ornament; `restrained` displays `ATELIER` only for non-editorial configurations that include the `brand` segment.

## Presets

- **editorial** — default Status Rail with activity, workspace identity, cache-hit summary, and telemetry
- **minimal** — compact activity, metrics, context, model, and menu
- **classic** — detailed cache telemetry, context, model, Git, and extension statuses

## Responsive behavior

The Status Rail removes optional information by priority as the terminal narrows instead of switching to fixed layouts. Brand and extension statuses are removed first, followed by Git and thinking level, cost, model, input and output totals, cache, and finally the menu shortcut. Activity and context are retained longest, and the result is truncated safely rather than wrapping when space is exceptionally tight.

## Privacy and security

Pi Atelier:

- Performs no telemetry, analytics, or external network calls
- Does not store prompts, responses, credentials, or session content
- Never includes prompt or assistant-response content in completion notifications
- Reads structured usage metadata already available inside Pi
- Executes read-only local Git worktree inspection after relevant Pi events to show branch and Workspace Pulse counts; untracked file contents are never read
- Invokes `osascript` on macOS or PowerShell on Windows for enabled best-effort system notifications
- Reads project configuration only when Pi reports the project as trusted

## Footer conflicts

Pi supports one custom footer at a time. If multiple extensions call `setFooter`, extension load order determines which footer is visible. Pi Atelier does not wrap undocumented footer internals. Disable it with `/atelier disable` to restore Pi's built-in footer.

## Troubleshooting

### The menu shortcut does not open

Some terminals or personal keymaps intercept `alt+a`. Use `/atelier`, then choose another shortcut in `pi-atelier.json` and run `/reload`.

### Metrics differ from the current context percentage

Token and cost metrics are cumulative across the entire session. Context percentage describes only the current model context after compaction.

### The footer is missing

Pi Atelier intentionally does not install terminal UI in print, JSON, or RPC modes. In TUI mode, check whether another extension replaced the footer later in load order.

## Publishing

Release verification must include:

```bash
npm run check
npm pack --dry-run
npm pack
```

Inspect the tarball before running `npm publish`.

## License

MIT

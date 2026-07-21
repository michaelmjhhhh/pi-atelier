# Pi Atelier

An elegant, information-rich status and menu bar for [Pi](https://pi.dev).

Pi Atelier replaces Pi's default footer with a calm, responsive Status Rail while preserving the operational metrics that matter during long coding sessions.

Wide terminals use two stable zones: agent state and workspace identity stay left, while readable telemetry is right-aligned. The footer uses the active Pi theme accent for agent state, neutral text for telemetry, and warning/error colors only when attention is required.

## Preview

```text
● PONDERING... · gpt-5.6-sol · low · main*        in 324k  out 15k  cache 99%  $5.041 (sub)  ctx 27.0% (auto)  ⌥A
```

## Features

- Preserves cumulative input, output, cache-read, cache-write, cache-hit, cost, subscription, context, and compaction information
- Responsive one-line layout that never wraps
- Model and thinking-level controls
- Searchable tool controls
- Editorial, minimal, and classic display presets
- Session details, renaming, and safe compaction controls
- Theme-aware styling with no hard-coded ANSI colors
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

`READY` remains fixed when idle. During each work cycle, the working label is selected once from a playful built-in phrase set—such as `KNEADING`, `MOONWALKING`, or `PONDERING`—and remains stable until the cycle ends. When the full activity label fits, its ellipsis shrinks from `...` to `..` to `.` every 400 ms. Narrower terminals use the compact, static `WORKING` label.

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

Additional commands:

```text
/atelier disable
/atelier enable
```

## Configuration

User configuration:

```text
~/.pi/agent/pi-atelier.json
```

Trusted project configuration:

```text
<project>/.pi/pi-atelier.json
```

Project settings override user settings only after Pi trusts the project. Menu changes apply to the current session; **Save as user default** writes user configuration atomically. Pi Atelier never modifies project configuration from the menu.

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
  "ornament": "restrained",
  "contextWarning": 70,
  "contextDanger": 90,
  "currencyDecimals": 3,
  "showExtensionStatuses": true,
  "showSessionActions": true
}
```

Unknown or invalid values are ignored with one warning. The required `metrics` and `context` segments are restored if omitted.

## Presets

- **editorial** — default Status Rail with activity, workspace identity, cache-hit summary, and telemetry
- **minimal** — compact activity, metrics, context, model, and menu
- **classic** — detailed cache telemetry, context, model, Git, and extension statuses

## Responsive behavior

The Status Rail removes optional information by priority as the terminal narrows instead of switching to fixed layouts. Brand and extension statuses are removed first, followed by Git and thinking level, cost, model, input and output totals, cache, and finally the menu shortcut. Activity and context are retained longest, and the result is truncated safely rather than wrapping when space is exceptionally tight.

## Privacy and security

Pi Atelier:

- Performs no telemetry, analytics, or network calls
- Does not store prompts, responses, credentials, or session content
- Reads structured usage metadata already available inside Pi
- Executes local `git status --porcelain --untracked-files=no` after relevant events to show tracked dirty state
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

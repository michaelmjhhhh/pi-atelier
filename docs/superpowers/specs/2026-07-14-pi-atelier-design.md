# Pi Atelier Design

## Summary

Pi Atelier is a reusable, publishable Pi extension that replaces Pi's built-in footer with an elegant, editorial-luxe status and menu bar directly below the input editor. It preserves Pi's operational metrics, adds balanced workspace context, and opens a keyboard-driven management menu for models, tools, display preferences, and sessions.

The package will be developed in its own repository at `/Users/michael/pi-atelier/` and published to npm as `pi-atelier`. Personal Pi configuration remains outside this repository and consumes the package through a local path during development or npm after release.

## Goals

- Provide a polished one-line footer without sacrificing Pi's existing operational information.
- Preserve input, output, cache, cost, context, attribution, and compaction metrics.
- Offer model, tool, display, and session controls through an accessible overlay menu.
- Adapt cleanly to wide, medium, and narrow terminals without wrapping.
- Support reusable user and trusted-project configuration.
- Behave safely across reloads, shutdown, missing data, invalid configuration, and non-TUI modes.
- Be suitable for public npm distribution with documentation, tests, and explicit compatibility.

## Non-goals for the first release

- A public API for third-party custom segments.
- Network telemetry, analytics, or cloud synchronization.
- Replacing Pi's input editor.
- Supporting Pi versions older than 0.80.7.
- Automatically modifying project configuration from the menu.
- Multiple simultaneous footer rows or a full dashboard.

## Product identity

- Product name: **Pi Atelier**
- npm package: `pi-atelier`
- Slash command: `/atelier`
- Default preset: `editorial`
- Additional presets: `minimal` and `classic`
- Visual direction: editorial luxury with restrained ornament, deliberate spacing, dark-neutral surfaces, and theme-derived accents

The design uses small diamonds, fine separators, and semantic color emphasis. It avoids hard-coded terminal colors and decorative clutter.

## Architecture

The package contains one Pi extension composed from four focused subsystems.

### State collector

The state collector subscribes to supported Pi lifecycle, model, thinking-level, tool, turn, agent, session, and compaction events. It normalizes data needed by the footer and menu without retaining message content.

Responsibilities:

- Track working, idle, warning, and error states.
- Read the current model, provider, thinking level, and active tools.
- Aggregate usage from assistant messages across all session entries, matching Pi's default footer semantics.
- Read current context usage and capacity.
- Read auto-compaction state through Pi's exported settings API and available billing attribution through the model registry.
- Receive git branch changes from the footer data API and refresh dirty state with event-driven local git probes.
- Preserve third-party extension statuses where configured.
- Request a render only after relevant state changes.

### Footer renderer

The footer renderer converts normalized state into a single ANSI-styled terminal line. Every rendered line must fit the supplied terminal width.

Responsibilities:

- Render ordered segments according to the active preset and configuration.
- Apply Pi theme colors supplied by the footer callback.
- Select the correct responsive width tier.
- Remove lower-priority segments before truncating required metrics.
- Never wrap onto a second line.
- Rebuild themed output when invalidated.

### Menu controller

The menu controller opens a centered overlay from `/atelier` or a configurable keyboard shortcut. It uses Pi's native selection and settings components rather than implementing custom navigation primitives.

Top-level sections:

1. **Model** — select provider/model and thinking level.
2. **Tools** — search, enable, and disable active Pi tools.
3. **Display** — choose a preset and configure segments, density, and ornament.
4. **Session** — inspect session details, rename the session, and expose only safe session actions.

Every screen supports keyboard navigation, Escape, and an explicit path back to the top-level menu. Failed actions leave previous state intact and display a concise error notification.

### Configuration loader

The configuration loader validates and merges settings in this order:

```text
built-in defaults -> user config -> trusted project config -> session overrides
```

The default shortcut is `alt+a`; `/atelier` remains the universal fallback when a terminal or user keymap intercepts it. User configuration lives at `~/.pi/agent/pi-atelier.json`. Trusted project configuration lives at `<cwd>/<CONFIG_DIR_NAME>/pi-atelier.json`, using Pi's exported config-directory constant rather than hard-coding `.pi`.

User and project configuration may control:

- Preset
- Segment visibility and order
- Menu shortcut
- Density and ornament level
- Context warning thresholds
- Number and currency formatting
- Third-party extension status visibility
- Session action visibility

Project configuration is read only when Pi considers the project trusted. The menu may save an explicit user default, but it never overwrites project configuration implicitly. Configuration writes use an atomic temporary-file-and-rename operation.

Invalid settings fall back to the nearest valid defaults and produce at most one concise warning per load.

## Footer information hierarchy

A representative wide layout is:

```text
◆ ATELIER  ● READY │ ↑324k ↓15k R5.9M CH98.8% $5.041 (sub) │ 27.0%/372k (auto) │ gpt-5.6-sol · medium │ main ✦ │ ⌘K
```

### Required metrics cluster

The footer preserves these operational values when available:

- `↑` cumulative input tokens
- `↓` cumulative output tokens
- `R` cumulative cache-read tokens
- `W` cumulative cache-write tokens when nonzero
- `CH` cache-hit percentage for the latest assistant response
- `$` estimated cost
- Billing or source attribution such as `(sub)`
- Current context percentage and token capacity
- Compaction mode such as `(auto)`

Missing optional values render as `—`; Pi Atelier must not invent or estimate unavailable attribution.

### Balanced workspace cluster

When width permits, the footer also includes:

- Atelier brand mark
- Agent activity state
- Current model
- Thinking level
- Git branch and dirty state
- Menu shortcut hint
- Configured third-party extension statuses

### Responsive behavior

- **Wide:** show brand, activity, full metrics, context, model, thinking, git, extension status, and menu hint.
- **Medium:** preserve full metrics and context; hide brand ornament, extension status, and secondary model details first.
- **Narrow (56 columns or wider):** preserve the complete required metrics and context clusters. Hide brand, git, shortcut text, and model details before removing any required metric.
- **Below 56 columns:** safety takes precedence over completeness. Render the metrics cluster first with aggressive compact formatting, then ANSI-aware truncation; `/atelier` remains available even when its hint is hidden.
- Values may use compact number formatting, but required metric categories remain present at supported widths of 56 columns or wider.
- The footer never scrolls and never wraps in the first release.

## Data calculations

Usage aggregation matches Pi's default footer: it scans assistant messages across all session entries, including entries before compaction, and uses structured usage fields supplied by Pi.

- Input, output, cache-read, cache-write, and cost totals are cumulative sums across those entries.
- Cache-hit percentage describes the latest assistant response: `cacheRead / (input + cacheRead + cacheWrite) * 100`. A zero denominator yields an unavailable value.
- Cost is the sum of structured message cost totals; it is formatted according to configuration.
- Subscription attribution `(sub)` appears when Pi's model registry reports OAuth-backed access for the active model.
- Current context usage comes from Pi's context-usage API and is not inferred from cumulative session usage.
- Model context capacity comes from the active model definition.
- Auto-compaction attribution `(auto)` reflects Pi's exported compaction setting rather than an Atelier default.
- Any other billing/source attribution is displayed only when Pi or another extension provides it explicitly.

Calculations are implemented as pure functions so they can be tested independently from Pi's runtime.

## Lifecycle and compatibility

- Minimum supported Pi version: `0.80.7`.
- Rich UI activates only when `ctx.mode === "tui"`.
- Print and JSON modes remain untouched.
- RPC mode does not install terminal-only footer or overlay components.
- `session_start` installs state subscriptions and the footer.
- Reload and shutdown dispose branch listeners and other subscriptions where APIs provide disposal handles.
- Disabling Pi Atelier restores Pi's default footer with `ctx.ui.setFooter(undefined)`.
- Pi supports only one custom footer at a time. Extension load order determines which custom footer wins; Pi Atelier documents this conflict and never attempts to wrap undocumented footer internals.
- Theme invalidation clears or rebuilds all cached ANSI output.
- The extension uses supported Pi APIs and does not wrap or replace the editor.

## Privacy and security

- Pi Atelier performs no telemetry, analytics, or external network calls.
- It never stores credentials, prompt text, response text, or session message content.
- Configuration contains display and interaction preferences only.
- Project configuration is ignored for untrusted projects.
- Session actions require explicit user input and use Pi's supported command context APIs.
- Package contents exclude local sessions, logs, caches, credentials, and development artifacts.

## Error handling

- Invalid configuration falls back safely and warns once.
- Missing model, usage, context, git, or cost data produces an unavailable display value rather than an exception.
- Menu action failure preserves previous state and notifies the user.
- Atomic configuration writes prevent partially written JSON.
- Rendering catches segment-level failures so one optional segment cannot remove the entire footer.
- Width calculations use ANSI-aware utilities and enforce the terminal width contract.
- Setup failures restore or retain Pi's built-in footer.

## Repository and package structure

```text
pi-atelier/
├── extensions/
│   └── index.ts
├── src/
│   ├── config.ts
│   ├── state.ts
│   ├── metrics.ts
│   ├── footer.ts
│   └── menu.ts
├── tests/
├── docs/
│   └── superpowers/specs/
├── package.json
├── README.md
├── CHANGELOG.md
├── LICENSE
└── .gitignore
```

The npm manifest will:

- Use the package name `pi-atelier`.
- Include the `pi-package` keyword.
- Declare the extension through the `pi.extensions` manifest.
- Declare Pi runtime packages as peer dependencies.
- Document Pi `>=0.80.7` compatibility.
- Include only runtime source, documentation, license, and necessary metadata.

## Testing strategy

Automated tests cover:

- Input, output, cache-read, cache-hit, cost, context, and attribution formatting.
- Division-by-zero and missing-usage cases.
- Wide, medium, supported narrow (56+ columns), and degraded extremely narrow widths.
- Strict rendered-line width limits with ANSI styling.
- Segment priority, abbreviation, and truncation.
- Preset defaults and configuration merge precedence.
- Invalid configuration fallback and warning deduplication.
- Menu navigation and state transitions.
- Failed model, tool, display, and session actions.
- Session reload and shutdown cleanup.
- Missing model, git, context, and extension-status data.
- Theme invalidation and rerendering.

Rendering tests compare normalized plain text separately from ANSI styling so snapshots remain stable across themes.

Before release, the package must pass:

1. Unit and integration tests.
2. Type checking.
3. Formatting and lint checks.
4. `npm pack --dry-run` inspection.
5. A clean-install smoke test using the packed tarball.
6. Interactive testing at representative terminal widths.

## Documentation and release

The README will include:

- Screenshot or short MP4 preview suitable for the Pi package gallery.
- Installation from npm and local development instructions.
- Default footer anatomy.
- Menu usage and shortcut configuration.
- Full configuration reference with examples.
- Responsive behavior.
- Pi compatibility policy.
- Privacy and security statement.
- Troubleshooting and conflict guidance for other custom-footer extensions.

The first release delivers one footer, one hierarchical menu, three presets, and JSON configuration. A custom-segment plugin API is deferred until concrete user demand establishes a stable interface.

## Acceptance criteria

Pi Atelier is ready for its first public release when:

- It installs from a packed npm artifact into Pi 0.80.7 or newer.
- The footer appears directly below the input in TUI mode and nowhere in non-TUI modes.
- Required operational metrics remain visible across supported width tiers.
- The footer never exceeds terminal width or wraps.
- `/atelier` and the configured shortcut open a fully keyboard-operable menu.
- All four menu sections work and recover safely from failed actions.
- User and trusted-project configuration merge predictably.
- Reload, shutdown, disable, and theme changes leave no stale UI or subscriptions.
- No message content, credentials, telemetry, or private runtime artifacts are stored or transmitted.
- Tests, type checking, package inspection, and clean-install smoke testing pass.

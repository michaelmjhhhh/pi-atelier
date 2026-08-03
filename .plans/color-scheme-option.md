# Color scheme option

## Scope

Add a configuration option that preserves Pi Atelier's existing fixed Midnight Spectrum by default, while allowing users to:

- inherit Pi's active TUI/theme color tokens, and
- supply a custom role-to-color map for Atelier palette roles.

## Interface and seams

Public seams under test:

1. Configuration loading/validation (`validateConfig`, `mergeConfig`, `loadConfig`) accepts and layers `colorScheme`.
2. Rendering (`createPalette`, `renderFooterLine`, `renderSidebarLines`) uses the effective `colorScheme` without changing default output.
3. README documents the configuration surface.

## Design

`colorScheme` values:

- `"atelier"` — existing fixed dark Midnight Spectrum (default).
- `"inherit"` — map Atelier roles to Pi theme tokens.
- object — custom partial role map with optional `base: "atelier" | "inherit"` and role entries such as `output: "#cba6f7"`, `working: "warning"`, or `cache: 45`.

Custom role values support Pi-style color values where practical: 6-digit hex RGB, xterm 0-255 color indices, `""` for terminal default foreground, and documented Pi theme tokens.

`colorScheme` layers field by field, matching how display deviations layer over a template: a custom object merges role by role over the layer below and keeps that layer's base unless it names its own, while a bare `"atelier"`/`"inherit"` replaces the scheme outright.

## Steps

1. Extend types/default config and config validation.
2. Extend palette rendering with inherited and custom schemes.
3. Thread `config.colorScheme` through footer/sidebar renderers.
4. Add red/green tests for config and palette/render behavior.
5. Update README.
6. Run focused tests, typecheck/lint/format check, then review the diff.

## Rollback

Revert the config/type/palette/render changes and remove README documentation; default behavior should remain unchanged by tests.

## Open questions

- The Display Settings Workspace remains focused on display layout. Color scheme customization is JSON-only in this change.
- A future workspace may edit `colorScheme` through `saveUserConfigPatch`: that patch layers `colorScheme` with the same rule as configuration layering, so writing one role preserves the stored base and roles.

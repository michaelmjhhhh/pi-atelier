# Pi Atelier Midnight Amethyst Palette Amendment

## Summary

Replace the footer's green/yellow semantic palette with a deliberate blue-purple system accented by orange. Red remains reserved for actual errors and dangerous context usage.

This amendment changes color rendering only. Footer information architecture, responsive breakpoints, metrics, configuration, menus, lifecycle, privacy, and package behavior remain unchanged.

## Palette

| Role | Color | Hex |
|---|---|---|
| Brand, Working, Output | Amethyst purple | `#B18CFF` |
| Ready, Input, healthy Context | Cobalt blue | `#6EA8FE` |
| Cache and secondary telemetry | Ice blue | `#7DD3FC` |
| Cost, Git dirty, Context warning | Burnished orange | `#FF9F43` |
| Error and dangerous Context | Signal red | `#FF5D73` |
| Metadata and separators | Active Pi theme | `text`, `muted`, `borderMuted` |

## State mapping

- Ready: cobalt blue
- Working: amethyst purple
- Warning: burnished orange
- Error: signal red
- Context below warning threshold: cobalt blue
- Context at or above warning threshold: burnished orange
- Context at or above danger threshold: signal red

## Telemetry mapping

- Input tokens: cobalt blue
- Output tokens: amethyst purple
- Cache read/write/hit rate: ice blue
- Cost and subscription attribution: burnished orange for cost, muted theme color for attribution
- Missing values: category color for label/symbol and muted theme color for the em dash

## Rendering strategy

Pi themes commonly map `success` to green and `warning` to yellow, so the footer cannot use those semantic theme tokens for colored categories. It will use explicit 24-bit foreground colors for the five approved palette values.

A small palette adapter will own all RGB escape generation. Footer rendering must not scatter raw escape codes or hexadecimal values across segment builders.

When `NO_COLOR` is present or true-color output is explicitly disabled, the adapter will use neutral Pi theme colors only:

- Brand and active state: `accent`
- Primary telemetry: `text`
- Secondary telemetry and missing values: `muted`
- Separators: `borderMuted`
- Error state: `error`

The fallback must not reintroduce green or yellow semantic tokens.

## Compatibility and safety

- ANSI reset sequences must not affect visible-width calculations.
- Every responsive width invariant remains unchanged.
- Palette application must preserve nested attribution and missing-value styling.
- Existing themes continue to control neutral text, separators, and menu presentation.
- No color configuration field is added in this release.

## Testing requirements

- Verify exact RGB escape sequences for purple, blue, ice blue, orange, and red.
- Verify Ready/Working/Warning/Error mappings.
- Verify input/output/cache/cost/context mappings.
- Verify threshold transitions to orange and red.
- Verify `NO_COLOR` fallback uses only `accent`, `text`, `muted`, `borderMuted`, and `error` theme tokens.
- Verify fallback never calls `success` or `warning`.
- Re-run all ANSI width and responsive breakpoint tests.
- Update the public preview asset to match the approved palette.

## Acceptance criteria

- No green or yellow appears in the normal footer palette.
- Blue and purple are visually dominant; orange is reserved for emphasis.
- Red appears only for errors and dangerous context.
- `NO_COLOR` produces a neutral, readable footer without green/yellow fallback.
- All footer width, telemetry completeness, configuration, and package checks continue to pass.

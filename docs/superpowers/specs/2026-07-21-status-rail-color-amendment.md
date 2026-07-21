# Status Rail Fixed Dark Midnight Spectrum Amendment

**Date:** 2026-07-21
**Status:** Approved

## Relationship to the Status Rail Design

This amendment changes only the color system defined in `2026-07-21-status-rail-footer-design.md`. It supersedes the earlier requirement that the default footer use one theme accent and neutral telemetry. The approved Status Rail layout, hierarchy, labels, responsive removal order, animation, commands, presets, configuration, privacy behavior, and one-line width guarantees remain unchanged.

## Goal

Make the approved Status Rail visibly colorful and identical across every selected Pi theme. The extension owns one dark-style palette; theme selection must not alter its foreground colors.

## Direction

The approved direction is **Fixed Dark Midnight Spectrum**:

```text
● READY · model · main*       in 324k  out 15k  cache 99%  $5.04  ctx 27%  ⌥A
  BLUE     neutral   amber       muted BLUE  muted PURPLE  muted CYAN  AMBER  muted BLUE  PURPLE
```

Only metric values and state anchors receive category colors. Labels and secondary metadata remain muted or neutral.

## Palette

### Fixed palette

| Role | Hex | Usage |
|---|---:|---|
| Blue | `#6EA8FE` | Ready, input values, healthy context values |
| Purple | `#B18CFF` | Output values, menu shortcut |
| Cyan | `#7DD3FC` | Cache values |
| Amber | `#FF9F43` | Working state, cost values, warnings, dirty Git marker |
| Red | `#FF5D73` | Error state, dangerous context |

The extension also fixes primary text to `#D4D4D4`, muted text to `#808080`, and dim text to `#666666`. Every named Pi theme—including light and custom themes—uses these exact colors.

## Application Rules

- Metric labels such as `in`, `out`, `cache`, `read`, `write`, `hit`, and `ctx` use the extension's fixed muted color.
- Metric values use their category role.
- Currency values use the cost role; subscription markers remain muted.
- Context values use blue while healthy, amber at the configured warning threshold, and red at the configured danger threshold.
- Unavailable values use the extension's fixed dim color and do not receive category color.
- Ready is blue, working is amber, warning is amber, and error is red.
- Git branch text remains neutral; only the dirty marker is amber.
- Model text remains neutral; thinking level and separators remain muted.
- The menu shortcut is purple.
- No color change may alter spacing, visible width, truncation, or responsive priority.

## Theme Independence

The footer ignores the selected named Pi theme when color is enabled. Built-in light, built-in dark, and named custom themes all receive the same fixed dark palette. An unnamed host theme may use safe theme-token fallbacks as an internal compatibility measure; user-selectable Pi themes are named and therefore always receive the fixed palette.

## Color-disabled Behavior

When color is disabled:

- The renderer emits no custom 24-bit RGB sequences.
- Primary values use theme-native text.
- Labels and secondary metadata use muted/dim roles.
- Warning and error remain distinguishable through native semantic theme roles when the host applies them.
- Ordering, wording, symbols, and spacing continue to carry the hierarchy without color.

## Rendering Boundary

The palette interface expands from generic semantic roles to include category roles for:

- `input`
- `output`
- `cache`
- `cost`
- `context`
- `menu`
- `ready`
- `working`
- `warning`
- `error`
- `primary`
- `muted`
- `dim`

The footer remains responsible for assigning roles to values and state. The palette remains responsible for applying the single fixed dark RGB table to every named theme and for applying color-disabled or unnamed-host fallbacks.

## Validation

Automated tests must verify:

- Exact fixed RGB output for every role across dark, light, and named custom themes
- Identical rendered output across selected themes
- Fixed primary, muted, and dim text colors
- Ready, working, warning, and error state colors
- Healthy, warning, and dangerous context colors
- Dim unavailable values
- Safe unnamed-host fallback behavior
- No custom RGB escapes when color is disabled
- ANSI-aware width limits at all representative responsive widths
- Existing removal order, one-line rendering, animation lifecycle, presets, and commands remain unchanged

Manual validation must launch the isolated extension with:

```bash
pi --no-extensions -e . --no-session
```

Then select Pi's built-in dark, built-in light, and a custom theme at wide, medium, narrow, and minimum terminal widths. The footer colors must remain identical.

## Files in Scope

- `src/palette.ts`
- `src/footer.ts`
- `tests/palette.test.ts`
- `tests/footer.test.ts`
- `README.md`

## Non-goals

- Changing the Status Rail layout or responsive removal order
- Adapting the palette to light or custom themes
- Adding a palette selector or new configuration field
- Changing the `/atelier` menu
- Coloring labels or all workspace metadata
- Adding animation or pulsing color
- Changing metric calculation, persistence, privacy, or network behavior

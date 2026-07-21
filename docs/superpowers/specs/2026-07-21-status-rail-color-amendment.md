# Status Rail Adaptive Midnight Spectrum Amendment

**Date:** 2026-07-21  
**Status:** Design approved; written amendment awaiting review

## Relationship to the Status Rail Design

This amendment changes only the color system defined in `2026-07-21-status-rail-footer-design.md`. It supersedes the earlier requirement that the default footer use one theme accent and neutral telemetry. The approved Status Rail layout, hierarchy, labels, responsive removal order, animation, commands, presets, configuration, privacy behavior, and one-line width guarantees remain unchanged.

## Goal

Make the approved Status Rail visibly colorful without returning to the previous flat rainbow strip. Color must reinforce category identity while muted labels, neutral workspace metadata, and restrained state overrides preserve the new hierarchy.

## Direction

The approved direction is **Adaptive Midnight Spectrum**:

```text
● READY · model · main*       in 324k  out 15k  cache 99%  $5.04  ctx 27%  ⌥A
  BLUE     neutral   amber       muted BLUE  muted PURPLE  muted CYAN  AMBER  muted BLUE  PURPLE
```

Only metric values and state anchors receive category colors. Labels and secondary metadata remain muted or neutral.

## Palette

### Dark themes

| Role | Hex | Usage |
|---|---:|---|
| Blue | `#6EA8FE` | Ready, input values, healthy context values |
| Purple | `#B18CFF` | Output values, menu shortcut |
| Cyan | `#7DD3FC` | Cache values |
| Amber | `#FF9F43` | Working state, cost values, warnings, dirty Git marker |
| Red | `#FF5D73` | Error state, dangerous context |

### Light themes

| Role | Hex | Usage |
|---|---:|---|
| Deep blue | `#245FBF` | Ready, input values, healthy context values |
| Deep purple | `#7042C1` | Output values, menu shortcut |
| Deep cyan | `#087C9E` | Cache values |
| Burnt amber | `#B45309` | Working state, cost values, warnings, dirty Git marker |
| Crimson | `#C62845` | Error state, dangerous context |

Pi's built-in `dark` and `light` themes use these exact variants.

## Application Rules

- Metric labels such as `in`, `out`, `cache`, `read`, `write`, `hit`, and `ctx` use the theme's muted role.
- Metric values use their category role.
- Currency values use the cost role; subscription markers remain muted.
- Context values use blue while healthy, amber at the configured warning threshold, and red at the configured danger threshold.
- Unavailable values use the theme's dim role and do not receive category color.
- Ready is blue, working is amber, warning is amber, and error is red.
- Git branch text remains neutral; only the dirty marker is amber.
- Model text remains neutral; thinking level and separators remain muted.
- The menu shortcut is purple.
- No color change may alter spacing, visible width, truncation, or responsive priority.

## Custom Themes

The footer must not guess the background luminance of arbitrary custom themes. When the active theme is not Pi's built-in `dark` or `light`, category roles map to compatible theme tokens:

- Ready, input, and healthy context use `thinkingLow`.
- Output and menu use `thinkingHigh`.
- Cache uses `syntaxType`.
- Working and cost use `mdHeading`.
- Warning and error use native `warning` and `error` tokens.

This fallback prioritizes contrast and custom-theme authorship over exact Midnight Spectrum RGB values.

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

The footer remains responsible for assigning roles to values and state. The palette remains responsible for selecting exact built-in-theme RGB variants, custom-theme token fallbacks, and color-disabled fallbacks.

Built-in theme selection may use the active theme's exposed name. Unknown or unnamed themes must follow the custom-theme fallback rather than assuming a dark background.

## Validation

Automated tests must verify:

- Exact dark-theme RGB output for each category role
- Exact light-theme RGB output for each category role
- Muted labels and colored values
- Ready, working, warning, and error state colors
- Healthy, warning, and dangerous context colors
- Dim unavailable values
- Custom-theme token fallback behavior
- No custom RGB escapes when color is disabled
- ANSI-aware width limits at all representative responsive widths
- Existing removal order, one-line rendering, animation lifecycle, presets, and commands remain unchanged

Manual validation must launch the isolated extension with:

```bash
pi --no-extensions -e . --no-session
```

Then compare Pi's built-in dark and light themes at wide, medium, narrow, and minimum terminal widths.

## Files in Scope

- `src/palette.ts`
- `src/footer.ts`
- `tests/palette.test.ts`
- `tests/footer.test.ts`
- `README.md`

## Non-goals

- Changing the Status Rail layout or responsive removal order
- Adding a palette selector or new configuration field
- Changing the `/atelier` menu
- Coloring labels or all workspace metadata
- Adding animation or pulsing color
- Changing metric calculation, persistence, privacy, or network behavior

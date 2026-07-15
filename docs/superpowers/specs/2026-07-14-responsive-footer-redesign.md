# Pi Atelier Responsive Footer Redesign

## Summary

This amendment replaces Pi Atelier's flat, uniformly dim footer with a responsive dual-zone instrument rail. The redesign keeps all existing operational data while introducing clearer hierarchy, semantic jewel-tone color groups, elastic whitespace on wide terminals, and explicit layouts for each width tier.

It amends the footer presentation and rendering strategy in `2026-07-14-pi-atelier-design.md`. Configuration, menus, privacy, package structure, and lifecycle behavior remain unchanged.

## Goals

- Make the footer easier to scan at a glance.
- Use color to identify data categories and state without visual noise.
- Organize wide layouts into workspace and telemetry zones.
- Recompose information deliberately at each responsive breakpoint.
- Preserve required metrics and context information at 56 columns or wider.
- Avoid orphaned separators, abrupt right-edge loss, and accidental wrapping.
- Remain compatible with Pi themes by using semantic theme tokens only.

## Non-goals

- A multi-line footer.
- Hard-coded RGB or ANSI colors.
- Background-color capsules that conflict with terminal themes.
- Animated footer segments.
- New metrics, configuration fields, or menu actions.
- Changing the existing menu frame or overlay design.

## Visual direction

The footer follows an editorial jewel-tone system: restrained neutral structure with focused color assigned to meaning. Color is not decorative; each tone identifies a stable category.

| Category | Pi theme token | Purpose |
|---|---|---|
| Atelier brand | `accent` | Product identity |
| Ready | `success` | Idle and healthy |
| Working | `accent` | Active processing |
| Warning | `warning` | Recoverable attention state |
| Error | `error` | Failed state |
| Input tokens | `syntaxVariable` | Prompt-side usage |
| Output tokens | `success` | Generated usage |
| Cache | `syntaxType` | Cache reads, writes, and hit rate |
| Cost | `warning` | Financial emphasis with a restrained gold effect |
| Normal context | `success` | Healthy capacity |
| Elevated context | `warning` | Usage at or above configured warning threshold |
| Dangerous context | `error` | Usage at or above configured danger threshold |
| Model/Git primary text | `text` | Workspace identity |
| Secondary metadata | `muted` | Thinking level and attribution |
| Separators | `borderMuted` | Quiet structural division |

Missing values retain their colored category label or symbol while rendering the value itself as a dim `—`.

## Information architecture

### Workspace zone

The left zone describes where and how the user is working:

1. Atelier brand
2. Agent activity
3. Model and thinking level
4. Git branch and dirty marker

### Telemetry zone

The right zone describes session operation:

1. Input and output tokens
2. Cache read/write and latest hit rate
3. Cost and subscription attribution
4. Context use, capacity, and compaction mode
5. Menu shortcut

At wide widths, the telemetry zone is right-aligned with elastic whitespace between zones. At smaller widths, the zones collapse into breakpoint-specific linear layouts.

## Representative wide layout

```text
◆ ATELIER  ● READY  gpt-5.6-sol · low  main ✦        ↑324k ↓15k  R5.9M CH98.8%  $5.041(sub)  ◔27%/372k(auto)  ⌥A
```

The actual spacing expands only between the two zones. Spacing inside a zone remains deterministic.

## Responsive layouts

The renderer selects one explicit layout before rendering. It does not repeatedly delete arbitrary segments from one universal layout.

### Gallery — 132 columns and wider

- Full Atelier wordmark
- Full activity label
- Full model ID and thinking level
- Git branch and dirty marker
- Full metrics formatting
- Full context formatting
- Full menu hint
- Workspace zone left-aligned and telemetry zone right-aligned

### Balanced — 96 through 131 columns

- Brand reduced to `◆`
- Full activity label when space permits
- Model ID shown with compact thinking notation
- Git retained when it fits its assigned budget
- Compact metrics and context formatting
- Menu reduced to shortcut only
- Linear grouped layout with quiet separators

### Focus — 72 through 95 columns

- Brand omitted
- Compact activity indicator
- Model ID receives a bounded width budget
- Git omitted
- Required metrics and context retained
- Menu shortcut retained when it fits
- Telemetry remains visually grouped by category

### Telemetry — 56 through 71 columns

- Workspace identity and decoration omitted
- Complete compact required metrics retained: input, output, cache read, optional nonzero cache write, latest cache-hit rate, cost, subscription attribution, context, and compaction state
- No menu hint if it would displace required telemetry
- No final truncation is allowed to remove a required category in this supported tier

### Safe — below 56 columns

- Render the compact telemetry rail first
- Apply ANSI-aware truncation only after compact category formatting
- Never wrap or exceed terminal width
- `/atelier` remains available even when the shortcut hint is absent

## Rendering architecture

### Colored metric parts

Metrics formatting will produce structured parts rather than one preformatted dim string. Each part includes:

```ts
interface FooterPart {
  id: string;
  full: string;
  compact: string;
  color: ThemeColor;
  required: boolean;
}
```

This allows labels, values, attribution, and context state to receive stable semantic colors without parsing an already formatted string.

### Zone composition

The renderer builds two arrays:

```ts
interface FooterZones {
  workspace: FooterPart[];
  telemetry: FooterPart[];
}
```

Each responsive layout selects and formats parts explicitly. Gallery mode calculates visible widths for both zones, inserts elastic padding, and right-aligns telemetry only when both zones fit. Other modes use deterministic compact separators.

### Width budgets

Potentially long workspace fields receive local budgets before composition:

- Model ID: ANSI-aware truncation within the selected layout's model budget
- Thinking level: compact notation in Balanced mode; omitted before model ID
- Git branch: ANSI-aware truncation; dirty marker is retained when Git is shown
- Extension statuses: Gallery only and only after required zones fit

A final `truncateToWidth` remains as a safety invariant, not the primary responsive strategy.

## Separator behavior

- Gallery: two spaces within zones; elastic whitespace between zones
- Balanced: themed `│` between major groups
- Focus: one themed middle dot or single space between compact groups
- Telemetry: compact spaces chosen to preserve all required categories
- Safe: minimal spaces and final ANSI-aware truncation

Separators are generated between present groups only. Hidden groups cannot leave leading, trailing, or doubled separators.

## Missing and exceptional data

- Missing usage values render colored labels with dim `—` values.
- Unknown compaction state remains visibly unavailable and is not treated as disabled.
- Missing model or Git data removes only that workspace part.
- Segment-formatting errors omit optional workspace parts and render a dim unavailable value for required telemetry parts.
- Non-finite and malformed numeric values remain unavailable.

## Testing requirements

Automated tests must cover:

- Exact layout selection at widths 132, 131, 96, 95, 72, 71, 56, and 55.
- Gallery left/right alignment and elastic padding.
- Semantic theme-token use for every metric category.
- Context color transitions below warning, at warning, and at danger thresholds.
- Complete worst-case telemetry at 56 columns.
- Long model IDs and Git branches within local budgets.
- Missing usage, cost, model, Git, and compaction data.
- ANSI-heavy themes and strict visible-width limits.
- Absence of orphaned, doubled, leading, or trailing separators.
- Stable state updates at unchanged terminal width.
- Existing configuration-based segment visibility and ordering where compatible with required telemetry guarantees.

## Acceptance criteria

The redesign is accepted when:

- The footer presents a clear workspace zone and telemetry zone at 132 columns or wider.
- Color is visibly richer but remains semantic and theme-derived.
- Every responsive breakpoint produces an intentional layout rather than a partially deleted wide layout.
- Required telemetry remains complete at 56 columns or wider.
- No rendered line exceeds the terminal width or wraps.
- Missing values are visibly unavailable and never presented as valid zeroes.
- Long fields cannot crowd out required telemetry.
- Existing footer, lifecycle, configuration, menu, package, and privacy tests continue to pass.

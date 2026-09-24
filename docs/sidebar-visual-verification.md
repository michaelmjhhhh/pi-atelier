# Sidebar information hierarchy — verification

Implements [#70](https://github.com/michaelmjhhhh/pi-atelier/issues/70). The maintainer selected design A after reviewing the separate colored rounded panels and continuous context meter. The exploratory implementation is preserved at commit `b89dd5a` (also retained locally on `archive/sidebar-design-prototype`). Production uses one renderer; there are no prototype commands, variants, environment switches, or preview-server assets.

## Scope and compatibility

- Aligned labels for agent configuration, response timing, Git state/counts, session history/storage, usage, and enabled tools.
- Existing panel IDs, saved order/visibility, contributed panels, and tool-name setting remain compatible. No configuration migration.
- Context uses a fractional block over a continuous background; percentage and muted token count remain separate. No-color mode uses block/shade characters and the same exact numeric percentage.
- Explicit labels take more vertical space. Optional content follows its previous drop order; at very short heights Agent metadata, Activity detail, and the Context token row contract before core panels are clipped.
- Below 40 columns, configured tool names still collapse. The displayed Enabled count describes configuration, not tools currently executing.

## Observed validation

- Existing renderer and extension checks pass after updating their old presentation expectations. No new TUI unit or e2e tests were added.
- Rendered fixture output inspected at 32 columns × 48 rows for zero, low (1.3%), active (17.8%), and high (92%) context; 32 × 12 checks the contracted hierarchy.
- Environment: macOS / Darwin arm64, Node 22.22.2, Pi and pi-tui 0.84.0.
- These are source-rendered text artifacts, not screenshots or a live terminal session. ANSI colors and the background track are stripped in the excerpts below. The maintainer approved the prototype's appearance; final live-terminal interaction checks remain pending.

## Manual TODO

Run from the checkout to open an ephemeral session with only this extension:

```sh
./node_modules/.bin/pi --no-session --no-extensions -e ./extensions/index.ts
```

- [ ] In regular and fullscreen Pi, check the approved panel colors, rounded borders, and aligned metrics.
- [ ] Send a prompt; inspect First token, Output speed, active/settled tools, and absence of repeated idle Ready status.
- [ ] Resize across 39/40 columns and reduce terminal height; check truncation, units, core-panel visibility, and intact borders.
- [ ] Check 0%, low, warning, and full context; confirm the fractional fill joins the track and background styling stops before the percentage/border.
- [ ] Check no-color output and the meter with the terminal's font/theme.
- [ ] Hide/reorder panels, expand tool names, and inspect contributed panels if available.
- [ ] Check Git clean/modified/conflict/stale/unavailable states and saved/temporary sessions.

## Rendered artifacts

### idle (32 × 48)

```text
  ╭─ ✦ CONTEXT ────────────────╮
  │                       0.0% │
  │ Tokens            0 / 272k │
  ╰────────────────────────────╯
```

### low (32 × 48)

```text
  ╭─ ✦ CONTEXT ────────────────╮
  │ ▎                     1.3% │
  │ Tokens         3.5k / 272k │
  ╰────────────────────────────╯
```

### active (32 × 48)

```text
  ╭─ ✦ CONTEXT ────────────────╮
  │ ███▎                 17.8% │
  │ Tokens          48k / 272k │
  ╰────────────────────────────╯
```

### warning (32 × 48)

```text
  ╭─ ✦ CONTEXT ────────────────╮
  │ ████████████████▌    92.0% │
  │ Tokens         250k / 272k │
  ╰────────────────────────────╯
```

### Short terminal (32 × 12, no color)

```text
  ╭─ ✧ AGENT ──────────────────╮
  │ ◆ Working                  │
  │ gpt-5.6-sol                │
  ╰────────────────────────────╯

  ╭─ ✦ ACTIVITY ───────────────╮
  │ Turn 3 · running 33s       │
  ╰────────────────────────────╯

  ╭─ ✦ CONTEXT ────────────────╮
  │ ███░░░░░░░░░░░░░░░   17.8% │
  ╰────────────────────────────╯
```

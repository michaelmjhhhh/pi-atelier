# Pi Atelier Responsive Footer Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat footer with a semantic jewel-tone dual-zone rail and explicit responsive layouts that remain organized at every terminal width.

**Architecture:** Keep metric calculation pure, introduce structured colored footer parts, and make `renderFooterLine` choose one of five deterministic layouts. Gallery mode composes independently measured workspace and telemetry zones with elastic padding; smaller modes use explicit part sets and width budgets rather than iterative arbitrary deletion.

**Tech Stack:** TypeScript 5.9, Pi 0.80.7 theme API, `@earendil-works/pi-tui` ANSI width utilities, Vitest 4

## Global Constraints

- Use Pi semantic theme tokens only; no hard-coded RGB or ANSI sequences.
- Preserve required input, output, cache, cost/subscription, context, and compaction categories at widths of 56 columns or wider.
- Never exceed the supplied width and never wrap.
- Breakpoints are exact: Gallery `>=132`, Balanced `96..131`, Focus `72..95`, Telemetry `56..71`, Safe `<56`.
- Missing numeric values remain unavailable rather than zero.
- Long model and Git fields cannot displace required telemetry.
- Existing configuration, lifecycle, menu, privacy, package, and release behavior must remain compatible.
- Follow red-green-refactor and commit each independently verified task.

---

### Task 1: Add structured semantic footer parts

**Files:**
- Modify: `src/footer.ts`
- Modify: `src/metrics.ts`
- Modify: `tests/footer.test.ts`
- Modify: `tests/metrics.test.ts`

**Interfaces:**
- Produces: `ResponsiveMode`, `selectResponsiveMode(width)`, structured metric/context part builders, and theme-token-aware rendering.
- Consumes: existing `AtelierState`, `AtelierConfig`, and pure metric values.

- [ ] **Step 1: Write failing semantic-color tests**

Add a recording theme whose `fg` returns tagged text and records token names. Assert wide rendering uses `syntaxVariable` for input, `success` for output, `syntaxType` for cache, `warning` for cost, and threshold-sensitive `success/warning/error` for context. Assert missing values retain category labels with a dim dash.

- [ ] **Step 2: Verify red**

Run: `npm test -- tests/footer.test.ts tests/metrics.test.ts`

Expected: FAIL because current metrics are emitted as one uniformly dim string.

- [ ] **Step 3: Introduce structured parts**

Define focused internal types in `src/footer.ts`:

```ts
type ResponsiveMode = "gallery" | "balanced" | "focus" | "telemetry" | "safe";
interface FooterPart {
  id: string;
  full: string;
  compact: string;
  color: string;
  required: boolean;
}
interface FooterZones {
  workspace: FooterPart[];
  telemetry: FooterPart[];
}
```

Export `selectResponsiveMode(width)` with exact breakpoint comparisons. Build metric parts directly from `AtelierMetrics` so each category receives its semantic color. Keep existing number-formatting helpers; do not parse the old combined metric string.

- [ ] **Step 4: Verify green**

Run: `npm test -- tests/footer.test.ts tests/metrics.test.ts && npm run typecheck`

Expected: semantic-color and missing-value tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/footer.ts src/metrics.ts tests/footer.test.ts tests/metrics.test.ts
git commit -m "refactor(footer): add semantic telemetry parts"
```

---

### Task 2: Implement deterministic dual-zone responsive layouts

**Files:**
- Modify: `src/footer.ts`
- Modify: `tests/footer.test.ts`

**Interfaces:**
- Consumes: structured workspace/telemetry parts and `selectResponsiveMode`.
- Produces: width-budgeted Gallery, Balanced, Focus, Telemetry, and Safe renderers.

- [ ] **Step 1: Write failing breakpoint and organization tests**

Add table tests for widths `132, 131, 96, 95, 72, 71, 56, 55`. Assert the selected mode and expected presence/absence of brand, activity label, model, Git, required telemetry, context, and menu. Add tests for:

- Gallery telemetry right alignment with elastic padding.
- No doubled, leading, or trailing separators.
- Long model IDs and branches not displacing telemetry.
- Worst-case complete required categories at width 56.
- Every output line satisfying `visibleWidth(line) <= width` with an ANSI-producing theme.

- [ ] **Step 2: Verify red**

Run: `npm test -- tests/footer.test.ts`

Expected: FAIL because the current renderer uses one layout and removes optional segments iteratively.

- [ ] **Step 3: Implement explicit layout renderers**

Add internal functions:

```ts
renderGallery(zones, width, theme): string
renderBalanced(zones, width, theme): string
renderFocus(zones, width, theme): string
renderTelemetry(zones, width, theme): string
renderSafe(zones, width, theme): string
```

Gallery measures both zones and inserts `width - leftWidth - rightWidth` spaces when both fit. Balanced uses themed `│`; Focus uses a themed middle dot or single spaces; Telemetry uses the already verified compact category rail; Safe applies final ANSI-aware truncation. Model and Git are truncated within local mode-specific budgets before zone composition.

`renderFooterLine` becomes a small dispatcher. Keep a final `truncateToWidth(..., width, "")` invariant in every mode.

- [ ] **Step 4: Verify green and regressions**

Run: `npm test -- tests/footer.test.ts && npm run typecheck && npm run lint`

Expected: all breakpoint, color, separator, width, and existing stale-state tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/footer.ts tests/footer.test.ts
git commit -m "feat(footer): add responsive dual-zone layouts"
```

---

### Task 3: Update presentation documentation and release verification

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `assets/preview.png`
- Verify: package artifact and runtime startup

**Interfaces:**
- Consumes: final renderer behavior.
- Produces: accurate public documentation and verified npm artifact.

- [ ] **Step 1: Update documentation**

Replace the README preview and responsive-behavior section with the dual-zone example, jewel-tone semantic legend, and exact five breakpoints. Add a changelog entry describing the responsive footer redesign.

- [ ] **Step 2: Refresh preview asset**

Generate `assets/preview.png` with the updated organized dual-zone rail and representative jewel-tone category colors. Preserve the existing 1600×300 PNG dimensions and avoid embedding private machine/session information.

- [ ] **Step 3: Run full verification**

Run: `npm run check`

Expected: typecheck, lint, formatting, all tests, and package allowlist verification pass.

- [ ] **Step 4: Verify clean package installation**

Run:

```bash
rm -f pi-atelier-0.1.0.tgz
npm pack
TMP_DIR=$(mktemp -d)
cd "$TMP_DIR"
npm init -y >/dev/null
npm install /Users/michael/pi-atelier/pi-atelier-0.1.0.tgz --ignore-scripts
node -e 'const p=require("./node_modules/pi-atelier/package.json"); if(p.name!=="pi-atelier") process.exit(1)'
```

Expected: packed artifact installs successfully.

- [ ] **Step 5: Smoke-test Pi loading and repository hygiene**

Run `pi -e . --list-models`, scan runtime source for secrets/network calls, run `git diff --check`, and verify only intended files changed.

- [ ] **Step 6: Commit**

```bash
git add README.md CHANGELOG.md assets/preview.png
git commit -m "docs: update responsive footer presentation"
```

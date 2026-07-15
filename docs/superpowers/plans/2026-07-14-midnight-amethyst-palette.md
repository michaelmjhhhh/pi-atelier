# Pi Atelier Midnight Amethyst Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace green/yellow footer colors with the approved blue-purple-orange palette while retaining red only for danger and providing a neutral `NO_COLOR` fallback.

**Architecture:** Add a focused palette adapter that converts named Atelier roles into either 24-bit ANSI colors or neutral Pi theme tokens. Inject the adapter into footer construction so segment logic requests roles rather than raw colors.

**Tech Stack:** TypeScript, ANSI 24-bit foreground sequences, Pi theme fallback, Vitest

## Global Constraints

- Purple `#B18CFF`, blue `#6EA8FE`, ice blue `#7DD3FC`, orange `#FF9F43`, red `#FF5D73`.
- No normal footer use of Pi `success` or `warning` theme tokens.
- Red only for error activity and dangerous context.
- `NO_COLOR` uses neutral `accent/text/muted/borderMuted/error` theme colors.
- Preserve every responsive and visible-width invariant.

### Task 1: Add palette adapter test-first

**Files:**
- Create: `src/palette.ts`
- Create: `tests/palette.test.ts`

- [ ] Write failing tests for exact RGB escapes and neutral fallback role mappings.
- [ ] Run `npm test -- tests/palette.test.ts` and verify failure because the module is missing.
- [ ] Implement `createPalette(theme, colorEnabled)` with named roles `brand`, `ready`, `working`, `warning`, `error`, `input`, `output`, `cache`, `cost`, `context`, and `muted`.
- [ ] Verify palette tests and typecheck.
- [ ] Commit with `feat(theme): add Midnight Amethyst palette`.

### Task 2: Apply palette to footer test-first

**Files:**
- Modify: `src/footer.ts`
- Modify: `extensions/index.ts`
- Modify: `tests/footer.test.ts`

- [ ] Add failing tests for Ready/Working/Warning/Error, telemetry roles, threshold transitions, and absence of `success`/`warning` theme calls.
- [ ] Add a failing `NO_COLOR` footer test.
- [ ] Replace footer category theme tokens with palette roles and pass `colorEnabled: !process.env.NO_COLOR` from the extension.
- [ ] Run all footer, extension, typecheck, and lint checks.
- [ ] Commit with `feat(footer): apply Midnight Amethyst colors`.

### Task 3: Update presentation and verify release

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `assets/preview.png`

- [ ] Document the palette and neutral fallback.
- [ ] Regenerate the 1600×300 preview using only the approved colors.
- [ ] Run `npm run check`, clean tarball installation, Pi extension load smoke test, secret scan, and `git diff --check`.
- [ ] Commit with `docs: present Midnight Amethyst palette`.

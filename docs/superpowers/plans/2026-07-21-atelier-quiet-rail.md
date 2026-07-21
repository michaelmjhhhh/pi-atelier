# Pi Atelier Quiet Utility Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine the docked sidebar into a calm, information-first utility rail without persistent branding or decorative cyber-style elements.

**Architecture:** Keep the existing snapshot, controller, overlay, and dock compositor. Change only row-level presentation helpers, error copy, snapshots, and user-facing documentation so lifecycle and data flow remain untouched.

**Tech Stack:** TypeScript 5.9, Pi extension API 0.80.7, `@earendil-works/pi-tui` 0.80.7, Vitest 4.1, Biome 2.5.

## Global Constraints

- Keep overlay width `44`, auto-hide threshold `88`, `anchor: "top-right"`, and `nonCapturing: true`.
- Preserve exact-height output, continuous left divider, ANSI-safe truncation, live resize, lifecycle safety, privacy, and `NO_COLOR`.
- Add no dependencies, interaction, telemetry, persistent state, or data sources.
- Remove normal and error-state PI/ATELIER branding.
- Use semantic color only; remove ornamental rules and decorative state glyphs.

---

### Task 1: Refine the utility rail presentation

**Files:**
- Modify: `src/sidebar.ts`
- Modify: `tests/sidebar.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Retains: `renderSidebarLines(...)`, `SidebarSnapshot`, `createSidebarComponent(...)`, and `createSidebarController(...)` signatures.
- Produces: unchanged public behavior with quieter row rendering.

- [ ] **Step 1: Extend failing visual tests**

Update `tests/sidebar.test.ts` to assert:

```ts
expect(text).not.toMatch(/PI ATELIER|ATELIER|▛▀▜|◆|●|✓/);
expect(rows[0]).toBe("PROJECT");
expect(rows.some((row) => /^PROJECT ─/.test(row))).toBe(false);
expect(rows).toContain("feature/sidebar · modified");
expect(rows).toContain("Working · gitifying");
```

Add assertions that the Context summary ends with `8.1%`, its bar has visible width `42`, status text is plain `tests passing`, and error output begins with `Sidebar unavailable` rather than `PI ATELIER`.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm test -- tests/sidebar.test.ts
```

Expected: FAIL on heading rules, decorative glyphs, context layout, status glyphs, and error branding.

- [ ] **Step 3: Simplify headings and semantic rows**

In `src/sidebar.ts`:

```ts
function headingRow(title: string, palette: AtelierPalette): string {
	return palette.paint("muted", sanitize(title).toUpperCase());
}
```

Change Git to `branch · state`; Agent activity to title-case state plus optional ` · working label`; Session separator to `·`; Tools heading to `TOOLS`; and status rows to sanitized plain text.

- [ ] **Step 4: Align Context and expand its bar**

Add a width-safe helper:

```ts
function spacedRow(left: string, right: string, width: number): string {
	const safeWidth = Math.max(0, Math.trunc(width));
	const rightWidth = visibleWidth(right);
	const leftMax = Math.max(0, safeWidth - rightWidth - 1);
	const safeLeft = truncateToWidth(left, leftMax, "");
	const gap = " ".repeat(Math.max(1, safeWidth - visibleWidth(safeLeft) - rightWidth));
	return truncateToWidth(`${safeLeft}${gap}${right}`, safeWidth, "");
}
```

Use it for `usage / window` and percentage. Set context bar width to `contentWidth`.

- [ ] **Step 5: Remove error branding and normalize spacing**

Render errors with:

```ts
renderDock(["Sidebar unavailable", detail], width, height, neutralPalette)
```

Ensure each section except the final visible section ends with one blank row; preserve optional-group dropping order and exact-height padding.

- [ ] **Step 6: Update snapshot and focused tests**

Regenerate the representative 44x36 inline snapshot, then run:

```bash
npm test -- tests/sidebar.test.ts
```

Expected: all sidebar tests pass.

- [ ] **Step 7: Update user documentation**

Update `README.md` to describe a quiet sectioned utility rail without a PI monogram. Add an Unreleased `CHANGELOG.md` bullet for the information-first visual refinement.

- [ ] **Step 8: Run full verification**

```bash
npm run format
npm run check
npm pack --dry-run
git diff --check
```

Expected: all checks pass, 15 package files are present, and `src/sidebar.ts` is included.

- [ ] **Step 9: Commit**

```bash
git add src/sidebar.ts tests/sidebar.test.ts README.md CHANGELOG.md
git commit -m "refactor(sidebar): simplify Atelier utility rail"
```

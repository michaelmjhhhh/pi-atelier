# Pi Atelier Docked Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the content-height rounded sidecar card with a full-terminal-height docked rail featuring a pixel PI monogram, organized sections, compact session data, and aligned usage metrics.

**Architecture:** Keep the existing snapshot and controller boundaries. Refactor `src/sidebar.ts` rendering into section helpers plus a final dock compositor, and let the controller inject live `tui.terminal.rows` through `getHeight()` so every render tracks terminal resizing.

**Tech Stack:** TypeScript 5.9, Pi extension API 0.80.7, `@earendil-works/pi-tui` 0.80.7, Vitest 4.1, Biome 2.5.

## Global Constraints

- Use only Pi's public extension API; do not modify Pi core.
- Overlay remains non-capturing and session-scoped.
- Overlay configuration uses `anchor: "top-right"`, width `44`, margin `0`, and auto-hide below `88` columns.
- Render exactly the requested terminal height and never exceed supplied width.
- Every row has one continuous left divider; no rounded outer frame.
- Render the approved pixel PI monogram and ATELIER title.
- Session omits raw file path and empty name rows.
- Usage metrics use aligned Input/Output, Cache/Hit, and Cost/Access pairs.
- Short terminals remove extension statuses, tools, usage, then session before core Project/Agent/Context content.
- Preserve toggle commands, menu state, lifecycle generation safety, footer independence, error fallback, fixed palette, and `NO_COLOR`.
- Add no dependencies, network calls, telemetry, or persistent state.

---

### Task 1: Implement the full-height dock renderer

**Files:**
- Modify: `src/sidebar.ts`
- Modify: `tests/sidebar.test.ts`

**Interfaces:**
- Retains: `SidebarSnapshot`, `buildSidebarSnapshot`, `SidebarController`, and `createSidebarController`.
- Changes: `SidebarComponentOptions` gains `getHeight(): number`.
- Produces: `renderSidebarLines(..., height: number, colorEnabled?: boolean): string[]` and updated `sidebarOverlayOptions()`.

- [ ] **Step 1: Write failing structural tests**

Update `tests/sidebar.test.ts` to assert:

```ts
const lines = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false);
expect(lines).toHaveLength(36);
expect(lines.every((line) => visibleWidth(line) <= 44)).toBe(true);
expect(lines.every((line) => stripAnsi(line).startsWith("│ "))).toBe(true);
expect(lines.join("\n")).not.toMatch(/[╭╮╰╯]/);
expect(lines.join("\n")).toContain("▛▀▜  ▀█▀");
expect(lines.join("\n")).toContain("▙▄▟   █");
expect(lines.join("\n")).toContain("ATELIER");
```

Change the overlay assertion to:

```ts
expect(sidebarOverlayOptions()).toMatchObject({
	anchor: "top-right",
	width: 44,
	margin: 0,
	nonCapturing: true,
});
```

- [ ] **Step 2: Add failing hierarchy tests**

Add tests proving:

- missing session name produces no standalone `—` in the Session section;
- session file path is absent;
- Session contains `6 entries` and `persisted` on one row;
- Usage renders muted `INPUT`, `OUTPUT`, `CACHE`, `HIT`, `COST`, and `ACCESS` labels with aligned value rows;
- section headings contain trailing rule glyphs;
- a 20-row render omits status details/tools/usage/session but retains PI mark, Project, Agent, and Context;
- changing `getHeight()` from 24 to 31 changes component output length without recreating the component;
- error rendering uses the divider, requested height, and no rounded corners.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npm test -- tests/sidebar.test.ts
```

Expected: FAIL because current output is content-height, rounded, and lacks the new hierarchy.

- [ ] **Step 4: Add dock primitives and brand mark**

Replace rounded `frameRows()` with a final compositor:

```ts
function renderDock(
	rows: string[],
	width: number,
	height: number,
	palette: AtelierPalette,
): string[] {
	const safeWidth = Math.max(0, Math.trunc(width));
	const safeHeight = Math.max(0, Math.trunc(height));
	if (safeWidth <= 0 || safeHeight <= 0) return [];
	const contentWidth = Math.max(0, safeWidth - 2);
	const divider = palette.paint("dim", "│");
	return Array.from({ length: safeHeight }, (_, index) => {
		const content = truncateToWidth(rows[index] ?? "", contentWidth, "");
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
		return truncateToWidth(`${divider} ${content}${padding}`, safeWidth, "");
	});
}
```

Implement `renderBrandMark()` with the approved four lines. Apply existing accent roles so custom RGB remains controlled by `colorEnabled`.

- [ ] **Step 5: Refactor sections into an organized rail**

Implement focused helpers for Project, Agent, Context, Session, Usage, and Status. Each helper returns unframed content rows.

Use a heading helper that fills the remaining width with `─` after `TITLE `. Session behavior:

```ts
const rows: string[] = [];
if (snapshot.sessionName && sanitize(snapshot.sessionName)) {
	rows.push(palette.paint("primary", sanitize(snapshot.sessionName)));
}
rows.push(/* entries • persisted/ephemeral */);
```

Do not read or render `snapshot.sessionFile` in this section.

Usage uses a two-column helper with fixed equal columns derived from content width. Render each label pair followed by its value pair.

- [ ] **Step 6: Implement height-priority composition**

Build named groups:

```ts
const required = [brand, project, agent, context];
const optional = [session, usage, tools, statuses];
```

Compose full output when it fits. If it does not, remove optional groups in order: statuses, tools, usage, session. If required content still exceeds height, truncate only at the final dock compositor. Preserve section order.

Update the renderer signature:

```ts
export function renderSidebarLines(
	snapshot: SidebarSnapshot,
	config: AtelierConfig,
	theme: ThemeLike,
	width: number,
	height: number,
	colorEnabled = true,
): string[]
```

- [ ] **Step 7: Inject live height and update error rendering**

Add `getHeight()` to `SidebarComponentOptions`. `render()` calls it each time and passes the result to normal or error rendering. In `createSidebarController`, pass:

```ts
getHeight: () => tui.terminal.rows
```

Update all test harness terminals to expose `rows`.

Change overlay anchor to `top-right`. Keep width, margin, non-capturing behavior, max height, and responsive visibility unchanged.

- [ ] **Step 8: Run focused and full verification**

```bash
npm test -- tests/sidebar.test.ts
npm run check
```

Expected: sidebar tests and the full repository pass.

- [ ] **Step 9: Commit Task 1**

```bash
git add src/sidebar.ts tests/sidebar.test.ts
git commit -m "feat(sidebar): dock and organize information rail"
```

---

### Task 2: Document and verify the docked rail

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: completed docked visual behavior.
- Produces: accurate user-facing description and release note.

- [ ] **Step 1: Update README**

Update Sidebar documentation to state that it:

- attaches to the top-right and fills terminal height;
- uses a PI monogram and sectioned information rail;
- shows compact session metadata and aligned usage metrics;
- remains non-capturing, toggleable, and auto-hidden below 88 columns.

Do not claim Pi reserves layout width or reflows the conversation.

- [ ] **Step 2: Update Unreleased changelog**

Add:

```md
- Redesign the persistent sidebar as a full-height docked information rail with a pixel PI monogram and clearer session and usage sections.
```

- [ ] **Step 3: Run complete verification**

Remove `.pi-subagents`, immediately recreate `.pi-subagents/artifacts`, then run:

```bash
npm run format
npm run check
npm pack --dry-run
git diff --check
```

Expected: 0 failures, `src/sidebar.ts` remains packaged, and no whitespace errors.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: describe docked Atelier rail"
```

- [ ] **Step 5: Verify committed state**

```bash
npm run check
git status --short --branch
```

Expected: full check passes and the feature worktree is clean.

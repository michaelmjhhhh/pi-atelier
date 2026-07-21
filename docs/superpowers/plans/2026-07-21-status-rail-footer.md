# Status Rail Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Pi Atelier's rainbow, abbreviation-heavy footer with the approved one-line, theme-aware Status Rail while preserving metrics, configuration, presets, lifecycle behavior, and privacy guarantees.

**Architecture:** Build semantic footer items first, with explicit zone, visual role, full/compact representation, and removal priority. A width-aware composer measures ANSI-rendered items, removes optional information in the approved order, and right-aligns telemetry whenever both zones fit. Palette styling uses Pi theme roles instead of fixed RGB codes.

**Tech Stack:** TypeScript 5.9, Pi extension API `0.80.7`, `@earendil-works/pi-tui`, Vitest 4, Biome 2.

## Global Constraints

- Pi must remain `0.80.7` or newer.
- Node.js must remain `22.19.0` or newer.
- The footer must remain exactly one terminal line and never exceed the supplied visible width.
- Activity and context health survive responsive reduction longest.
- The default presentation uses one theme accent; warning and error colors are reserved for actionable state.
- Existing metric calculation, commands, persistence, trusted-project behavior, network behavior, and privacy guarantees must not change.
- The `/atelier` overlay menu is outside this visual redesign except where its existing preset actions select footer behavior.
- Use test-driven development: add a failing focused test before each production change.

---

## File Map

- `src/palette.ts` — semantic theme-role painter for accent, primary, muted, warning, and error text.
- `src/footer.ts` — semantic item construction, Status Rail composition, responsive reduction, and activity animation lifecycle.
- `src/types.ts` — default presentation configuration; change the editorial default ornament to `none`.
- `src/menu.ts` — keep minimal/classic preset intent and ensure editorial resolves to the new default.
- `tests/palette.test.ts` — semantic theme-role contract and monochrome behavior.
- `tests/footer.test.ts` — visual hierarchy, labels, responsive priority, ANSI width, unavailable values, presets, and animation.
- `tests/menu.test.ts` — preset selection compatibility.
- `README.md` — replace the obsolete Midnight Amethyst/footer anatomy documentation with Status Rail documentation.

---

### Task 1: Replace the fixed RGB palette with semantic theme roles

**Files:**
- Modify: `tests/palette.test.ts`
- Modify: `src/palette.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: `ThemeLike.fg(color, text)` from Pi's active theme.
- Produces: `PaletteRole = "accent" | "primary" | "muted" | "warning" | "error"` and `createPalette(theme, colorEnabled).paint(role, text)` for `src/footer.ts`.

- [ ] **Step 1: Replace palette expectations with failing semantic-role tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { createPalette } from "../src/palette.js";

const theme = {
	fg: vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`),
};

describe("Status Rail palette", () => {
	it.each([
		["accent", "accent"],
		["primary", "text"],
		["muted", "muted"],
		["warning", "warning"],
		["error", "error"],
	] as const)("maps %s to the Pi %s theme role", (role, themeRole) => {
		expect(createPalette(theme, true).paint(role, "X")).toBe(`<${themeRole}>X</${themeRole}>`);
	});

	it("uses the same semantic hierarchy when color is disabled", () => {
		const fg = vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`);
		const palette = createPalette({ fg }, false);
		for (const role of ["accent", "primary", "muted", "warning", "error"] as const) {
			palette.paint(role, role);
		}
		expect(fg.mock.calls.map(([color]) => color)).toEqual([
			"accent",
			"text",
			"muted",
			"warning",
			"error",
		]);
	});
});
```

- [ ] **Step 2: Run the focused test and confirm the old role contract fails**

Run: `npm test -- tests/palette.test.ts`

Expected: FAIL because `accent` and `primary` are not valid old palette roles and the old implementation emits fixed ANSI RGB sequences.

- [ ] **Step 3: Implement the semantic palette**

Replace `src/palette.ts` with:

```ts
export type PaletteRole = "accent" | "primary" | "muted" | "warning" | "error";

interface PaletteTheme {
	fg(color: string, text: string): string;
}

const THEME_ROLE: Record<PaletteRole, string> = {
	accent: "accent",
	primary: "text",
	muted: "muted",
	warning: "warning",
	error: "error",
};

export interface AtelierPalette {
	paint(role: PaletteRole, text: string): string;
}

export function createPalette(theme: PaletteTheme, _colorEnabled: boolean): AtelierPalette {
	return {
		paint(role, text) {
			return theme.fg(THEME_ROLE[role], text);
		},
	};
}
```

Change the `ornament` field in `DEFAULT_CONFIG` in `src/types.ts` from:

```ts
ornament: "restrained",
```

to:

```ts
ornament: "none",
```

Do not remove `colorEnabled` or `ornament`; they remain compatibility inputs even though the Status Rail no longer needs fixed RGB output or a default brand ornament.

- [ ] **Step 4: Run palette and configuration tests**

Run: `npm test -- tests/palette.test.ts tests/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the semantic palette**

```bash
git add src/palette.ts src/types.ts tests/palette.test.ts
git commit -m "refactor(footer): use semantic theme colors"
```

---

### Task 2: Build the semantic Status Rail and readable telemetry

**Files:**
- Modify: `tests/footer.test.ts`
- Modify: `src/footer.ts`

**Interfaces:**
- Consumes: `AtelierState`, `AtelierConfig`, `AtelierPalette`, `visibleWidth`, and `truncateToWidth`.
- Produces: unchanged public functions `selectResponsiveMode(width)`, `renderFooterLine(state, config, theme, width, colorEnabled?, workingDots?)`, and `createFooterComponent(options)`.
- Internal item contract:

```ts
type FooterZone = "left" | "right";
type FooterItemId =
	| "brand"
	| "status"
	| "activity"
	| "model"
	| "thinking"
	| "git"
	| "input"
	| "output"
	| "cache"
	| "cost"
	| "context"
	| "menu";

interface FooterItem {
	id: FooterItemId;
	zone: FooterZone;
	full: string;
	compact: string;
	dropRank: number;
	required: boolean;
}
```

- [ ] **Step 1: Replace obsolete wide-layout assertions with failing Status Rail tests**

Keep the existing shared `state`, `plainTheme`, `stripAnsi`, animation lifecycle tests, and generic ANSI-width loops. Replace tests that assert `ATELIER`, per-metric RGB values, `R`, `CH`, `◔`, `✦`, and `MENU` with these contracts:

```ts
it("renders a quiet two-zone Status Rail at wide widths", () => {
	const line = stripAnsi(renderFooterLine(state, DEFAULT_CONFIG, plainTheme, 160));
	expect(line).toContain("● READY · gpt-5.6-sol · medium · main*");
	for (const text of ["in 324k", "out 15k", "cache 99%", "$5.041 (sub)", "ctx 27.0%", "⌥A"]) {
		expect(line).toContain(text);
	}
	expect(line).not.toMatch(/ATELIER|R5\.9M|CH98\.8|◔|✦|MENU/);
	expect(visibleWidth(line)).toBe(160);
});

it("right-aligns readable telemetry", () => {
	const line = stripAnsi(renderFooterLine(state, DEFAULT_CONFIG, plainTheme, 180));
	expect(line.endsWith("⌥A")).toBe(true);
	expect(line.indexOf("● READY")).toBe(0);
	expect(line.indexOf("in 324k")).toBeGreaterThan(line.indexOf("main*"));
});

it("styles labels as muted and values as primary", () => {
	const fg = vi.fn((_color: string, text: string) => text);
	renderFooterLine(state, DEFAULT_CONFIG, { fg, bold: (text) => text, italic: (text) => text }, 180);
	expect(fg).toHaveBeenCalledWith("muted", "in");
	expect(fg).toHaveBeenCalledWith("text", "324k");
	expect(fg).toHaveBeenCalledWith("muted", "cache");
	expect(fg).toHaveBeenCalledWith("text", "99%");
});

it("uses warning and error only for actionable states", () => {
	for (const [percent, color] of [[70, "warning"], [90, "error"]] as const) {
		const fg = vi.fn((_color: string, text: string) => text);
		renderFooterLine(
			{ ...state, metrics: { ...state.metrics, contextPercent: percent } },
			DEFAULT_CONFIG,
			{ fg, bold: (text) => text, italic: (text) => text },
			160,
		);
		expect(fg).toHaveBeenCalledWith(color, `${percent.toFixed(1)}%`);
	}
});
```

Update unavailable-value assertions to readable forms:

```ts
for (const marker of ["in —", "out —", "cache —", "$—", "ctx —"]) {
	expect(unavailableLine).toContain(marker);
}
```

- [ ] **Step 2: Run the focused footer tests and verify the old renderer fails**

Run: `npm test -- tests/footer.test.ts`

Expected: FAIL because the old renderer emits the brand, fixed abbreviations, unique metric colors, and old symbols.

- [ ] **Step 3: Introduce semantic item and formatting helpers in `src/footer.ts`**

Replace the old `FooterZones`, `telemetry`, `contextCore`, `activity`, and `buildZones` contracts with the item types above and these helpers:

```ts
const DROP = {
	brand: 0,
	status: 0,
	git: 10,
	thinking: 10,
	cost: 20,
	model: 30,
	input: 40,
	output: 40,
	cache: 50,
	menu: 60,
	activity: Number.POSITIVE_INFINITY,
	context: Number.POSITIVE_INFINITY,
} as const;

function metric(label: string, value: string, palette: AtelierPalette, role: PaletteRole = "primary"): string {
	return `${palette.paint("muted", label)} ${palette.paint(role, value)}`;
}

function availableValue(available: boolean, value: number, theme: ThemeLike): string {
	return available && Number.isFinite(value) ? formatTokens(value) : theme.fg("dim", "—");
}

function percentValue(value: number | null | undefined, decimals: number, theme: ThemeLike): string {
	return value !== null && value !== undefined && Number.isFinite(value)
		? `${value.toFixed(decimals)}%`
		: theme.fg("dim", "—");
}

function contextRole(metrics: AtelierMetrics, config: AtelierConfig): PaletteRole {
	if (metrics.contextPercent === null || !Number.isFinite(metrics.contextPercent)) return "muted";
	if (metrics.contextPercent >= config.contextDanger) return "error";
	if (metrics.contextPercent >= config.contextWarning) return "warning";
	return "primary";
}

function activityText(
	state: AtelierState,
	palette: AtelierPalette,
	theme: ThemeLike,
	workingDots: string,
	compact: boolean,
): string {
	const fallback = state.activity.toUpperCase();
	const label = state.activity === "working" && !compact ? state.workingLabel ?? fallback : fallback;
	const dots = state.activity === "working" && !compact ? workingDots : "";
	const role: PaletteRole = state.activity === "warning" ? "warning" : state.activity === "error" ? "error" : "accent";
	return palette.paint(role, theme.bold(`● ${sanitize(label)}${dots}`));
}
```

Build configured items in zone order. Use these exact visible forms:

```ts
const inputFull = metric("in", availableValue(metrics.usageAvailable, metrics.input, theme), palette);
const outputFull = metric("out", availableValue(metrics.usageAvailable, metrics.output, theme), palette);
const cacheHit = metric("cache", percentValue(metrics.cacheHitPercent, 0, theme), palette);
const cost = `${palette.paint("primary", `$${costValue(metrics, config.currencyDecimals, false, theme)}`)}${
	metrics.subscription ? palette.paint("muted", " (sub)") : ""
}`;
const contextFull = `${metric("ctx", percentValue(metrics.contextPercent, 1, theme), palette, contextRole(metrics, config))}${
	metrics.autoCompact === true ? palette.paint("muted", " (auto)") : ""
}`;
const contextCompact = metric("ctx", percentValue(metrics.contextPercent, 0, theme), palette, contextRole(metrics, config));
```

For `config.preset === "classic"`, use detailed cache text in the cache item's `full` representation:

```ts
const cacheDetail = [
	metric("read", availableValue(metrics.usageAvailable, metrics.cacheRead, theme), palette),
	metrics.cacheWrite > 0
		? metric("write", availableValue(metrics.usageAvailable, metrics.cacheWrite, theme), palette)
		: "",
	metric("hit", percentValue(metrics.cacheHitPercent, 1, theme), palette),
].filter(Boolean).join(" ");
```

The default editorial cache item uses `cacheHit`. The activity item uses full custom working text and compact `● WORKING`. The model, thinking, and Git items use primary/muted roles, with the Git dirty marker rendered as `palette.paint("warning", "*")`. Sanitize optional state and extension-status strings before rendering.

Preserve configured ordering within each zone by iterating `config.segments`; expand `metrics` into input, output, cache, and cost items. Ignore `brand` when `config.preset === "editorial"` or `config.ornament === "none"`. Existing non-editorial restrained ornament may render a muted `ATELIER` item with `dropRank: 0`, but it must never displace state or telemetry.

- [ ] **Step 4: Implement the two-zone composer**

Replace mode-specific joining with a single composer using this contract:

```ts
function renderItems(
	items: FooterItem[],
	compactIds: Set<FooterItemId>,
	separator: string,
): string {
	return items
		.map((item) => (compactIds.has(item.id) ? item.compact : item.full))
		.filter(Boolean)
		.join(separator);
}

function compose(items: FooterItem[], width: number): string {
	const active = [...items];
	const compactIds = new Set<FooterItemId>();
	const left = () =>
		renderItems(active.filter((item) => item.zone === "left"), compactIds, " · ");
	const right = () =>
		renderItems(active.filter((item) => item.zone === "right"), compactIds, "  ");
	const measured = () =>
		visibleWidth(left()) + visibleWidth(right()) + (left() && right() ? 2 : 0);

	const droppable = active
		.filter((item) => !item.required)
		.sort((a, b) => a.dropRank - b.dropRank);
	for (const item of droppable) {
		if (measured() <= width) break;
		const index = active.findIndex((candidate) => candidate.id === item.id);
		if (index >= 0) active.splice(index, 1);
	}

	for (const item of active.filter((candidate) => candidate.required)) {
		if (measured() <= width) break;
		if (item.full !== item.compact) compactIds.add(item.id);
	}

	const leftText = left();
	const rightText = right();
	const gap = width - visibleWidth(leftText) - visibleWidth(rightText);
	if (leftText && rightText && gap >= 2) return `${leftText}${" ".repeat(gap)}${rightText}`;
	return truncateToWidth([leftText, rightText].filter(Boolean).join("  "), width, "");
}
```

When implementing, preserve duplicate-category safety by assigning unique item IDs only once and by generating at most one item per ID. Required means “survives automatic reduction when enabled,” not “bypasses the user's segment configuration.”

Keep `selectResponsiveMode` and its existing thresholds as a compatibility export, but do not use abrupt mode-specific punctuation or color schemes. `renderFooterLine` should build semantic items, pass them to `compose`, and return `truncateToWidth(line, width, "")` as the final safety boundary.

- [ ] **Step 5: Run footer tests and adjust only implementation defects**

Run: `npm test -- tests/footer.test.ts`

Expected: PASS, including old lifecycle/disposal tests after their visual expectations are updated from italic fixed RGB output to bold theme-accent output.

- [ ] **Step 6: Commit the Status Rail renderer**

```bash
git add src/footer.ts tests/footer.test.ts
git commit -m "feat(footer): add quiet status rail layout"
```

---

### Task 3: Lock responsive priority and preset compatibility

**Files:**
- Modify: `tests/footer.test.ts`
- Modify: `tests/menu.test.ts`
- Modify: `src/footer.ts` if the focused tests expose priority defects
- Modify: `src/menu.ts` only if preset configuration does not satisfy the tests

**Interfaces:**
- Consumes: semantic item `dropRank`, `required`, `full`, and `compact` fields from Task 2.
- Produces: deterministic wide/medium/narrow/minimum behavior and preserved `editorial`, `minimal`, and `classic` menu actions.

- [ ] **Step 1: Add failing responsive reduction tests**

Add tests that search a representative width range instead of coupling behavior to font-specific pixel assumptions:

```ts
function plainAt(width: number, config = DEFAULT_CONFIG): string {
	return stripAnsi(renderFooterLine(state, config, plainTheme, width));
}

function firstWidthWithout(text: string): number {
	for (let width = 180; width >= 20; width -= 1) {
		if (!plainAt(width).includes(text)) return width;
	}
	throw new Error(`Expected ${text} to be removed`);
}

it("removes optional information in the approved order", () => {
	const branchGone = firstWidthWithout("main*");
	const costGone = firstWidthWithout("$5.041");
	const modelGone = firstWidthWithout("gpt-5.6-sol");
	const inputGone = firstWidthWithout("in 324k");
	const cacheGone = firstWidthWithout("cache 99%");
	const menuGone = firstWidthWithout("⌥A");
	expect(branchGone).toBeGreaterThan(costGone);
	expect(costGone).toBeGreaterThan(modelGone);
	expect(modelGone).toBeGreaterThan(inputGone);
	expect(inputGone).toBeGreaterThan(cacheGone);
	expect(cacheGone).toBeGreaterThan(menuGone);
});

it("keeps activity and context after optional information is removed", () => {
	const line = plainAt(24);
	expect(line).toContain("● READY");
	expect(line).toContain("ctx");
	expect(visibleWidth(line)).toBeLessThanOrEqual(24);
});

it("never introduces old cryptic compact labels", () => {
	for (const width of [180, 132, 96, 72, 56, 40, 24]) {
		expect(plainAt(width)).not.toMatch(/(?:^|\s)(?:R|W|CH)\d|◔/);
	}
});
```

If threshold ordering makes two same-rank items disappear at adjacent widths, assert grouped ordering (`git/thinking`, then cost, then model, then input/output, then cache, then menu) without requiring a fixed difference between members of one group.

Add preset coverage:

```ts
it("uses cache hit for editorial and detailed cache values for classic", () => {
	expect(plainAt(180, DEFAULT_CONFIG)).toContain("cache 99%");
	const classic = plainAt(180, { ...DEFAULT_CONFIG, preset: "classic", ornament: "none" });
	expect(classic).toContain("read 5.9M");
	expect(classic).toContain("hit 98.8%");
});
```

Add to `tests/menu.test.ts`:

```ts
it("maps editorial to the ornament-free Status Rail default", () => {
	const h = harness();
	h.actions.setPreset("editorial");
	expect(h.runtime.getConfig()).toMatchObject({
		preset: "editorial",
		ornament: "none",
		density: "comfortable",
	});
});
```

- [ ] **Step 2: Run responsive and menu tests to verify any uncovered behavior fails**

Run: `npm test -- tests/footer.test.ts tests/menu.test.ts`

Expected: FAIL if reduction order, compact activity/context survival, classic detail, or editorial defaults differ from the approved contract.

- [ ] **Step 3: Make the smallest renderer or preset corrections required by the tests**

Use these invariant ranks in `src/footer.ts`:

```ts
brand: 0;
status: 0;
git: 10;
thinking: 10;
cost: 20;
model: 30;
input: 40;
output: 40;
cache: 50;
menu: 60;
activity: Number.POSITIVE_INFINITY;
context: Number.POSITIVE_INFINITY;
```

In `src/menu.ts`, retain:

```ts
const PRESET_CONFIG: Record<PresetName, Partial<AtelierConfig>> = {
	editorial: DEFAULT_CONFIG,
	minimal: {
		preset: "minimal",
		segments: ["activity", "metrics", "context", "model", "menu"],
		density: "compact",
		ornament: "none",
	},
	classic: {
		preset: "classic",
		segments: ["metrics", "context", "model", "git", "statuses"],
		density: "comfortable",
		ornament: "none",
	},
};
```

Do not add new configuration fields for responsive ranks or colors; the approved behavior is a presentation invariant, not user configuration.

- [ ] **Step 4: Run all unit tests**

Run: `npm test`

Expected: all Vitest files PASS.

- [ ] **Step 5: Commit responsive and preset contracts**

```bash
git add src/footer.ts src/menu.ts tests/footer.test.ts tests/menu.test.ts
git commit -m "test(footer): lock status rail responsiveness"
```

---

### Task 4: Update documentation and complete release-grade validation

**Files:**
- Modify: `README.md`
- Verify: `CHANGELOG.md` remains unchanged unless a release/version bump is explicitly requested later.

**Interfaces:**
- Consumes: final visible strings and responsive behavior from Tasks 1–3.
- Produces: user documentation matching the shipped default footer.

- [ ] **Step 1: Replace obsolete preview and palette documentation**

Replace the README preview with:

```text
● PONDERING... · gpt-5.6-sol · low · main*        in 324k  out 15k  cache 99%  $5.041 (sub)  ctx 27.0% (auto)  ⌥A
```

Replace “editorial-luxe” and “Midnight Amethyst palette” claims with a concise Status Rail description:

```markdown
Pi Atelier replaces Pi's default footer with a calm, responsive Status Rail while preserving the operational metrics that matter during long coding sessions.

Wide terminals use two stable zones: agent state and workspace identity stay left, while readable telemetry is right-aligned. The footer uses the active Pi theme accent for agent state, neutral text for telemetry, and warning/error colors only when attention is required.
```

Replace footer anatomy labels with:

```markdown
- `in` cumulative input tokens
- `out` cumulative output tokens
- `cache` latest cache-hit percentage in the editorial preset
- `read`, `write`, and `hit` detailed cache telemetry in the classic preset
- `$` cumulative estimated cost
- `(sub)` OAuth subscription-backed access
- `ctx` context utilization
- `(auto)` automatic context compaction
- `*` tracked working-tree changes
```

Document responsive behavior as priority-based removal, with activity and context retained longest. Remove claims about fixed purple, blue, ice blue, orange, and red RGB values.

- [ ] **Step 2: Run formatting and static checks**

Run: `npm run typecheck && npm run lint && npm run format:check`

Expected: all three commands exit 0. If `format:check` reports only changed source/test files, run `npm run format`, inspect the diff, and rerun the three checks.

- [ ] **Step 3: Run the complete project check**

Run: `npm run check`

Expected: typecheck, Biome lint, Biome format check, all Vitest tests, and package verification PASS.

- [ ] **Step 4: Review the final diff against the approved specification**

Run:

```bash
git diff --check main...HEAD
git diff --stat main...HEAD
git status --short
```

Expected: no whitespace errors; only the planned source, test, README, spec, and plan files are present; no generated package archive or temporary screenshot is tracked.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md
git commit -m "docs: describe the status rail footer"
```

- [ ] **Step 6: Run final verification after the last commit**

Run: `npm run check && git status --short`

Expected: `npm run check` exits 0 and `git status --short` prints nothing.

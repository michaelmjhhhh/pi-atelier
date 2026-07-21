# Adaptive Midnight Spectrum Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an adaptive blue/purple/cyan/amber/red Midnight Spectrum to the approved Status Rail while keeping labels muted, preserving contrast on built-in light/dark and custom themes, and changing no layout behavior.

**Architecture:** Expand the palette into category roles and let it choose exact dark/light RGB variants for Pi's built-in themes, theme-token fallbacks for custom themes, and neutral/semantic roles when color is disabled. Refactor footer value formatting to carry availability separately from text so unavailable values stay dim rather than inheriting category color. The existing semantic item composer remains unchanged.

**Tech Stack:** TypeScript 5.9, Pi extension API `0.80.7`, `@earendil-works/pi-tui`, Vitest 4, Biome 2.

## Global Constraints

- Pi must remain `0.80.7` or newer.
- Node.js must remain `22.19.0` or newer.
- Preserve the approved Status Rail layout, wording, responsive removal order, one-line width guarantee, animation, commands, presets, configuration, privacy, and network behavior.
- Built-in dark colors: blue `#6EA8FE`, purple `#B18CFF`, cyan `#7DD3FC`, amber `#FF9F43`, red `#FF5D73`.
- Built-in light colors: deep blue `#245FBF`, deep purple `#7042C1`, deep cyan `#087C9E`, burnt amber `#B45309`, crimson `#C62845`.
- Labels and secondary metadata stay muted/neutral; only values, state anchors, menu shortcut, and dirty marker receive category/state colors.
- Warning and danger context colors override healthy context blue.
- Unknown or unnamed custom themes use exact token fallbacks: `thinkingLow`, `thinkingHigh`, `syntaxType`, `mdHeading`, `warning`, and `error`.
- Color-disabled output emits no custom 24-bit RGB sequences.
- No new configuration field or menu control.
- Follow TDD for every production behavior change.

---

## File Map

- `src/palette.ts` — category roles, built-in dark/light RGB tables, custom-theme token fallback, and color-disabled fallback.
- `src/footer.ts` — assign category roles to values/states and keep unavailable values dim.
- `tests/palette.test.ts` — exact RGB, custom-theme, and color-disabled palette contract.
- `tests/footer.test.ts` — value-only coloring, state/context overrides, unavailable values, width, and lifecycle regression coverage.
- `README.md` — describe the Adaptive Midnight Spectrum and remove obsolete neutral-only claims.

---

### Task 1: Implement the adaptive category palette

**Files:**
- Modify: `tests/palette.test.ts`
- Modify: `src/palette.ts`

**Interfaces:**
- Consumes: an active theme with `name?: string` and `fg(color, text)`.
- Produces: `PaletteRole`, `AtelierPalette.paint(role, text)`, exact built-in-theme RGB output, custom-theme token output, and color-disabled output.
- Preserves: the existing `createPalette(theme, colorEnabled)` call signature and temporary `accent` compatibility role used by `src/footer.ts` until Task 2.

- [ ] **Step 1: Add failing exact-spectrum palette tests**

Replace the old semantic-only tests with this contract while retaining a test for `primary`, `muted`, and compatibility `accent`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createPalette } from "../src/palette.js";

const rgb = (red: number, green: number, blue: number, text = "X") =>
	`\u001b[38;2;${red};${green};${blue}m${text}\u001b[39m`;

const themed = (name?: string) => ({
	name,
	fg: vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`),
});

describe("Adaptive Midnight Spectrum", () => {
	it.each([
		["ready", rgb(110, 168, 254)],
		["input", rgb(110, 168, 254)],
		["context", rgb(110, 168, 254)],
		["output", rgb(177, 140, 255)],
		["menu", rgb(177, 140, 255)],
		["cache", rgb(125, 211, 252)],
		["working", rgb(255, 159, 67)],
		["cost", rgb(255, 159, 67)],
		["warning", rgb(255, 159, 67)],
		["error", rgb(255, 93, 115)],
	] as const)("paints dark %s with its exact RGB", (role, expected) => {
		expect(createPalette(themed("dark"), true).paint(role, "X")).toBe(expected);
	});

	it.each([
		["ready", rgb(36, 95, 191)],
		["input", rgb(36, 95, 191)],
		["context", rgb(36, 95, 191)],
		["output", rgb(112, 66, 193)],
		["menu", rgb(112, 66, 193)],
		["cache", rgb(8, 124, 158)],
		["working", rgb(180, 83, 9)],
		["cost", rgb(180, 83, 9)],
		["warning", rgb(180, 83, 9)],
		["error", rgb(198, 40, 69)],
	] as const)("paints light %s with its exact RGB", (role, expected) => {
		expect(createPalette(themed("light"), true).paint(role, "X")).toBe(expected);
	});

	it.each([
		["ready", "thinkingLow"],
		["input", "thinkingLow"],
		["context", "thinkingLow"],
		["output", "thinkingHigh"],
		["menu", "thinkingHigh"],
		["cache", "syntaxType"],
		["working", "mdHeading"],
		["cost", "mdHeading"],
		["warning", "warning"],
		["error", "error"],
	] as const)("maps custom-theme %s to %s", (role, token) => {
		expect(createPalette(themed("nord"), true).paint(role, "X")).toBe(`<${token}>X</${token}>`);
	});

	it("uses neutral and semantic roles without RGB when color is disabled", () => {
		const theme = themed("dark");
		const palette = createPalette(theme, false);
		for (const role of ["ready", "working", "input", "output", "cache", "cost", "context", "menu"] as const) {
			expect(palette.paint(role, "X")).toBe("<text>X</text>");
		}
		expect(palette.paint("warning", "X")).toBe("<warning>X</warning>");
		expect(palette.paint("error", "X")).toBe("<error>X</error>");
	});
});
```

- [ ] **Step 2: Run the palette test and verify RED**

Run: `npm test -- tests/palette.test.ts`

Expected: FAIL because category roles and exact built-in RGB variants do not exist.

- [ ] **Step 3: Implement the adaptive palette**

Use this role contract in `src/palette.ts`:

```ts
export type PaletteRole =
	| "accent"
	| "primary"
	| "muted"
	| "ready"
	| "working"
	| "input"
	| "output"
	| "cache"
	| "cost"
	| "context"
	| "menu"
	| "warning"
	| "error";

interface PaletteTheme {
	readonly name?: string;
	fg(color: string, text: string): string;
}

type SpectrumRole = Exclude<PaletteRole, "accent" | "primary" | "muted">;
type Rgb = readonly [number, number, number];
```

Define exact RGB tables:

```ts
const DARK: Record<SpectrumRole, Rgb> = {
	ready: [110, 168, 254],
	working: [255, 159, 67],
	input: [110, 168, 254],
	output: [177, 140, 255],
	cache: [125, 211, 252],
	cost: [255, 159, 67],
	context: [110, 168, 254],
	menu: [177, 140, 255],
	warning: [255, 159, 67],
	error: [255, 93, 115],
};

const LIGHT: Record<SpectrumRole, Rgb> = {
	ready: [36, 95, 191],
	working: [180, 83, 9],
	input: [36, 95, 191],
	output: [112, 66, 193],
	cache: [8, 124, 158],
	cost: [180, 83, 9],
	context: [36, 95, 191],
	menu: [112, 66, 193],
	warning: [180, 83, 9],
	error: [198, 40, 69],
};
```

Use exact custom and color-disabled mappings:

```ts
const CUSTOM: Record<PaletteRole, string> = {
	accent: "accent",
	primary: "text",
	muted: "muted",
	ready: "thinkingLow",
	working: "mdHeading",
	input: "thinkingLow",
	output: "thinkingHigh",
	cache: "syntaxType",
	cost: "mdHeading",
	context: "thinkingLow",
	menu: "thinkingHigh",
	warning: "warning",
	error: "error",
};

const NO_COLOR: Record<PaletteRole, string> = {
	accent: "accent",
	primary: "text",
	muted: "muted",
	ready: "text",
	working: "text",
	input: "text",
	output: "text",
	cache: "text",
	cost: "text",
	context: "text",
	menu: "text",
	warning: "warning",
	error: "error",
};
```

Selection rules:

```ts
function rgb([red, green, blue]: Rgb, text: string): string {
	return `\u001b[38;2;${red};${green};${blue}m${text}\u001b[39m`;
}

export function createPalette(theme: PaletteTheme, colorEnabled: boolean): AtelierPalette {
	return {
		paint(role, text) {
			if (!colorEnabled) return theme.fg(NO_COLOR[role], text);
			if (role === "accent" || role === "primary" || role === "muted") {
				return theme.fg(CUSTOM[role], text);
			}
			if (theme.name?.toLowerCase() === "dark") return rgb(DARK[role], text);
			if (theme.name?.toLowerCase() === "light") return rgb(LIGHT[role], text);
			return theme.fg(CUSTOM[role], text);
		},
	};
}
```

Unknown and unnamed themes must use `CUSTOM`; do not infer background from arbitrary names.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -- tests/palette.test.ts && npm run typecheck`

Expected: PASS with no diagnostics.

- [ ] **Step 5: Commit the adaptive palette**

```bash
git add src/palette.ts tests/palette.test.ts
git commit -m "feat(palette): add adaptive midnight spectrum"
```

---

### Task 2: Apply category colors to Status Rail values

**Files:**
- Modify: `tests/footer.test.ts`
- Modify: `src/footer.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: category roles from Task 1.
- Produces: value-only category coloring, state-specific activity colors, threshold overrides, dim unavailable values, and accurate user documentation.
- Preserves: `renderFooterLine`, `createFooterComponent`, item composition, responsive ranks, and all public behavior outside color.

- [ ] **Step 1: Add failing footer color-placement tests**

Add fixtures with explicit built-in names:

```ts
const namedTheme = (name: "dark" | "light") => ({
	name,
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => text,
	italic: (text: string) => text,
});

const darkRgb = {
	blue: "\u001b[38;2;110;168;254m",
	purple: "\u001b[38;2;177;140;255m",
	cyan: "\u001b[38;2;125;211;252m",
	amber: "\u001b[38;2;255;159;67m",
	red: "\u001b[38;2;255;93;115m",
};
```

Test values and muted labels independently:

```ts
it("colors dark-theme values while keeping labels muted", () => {
	const line = renderFooterLine(state, DEFAULT_CONFIG, namedTheme("dark"), 180);
	expect(line).toContain(`<muted>in</muted> ${darkRgb.blue}324k\u001b[39m`);
	expect(line).toContain(`<muted>out</muted> ${darkRgb.purple}15k\u001b[39m`);
	expect(line).toContain(`<muted>cache</muted> ${darkRgb.cyan}99%\u001b[39m`);
	expect(line).toContain(`${darkRgb.amber}$5.041\u001b[39m<muted> (sub)</muted>`);
	expect(line).toContain(`<muted>ctx</muted> ${darkRgb.blue}27.0%\u001b[39m`);
	expect(line).toContain(`${darkRgb.purple}⌥A\u001b[39m`);
});

it("uses state-specific activity colors", () => {
	const ready = renderFooterLine(state, DEFAULT_CONFIG, namedTheme("dark"), 180);
	const working = renderFooterLine(
		{ ...state, activity: "working", workingLabel: "PONDERING" },
		DEFAULT_CONFIG,
		namedTheme("dark"),
		180,
	);
	expect(ready).toContain(`${darkRgb.blue}● READY\u001b[39m`);
	expect(working).toContain(`${darkRgb.amber}● PONDERING...\u001b[39m`);
});

it("overrides context blue at warning and danger thresholds", () => {
	const warning = renderFooterLine(
		{ ...state, metrics: { ...state.metrics, contextPercent: 70 } },
		DEFAULT_CONFIG,
		namedTheme("dark"),
		180,
	);
	const danger = renderFooterLine(
		{ ...state, metrics: { ...state.metrics, contextPercent: 90 } },
		DEFAULT_CONFIG,
		namedTheme("dark"),
		180,
	);
	expect(warning).toContain(`${darkRgb.amber}70.0%\u001b[39m`);
	expect(danger).toContain(`${darkRgb.red}90.0%\u001b[39m`);
});
```

Add equivalent light-theme assertions for at least input, output, cache, cost, context, and menu using the exact light RGB values from the amendment.

Add an unavailable-value regression:

```ts
it("keeps unavailable values dim instead of category-colored", () => {
	const line = renderFooterLine(
		{ ...state, metrics: { ...state.metrics, usageAvailable: false, costAvailable: false, contextPercent: null } },
		DEFAULT_CONFIG,
		namedTheme("dark"),
		180,
	);
	expect(line).toContain("<dim>—</dim>");
	expect(line).not.toMatch(/\u001b\[38;2;[^m]+m—/);
});
```

- [ ] **Step 2: Run footer tests and verify RED**

Run: `npm test -- tests/footer.test.ts`

Expected: FAIL because footer values still use generic primary/accent roles.

- [ ] **Step 3: Carry availability separately from display text**

In `src/footer.ts`, add:

```ts
interface DisplayValue {
	text: string;
	available: boolean;
}
```

Change telemetry helpers to return `DisplayValue` rather than pre-styled strings:

```ts
function availableValue(available: boolean, value: number): DisplayValue {
	return available && Number.isFinite(value)
		? { text: formatTokens(value), available: true }
		: { text: "—", available: false };
}

function percentValue(value: number | null | undefined, decimals: number): DisplayValue {
	return value !== null && value !== undefined && Number.isFinite(value)
		? { text: `${value.toFixed(decimals)}%`, available: true }
		: { text: "—", available: false };
}

function costValue(metrics: AtelierMetrics, decimals: number, compact: boolean): DisplayValue {
	if (!metrics.costAvailable || !Number.isFinite(metrics.cost)) return { text: "$—", available: false };
	const amount = compact && metrics.cost >= 1_000
		? formatTokens(metrics.cost)
		: metrics.cost.toFixed(compact ? Math.min(2, decimals) : decimals);
	return { text: `$${amount}`, available: true };
}
```

Render labels and values separately:

```ts
function paintValue(value: DisplayValue, role: PaletteRole, palette: AtelierPalette, theme: ThemeLike): string {
	return value.available ? palette.paint(role, value.text) : theme.fg("dim", value.text);
}

function metric(
	label: string,
	value: DisplayValue,
	palette: AtelierPalette,
	theme: ThemeLike,
	role: PaletteRole,
): string {
	return `${palette.paint("muted", label)} ${paintValue(value, role, palette, theme)}`;
}
```

Update all call sites so input uses `input`, output uses `output`, every classic/editorial cache value uses `cache`, cost uses `cost`, healthy context uses `context`, and the menu shortcut uses `menu`.

- [ ] **Step 4: Apply state and threshold roles**

Update context and activity role selection:

```ts
function contextRole(metrics: AtelierMetrics, config: AtelierConfig): PaletteRole {
	if (metrics.contextPercent === null || !Number.isFinite(metrics.contextPercent)) return "context";
	if (metrics.contextPercent >= config.contextDanger) return "error";
	if (metrics.contextPercent >= config.contextWarning) return "warning";
	return "context";
}
```

```ts
const role: PaletteRole =
	state.activity === "ready"
		? "ready"
		: state.activity === "working"
			? "working"
			: state.activity === "warning"
				? "warning"
				: "error";
```

Keep branch/model primary, thinking/separators/status/subscription/compaction muted, dirty Git warning, and unavailable values dim.

Extend `ThemeLike` with `readonly name?: string` so the palette can select built-in variants without changing existing theme fixtures.

- [ ] **Step 5: Run focused tests and preserve width/lifecycle behavior**

Run: `npm test -- tests/footer.test.ts tests/palette.test.ts`

Expected: PASS, including all existing responsive, ANSI-width, preset, sanitation, malformed-value, and animation lifecycle tests.

- [ ] **Step 6: Update README color documentation**

Replace the neutral-only introduction sentence with:

```markdown
Wide terminals use two stable zones: agent state and workspace identity stay left, while readable telemetry is right-aligned. Values use an adaptive Midnight Spectrum—blue input/context, purple output/menu, cyan cache, amber cost/working, and red danger—while labels and workspace metadata stay quiet.
```

Replace the feature bullet `Theme-aware styling with no hard-coded ANSI colors` with:

```markdown
- Adaptive dark/light Midnight Spectrum with custom-theme and `NO_COLOR` fallbacks
```

Add a short palette section after the preview documenting dark/light adaptation, value-only coloring, custom-theme token fallback, and semantic warning/error overrides. Do not change footer anatomy, layout, or command documentation.

- [ ] **Step 7: Run complete worker-side verification**

Do not remove `.pi-subagents` while a subagent process is active. Run project checks that do not scan ignored runner artifacts, plus scoped formatting for tracked files:

```bash
npm run typecheck
npm run lint
npx biome format src/palette.ts src/footer.ts tests/palette.test.ts tests/footer.test.ts README.md
npm test
npm run check:pack
git diff --check
git status --short
```

Expected: typecheck, lint, scoped formatting, all tests, and package verification PASS; no whitespace errors; status lists only the planned tracked files before commit.

- [ ] **Step 8: Commit the footer color application**

```bash
git add src/footer.ts tests/footer.test.ts README.md
git commit -m "feat(footer): color status rail values"
```

- [ ] **Step 9: Run post-commit worker checks and hand off the final gate**

Run:

```bash
npm test
git diff --check main...HEAD
git status --short
```

Expected: all tests pass, no whitespace errors, and tracked status is clean. After the worker exits, the execution controller removes ignored `.pi-subagents` artifacts and runs fresh `npm run check` as the final completion gate.

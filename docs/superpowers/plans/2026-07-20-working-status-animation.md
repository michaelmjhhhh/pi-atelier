# Working Status Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Animate the visible working status as an orange italic phrase followed by a shrinking three-to-one ellipsis every 400 ms.

**Architecture:** Keep semantic activity and phrase selection in `AtelierRuntime`; keep transient frame and timer state inside the footer component. Extend the pure footer renderer with a presentation-only dot-frame argument so styling and width behavior remain deterministic and independently testable.

**Tech Stack:** TypeScript 5.9, Pi extension API 0.80.7, `@earendil-works/pi-tui` 0.80.7, Vitest 4 fake timers, Biome.

## Global Constraints

- Idle remains `● READY` in blue, upright, and static.
- Full working animation appears only in Gallery (132+) and Balanced (96–131) modes.
- Focus, Telemetry, and Safe layouts preserve their existing compact behavior.
- Dot frames are exactly `...`, `..`, `.` at exactly 400 ms per frame.
- Only the working phrase and dots are italic; the leading bullet remains upright.
- Working uses Atelier orange `#FF9F43`; do not add yellow.
- A footer component owns at most one timer and clears it on idle, compact rendering, and disposal.
- Do not add dependencies or configuration options.

## File Structure

- Modify `src/palette.ts`: map the semantic `working` role to Atelier orange.
- Modify `src/footer.ts`: add italic theme support, pure working-frame rendering, and component-owned timer lifecycle.
- Modify `tests/palette.test.ts`: lock the exact working RGB value.
- Modify `tests/footer.test.ts`: lock styling, frame sequence, responsive behavior, and timer cleanup.
- Modify `README.md`: update palette and work-cycle descriptions plus the text preview.
- Modify `CHANGELOG.md`: record the user-visible animation under an Unreleased heading.

---

### Task 1: Render the Orange Italic Working Status

**Files:**
- Modify: `src/palette.ts:18-29`
- Modify: `src/footer.ts:6-9,123-154,256-275`
- Test: `tests/palette.test.ts:8-19`
- Test: `tests/footer.test.ts:6-10,51-73,268-302`

**Interfaces:**
- Consumes: existing `AtelierState.activity`, `AtelierState.workingLabel`, `AtelierPalette.paint()`.
- Produces: `ThemeLike.italic(text: string): string` and `renderFooterLine(state, config, theme, width, colorEnabled?, workingDots?)`, where `workingDots` defaults to `"..."`.

- [ ] **Step 1: Add failing palette and rendering tests**

Update the shared theme and inline `ThemeLike` test doubles in `tests/footer.test.ts` so they implement `italic`:

```ts
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
};
```

For every inline object passed as a footer theme, add either `italic: (text) => text` or an ANSI implementation. In particular, update the ANSI-heavy theme to:

```ts
const ansiTheme = {
	fg: (_color: string, text: string) => `\u001b[38;5;45m${text}\u001b[0m`,
	bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
	italic: (text: string) => `\u001b[3m${text}\u001b[23m`,
};
```

Add `working` to the exact true-color cases in `tests/palette.test.ts`:

```ts
["working", "\u001b[38;2;255;159;67mX\u001b[39m"],
```

Add this test near the existing working-phrase tests in `tests/footer.test.ts`:

```ts
it("renders the full working phrase and dots in orange italics without italicizing the bullet", () => {
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => `<i>${text}</i>`,
	};
	const working = { ...state, activity: "working" as const, workingLabel: "PONDERING" };
	const line = renderFooterLine(working, DEFAULT_CONFIG, theme, 160, true, "..");

	expect(line).toContain("\u001b[38;2;255;159;67m● <i>PONDERING..</i>\u001b[39m");
	expect(line).not.toContain("<i>●");
});
```

Strengthen the fallback-label case for `working` by expecting the default dots:

```ts
expect(line).toContain(activity === "working" ? `${expected}...` : expected);
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
npm test -- tests/palette.test.ts tests/footer.test.ts
```

Expected: FAIL because `working` is still purple, `ThemeLike` has no `italic` method, `renderFooterLine` has no `workingDots` argument, and working output has no ellipsis.

- [ ] **Step 3: Implement pure working-status styling**

In `src/palette.ts`, change only the `working` RGB tuple:

```ts
working: [255, 159, 67],
```

Extend `ThemeLike` in `src/footer.ts`:

```ts
export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
}
```

Replace `activity()` with:

```ts
function activity(
	state: AtelierState,
	full: boolean,
	palette: AtelierPalette,
	theme: ThemeLike,
	workingDots: string,
): string {
	const labels = {
		ready: "READY",
		working: state.workingLabel ?? "WORKING",
		warning: "WARNING",
		error: "ERROR",
	} as const;
	const roles = { ready: "ready", working: "working", warning: "warning", error: "error" } as const;
	if (!full) return palette.paint(roles[state.activity], "●");
	if (state.activity === "working") {
		return palette.paint("working", `● ${theme.italic(`${labels.working}${workingDots}`)}`);
	}
	return palette.paint(roles[state.activity], `● ${labels[state.activity]}`);
}
```

Add `workingDots` to `buildZones()` after `colorEnabled` and pass it to `activity()`:

```ts
function buildZones(
	state: AtelierState,
	config: AtelierConfig,
	theme: ThemeLike,
	mode: ResponsiveMode,
	colorEnabled: boolean,
	workingDots: string,
): FooterZones {
```

```ts
workspace.push(activity(state, mode === "gallery" || mode === "balanced", palette, theme, workingDots));
```

Extend `renderFooterLine()` with a default frame:

```ts
export function renderFooterLine(
	state: AtelierState,
	config: AtelierConfig,
	theme: ThemeLike,
	width: number,
	colorEnabled = true,
	workingDots = "...",
): string {
```

Pass `workingDots` into both `buildZones()` calls, including the Gallery-to-Balanced fallback:

```ts
const zones = buildZones(state, config, theme, mode, colorEnabled, workingDots);
```

```ts
renderBalanced(buildZones(state, config, theme, "balanced", colorEnabled, workingDots), width, theme);
```

- [ ] **Step 4: Run focused tests and type checking**

Run:

```bash
npm test -- tests/palette.test.ts tests/footer.test.ts && npm run typecheck
```

Expected: both test files PASS and TypeScript reports no errors. The longest-phrase width test must still pass with the default three dots.

- [ ] **Step 5: Commit the pure rendering change**

```bash
git add src/palette.ts src/footer.ts tests/palette.test.ts tests/footer.test.ts
git commit -m "feat(footer): style active working status"
```

---

### Task 2: Animate and Clean Up Shrinking Dots

**Files:**
- Modify: `src/footer.ts:277-308`
- Test: `tests/footer.test.ts:268-323`

**Interfaces:**
- Consumes: Task 1’s `renderFooterLine(..., workingDots?)`.
- Produces: component behavior that owns one 400 ms interval only when the rendered line actually contains the full working label, sends the frame through `renderFooterLine`, and clears and resets state otherwise.

- [ ] **Step 1: Add failing component animation tests**

Replace the existing `"renders the selected working phrase without changing it across redraws"` test with this fake-timer test:

```ts
it("animates shrinking dots every 400 ms while retaining the selected phrase", () => {
	vi.useFakeTimers();
	const requestRender = vi.fn();
	const working = { ...state, activity: "working" as const, workingLabel: "PHOTOSYNTHESIZING" };
	const component = createFooterComponent({
		getState: () => working,
		getConfig: () => DEFAULT_CONFIG,
		requestRender,
		onBranchChange: () => vi.fn(),
		theme: plainTheme,
	});

	try {
		expect(component.render(160)[0]).toContain("PHOTOSYNTHESIZING...");
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(400);
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(component.render(160)[0]).toContain("PHOTOSYNTHESIZING..");
		vi.advanceTimersByTime(400);
		expect(component.render(160)[0]).toContain("PHOTOSYNTHESIZING.");
		vi.advanceTimersByTime(400);
		expect(component.render(160)[0]).toContain("PHOTOSYNTHESIZING...");
		expect(component.render(160)[0]).not.toContain("WORKING");
	} finally {
		component.dispose();
		vi.useRealTimers();
	}
});
```

Add a responsive start/stop/reset test:

```ts
it("animates only when the full working status is visible and resets after stopping", () => {
	vi.useFakeTimers();
	let current: AtelierState = {
		...state,
		activity: "working",
		workingLabel: "PONDERING",
	};
	let config = DEFAULT_CONFIG;
	const requestRender = vi.fn();
	const component = createFooterComponent({
		getState: () => current,
		getConfig: () => config,
		requestRender,
		onBranchChange: () => vi.fn(),
		theme: plainTheme,
	});

	try {
		expect(component.render(95)[0]).not.toContain("PONDERING");
		expect(vi.getTimerCount()).toBe(0);
		config = { ...DEFAULT_CONFIG, segments: DEFAULT_CONFIG.segments.filter((id) => id !== "activity") };
		expect(component.render(100)[0]).not.toContain("PONDERING");
		expect(vi.getTimerCount()).toBe(0);
		config = DEFAULT_CONFIG;
		expect(component.render(100)[0]).toContain("PONDERING...");
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(400);
		expect(component.render(100)[0]).toContain("PONDERING..");

		current = { ...state, activity: "ready" };
		expect(component.render(100)[0]).toContain("READY");
		expect(vi.getTimerCount()).toBe(0);
		current = { ...state, activity: "working", workingLabel: "PONDERING" };
		expect(component.render(100)[0]).toContain("PONDERING...");
	} finally {
		component.dispose();
		vi.useRealTimers();
	}
});
```

Add a disposal test after the existing branch-subscription test:

```ts
it("clears the animation timer and prevents redraws after disposal", () => {
	vi.useFakeTimers();
	const requestRender = vi.fn();
	const component = createFooterComponent({
		getState: () => ({ ...state, activity: "working", workingLabel: "PONDERING" }),
		getConfig: () => DEFAULT_CONFIG,
		requestRender,
		onBranchChange: () => vi.fn(),
		theme: plainTheme,
	});

	try {
		component.render(160);
		expect(vi.getTimerCount()).toBe(1);
		component.dispose();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(800);
		expect(requestRender).not.toHaveBeenCalled();
		component.dispose();
	} finally {
		component.dispose();
		vi.useRealTimers();
	}
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm test -- tests/footer.test.ts
```

Expected: FAIL because the component always renders the default `...`, owns no interval, and never calls `requestRender()` for animation.

- [ ] **Step 3: Implement the footer-owned animation lifecycle**

Add these constants near `ResponsiveMode` in `src/footer.ts`:

```ts
const WORKING_DOT_FRAMES = ["...", "..", "."] as const;
const WORKING_ANIMATION_INTERVAL_MS = 400;
```

Replace `createFooterComponent()` with:

```ts
export function createFooterComponent(options: FooterComponentOptions): Component & { dispose(): void } {
	let disposed = false;
	let frameIndex = 0;
	let animationTimer: ReturnType<typeof setInterval> | undefined;
	const unsubscribe = options.onBranchChange(options.requestRender);

	const stopAnimation = (): void => {
		if (animationTimer) {
			clearInterval(animationTimer);
			animationTimer = undefined;
		}
		frameIndex = 0;
	};

	const syncAnimation = (visible: boolean): void => {
		if (!visible) {
			stopAnimation();
			return;
		}
		if (animationTimer) return;
		animationTimer = setInterval(() => {
			if (disposed) return;
			frameIndex = (frameIndex + 1) % WORKING_DOT_FRAMES.length;
			options.requestRender();
		}, WORKING_ANIMATION_INTERVAL_MS);
	};

	return {
		render(width) {
			const state = options.getState();
			const line = renderFooterLine(
				state,
				options.getConfig(),
				options.theme,
				width,
				options.colorEnabled ?? true,
				WORKING_DOT_FRAMES[frameIndex],
			);
			const workingLabel = state.workingLabel ?? "WORKING";
			syncAnimation(state.activity === "working" && line.includes(workingLabel));
			return [line];
		},
		invalidate() {},
		dispose() {
			if (disposed) return;
			disposed = true;
			stopAnimation();
			unsubscribe();
		},
	};
}
```

- [ ] **Step 4: Run footer tests and the full automated check**

Run:

```bash
npm test -- tests/footer.test.ts
npm run check
```

Expected: the focused footer suite PASSes, followed by typecheck, lint, format check, all Vitest suites, and package verification passing with exit code 0.

- [ ] **Step 5: Commit the animation lifecycle**

```bash
git add src/footer.ts tests/footer.test.ts
git commit -m "feat(footer): animate shrinking working dots"
```

---

### Task 3: Document the Motion and Color Change

**Files:**
- Modify: `README.md:11-32,85-87,165-170`
- Modify: `CHANGELOG.md:1-6`

**Interfaces:**
- Consumes: the final behavior implemented by Tasks 1 and 2.
- Produces: public documentation that accurately describes the orange italic status, three-to-one ellipsis, 400 ms cadence, and responsive visibility.

- [ ] **Step 1: Update the README preview and palette description**

Change the preview to:

```text
◆ ATELIER  ● PONDERING...  gpt-5.6-sol · low  main ✦    ↑324k ↓15k  R5.9M CH98.8%  $5.041 (sub)  ◔27.0%/372k (auto)  ⌥A MENU
```

Replace the purple and orange palette bullets with:

```md
- **Purple `#B18CFF`:** Atelier and output tokens
- **Orange `#FF9F43`:** active working status, cost, Git dirty, context warning
```

Replace the work-cycle paragraph with:

```md
`READY` remains fixed when idle. During each work cycle, the working label is selected once from a playful built-in phrase set—such as `KNEADING`, `MOONWALKING`, or `PONDERING`—and remains stable until the cycle ends. In Gallery and Balanced layouts, the active phrase is orange and italic with an ellipsis that shrinks from `...` to `..` to `.` every 400 ms. Narrower layouts retain the compact static activity bullet.
```

Update the final responsive color sentence so orange includes active work:

```md
Color remains semantic at every width: input and healthy context are blue, output is purple, cache is ice blue, active work, cost, and warnings are orange, and only dangerous context or errors use red.
```

- [ ] **Step 2: Add an Unreleased changelog entry**

Insert this before `## 0.1.1` in `CHANGELOG.md`:

```md
## Unreleased

- Animate the visible work-cycle phrase with orange italics and a shrinking three-to-one ellipsis.

```

- [ ] **Step 3: Verify formatting, package contents, and the full suite**

Run:

```bash
npm run format:check
npm run check
npm pack --dry-run
```

Expected: formatting check passes, the full project check exits 0, and the dry-run tarball includes `README.md`, `CHANGELOG.md`, `src/footer.ts`, and `src/palette.ts` with no unexpected generated files.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: describe working status motion"
```

---

## Final Verification

- [ ] Run the complete release checks from a clean working tree:

```bash
npm run check
git status --short
```

Expected: `npm run check` exits 0 and `git status --short` prints nothing.

- [ ] Launch the extension for a manual TUI smoke test:

```bash
pi -e .
```

Expected: idle shows blue upright `● READY`; submitting a prompt shows an orange upright bullet followed by an italic stable phrase whose suffix cycles `...` → `..` → `.` every 400 ms; settling returns to `● READY`; resizing below 96 columns removes the phrase animation without wrapping or redraw artifacts.

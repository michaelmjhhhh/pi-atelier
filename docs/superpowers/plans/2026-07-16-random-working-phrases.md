# Random Working Phrases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep `READY` unchanged while replacing the fixed `WORKING` footer label with one stable, randomly selected reference-image phrase per work cycle.

**Architecture:** Put the approved phrase pool and bounded selection logic in a focused activity module. The runtime owns cycle-level selection and stores the result in `AtelierState`; the footer remains deterministic and renders that stored label with a compatibility fallback.

**Tech Stack:** TypeScript 5.9, Vitest 4, Pi extension APIs, Biome

## Global Constraints

- Use exactly the 36 English phrases listed in `docs/superpowers/specs/2026-07-16-random-working-phrases-design.md`.
- Display phrases in uppercase.
- Select once on each transition from a non-working activity to `working`.
- Keep the selected phrase stable through redraws and usage refreshes in the same work cycle.
- Consecutive work cycles may naturally select the same phrase; do not track history.
- Keep `READY`, `WARNING`, and `ERROR` unchanged.
- Compact layouts continue to render only the activity dot.
- Preserve every existing responsive width invariant.
- Keep Pi `>=0.80.7` and Node.js `>=22.19.0`; add no dependencies.

---

### Task 1: Add the authoritative phrase selector

**Files:**
- Create: `src/activity.ts`
- Create: `tests/activity.test.ts`

**Interfaces:**
- Consumes: a numeric random sample, normally from `Math.random()`.
- Produces: `WORKING_PHRASES: readonly string[]` and `selectWorkingPhrase(randomValue: number): string`.

- [ ] **Step 1: Write the failing selector tests**

Create `tests/activity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selectWorkingPhrase, WORKING_PHRASES } from "../src/activity.js";

const expectedPhrases = [
	"KNEADING",
	"PERCOLATING",
	"MARINATING",
	"CARAMELIZING",
	"JULIENNING",
	"FLAMBÉING",
	"CHOREOGRAPHING",
	"MOONWALKING",
	"JITTERBUGGING",
	"SOCK-HOPPING",
	"BOOGIEING",
	"SHIMMYING",
	"EBBING",
	"UNDULATING",
	"PROPAGATING",
	"PHOTOSYNTHESIZING",
	"GERMINATING",
	"POLLINATING",
	"PONDERING",
	"RUMINATING",
	"COGITATING",
	"CEREBRATING",
	"DELIBERATING",
	"MUSING",
	"FROLICKING",
	"LOLLYGAGGING",
	"DILLY-DALLYING",
	"BOONDOGGLING",
	"SHENANIGANING",
	"RAZZLE-DAZZLING",
	"CLAUDING",
	"GITIFYING",
	"RETICULATING",
	"HYPERSPACING",
	"QUANTUMIZING",
	"COMBOBULATING",
] as const;

describe("working phrases", () => {
	it("contains exactly the approved reference-image phrases", () => {
		expect(WORKING_PHRASES).toEqual(expectedPhrases);
		expect(new Set(WORKING_PHRASES).size).toBe(36);
	});

	it.each([
		[0, "KNEADING"],
		[0.5, "PONDERING"],
		[0.999_999, "COMBOBULATING"],
		[1, "COMBOBULATING"],
		[-1, "KNEADING"],
		[Number.NaN, "KNEADING"],
	] as const)("selects a bounded phrase for random value %s", (randomValue, expected) => {
		expect(selectWorkingPhrase(randomValue)).toBe(expected);
	});
});
```

- [ ] **Step 2: Run the test and verify the red state**

Run:

```bash
npm test -- tests/activity.test.ts
```

Expected: FAIL because `../src/activity.js` does not exist.

- [ ] **Step 3: Implement the minimal phrase module**

Create `src/activity.ts`:

```ts
export const WORKING_PHRASES = [
	"KNEADING",
	"PERCOLATING",
	"MARINATING",
	"CARAMELIZING",
	"JULIENNING",
	"FLAMBÉING",
	"CHOREOGRAPHING",
	"MOONWALKING",
	"JITTERBUGGING",
	"SOCK-HOPPING",
	"BOOGIEING",
	"SHIMMYING",
	"EBBING",
	"UNDULATING",
	"PROPAGATING",
	"PHOTOSYNTHESIZING",
	"GERMINATING",
	"POLLINATING",
	"PONDERING",
	"RUMINATING",
	"COGITATING",
	"CEREBRATING",
	"DELIBERATING",
	"MUSING",
	"FROLICKING",
	"LOLLYGAGGING",
	"DILLY-DALLYING",
	"BOONDOGGLING",
	"SHENANIGANING",
	"RAZZLE-DAZZLING",
	"CLAUDING",
	"GITIFYING",
	"RETICULATING",
	"HYPERSPACING",
	"QUANTUMIZING",
	"COMBOBULATING",
] as const;

export function selectWorkingPhrase(randomValue: number): string {
	const bounded = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0;
	const index = Math.min(WORKING_PHRASES.length - 1, Math.floor(bounded * WORKING_PHRASES.length));
	return WORKING_PHRASES[index];
}
```

- [ ] **Step 4: Run focused verification**

Run:

```bash
npm test -- tests/activity.test.ts
npm run typecheck
```

Expected: both commands PASS; six selector cases pass and TypeScript reports no errors.

- [ ] **Step 5: Commit the selector**

```bash
git add src/activity.ts tests/activity.test.ts
git commit -m "feat(activity): add working phrase selector"
```

---

### Task 2: Select and retain a phrase per runtime work cycle

**Files:**
- Modify: `src/types.ts:24-34`
- Modify: `src/state.ts:5-54`
- Modify: `tests/state.test.ts:12-69`

**Interfaces:**
- Consumes: `selectWorkingPhrase(randomValue: number): string` from Task 1.
- Produces: optional `AtelierState.workingLabel?: string`; optional `RuntimeDependencies.random?: () => number`; cycle-aware `AtelierRuntime.setActivity(activity: ActivityState): void`.

- [ ] **Step 1: Write failing runtime tests for cycle selection and stability**

In `tests/state.test.ts`, change the helper signature and runtime construction to accept an injected random source:

```ts
function createRuntime(
	execResult = { stdout: "", stderr: "", code: 0, killed: false },
	random: () => number = Math.random,
) {
	const requestRender = vi.fn();
	const exec = vi.fn().mockResolvedValue(execResult);
	const ctx = {
		model: { id: "model", provider: "provider", reasoning: true },
		modelRegistry: { isUsingOAuth: vi.fn().mockReturnValue(true) },
		getContextUsage: vi.fn().mockReturnValue({ tokens: 1_000, contextWindow: 10_000, percent: 10 }),
		sessionManager: { getEntries: vi.fn().mockReturnValue([assistant]) },
	};
	const runtime = new AtelierRuntime({
		pi: { exec } as never,
		ctx: ctx as never,
		config: DEFAULT_CONFIG,
		autoCompact: true,
		random,
		requestRender,
	});
	return { runtime, exec, requestRender };
}
```

Replace the existing activity/configuration test with these two tests:

```ts
it("selects one stable label when a work cycle starts", () => {
	const random = vi.fn().mockReturnValue(0.5);
	const { runtime, requestRender } = createRuntime(undefined, random);
	requestRender.mockClear();

	runtime.setActivity("working");
	const selected = runtime.getState().workingLabel;
	runtime.setActivity("working");
	runtime.refreshUsage();

	expect(selected).toBe("PONDERING");
	expect(runtime.getState()).toMatchObject({ activity: "working", workingLabel: "PONDERING" });
	expect(random).toHaveBeenCalledOnce();
	expect(requestRender).toHaveBeenCalledTimes(2);
});

it("selects again for the next work cycle and still updates configuration", () => {
	const random = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0.999_999);
	const { runtime, requestRender } = createRuntime(undefined, random);
	requestRender.mockClear();

	runtime.setActivity("working");
	expect(runtime.getState().workingLabel).toBe("KNEADING");
	runtime.setActivity("ready");
	runtime.setActivity("working");
	runtime.setConfig({ ...DEFAULT_CONFIG, preset: "minimal" });

	expect(runtime.getState()).toMatchObject({ activity: "working", workingLabel: "COMBOBULATING" });
	expect(runtime.getConfig().preset).toBe("minimal");
	expect(random).toHaveBeenCalledTimes(2);
	expect(requestRender).toHaveBeenCalledTimes(4);
});
```

- [ ] **Step 2: Run the runtime test and verify the red state**

Run:

```bash
npm test -- tests/state.test.ts
```

Expected: FAIL because `RuntimeDependencies` does not accept `random` and `AtelierState` has no `workingLabel`.

- [ ] **Step 3: Add the state field and runtime dependency**

In `src/types.ts`, add the optional field immediately after `activity`:

```ts
export interface AtelierState {
	activity: ActivityState;
	workingLabel?: string;
	modelId?: string;
```

In `src/state.ts`, import the selector:

```ts
import { selectWorkingPhrase } from "./activity.js";
```

Extend `RuntimeDependencies` and runtime fields:

```ts
export interface RuntimeDependencies {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	config: AtelierConfig;
	autoCompact: boolean | null;
	random?: () => number;
	requestRender(): void;
}
```

```ts
readonly #random: () => number;
```

Assign the dependency in the constructor:

```ts
this.#random = dependencies.random ?? Math.random;
```

Replace `setActivity` with:

```ts
setActivity(activity: ActivityState): void {
	if (this.#state.activity === activity) return;
	this.#state =
		activity === "working"
			? { ...this.#state, activity, workingLabel: selectWorkingPhrase(this.#random()) }
			: { ...this.#state, activity };
	this.#invalidate();
}
```

- [ ] **Step 4: Run focused runtime verification**

Run:

```bash
npm test -- tests/state.test.ts tests/activity.test.ts
npm run typecheck
```

Expected: all activity and runtime tests PASS; TypeScript reports no errors.

- [ ] **Step 5: Commit runtime cycle selection**

```bash
git add src/types.ts src/state.ts tests/state.test.ts
git commit -m "feat(state): retain phrase for each work cycle"
```

---

### Task 3: Render the selected phrase deterministically

**Files:**
- Modify: `src/footer.ts:123-127`
- Modify: `tests/footer.test.ts:268-281`

**Interfaces:**
- Consumes: `AtelierState.workingLabel?: string` from Task 2.
- Produces: deterministic full-width activity output using the stored phrase; literal `WORKING` only as a compatibility fallback.

- [ ] **Step 1: Write failing footer tests for rendering and fallback states**

Replace the existing `rerenders changed state at the same width` test in `tests/footer.test.ts` with:

```ts
it("renders the selected working phrase without changing it across redraws", () => {
	let current = state;
	const component = createFooterComponent({
		getState: () => current,
		getConfig: () => DEFAULT_CONFIG,
		requestRender: vi.fn(),
		onBranchChange: () => vi.fn(),
		theme: plainTheme,
	});
	
	expect(component.render(160)[0]).toContain("READY");
	current = { ...state, activity: "working", workingLabel: "PHOTOSYNTHESIZING" };
	expect(component.render(160)[0]).toContain("PHOTOSYNTHESIZING");
	expect(component.render(160)[0]).toContain("PHOTOSYNTHESIZING");
	expect(component.render(160)[0]).not.toContain("WORKING");
});

it.each([
	["ready", "READY"],
	["warning", "WARNING"],
	["error", "ERROR"],
	["working", "WORKING"],
] as const)("renders %s with the expected fallback label", (activity, expected) => {
	const line = renderFooterLine({ ...state, activity }, DEFAULT_CONFIG, plainTheme, 160);
	expect(line).toContain(expected);
});

it("keeps the longest working phrase within responsive width limits", () => {
	const working = { ...state, activity: "working" as const, workingLabel: "PHOTOSYNTHESIZING" };
	for (const width of [132, 131, 96, 95, 72, 71, 56, 55, 20]) {
		expect(visibleWidth(renderFooterLine(working, DEFAULT_CONFIG, plainTheme, width))).toBeLessThanOrEqual(
			width,
		);
	}
});
```

- [ ] **Step 2: Run the footer test and verify the red state**

Run:

```bash
npm test -- tests/footer.test.ts
```

Expected: FAIL because working activity still renders the fixed `WORKING` label.

- [ ] **Step 3: Make footer activity rendering read the stored label**

Replace `activity` in `src/footer.ts` with:

```ts
function activity(state: AtelierState, full: boolean, palette: AtelierPalette): string {
	const labels = {
		ready: "READY",
		working: state.workingLabel ?? "WORKING",
		warning: "WARNING",
		error: "ERROR",
	} as const;
	const roles = { ready: "ready", working: "working", warning: "warning", error: "error" } as const;
	return palette.paint(roles[state.activity], full ? `● ${labels[state.activity]}` : "●");
}
```

- [ ] **Step 4: Run focused footer verification**

Run:

```bash
npm test -- tests/footer.test.ts tests/state.test.ts tests/activity.test.ts
npm run typecheck
npm run lint
```

Expected: all focused tests PASS; TypeScript and Biome report no errors.

- [ ] **Step 5: Commit deterministic rendering**

```bash
git add src/footer.ts tests/footer.test.ts
git commit -m "feat(footer): show randomized working phrases"
```

---

### Task 4: Update user-facing documentation and verify the package

**Files:**
- Modify: `README.md:9-31`
- Modify: `README.md:69-84`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the completed runtime and footer behavior from Tasks 1–3.
- Produces: accurate user-facing behavior documentation and a release-verification result.

- [ ] **Step 1: Update the README preview and palette wording**

Change the preview status example from:

```text
◆ ATELIER  ● READY  gpt-5.6-sol · low  main ✦
```

To a representative working-state example:

```text
◆ ATELIER  ● PONDERING  gpt-5.6-sol · low  main ✦
```

Preserve the telemetry that follows on the existing preview line. Change the palette bullet from:

```markdown
- **Purple `#B18CFF`:** Atelier, Working, output tokens
```

To:

```markdown
- **Purple `#B18CFF`:** Atelier, randomized working phrases, output tokens
```

After the Footer anatomy code block, add:

```markdown
`READY` remains fixed when idle. During each work cycle, the working label is selected once from a playful built-in phrase set—such as `KNEADING`, `MOONWALKING`, or `PONDERING`—and remains stable until the cycle ends.
```

- [ ] **Step 2: Add a changelog entry**

Under the existing `## 0.1.0` heading in `CHANGELOG.md`, add:

```markdown
- Replace the fixed `WORKING` footer label with one stable, randomly selected activity phrase per work cycle.
```

- [ ] **Step 3: Run the full release check**

Run:

```bash
npm run check
```

Expected: typecheck, lint, format check, all Vitest suites, and package verification PASS.

If only formatting fails, run:

```bash
npm run format
npm run check
```

Expected: the second full check PASS. If any non-formatting check fails, fix the specific implementation or test rather than weakening assertions.

- [ ] **Step 4: Inspect final changes and package contents**

Run:

```bash
git diff --check
git status --short
npm pack --dry-run
```

Expected: no whitespace errors; only intended source, test, README, and changelog files are modified; dry-run package contents include `src/activity.ts` and exclude tests and design documents.

- [ ] **Step 5: Commit documentation and formatting changes**

```bash
git add README.md CHANGELOG.md src tests
git commit -m "docs: describe randomized working phrases"
```

- [ ] **Step 6: Confirm the repository is clean and tests remain green**

Run:

```bash
git status --short
npm run check
```

Expected: `git status --short` prints nothing and the complete check passes.

# Pi Atelier Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live, read-only Pi Atelier information sidebar opened by `/atelier sidebar`, with a right-side wide-terminal layout and centered narrow-terminal fallback.

**Architecture:** A new `src/sidebar.ts` module owns snapshot construction, width-safe rendering, keyboard behavior, and overlay opening. `AtelierRuntime` becomes the authoritative source for both Git branch and dirty state, while `extensions/index.ts` routes the command and fans lifecycle invalidation out to the footer and any open sidebar.

**Tech Stack:** TypeScript 5.9, Pi extension API 0.80.7, `@earendil-works/pi-tui` 0.80.7, Vitest 4.1, Biome 2.5.

## Global Constraints

- Work on a separate Git branch and isolated worktree created at execution time.
- Preserve `/atelier`, `/atelier enable`, and `/atelier disable` behavior.
- Add `/atelier sidebar` as the only new command action.
- Keep the panel read-only and TUI-only.
- Use no network requests, telemetry, file writes, runtime dependencies, or persistent sidebar state.
- Reuse Pi Atelier's fixed Midnight Spectrum and its `NO_COLOR` fallback.
- Every rendered line must fit the width supplied by the TUI.
- `Escape`, `q`, and `Ctrl+C` close the sidebar.
- Wide terminals use a right-side overlay; narrow terminals use a centered near-full-width overlay.
- Pi `0.80.7` and Node.js `22.19.0` remain the minimum supported versions.

---

## File Structure

- Create `src/sidebar.ts` — sidebar snapshot types, data gathering, rendering, component lifecycle, and overlay configuration.
- Create `tests/sidebar.test.ts` — snapshot, rendering, color, truncation, keyboard, and responsive overlay tests.
- Modify `src/state.ts` — collect Git branch and dirty state together so sidebar data remains available even when the footer is disabled.
- Modify `tests/state.test.ts` — verify Git status parsing and safe fallback.
- Modify `extensions/index.ts` — route `/atelier sidebar`, capture footer-only extension statuses, and maintain sidebar invalidation lifecycle.
- Modify `tests/extension.test.ts` — verify command routing, non-TUI warning, invalidation, and shutdown cleanup.
- Modify `README.md` — document the sidebar command and displayed fields.
- Modify `CHANGELOG.md` — record the new sidebar under Unreleased.

---

### Task 1: Make runtime Git state complete

**Files:**
- Modify: `src/state.ts`
- Modify: `tests/state.test.ts`

**Interfaces:**
- Consumes: `AtelierRuntime.getState(): AtelierState` and `AtelierState.branch?: string`.
- Produces: `AtelierRuntime.refreshGitState(): Promise<void>`; retains `refreshGitDirty(): Promise<void>` as a compatibility alias during this change so existing callers do not break mid-task.

- [ ] **Step 1: Replace the dirty-only test with failing branch-and-dirty tests**

Add these cases to `tests/state.test.ts`:

```ts
it("derives branch and dirty state from one porcelain query", async () => {
	const { runtime, exec } = createRuntime({
		stdout: "## feature/sidebar\n M src/a.ts\n",
		stderr: "",
		code: 0,
		killed: false,
	});

	await runtime.refreshGitState();

	expect(exec).toHaveBeenCalledWith(
		"git",
		["status", "--short", "--branch", "--untracked-files=no"],
		{ timeout: 2_000 },
	);
	expect(runtime.getState()).toMatchObject({ branch: "feature/sidebar", dirty: true });
});

it("handles detached HEAD and a clean tree", async () => {
	const { runtime } = createRuntime({
		stdout: "## HEAD (no branch)\n",
		stderr: "",
		code: 0,
		killed: false,
	});

	await runtime.refreshGitState();

	expect(runtime.getState()).toMatchObject({ branch: "detached", dirty: false });
});

it("clears Git metadata when the directory is not a repository", async () => {
	const { runtime, exec } = createRuntime();
	exec.mockRejectedValue(new Error("not a repository"));

	await expect(runtime.refreshGitState()).resolves.toBeUndefined();

	expect(runtime.getState().branch).toBeUndefined();
	expect(runtime.getState().dirty).toBe(false);
});
```

Remove or update the old test that expects `git status --porcelain`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- tests/state.test.ts
```

Expected: FAIL because `refreshGitState` does not exist and branch is not populated.

- [ ] **Step 3: Implement branch-safe Git parsing**

In `src/state.ts`, add a parser and replace the dirty-only query:

```ts
export function parseGitStatus(output: string): { branch?: string; dirty: boolean } {
	const lines = output.split(/\r?\n/).filter(Boolean);
	const header = lines[0]?.startsWith("## ") ? lines[0].slice(3).trim() : "";
	const rawBranch = header.split("...")[0]?.trim() ?? "";
	const branch = rawBranch === "HEAD (no branch)" ? "detached" : rawBranch;
	return {
		...(branch ? { branch } : {}),
		dirty: lines.some((line) => !line.startsWith("## ")),
	};
}
```

Replace `refreshGitDirty` with:

```ts
async refreshGitState(): Promise<void> {
	if (this.#disposed) return;
	let next: { branch?: string; dirty: boolean } = { dirty: false };
	try {
		const result = await this.#pi.exec(
			"git",
			["status", "--short", "--branch", "--untracked-files=no"],
			{ timeout: 2_000 },
		);
		if (result.code === 0) next = parseGitStatus(result.stdout);
	} catch {
		next = { dirty: false };
	}
	const sameBranch = this.#state.branch === next.branch;
	if (sameBranch && this.#state.dirty === next.dirty) return;
	const { branch: _branch, ...withoutBranch } = this.#state;
	this.#state = { ...withoutBranch, ...next };
	this.#invalidate();
}

async refreshGitDirty(): Promise<void> {
	await this.refreshGitState();
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npm test -- tests/state.test.ts
```

Expected: all `tests/state.test.ts` tests pass.

- [ ] **Step 5: Commit the runtime seam**

```bash
git add src/state.ts tests/state.test.ts
git commit -m "feat(state): expose complete Git status"
```

---

### Task 2: Build and render the sidebar component

**Files:**
- Create: `src/sidebar.ts`
- Create: `tests/sidebar.test.ts`

**Interfaces:**
- Consumes: `AtelierState`, `AtelierConfig`, `ExtensionAPI`, `ExtensionContext`, `ThemeLike`, `createPalette`, `formatTokens`.
- Produces:
  - `SidebarSnapshot`
  - `buildSidebarSnapshot(input: SidebarSnapshotInput): SidebarSnapshot`
  - `renderSidebarLines(snapshot: SidebarSnapshot, config: AtelierConfig, theme: ThemeLike, width: number, colorEnabled?: boolean): string[]`
  - `selectSidebarOverlay(termWidth: number): OverlayOptions`
  - `createSidebarComponent(options: SidebarComponentOptions): Component`
  - `openAtelierSidebar(options: OpenSidebarOptions): Promise<void>`

- [ ] **Step 1: Write failing snapshot and width tests**

Create `tests/sidebar.test.ts` with a complete state fixture and these core assertions:

```ts
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	buildSidebarSnapshot,
	createSidebarComponent,
	renderSidebarLines,
	selectSidebarOverlay,
} from "../src/sidebar.js";
import { DEFAULT_CONFIG, type AtelierState } from "../src/types.js";

const theme = {
	name: "dark",
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
};

const state: AtelierState = {
	activity: "working",
	workingLabel: "GITIFYING",
	modelId: "gpt-5.6-sol",
	provider: "openai-codex",
	thinkingLevel: "medium",
	branch: "feature/sidebar",
	dirty: true,
	metrics: {
		usageAvailable: true,
		costAvailable: true,
		input: 50_000,
		output: 1_900,
		cacheRead: 100_000,
		cacheWrite: 0,
		cacheHitPercent: 96,
		cost: 0.479,
		subscription: true,
		contextTokens: 32_400,
		contextWindow: 400_000,
		contextPercent: 8.1,
		autoCompact: true,
	},
	extensionStatuses: [],
};

function snapshot() {
	return buildSidebarSnapshot({
		state,
		cwd: "/Users/example/projects/pi-atelier",
		sessionName: "Sidebar implementation",
		sessionFile: "/tmp/session.jsonl",
		branchEntryCount: 38,
		activeToolCount: 8,
		availableToolCount: 12,
		extensionStatuses: ["tests passing"],
	});
}

it("builds the approved core overview", () => {
	expect(snapshot()).toMatchObject({
		projectName: "pi-atelier",
		branch: "feature/sidebar",
		dirty: true,
		sessionName: "Sidebar implementation",
		persisted: true,
		branchEntryCount: 38,
		activeToolCount: 8,
		availableToolCount: 12,
	});
});

it("renders organized sections without exceeding width", () => {
	for (const width of [32, 40, 44]) {
		const lines = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, width, false);
		expect(lines.join("\n")).toContain("PI ATELIER");
		expect(lines.join("\n")).toContain("PROJECT");
		expect(lines.join("\n")).toContain("CONTEXT");
		expect(lines.join("\n")).toContain("TOOLS & STATUS");
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	}
});

it("uses a right panel on wide terminals and centered fallback when narrow", () => {
	expect(selectSidebarOverlay(120)).toMatchObject({ anchor: "right-center", width: 44 });
	expect(selectSidebarOverlay(70)).toMatchObject({ anchor: "center", width: "92%" });
});
```

Add focused tests for missing metadata, long values, context threshold roles, and a closable component.

- [ ] **Step 2: Run the sidebar tests and verify RED**

Run:

```bash
npm test -- tests/sidebar.test.ts
```

Expected: FAIL because `src/sidebar.ts` does not exist.

- [ ] **Step 3: Implement snapshot construction and responsive options**

Create `src/sidebar.ts` with these data contracts:

```ts
export interface SidebarSnapshotInput {
	state: AtelierState;
	cwd: string;
	sessionName?: string;
	sessionFile?: string;
	branchEntryCount: number;
	activeToolCount: number;
	availableToolCount: number;
	extensionStatuses: readonly string[];
}

export interface SidebarSnapshot extends AtelierState {
	projectName: string;
	cwd: string;
	sessionName?: string;
	sessionFile?: string;
	persisted: boolean;
	branchEntryCount: number;
	activeToolCount: number;
	availableToolCount: number;
}

export function buildSidebarSnapshot(input: SidebarSnapshotInput): SidebarSnapshot {
	const projectName = basename(input.cwd) || input.cwd;
	return {
		...input.state,
		projectName,
		cwd: input.cwd,
		...(input.sessionName ? { sessionName: input.sessionName } : {}),
		...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
		persisted: Boolean(input.sessionFile),
		branchEntryCount: input.branchEntryCount,
		activeToolCount: input.activeToolCount,
		availableToolCount: input.availableToolCount,
		extensionStatuses: input.extensionStatuses,
	};
}

export function selectSidebarOverlay(termWidth: number): OverlayOptions {
	return termWidth >= 88
		? { anchor: "right-center", width: 44, maxHeight: "92%", margin: 1 }
		: { anchor: "center", width: "92%", minWidth: 30, maxHeight: "92%", margin: 1 };
}
```

Use `basename` from `node:path` and export the function for deterministic tests.

- [ ] **Step 4: Implement width-safe rendering**

Implement local helpers that sanitize control characters, shorten home paths, frame every row, create section headings, and render a 20-cell context bar. All final lines must pass through `truncateToWidth(line, width, "")`; all frame padding must use `visibleWidth` rather than string length.

The public renderer must have this exact shape:

```ts
export function renderSidebarLines(
	snapshot: SidebarSnapshot,
	config: AtelierConfig,
	theme: ThemeLike,
	width: number,
	colorEnabled = true,
): string[] {
	if (width <= 0) return [];
	const palette = createPalette(theme, colorEnabled);
	const innerWidth = Math.max(1, width - 2);
	const rows = [
		titleRow("PI ATELIER", innerWidth, palette, theme),
		sectionRow("PROJECT", innerWidth, palette),
		valueRow(snapshot.projectName, innerWidth, palette, "primary"),
		valueRow(shortPath(snapshot.cwd), innerWidth, palette, "muted"),
		gitRow(snapshot, innerWidth, palette),
		sectionRow("AGENT", innerWidth, palette),
		agentRows(snapshot, innerWidth, palette, theme),
		sectionRow("CONTEXT", innerWidth, palette),
		contextRows(snapshot, config, innerWidth, palette),
		sectionRow("SESSION", innerWidth, palette),
		sessionRows(snapshot, innerWidth, palette),
		sectionRow("USAGE", innerWidth, palette),
		usageRows(snapshot, config, innerWidth, palette),
		sectionRow("TOOLS & STATUS", innerWidth, palette),
		statusRows(snapshot, innerWidth, palette),
		helpRow("esc/q close", innerWidth, palette),
	].flat();
	return frameRows(rows, width, palette);
}
```

Define every helper referenced above in the same module. Omit blank optional status rows rather than rendering empty bullets. Use `formatTokens` for token values and the configured currency decimals for cost.

- [ ] **Step 5: Implement close keys and overlay opening**

Add:

```ts
export interface SidebarComponentOptions {
	getSnapshot(): SidebarSnapshot;
	getConfig(): AtelierConfig;
	theme: ThemeLike;
	colorEnabled?: boolean;
	onClose(): void;
}

export function createSidebarComponent(options: SidebarComponentOptions): Component {
	return {
		render: (width) =>
			renderSidebarLines(
				options.getSnapshot(),
				options.getConfig(),
				options.theme,
				width,
				options.colorEnabled ?? true,
			),
		handleInput(data) {
			if (
				matchesKey(data, Key.escape) ||
				matchesKey(data, "q") ||
				matchesKey(data, Key.ctrl("c"))
			) options.onClose();
		},
		invalidate() {},
	};
}
```

Define `OpenSidebarOptions` with `ctx`, `getSnapshot`, `getConfig`, `onRequestRender`, and `onClosed`. Open `ctx.ui.custom` with `{ overlay: true, overlayOptions: () => selectSidebarOverlay(tui.terminal.width) }`; wire `done(undefined)` to the component close callback, expose `tui.requestRender` while open, and clear it in `finally`.

- [ ] **Step 6: Expand keyboard and missing-data tests, then verify GREEN**

Use a `vi.fn()` close callback and call `handleInput` with `"q"`, `"\u001b"`, and `"\u0003"`. Add a snapshot with undefined model, branch, context, and session file; assert rendering contains `—`, `ephemeral`, and no line exceeds width.

Run:

```bash
npm test -- tests/sidebar.test.ts
```

Expected: all sidebar tests pass.

- [ ] **Step 7: Commit the isolated sidebar module**

```bash
git add src/sidebar.ts tests/sidebar.test.ts
git commit -m "feat(sidebar): add live overview panel"
```

---

### Task 3: Integrate command routing and live invalidation

**Files:**
- Modify: `extensions/index.ts`
- Modify: `tests/extension.test.ts`

**Interfaces:**
- Consumes: `openAtelierSidebar`, `buildSidebarSnapshot`, `AtelierRuntime.refreshGitState`.
- Produces: `/atelier sidebar` routing and one active sidebar render callback that lifecycle events can invalidate.

- [ ] **Step 1: Extend the extension harness with failing sidebar-routing tests**

Update `tests/extension.test.ts` so `ctx` includes:

```ts
sessionManager: {
	getEntries: vi.fn().mockReturnValue([]),
	getBranch: vi.fn().mockReturnValue([]),
	getSessionName: vi.fn().mockReturnValue("Test session"),
	getSessionFile: vi.fn().mockReturnValue("/tmp/session.jsonl"),
},
ui: {
	setFooter,
	notify: vi.fn(),
	theme: {},
	custom: vi.fn().mockImplementation(async (factory) => {
		factory(
			{ terminal: { width: 120 }, requestRender: vi.fn() },
			{ fg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text },
			{},
			() => undefined,
		);
	}),
},
```

Add tests:

```ts
it("opens the sidebar through /atelier sidebar", async () => {
	const h = harness();
	await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
	await h.commands.get("atelier").handler("sidebar", h.ctx);
	expect(h.ctx.ui.custom).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ overlay: true }));
});

it("warns instead of opening the sidebar outside TUI mode", async () => {
	const h = harness("print");
	await h.commands.get("atelier").handler("sidebar", h.ctx);
	expect(h.ctx.ui.custom).not.toHaveBeenCalled();
	expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("TUI mode"), "warning");
});

it("preserves menu routing for bare /atelier", async () => {
	const h = harness();
	await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
	await h.commands.get("atelier").handler("", h.ctx);
	expect(h.ctx.ui.custom).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run extension tests and verify RED**

Run:

```bash
npm test -- tests/extension.test.ts
```

Expected: sidebar-routing test fails because the action currently opens the menu.

- [ ] **Step 3: Add sidebar lifecycle state and snapshot assembly**

In `extensions/index.ts`, import the sidebar functions and add closure state:

```ts
let sidebarRequestRender: () => void = () => undefined;
let sidebarOpen = false;
let extensionStatuses: readonly string[] = [];

const requestAllRenders = (): void => {
	requestRender();
	sidebarRequestRender();
};
```

Pass `requestAllRenders` into `AtelierRuntime` instead of the footer-only callback. While the footer factory is active, update the closure from `footerData.getExtensionStatuses()` before returning state. Keep this footer-only collection out of `AtelierRuntime`.

Add a snapshot builder closure that reads current values at render time:

```ts
function getSidebarSnapshot(ctx: ExtensionContext): SidebarSnapshot {
	if (!runtime) throw new Error("Pi Atelier runtime unavailable");
	return buildSidebarSnapshot({
		state: runtime.getState(),
		cwd: ctx.cwd,
		sessionName: ctx.sessionManager.getSessionName(),
		sessionFile: ctx.sessionManager.getSessionFile(),
		branchEntryCount: ctx.sessionManager.getBranch().length,
		activeToolCount: pi.getActiveTools().length,
		availableToolCount: pi.getAllTools().length,
		extensionStatuses,
	});
}
```

- [ ] **Step 4: Route `/atelier sidebar` and prevent duplicates**

Before the enable/disable branches in the command handler, add:

```ts
if (action === "sidebar") {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Pi Atelier sidebar requires TUI mode", "warning");
		return;
	}
	if (!runtime) {
		ctx.ui.notify("Pi Atelier is not active in this session", "warning");
		return;
	}
	if (sidebarOpen) {
		ctx.ui.notify("Pi Atelier sidebar is already open", "info");
		return;
	}
	sidebarOpen = true;
	try {
		await openAtelierSidebar({
			ctx,
			getSnapshot: () => getSidebarSnapshot(ctx),
			getConfig: () => runtime?.getConfig() ?? DEFAULT_CONFIG,
			onRequestRender: (request) => {
				sidebarRequestRender = request;
			},
			onClosed: () => {
				sidebarRequestRender = () => undefined;
			},
		});
	} finally {
		sidebarOpen = false;
		sidebarRequestRender = () => undefined;
	}
	return;
}
```

Import `DEFAULT_CONFIG` only if the callback requires a post-shutdown fallback; otherwise throw consistently and remove the fallback.

- [ ] **Step 5: Update Git calls and shutdown cleanup**

Replace internal calls to `refreshGitDirty()` with `refreshGitState()`. On shutdown, reset `sidebarOpen`, `sidebarRequestRender`, and `extensionStatuses` alongside existing footer cleanup.

Add or update a test that invokes `turn_end` and confirms the open sidebar's captured `requestRender` callback runs. Add a shutdown assertion that subsequent lifecycle events do not call the stale callback.

- [ ] **Step 6: Run extension and state tests**

Run:

```bash
npm test -- tests/extension.test.ts tests/state.test.ts tests/sidebar.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 7: Commit integration**

```bash
git add extensions/index.ts tests/extension.test.ts
git commit -m "feat(extension): route Atelier sidebar command"
```

---

### Task 4: Document and verify the feature

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: implemented `/atelier sidebar` behavior.
- Produces: user-facing command and feature documentation.

- [ ] **Step 1: Add README command and feature copy**

Under `## Menu`, add:

````md
## Sidebar

Open the live session overview with:

```text
/atelier sidebar
```

Wide terminals display a right-side panel; narrow terminals use a centered responsive view. The read-only sidebar shows project and Git state, model and thinking level, context utilization, session identity, cumulative usage and cost, active tools, and extension statuses. Press `Esc`, `q`, or `Ctrl+C` to close it.
````

Add “Live session-information sidebar with a narrow-terminal fallback” to the Features list.

- [ ] **Step 2: Update the changelog**

Under `## Unreleased`, add:

```md
- Add a live `/atelier sidebar` overview for project, agent, context, session, usage, tools, and extension status information.
```

- [ ] **Step 3: Run formatting before full verification**

Run:

```bash
npm run format
```

Expected: Biome formats modified TypeScript and documentation-compatible files without errors.

- [ ] **Step 4: Run the full repository verification**

Run:

```bash
npm run check
npm pack --dry-run
```

Expected:

- TypeScript compilation passes.
- Biome lint and format checks pass.
- All Vitest tests pass.
- Package-content verification passes and includes `src/sidebar.ts`.
- Dry-run tarball generation succeeds.

- [ ] **Step 5: Inspect the final branch diff**

Run:

```bash
git status --short
git diff --check
git diff --stat main...HEAD
```

Expected: only intended sidebar source, tests, and docs are changed; `git diff --check` prints nothing.

- [ ] **Step 6: Commit documentation and verification changes**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: describe Atelier sidebar"
```

- [ ] **Step 7: Re-run final verification after the last commit**

Run:

```bash
npm run check
git status --short
```

Expected: all checks pass and the feature worktree is clean.

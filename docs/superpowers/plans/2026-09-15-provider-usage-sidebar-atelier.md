# Provider Usage Sidebar — Pi Atelier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Pi Atelier's sidebar panel protocol with capability-negotiated contribution defaults, so supporting extensions can request default visibility and placement after the built-in Usage panel.

**Architecture:** The existing `pi-atelier:sidebar-panels` event seam stays version 1 and additive. Discovery events gain a `capabilities` list; register events gain an optional `defaults` object (`visible`, `after`). A new pure function computes the effective render layout by inserting default-visible, unconfigured contributions after their requested anchor. Explicit saved configuration always wins.

**Tech Stack:** TypeScript (tabs, strict), Vitest, Biome, Node ≥ 22.19, Pi `@earendil-works/pi-coding-agent` ≥ 0.84.

**Spec:** `docs/superpowers/specs/2026-09-15-provider-usage-sidebar-design.md` (same branch). PRD: michaelmjhhhh/pi-atelier#47.

## Global Constraints

- Event channel stays `pi-atelier:sidebar-panels`; protocol version stays `1`.
- New capability constant: `SIDEBAR_PANEL_DEFAULTS_CAPABILITY = "panel-defaults-v1"`, exported from `src/sidebar-panels.ts` and re-exported by `src/sidebar.ts`.
- `defaults.after` accepts built-in panel IDs only (`BuiltinSidebarPanelId`), making contributor ordering cycles impossible.
- Invalid `defaults` metadata is dropped, never the panel; panels without defaults remain hidden until enabled (current behavior).
- Default insertion affects the effective runtime layout only; it never rewrites saved configuration.
- No vendor-specific logic, IDs, or provider names anywhere in this repo.
- Conventional commits; stage explicit paths; run `npx vitest run <file>` per task and `npm run check` at the end.

---

### Task 1: Protocol capability and contribution defaults

**Files:**
- Modify: `src/sidebar-panels.ts` (capability constant after line 12; `SidebarPanelDefaults` after the `SidebarPanelRole` union near line 88; `defaults` on `SidebarPanelContribution` near line 100 and on `SanitizedSidebarPanelContribution` near line 106; `sanitizeSidebarPanelDefaults` before `sanitizeContribution` near line 300; equality near line 388; discovery emission near line 508)
- Modify: `src/sidebar.ts:48-70` (named re-export block from `./sidebar-panels.js`)
- Test: `tests/sidebar.test.ts`

**Interfaces:**
- Produces: `SIDEBAR_PANEL_DEFAULTS_CAPABILITY: "panel-defaults-v1"`; `interface SidebarPanelDefaults { visible: boolean; after?: (typeof BUILTIN_SIDEBAR_PANEL_IDS)[number] }`; `SidebarPanelContribution.defaults?: SidebarPanelDefaults`; `SidebarPanelData.defaults?: SidebarPanelDefaults` (inherited via `Omit<SidebarPanelContribution, "rows">`); discovery events now carry `capabilities: readonly string[]`.

- [ ] **Step 1: Set up the workspace and branch**

```bash
cd /home/caan9/Projects/pi-atelier
git switch design/provider-usage-sidebar
git switch -c feat/panel-defaults
npm install
```

- [ ] **Step 2: Write the failing tests**

Add `SIDEBAR_PANEL_DEFAULTS_CAPABILITY` to the existing import block from `"../src/sidebar.js"` in `tests/sidebar.test.ts`, then add this describe near the existing registry tests:

```ts
describe("sidebar panel defaults capability", () => {
	it("advertises the defaults capability in discovery requests", () => {
		const emitted: unknown[] = [];
		const events = {
			on: () => () => undefined,
			emit: (_channel: string, data: unknown) => emitted.push(data),
		};
		const registry = createSidebarPanelRegistry({ events });
		const discovery = emitted.at(-1) as { type?: string; capabilities?: string[] };
		expect(discovery.type).toBe("discover");
		expect(discovery.capabilities).toContain(SIDEBAR_PANEL_DEFAULTS_CAPABILITY);
		registry.dispose();
	});

	it("sanitizes valid defaults and drops invalid metadata without rejecting the panel", () => {
		const events = { on: () => () => undefined, emit: () => undefined };
		const registry = createSidebarPanelRegistry({ events });
		expect(
			registry.register({
				id: "vendor:queued",
				title: "Queued",
				rows: [],
				defaults: { visible: true, after: "usage" },
			}),
		).toBe(true);
		expect(registry.get("vendor:queued")?.defaults).toEqual({ visible: true, after: "usage" });
		expect(
			registry.register({
				id: "vendor:bad-anchor",
				title: "Bad",
				rows: [],
				defaults: { visible: true, after: "vendor:queued" as "usage" },
			}),
		).toBe(true);
		expect(registry.get("vendor:bad-anchor")?.defaults).toBeUndefined();
		expect(
			registry.register({ id: "vendor:bad-visible", title: "Bad", rows: [], defaults: { visible: "yes" as boolean } }),
		).toBe(true);
		expect(registry.get("vendor:bad-visible")?.defaults).toBeUndefined();
		registry.dispose();
	});

	it("detects changed defaults between updates", () => {
		const listeners = new Set<(data: unknown) => void>();
		const events = {
			on: (_channel: string, handler: (data: unknown) => void) => {
				listeners.add(handler);
				return () => listeners.delete(handler);
			},
			emit: (_channel: string, data: unknown) => {
				for (const listener of [...listeners]) listener(data);
			},
		};
		const publisher = registerSidebarPanel(
			{ events },
			{ id: "vendor:queue", title: "Queue", rows: ["one"], defaults: { visible: true, after: "usage" } },
		);
		const changed = vi.fn();
		const registry = createSidebarPanelRegistry({ events, onChange: changed });
		expect(registry.get("vendor:queue")?.defaults).toEqual({ visible: true, after: "usage" });
		publisher.update({ id: "vendor:queue", title: "Queue", rows: ["one"], defaults: { visible: false } });
		expect(registry.get("vendor:queue")?.defaults).toEqual({ visible: false });
		publisher.dispose();
		registry.dispose();
	});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/sidebar.test.ts`
Expected: FAIL — `SIDEBAR_PANEL_DEFAULTS_CAPABILITY` is not exported from `../src/sidebar.js` (module resolution error).

- [ ] **Step 4: Implement the protocol extension**

In `src/sidebar-panels.ts`:

After `export const SIDEBAR_PANEL_PROTOCOL_VERSION = 1 as const;` add:

```ts
/**
 * Capability a sidebar host advertises in discovery events when it honors
 * contribution `defaults`. Contributors must not suppress their fallback UI
 * or send `defaults` metadata before observing it.
 */
export const SIDEBAR_PANEL_DEFAULTS_CAPABILITY = "panel-defaults-v1" as const;
```

After the `SidebarPanelRole` union, add:

```ts
/** Default placement a contributor may request for a panel absent from saved configuration. */
export interface SidebarPanelDefaults {
	visible: boolean;
	/** Built-in panel to position after. Restricting to built-ins makes contributor ordering cycles impossible. */
	after?: (typeof BUILTIN_SIDEBAR_PANEL_IDS)[number];
}
```

In `SidebarPanelContribution`, after the `role?: SidebarPanelRole;` line, add:

```ts
	/** Optional default placement request; honored only by hosts advertising SIDEBAR_PANEL_DEFAULTS_CAPABILITY. */
	defaults?: SidebarPanelDefaults;
```

In `SanitizedSidebarPanelContribution`, after `role?: SidebarPanelRole;`, add:

```ts
	defaults?: SidebarPanelDefaults;
```

Before `sanitizeContribution`, add:

```ts
/** Validate optional default placement. Invalid metadata is dropped, never the panel. */
function sanitizeSidebarPanelDefaults(value: unknown): SidebarPanelDefaults | undefined {
	if (!isRecord(value) || typeof value.visible !== "boolean") return undefined;
	if (value.after !== undefined && !BUILTIN_IDS.has(value.after)) return undefined;
	return {
		visible: value.visible,
		...(value.after !== undefined ? { after: value.after as (typeof BUILTIN_SIDEBAR_PANEL_IDS)[number] } : {}),
	};
}
```

In `sanitizeContribution`, capture and include the sanitized defaults — replace the final `return { ... }` with:

```ts
	const defaults = sanitizeSidebarPanelDefaults(value.defaults);
	return {
		id: value.id,
		title: sanitizeSidebarPanelText(value.title, SIDEBAR_PANEL_MAX_TITLE_CHARS),
		rows,
		...(isSidebarPanelRole(value.role) ? { role: value.role } : {}),
		...(defaults ? { defaults } : {}),
	};
```

Above `sidebarPanelDataEqual`, add:

```ts
function sidebarPanelDefaultsEqual(
	first: SidebarPanelDefaults | undefined,
	second: SidebarPanelDefaults | undefined,
): boolean {
	if (first === second) return true;
	if (first === undefined || second === undefined) return false;
	return first.visible === second.visible && first.after === second.after;
}
```

In `sidebarPanelDataEqual`, after the `first.role === second.role &&` line, add:

```ts
		sidebarPanelDefaultsEqual(first.defaults, second.defaults) &&
```

In `createSidebarPanelRegistry`'s `requestDiscovery`, add the capability list to the emitted event:

```ts
		options.events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
			version: SIDEBAR_PANEL_PROTOCOL_VERSION,
			type: "discover",
			requestId,
			capabilities: [SIDEBAR_PANEL_DEFAULTS_CAPABILITY],
		});
```

In `src/sidebar.ts`, add `SIDEBAR_PANEL_DEFAULTS_CAPABILITY` to the named export block re-exporting from `"./sidebar-panels.js"` (lines 48–70).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/sidebar.test.ts`
Expected: PASS (all tests in the file, including the pre-existing protocol suites).

- [ ] **Step 6: Commit**

```bash
git add src/sidebar-panels.ts src/sidebar.ts tests/sidebar.test.ts
git commit -m "feat(panels): negotiate contribution default placement"
```

### Task 2: Effective layout default insertion

**Files:**
- Modify: `src/sidebar-panels.ts` (new `applyContributionDefaults` after `normalizeSidebarPanelLayout`, ~line 258)
- Modify: `src/sidebar.ts:48-70` (re-export) and `src/sidebar.ts:1017-1023` (render composition)
- Test: `tests/sidebar.test.ts`

**Interfaces:**
- Consumes: `SidebarPanelData.defaults` from Task 1.
- Produces: `applyContributionDefaults(layout: readonly SidebarPanelLayoutEntry[], panels: readonly SidebarPanelData[]): SidebarPanelLayout`.

- [ ] **Step 1: Write the failing tests**

Add `applyContributionDefaults` to the test import block, then add:

```ts
describe("applyContributionDefaults", () => {
	const panel = (
		id: string,
		defaults?: { visible: boolean; after?: "agent" | "usage" },
	): Parameters<typeof applyContributionDefaults>[1][number] => ({
		id: id as `${string}:${string}`,
		title: id,
		rows: [],
		available: true as const,
		source: id.slice(0, id.indexOf(":")),
		...(defaults ? { defaults } : {}),
	});

	it("inserts default-visible panels after the requested anchor, ordered by id", () => {
		const layout = applyContributionDefaults(
			[
				{ id: "agent", visible: true },
			{ id: "usage", visible: true },
			],
			[
				panel("vendor:beta", { visible: true, after: "usage" }),
				panel("vendor:alpha", { visible: true, after: "usage" }),
			],
		);
		expect(layout.map((entry) => entry.id)).toEqual(["agent", "usage", "vendor:alpha", "vendor:beta"]);
	});

	it("never inserts configured panels or panels without visible defaults", () => {
		const layout = applyContributionDefaults([{ id: "vendor:hidden", visible: false }], [
			panel("vendor:hidden", { visible: true, after: "usage" }),
			panel("vendor:plain", { visible: false }),
		]);
		expect(layout.map((entry) => entry.id)).toEqual(["vendor:hidden"]);
	});

	it("appends defaulted panels at the end when the anchor is missing", () => {
		const layout = applyContributionDefaults([{ id: "agent", visible: true }], [
			panel("vendor:queued", { visible: true, after: "usage" }),
		]);
		expect(layout.map((entry) => entry.id)).toEqual(["agent", "vendor:queued"]);
	});

	it("does not mutate the configured layout", () => {
		const configured = [{ id: "agent", visible: true }];
		applyContributionDefaults(configured, [panel("vendor:queued", { visible: true, after: "agent" })]);
		expect(configured).toEqual([{ id: "agent", visible: true }]);
	});
});

it("renders a default-visible contributed panel after the built-in usage panel", () => {
	const contributed = {
		id: "ollama-cloud:usage",
		title: "Ollama Cloud",
		rows: [{ text: "5h ▕████░░░░░░▏ 40%", role: "warning" }],
		available: true as const,
		source: "ollama-cloud",
		defaults: { visible: true, after: "usage" as const },
	};
	const lines = renderSidebarLines(
		{ ...snapshot(), sidebarPanels: [contributed] },
		{ ...DEFAULT_CONFIG },
		theme,
		60,
		64,
	);
	const rows = contentRows(lines);
	const usage = rows.findIndex((row) => row === "USAGE");
	const cloud = rows.findIndex((row) => row.includes("OLLAMA CLOUD"));
	expect(usage).toBeGreaterThanOrEqual(0);
	expect(cloud).toBeGreaterThan(usage);
	expect(rows[cloud + 1]).toContain("5h");
});

it("keeps an explicit hidden configuration entry authoritative over contribution defaults", () => {
	const config = {
		...DEFAULT_CONFIG,
		sidebarPanelLayout: [...DEFAULT_CONFIG.sidebarPanelLayout, { id: "ollama-cloud:usage" as const, visible: false }],
	};
	const lines = renderSidebarLines(
		{
			...snapshot(),
			sidebarPanels: [
				{
					id: "ollama-cloud:usage",
					title: "Ollama Cloud",
					rows: [{ text: "5h 40%" }],
					available: true,
					source: "ollama-cloud",
					defaults: { visible: true, after: "usage" },
				},
			],
		},
		config,
		theme,
		60,
		64,
	);
	expect(contentRows(lines).some((row) => row.includes("OLLAMA CLOUD"))).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sidebar.test.ts`
Expected: FAIL — `applyContributionDefaults` is not exported; the render tests fail because the contributed panel is not shown.

- [ ] **Step 3: Implement default insertion**

In `src/sidebar-panels.ts`, after `normalizeSidebarPanelLayout`, add:

```ts
/**
 * Effective layout for rendering: saved entries plus default-visible
 * contributions absent from configuration. Explicit configuration always
 * wins; contributions sharing an anchor are ordered deterministically by
 * panel ID; a missing anchor places the panel at the end. Saved
 * configuration is never rewritten.
 */
export function applyContributionDefaults(
	layout: readonly SidebarPanelLayoutEntry[],
	panels: readonly SidebarPanelData[],
): SidebarPanelLayout {
	const effective = layout.map((entry) => ({ id: entry.id, visible: entry.visible }));
	const present = new Set(effective.map((entry) => entry.id));
	const byAnchor = new Map<string, string[]>();
	for (const panel of panels) {
		if (panel.defaults?.visible !== true || present.has(panel.id)) continue;
		const group = byAnchor.get(panel.defaults.after) ?? [];
		group.push(panel.id);
		byAnchor.set(panel.defaults.after, group);
	}
	for (const [anchor, ids] of byAnchor) {
		const entries = ids
			.sort((a, b) => a.localeCompare(b, "en"))
			.map((id) => ({ id: id as SidebarPanelLayoutEntry["id"], visible: true }));
		const index = effective.findIndex((entry) => entry.id === anchor);
		if (index === -1) effective.push(...entries);
		else effective.splice(index + 1, 0, ...entries);
	}
	return effective;
}
```

In `src/sidebar.ts`, add `applyContributionDefaults` to the re-export block from `"./sidebar-panels.js"`. In `renderSidebarLines`, change the composition to use the effective layout — replace:

```ts
	const contributed = new Map((snapshot.sidebarPanels ?? []).map((panel) => [panel.id, panel]));
	const grouped = new Map<string, SidebarGroup[]>();
```

with:

```ts
	const contributed = new Map((snapshot.sidebarPanels ?? []).map((panel) => [panel.id, panel]));
	const effectiveLayout = applyContributionDefaults(config.sidebarPanelLayout, snapshot.sidebarPanels ?? []);
	const grouped = new Map<string, SidebarGroup[]>();
```

and change the layout loop header from `for (const entry of config.sidebarPanelLayout) {` to:

```ts
	for (const entry of effectiveLayout) {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/sidebar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidebar-panels.ts src/sidebar.ts tests/sidebar.test.ts
git commit -m "feat(panels): apply contribution defaults to effective layout"
```

### Task 3: Settings integration for default-visible panels

**Files:**
- Modify: `extensions/index.ts:441-447` (getSidebarPanelSettings append branch)
- Modify: `src/settings-workspace.ts:219` (syncSidebarDraft append)
- Test: `tests/settings-workspace.test.ts`

**Interfaces:**
- Consumes: `SidebarPanelData.defaults` (Task 1), `SidebarPanelSetting { id; title; available; visible }`.
- Produces: newly discovered panels surface in Settings with their default visibility; saving persists an explicit entry.

- [ ] **Step 1: Write the failing test**

In `tests/settings-workspace.test.ts`, add inside the top-level describe:

```ts
	it("shows a default-visible contributed panel as shown before saving", () => {
		const h = harness({}, DEFAULT_CONFIG, () => [
			...DEFAULT_CONFIG.sidebarPanelLayout.map((entry) => ({
				id: entry.id,
				title: entry.id === "agent" ? "Agent" : entry.id,
				available: true,
				visible: entry.visible,
			})),
			{ id: "ollama-cloud:usage" as const, title: "Ollama Cloud", available: true, visible: true },
		]);
		const rendered = text(h.component);
		expect(rendered).toContain("Ollama Cloud");
		expect(rendered).toContain("● Ollama Cloud");
	});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/settings-workspace.test.ts`
Expected: FAIL — the draft row is appended as hidden, so the rendered row shows `○ Ollama Cloud`.

- [ ] **Step 3: Implement**

In `src/settings-workspace.ts` `syncSidebarDraft`, change:

```ts
			sidebarDraft.push({ id: setting.id, visible: false });
```

to:

```ts
			sidebarDraft.push({ id: setting.id, visible: setting.visible });
```

In `extensions/index.ts` `getSidebarPanelSettings`, change the newly discovered append branch from `visible: false,` to:

```ts
				visible: panel.defaults?.visible === true,
```

so runtime default-visible panels reach Settings as shown while plain discoveries stay hidden until enabled.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/settings-workspace.test.ts tests/sidebar.test.ts`
Expected: PASS (the existing "merges newly discovered contributed panels" suite continues to pass — appended entries persist as explicit entries on save).

- [ ] **Step 5: Commit**

```bash
git add extensions/index.ts src/settings-workspace.ts tests/settings-workspace.test.ts
git commit -m "feat(panels): carry default visibility through settings"
```

### Task 4: Documentation, full check, and push

**Files:**
- Modify: `README.md` (Use section)

- [ ] **Step 1: Document contributed panel defaults**

In `README.md`, after the paragraph explaining sidebar mode and resizing ("In Pi fullscreen TUI mode, …"), add:

```markdown
Extensions can contribute read-only panels to the sidebar over Pi's shared event bus. Panels that declare default placement appear automatically after the built-in Usage panel; reorder or hide them in **Settings → Display** — an explicit setting always overrides a contributor's default.
```

- [ ] **Step 2: Run the full check suite**

Run: `npm run check`
Expected: typecheck, lint, format check, all Vitest suites, and the pack check pass with zero errors. Fix anything this branch introduced before proceeding.

- [ ] **Step 3: Commit and push**

```bash
git add README.md
git commit -m "docs: describe contributed sidebar panel defaults"
git push -u origin feat/panel-defaults
```

Expected: branch `feat/panel-defaults` pushed to `sekhnat/pi-atelier` containing four commits on top of `design/provider-usage-sidebar`.

import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_RUN_ACTIVITY, type RunActivitySnapshot } from "../src/run-activity.js";
import {
	buildSidebarSnapshot,
	createSidebarComponent,
	createSidebarController,
	renderSidebarLines,
} from "../src/sidebar.js";
import { DEFAULT_SIDEBAR_WIDTH } from "../src/split-pane.js";
import { type AtelierState, DEFAULT_CONFIG } from "../src/types.js";

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

const theme = {
	name: "dark",
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
};

afterEach(() => {
	vi.useRealTimers();
});

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
		runActivity: EMPTY_RUN_ACTIVITY,
	});
}

function withActivity(runActivity: RunActivitySnapshot) {
	return { ...snapshot(), runActivity };
}

function activeActivity(): RunActivitySnapshot {
	return {
		phase: "running",
		turnNumber: 3,
		startedAt: 1_000,
		activeTools: [
			{
				id: "read-1",
				name: "read",
				summary: "src/state.ts",
				status: "running",
				startedAt: 2_000,
			},
		],
		recentTools: [
			{
				id: "bash-1",
				name: "bash",
				summary: "npm test",
				status: "done",
				startedAt: 12_000,
				durationMs: 4_000,
			},
		],
		completedCount: 2,
		failedCount: 1,
	};
}

function contentRows(lines: string[]) {
	return lines.map((line) => stripAnsi(line).slice(2).trimEnd());
}

async function flushOverlay() {
	await Promise.resolve();
	await Promise.resolve();
}

function fakeTui(requestRender = vi.fn()) {
	return {
		render: vi.fn((width: number) => [`main:${width}`]),
		requestRender,
		terminal: { columns: 120, rows: 36, write: vi.fn() },
	};
}

describe("sidebar snapshot and layout", () => {
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

	it("renders a full-height dock without rounded corners or a brand block", () => {
		const lines = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false);
		const text = lines.join("\n");
		expect(lines).toHaveLength(36);
		expect(lines.every((line) => visibleWidth(line) <= 44)).toBe(true);
		expect(lines.every((line) => stripAnsi(line).startsWith("│ "))).toBe(true);
		expect(text).not.toMatch(/[╭╮╰╯]/);
		expect(text).not.toContain("ATELIER");
		expect(text).not.toMatch(/PI ATELIER|ATELIER|▛▀▜/);
		expect(contentRows(lines)[0]).toBe("AGENT");
		expect(contentRows(lines).some((row) => /^AGENT ─/.test(row))).toBe(false);
		expect(contentRows(lines)).toContain("pi-atelier · feature/sidebar ▲");
		expect(contentRows(lines)).toContain("◆ Working · gitifying  gpt-5.6-sol");
	});

	it("matches the representative 44x36 no-color docked rail", () => {
		const noSession = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: [] },
			cwd: "/Users/example/projects/pi-atelier",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: [],
		});
		expect(
			contentRows(renderSidebarLines(noSession, DEFAULT_CONFIG, theme, 44, 36, false)),
		).toMatchInlineSnapshot(`
			[
			  "AGENT",
			  "◆ Working · gitifying  gpt-5.6-sol",
			  "openai-codex · medium · subscription",
			  "",
			  "CONTEXT",
			  "32k / 400k [■·········] 8.1%",
			  "",
			  "WORKSPACE",
			  "pi-atelier · feature/sidebar ▲",
			  "/Users/example/projects/pi-atelier",
			  "6 entries · ephemeral",
			  "",
			  "USAGE",
			  "In 50.0k  Out 1.9k",
			  "Cache 100.0k  Hit 96.0%",
			  "Cost $0.479",
			  "",
			  "TOOLS",
			  "8 / 12 active ▸",
			  "",
			  "",
			  "",
			  "",
			  "",
			  "",
			  "",
			  "",
			  "",
			  "",
			  "",
			  "",
			  "",
			  "",
			  "",
			  "",
			  "",
			]
		`);
	});

	it("renders organized sections without exceeding width", () => {
		for (const width of [32, 40, 44]) {
			const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, width, 36, false));
			expect(rows.join("\n")).not.toContain("ATELIER");
			expect(rows.join("\n")).toContain("WORKSPACE");
			expect(rows.join("\n")).toContain("CONTEXT");
			expect(rows).toContain("TOOLS");
			expect(rows.every((row) => !row.startsWith("STATUS "))).toBe(true);
			expect(
				renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, width, 36, false).every(
					(line) => visibleWidth(line) <= width,
				),
			).toBe(true);
		}
	});

	it("switches all dense sections to compact rows below 40 columns", () => {
		const expandedConfig = { ...DEFAULT_CONFIG, showSidebarToolNames: true };
		const compact = contentRows(renderSidebarLines(snapshot(), expandedConfig, theme, 28, 36, false));
		expect(compact).toContain("◆ Working · gitifying");
		expect(compact).toContain("gpt-5.6-sol");
		expect(compact).toContain("openai-codex");
		expect(compact).toContain("medium · subscription");
		const compactContext = compact.indexOf("CONTEXT");
		expect(compact[compactContext + 1]).toMatch(/^32k \/ 400k\s+8\.1%$/);
		expect(compact[compactContext + 2]).toMatch(/^\[■·+\]$/);
		expect(compact).toContain("pi-atelier");
		expect(compact).toContain("feature/sidebar ▲");
		expect(compact).toContain("In 50.0k · Out 1.9k");
		expect(compact).toContain("Cache 100.0k · Hit 96.0%");
		expect(compact).toContain("8 / 12 active ▸");
		expect(compact).toEqual(expect.not.arrayContaining([expect.stringMatching(/subs$/)]));

		const regular = contentRows(renderSidebarLines(snapshot(), expandedConfig, theme, 40, 36, false));
		expect(regular).toContain("◆ Working · gitifying  gpt-5.6-sol");
		expect(regular).toContain("openai-codex · medium · subscription");
		expect(regular).toContain("pi-atelier · feature/sidebar ▲");
		expect(regular).toContain("8 / 12 active ▾");
	});

	it("renders a compact segmented context meter that adapts to width", () => {
		const narrow = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 28, 36, false));
		const narrowContext = narrow.indexOf("CONTEXT");
		expect(narrow[narrowContext + 1]).toMatch(/^32k \/ 400k\s+8\.1%$/);
		expect(narrow[narrowContext + 2]).toMatch(/^\[■·+\]$/);

		for (const width of [40, 44, 72]) {
			const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, width, 36, false));
			const contextIndex = rows.indexOf("CONTEXT");
			expect(rows[contextIndex + 1]).toMatch(/^32k \/ 400k \[■·+\] 8\.1%$/);
			expect(visibleWidth(rows[contextIndex + 1] ?? "")).toBeLessThanOrEqual(width - 2);
		}
	});

	it("omits a standalone unavailable marker when session name is missing", () => {
		const missingSession = buildSidebarSnapshot({
			state,
			cwd: "/tmp/project",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: [],
		});
		const rows = contentRows(renderSidebarLines(missingSession, DEFAULT_CONFIG, theme, 44, 36, false));
		const sessionIndex = rows.findIndex((row) => row.startsWith("SESSION "));
		const usageIndex = rows.findIndex((row) => row.startsWith("USAGE "));
		expect(rows.slice(sessionIndex + 1, usageIndex)).not.toContain("—");
		expect(rows.slice(sessionIndex + 1, usageIndex)).toContain("6 entries · ephemeral");
	});

	it("does not render the session file path", () => {
		const text = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false).join("\n");
		expect(text).not.toContain("/tmp/session.jsonl");
		expect(text).not.toContain("session.jsonl");
	});

	it("renders session entry count and persistence on one row", () => {
		const persisted = buildSidebarSnapshot({
			state,
			cwd: "/tmp/project",
			sessionName: "Task session",
			sessionFile: "/tmp/session.jsonl",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: [],
		});
		expect(contentRows(renderSidebarLines(persisted, DEFAULT_CONFIG, theme, 44, 36, false))).toContain(
			"6 entries · persisted",
		);
	});

	it("renders populated usage as compact inline metric rows", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const unnamedTheme = { fg, bold: theme.bold, italic: theme.italic };
		const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, unnamedTheme, 44, 36, true));
		const usageIndex = rows.indexOf("USAGE");
		expect(rows[usageIndex + 1]).toBe("In 50.0k  Out 1.9k");
		expect(rows[usageIndex + 2]).toBe("Cache 100.0k  Hit 96.0%");
		expect(rows[usageIndex + 3]).toBe("Cost $0.479");
		for (const label of ["In", "Out", "Cache", "Hit", "Cost"]) {
			expect(fg).toHaveBeenCalledWith("muted", label);
		}
		for (const width of [40, 56, 72]) {
			const wideRows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, width, 36, false));
			const wideUsage = wideRows.indexOf("USAGE");
			expect(wideRows[wideUsage + 1]).toBe("In 50.0k  Out 1.9k");
			expect(wideRows[wideUsage + 2]).toBe("Cache 100.0k  Hit 96.0%");
		}
	});

	it("hides unavailable usage while keeping access under Agent", () => {
		const unavailable = {
			...snapshot(),
			metrics: {
				...state.metrics,
				usageAvailable: false,
				costAvailable: false,
				input: 0,
				output: 0,
				cacheRead: 0,
				cost: 0,
			},
		};
		const rows = contentRows(renderSidebarLines(unavailable, DEFAULT_CONFIG, theme, 44, 36, false));
		expect(rows).not.toContain("USAGE");
		expect(rows).toContain("openai-codex · medium · subscription");
	});

	it("renders quiet section labels without ornamental rules", () => {
		const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false));
		for (const heading of ["AGENT", "CONTEXT", "WORKSPACE", "USAGE", "TOOLS"]) {
			expect(rows).toContain(heading);
		}
		expect(rows).toEqual(expect.not.arrayContaining([expect.stringMatching(/^[A-Z &]+ ─/)]));
	});

	it("renders deterministic live run activity", () => {
		const rows = contentRows(
			renderSidebarLines(withActivity(activeActivity()), DEFAULT_CONFIG, theme, 44, 36, false, 20_000),
		);
		expect(rows).toContain("ACTIVITY");
		expect(rows).toContain("Turn 3 · running 19s");
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^read\s+src\/state\.ts\s+18s$/),
				expect.stringMatching(/^bash\s+npm test\s+done 4s$/),
			]),
		);
		expect(rows).toContain("tools 2 done · 1 failed");
	});

	it.each([
		{ completedCount: 2, failedCount: 0, expected: "tools 2 done · 0 failed" },
		{ completedCount: 0, failedCount: 1, expected: "tools 0 done · 1 failed" },
	])("renders both aggregate sides for %#", ({ completedCount, failedCount, expected }) => {
		const rows = contentRows(
			renderSidebarLines(
				withActivity({
					phase: "settled",
					startedAt: 10_000,
					durationMs: 5_000,
					activeTools: [],
					recentTools: [],
					completedCount,
					failedCount,
				}),
				DEFAULT_CONFIG,
				theme,
				44,
				36,
				false,
				20_000,
			),
		);
		expect(rows).toContain(expected);
	});

	it("renders settled activity duration and omits only empty idle activity", () => {
		const idleRows = contentRows(
			renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false, 20_000),
		);
		expect(idleRows).not.toContain("ACTIVITY");

		const settledRows = contentRows(
			renderSidebarLines(
				withActivity({
					phase: "settled",
					turnNumber: 4,
					startedAt: 1_000,
					durationMs: 6_500,
					activeTools: [],
					recentTools: [
						{
							id: "edit-1",
							name: "edit",
							summary: "src/sidebar.ts",
							status: "failed",
							startedAt: 2_000,
							durationMs: 2_000,
						},
					],
					completedCount: 0,
					failedCount: 1,
				}),
				DEFAULT_CONFIG,
				theme,
				44,
				36,
				false,
				20_000,
			),
		);
		expect(settledRows).toContain("Last run · 6s");
		expect(settledRows).not.toContain("Turn 4 · settled 6s");
		expect(settledRows).toEqual(
			expect.arrayContaining([expect.stringMatching(/^edit\s+src\/sidebar\.ts\s+failed 2s$/)]),
		);

		const idleWithRecent = contentRows(
			renderSidebarLines(
				withActivity({
					phase: "idle",
					activeTools: [],
					recentTools: [
						{
							id: "idle-recent",
							name: "bash",
							summary: "npm test",
							status: "done",
							startedAt: 2_000,
							durationMs: 1_000,
						},
					],
					completedCount: 1,
					failedCount: 0,
				}),
				DEFAULT_CONFIG,
				theme,
				44,
				36,
				false,
				20_000,
			),
		);
		expect(idleWithRecent).toContain("ACTIVITY");
		expect(idleWithRecent).toEqual(
			expect.arrayContaining([expect.stringMatching(/^bash\s+npm test\s+done 1s$/)]),
		);
		expect(idleWithRecent).toContain("tools 1 done · 0 failed");

		const idleWithActive = contentRows(
			renderSidebarLines(
				withActivity({
					phase: "idle",
					startedAt: 10_000,
					activeTools: [
						{ id: "idle-active", name: "read", summary: "src/a.ts", status: "running", startedAt: 15_000 },
					],
					recentTools: [],
					completedCount: 0,
					failedCount: 0,
				}),
				DEFAULT_CONFIG,
				theme,
				44,
				36,
				false,
				20_000,
			),
		);
		expect(idleWithActive).toContain("ACTIVITY");
		expect(idleWithActive).toEqual(
			expect.arrayContaining([expect.stringMatching(/^read\s+src\/a\.ts\s+5s$/)]),
		);

		const idleWithCounts = contentRows(
			renderSidebarLines(
				withActivity({
					phase: "idle",
					activeTools: [],
					recentTools: [],
					completedCount: 0,
					failedCount: 2,
				}),
				DEFAULT_CONFIG,
				theme,
				44,
				36,
				false,
				20_000,
			),
		);
		expect(idleWithCounts).toContain("ACTIVITY");
		expect(idleWithCounts).toContain("tools 0 done · 2 failed");
	});

	it("keeps active tools before recent tools and preserves parallel start order", () => {
		const rows = contentRows(
			renderSidebarLines(
				withActivity({
					phase: "running",
					turnNumber: 1,
					startedAt: 10_000,
					activeTools: [
						{ id: "second", name: "grep", summary: "later", status: "running", startedAt: 13_000 },
						{ id: "first", name: "read", summary: "same-a", status: "running", startedAt: 12_000 },
						{ id: "third", name: "bash", summary: "same-b", status: "running", startedAt: 12_000 },
					],
					recentTools: [
						{
							id: "old",
							name: "write",
							summary: "recent",
							status: "done",
							startedAt: 3_000,
							durationMs: 1_000,
						},
					],
					completedCount: 1,
					failedCount: 0,
				}),
				DEFAULT_CONFIG,
				theme,
				44,
				36,
				false,
				20_000,
			),
		);
		const first = rows.findIndex((row) => /^read\s+same-a/.test(row));
		const third = rows.findIndex((row) => /^bash\s+same-b/.test(row));
		const second = rows.findIndex((row) => /^grep\s+later/.test(row));
		const recent = rows.findIndex((row) => /^write\s+recent/.test(row));
		expect([first, third, second, recent].every((index) => index > -1)).toBe(true);
		expect(first).toBeLessThan(third);
		expect(third).toBeLessThan(second);
		expect(second).toBeLessThan(recent);
	});

	it("caps recent tools, deduplicates active IDs, and bounds long summaries", () => {
		const rows = contentRows(
			renderSidebarLines(
				withActivity({
					phase: "running",
					startedAt: 0,
					activeTools: [{ id: "dupe", name: "read", summary: "active", status: "running", startedAt: 1_000 }],
					recentTools: [
						{
							id: "new",
							name: "bash",
							summary: "n".repeat(80),
							status: "done",
							startedAt: 9_000,
							durationMs: 1_000,
						},
						{
							id: "dupe",
							name: "read",
							summary: "duplicate",
							status: "done",
							startedAt: 8_000,
							durationMs: 1_000,
						},
						{
							id: "middle",
							name: "edit",
							summary: "middle",
							status: "done",
							startedAt: 7_000,
							durationMs: 1_000,
						},
						{
							id: "older",
							name: "write",
							summary: "older",
							status: "done",
							startedAt: 6_000,
							durationMs: 1_000,
						},
						{
							id: "oldest",
							name: "grep",
							summary: "oldest",
							status: "done",
							startedAt: 5_000,
							durationMs: 1_000,
						},
					],
					completedCount: 5,
					failedCount: 0,
				}),
				DEFAULT_CONFIG,
				theme,
				34,
				60,
				false,
				20_000,
			),
		);
		const recentRows = rows.filter((row) => /^(bash|edit|write)\s+/.test(row));
		expect(recentRows).toHaveLength(3);
		expect(recentRows[0]).toMatch(/^bash\s+n+/);
		expect(recentRows[1]).toMatch(/^edit\s+middle\s+done 1s$/);
		expect(recentRows[2]).toMatch(/^write\s+older\s+done 1s$/);
		expect(rows).not.toEqual(expect.arrayContaining([expect.stringContaining("duplicate")]));
		expect(rows).not.toEqual(expect.arrayContaining([expect.stringContaining("oldest")]));
		expect(rows.every((row) => visibleWidth(row) <= 32)).toBe(true);
	});

	it("uses success, error, and working palette roles for activity status", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		renderSidebarLines(
			withActivity({
				phase: "running",
				startedAt: 10_000,
				activeTools: [
					{ id: "active", name: "read", summary: "src/a.ts", status: "running", startedAt: 10_000 },
				],
				recentTools: [
					{ id: "ok", name: "bash", summary: "ok", status: "done", startedAt: 9_000, durationMs: 1_000 },
					{ id: "bad", name: "edit", summary: "bad", status: "failed", startedAt: 8_000, durationMs: 1_000 },
				],
				completedCount: 1,
				failedCount: 1,
			}),
			DEFAULT_CONFIG,
			{ fg, bold: theme.bold, italic: theme.italic },
			44,
			36,
			true,
			20_000,
		);
		expect(fg).toHaveBeenCalledWith("mdHeading", "10s");
		expect(fg).toHaveBeenCalledWith("thinkingLow", "done 1s");
		expect(fg).toHaveBeenCalledWith("error", "failed 1s");
	});

	it("drops tools, then usage, then workspace as height contracts", () => {
		const ranked = withActivity({
			phase: "running",
			turnNumber: 2,
			startedAt: 1_000,
			activeTools: [
				{ id: "active-a", name: "read", summary: "active-a", status: "running", startedAt: 2_000 },
				{ id: "active-b", name: "bash", summary: "active-b", status: "running", startedAt: 3_000 },
			],
			recentTools: [
				{
					id: "newest",
					name: "write",
					summary: "newest",
					status: "done",
					startedAt: 8_000,
					durationMs: 1_000,
				},
				{
					id: "middle",
					name: "grep",
					summary: "middle",
					status: "done",
					startedAt: 7_000,
					durationMs: 1_000,
				},
				{
					id: "oldest",
					name: "edit",
					summary: "oldest",
					status: "failed",
					startedAt: 6_000,
					durationMs: 1_000,
				},
			],
			completedCount: 3,
			failedCount: 1,
		});

		const fullRows = contentRows(renderSidebarLines(ranked, DEFAULT_CONFIG, theme, 44, 29, false, 20_000));
		expect(fullRows).toContain("TOOLS");
		expect(fullRows).toContain("USAGE");
		expect(fullRows).toContain("WORKSPACE");
		expect(fullRows.findIndex((row) => /^read\s+active-a/.test(row))).toBeLessThan(
			fullRows.indexOf("CONTEXT"),
		);

		const withoutTools = contentRows(
			renderSidebarLines(ranked, DEFAULT_CONFIG, theme, 44, 28, false, 20_000),
		);
		expect(withoutTools).not.toContain("TOOLS");
		expect(withoutTools).toContain("USAGE");
		expect(withoutTools).toContain("WORKSPACE");

		const withoutUsage = contentRows(
			renderSidebarLines(ranked, DEFAULT_CONFIG, theme, 44, 26, false, 20_000),
		);
		expect(withoutUsage).not.toContain("TOOLS");
		expect(withoutUsage).not.toContain("USAGE");
		expect(withoutUsage).toContain("WORKSPACE");

		const coreOnly = contentRows(renderSidebarLines(ranked, DEFAULT_CONFIG, theme, 44, 21, false, 20_000));
		expect(coreOnly).not.toContain("TOOLS");
		expect(coreOnly).not.toContain("USAGE");
		expect(coreOnly).not.toContain("WORKSPACE");
		expect(coreOnly).toContain("AGENT");
		expect(coreOnly).toContain("CONTEXT");
	});

	it("normalizes tools, collapses names by default, and expands them from configuration", () => {
		const toolsSnapshot = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: [] },
			cwd: "/tmp/project",
			branchEntryCount: 6,
			activeToolCount: 3,
			availableToolCount: 7,
			activeToolNames: ["read", "\u001b[31mbash", " edit\n", "read", "   "],
			extensionStatuses: [],
		});
		expect(toolsSnapshot.activeToolNames).toEqual(["bash", "edit", "read"]);

		const collapsed = contentRows(renderSidebarLines(toolsSnapshot, DEFAULT_CONFIG, theme, 44, 36, false));
		const collapsedIndex = collapsed.indexOf("TOOLS");
		expect(collapsed[collapsedIndex + 1]).toBe("3 / 7 active ▸");
		expect(collapsed).not.toContain("bash  edit");

		const expandedConfig = { ...DEFAULT_CONFIG, showSidebarToolNames: true };
		const expanded = contentRows(renderSidebarLines(toolsSnapshot, expandedConfig, theme, 44, 36, false));
		const expandedIndex = expanded.indexOf("TOOLS");
		expect(expanded[expandedIndex + 1]).toBe("3 / 7 active ▾");
		expect(expanded[expandedIndex + 2]).toBe("bash  edit");
		expect(expanded[expandedIndex + 3]).toBe("read");
		expect(expanded.join("\n")).not.toContain("[31m");

		for (const width of [40, 56, 72]) {
			const wide = contentRows(renderSidebarLines(toolsSnapshot, expandedConfig, theme, width, 36, false));
			const wideIndex = wide.indexOf("TOOLS");
			expect(wide[wideIndex + 2]).toBe("bash  edit");
			expect(wide[wideIndex + 3]).toBe("read");
		}

		for (const width of [28, 39]) {
			const narrow = contentRows(renderSidebarLines(toolsSnapshot, expandedConfig, theme, width, 36, false));
			const narrowIndex = narrow.indexOf("TOOLS");
			expect(narrow[narrowIndex + 1]).toBe("3 / 7 active ▸");
			expect(narrow).not.toContain("bash  edit");
			expect(narrow).not.toContain("read");
		}
		expect(expandedConfig.showSidebarToolNames).toBe(true);
	});

	it("drops activated tool-name rows before the tool count", () => {
		const toolsSnapshot = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: [] },
			cwd: "/tmp/project",
			branchEntryCount: 6,
			activeToolCount: 4,
			availableToolCount: 7,
			activeToolNames: ["write", "read", "edit", "bash"],
			extensionStatuses: [],
		});
		const expandedConfig = { ...DEFAULT_CONFIG, showSidebarToolNames: true };
		const fullRows = contentRows(renderSidebarLines(toolsSnapshot, expandedConfig, theme, 44, 60, false));
		const fullHeight = fullRows.findLastIndex((row) => row !== "") + 1;
		const constrained = contentRows(
			renderSidebarLines(toolsSnapshot, expandedConfig, theme, 44, fullHeight - 1, false),
		);
		expect(constrained).toContain("4 / 7 active ▾");
		expect(constrained).toContain("bash  edit");
		expect(constrained).not.toContain("read  write");
	});

	it("renders no tool-name placeholder when none are active", () => {
		const toolsSnapshot = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: [] },
			cwd: "/tmp/project",
			branchEntryCount: 0,
			activeToolCount: 0,
			availableToolCount: 7,
			activeToolNames: [],
			extensionStatuses: [],
		});
		const rows = contentRows(renderSidebarLines(toolsSnapshot, DEFAULT_CONFIG, theme, 44, 36, false));
		const toolsIndex = rows.indexOf("TOOLS");
		expect(rows[toolsIndex + 1]).toBe("0 / 7 active ▸");
		expect(rows[toolsIndex + 2]).toBe("");
	});

	it("renders tool count without standalone status placeholder when extension statuses are empty", () => {
		const emptyStatuses = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: [] },
			cwd: "/tmp/project",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: [],
		});
		const rows = contentRows(renderSidebarLines(emptyStatuses, DEFAULT_CONFIG, theme, 44, 36, false));
		const toolsIndex = rows.indexOf("TOOLS");
		expect(toolsIndex).toBeGreaterThan(-1);
		expect(rows[toolsIndex + 1]).toBe("8 / 12 active ▸");
		expect(rows.slice(toolsIndex + 2)).not.toContain("—");
		expect(rows).toEqual(expect.not.arrayContaining([expect.stringMatching(/^STATUS /)]));
	});

	it("shows only sanitized warning and error extension statuses", () => {
		const statusSnapshot = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: [] },
			cwd: "/tmp/project",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: ["tests \u001b[31mpassing", "api\nready", "sync warning", "index failed", "   "],
		});
		const rows = contentRows(renderSidebarLines(statusSnapshot, DEFAULT_CONFIG, theme, 44, 36, false));
		expect(rows).toContain("ALERTS");
		expect(rows).toContain("▲ sync warning");
		expect(rows).toContain("✕ index failed");
		expect(rows).not.toContain("tests passing");
		expect(rows).not.toContain("api ready");
		expect(rows.join("\n")).not.toContain("[31m");
	});

	it("suppresses routine healthy extension statuses", () => {
		const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 28, false));
		expect(rows).toContain("8 / 12 active ▸");
		expect(rows).not.toContain("tests passing");
		expect(rows).not.toContain("ALERTS");
	});

	it("keeps only the required hierarchy in a compact 12 row rail", () => {
		const text = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 12, false).join("\n");
		expect(text).not.toContain("▛▀▜");
		expect(text).toContain("AGENT");
		expect(text).toContain("CONTEXT");
		expect(text).not.toContain("WORKSPACE");
		expect(text).not.toContain("USAGE");
		expect(text).not.toContain("TOOLS");
		expect(text).not.toContain("tests passing");
	});

	it("renders missing metadata as unavailable and the session as ephemeral", () => {
		const {
			modelId: _model,
			provider: _provider,
			thinkingLevel: _thinking,
			branch: _branch,
			...base
		} = state;
		const missing = buildSidebarSnapshot({
			state: {
				...base,
				metrics: { ...state.metrics, contextTokens: null, contextPercent: null },
			},
			cwd: "/tmp/project",
			branchEntryCount: 0,
			activeToolCount: 0,
			availableToolCount: 0,
			extensionStatuses: [],
		});
		const lines = renderSidebarLines(missing, DEFAULT_CONFIG, theme, 32, 36, false);
		expect(lines.join("\n")).toContain("—");
		expect(lines.join("\n")).toContain("ephemeral");
		expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
	});

	it("sanitizes and truncates long values without breaking the frame", () => {
		const long = {
			...snapshot(),
			modelId: `model\u001b[31m${"界".repeat(60)}`,
			branch: `feature/${"x".repeat(100)}`,
			sessionName: `release\n${"y".repeat(100)}`,
			extensionStatuses: [`status\t${"z".repeat(100)}`],
		};
		const lines = renderSidebarLines(long, DEFAULT_CONFIG, theme, 34, 36, false);
		expect(lines.join("")).not.toContain("[31m");
		expect(lines.every((line) => visibleWidth(line) <= 34)).toBe(true);
	});

	it.each([
		[50, "text"],
		[75, "warning"],
		[95, "error"],
	] as const)("uses the configured context role at %s%%", (percent, expectedRole) => {
		const fg = vi.fn((_color: string, text: string) => text);
		renderSidebarLines(
			{ ...snapshot(), metrics: { ...state.metrics, contextPercent: percent } },
			DEFAULT_CONFIG,
			{ ...theme, fg },
			44,
			36,
			false,
		);
		expect(fg).toHaveBeenCalledWith(expectedRole, expect.stringContaining(`${percent.toFixed(1)}%`));
	});
});

describe("sidebar component and overlay", () => {
	it("does not capture editor input or render modal close help", () => {
		const component = createSidebarComponent({
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			getHeight: () => 36,
			theme,
		});
		expect(component.handleInput).toBeUndefined();
		expect(component.render(44).join("\n")).not.toContain("esc/q close");
	});

	it("shows a visible Resize state and active divider styling", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const component = createSidebarComponent({
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			getHeight: () => 36,
			isResizing: () => true,
			theme: { fg, bold: theme.bold, italic: theme.italic },
		});

		expect(component.render(44).join("\n")).toContain("RESIZE");
		expect(fg).toHaveBeenCalledWith("warning", "│");
	});

	it("reads live terminal height on every render without recreation", () => {
		let height = 24;
		const component = createSidebarComponent({
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			getHeight: () => height,
			theme,
		});
		expect(component.render(44)).toHaveLength(24);
		height = 31;
		expect(component.render(44)).toHaveLength(31);
	});

	it.each(["snapshot", "config", "render"] as const)(
		"renders a bounded error state after a %s failure",
		(source) => {
			const component = createSidebarComponent({
				getSnapshot: () => {
					if (source === "snapshot") throw new Error("snapshot failed");
					return snapshot();
				},
				getConfig: () => {
					if (source === "config") throw new Error("config failed");
					return DEFAULT_CONFIG;
				},
				getHeight: () => 7,
				theme:
					source === "render"
						? {
								...theme,
								bold: () => {
									throw new Error("render failed");
								},
							}
						: theme,
			});
			const lines = component.render(24);
			expect(lines).toHaveLength(7);
			expect(lines.every((line) => stripAnsi(line).startsWith("│ "))).toBe(true);
			expect(contentRows(lines)[0]).toBe("Sidebar unavailable");
			expect(lines.join("\n")).not.toMatch(/PI ATELIER|ATELIER/);
			expect(lines.join("\n")).not.toContain("esc/q close");
			expect(lines.join("\n")).not.toMatch(/[╭╮╰╯]/);
			expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
		},
	);

	it("keeps one overlay alive and supports repeated lifecycle operations", async () => {
		const requestRender = vi.fn();
		const closeCallbacks: Array<ReturnType<typeof vi.fn>> = [];
		const handles: Array<{ hide: ReturnType<typeof vi.fn> }> = [];
		const components: unknown[] = [];
		const tui = fakeTui(requestRender);
		const custom = vi.fn((factory, customOptions) => {
			return new Promise<undefined>((resolve) => {
				let closed = false;
				const done = vi.fn((value: undefined) => {
					if (closed) return;
					closed = true;
					resolve(value);
				});
				const handle = { hide: vi.fn() };
				closeCallbacks.push(done);
				handles.push(handle);
				components.push(factory(tui as never, theme as never, {} as never, done));
				const overlayOptions =
					typeof customOptions.overlayOptions === "function"
						? customOptions.overlayOptions()
						: customOptions.overlayOptions;
				expect(overlayOptions).toMatchObject({
					anchor: "top-right",
					width: DEFAULT_SIDEBAR_WIDTH,
					nonCapturing: true,
				});
				expect(tui.render(120)).toEqual([`main:${120 - DEFAULT_SIDEBAR_WIDTH}`]);
				customOptions.onHandle?.(handle as never);
			});
		});
		const controller = createSidebarController({
			ctx: { mode: "tui", ui: { custom } } as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
		});

		expect(controller.isVisible()).toBe(false);
		controller.show();
		expect(controller.isVisible()).toBe(true);
		expect(custom).toHaveBeenCalledOnce();
		expect(custom.mock.calls[0]?.[1]).toMatchObject({
			overlay: true,
			overlayOptions: expect.any(Function),
			onHandle: expect.any(Function),
		});
		expect(components).toHaveLength(1);
		controller.show();
		expect(custom).toHaveBeenCalledOnce();

		requestRender.mockClear();
		controller.requestRender();
		expect(requestRender).toHaveBeenCalledTimes(2);
		controller.hide();
		expect(controller.isVisible()).toBe(false);
		expect(closeCallbacks[0]).toHaveBeenCalledOnce();
		expect(handles[0]?.hide).not.toHaveBeenCalled();
		controller.hide();
		expect(closeCallbacks[0]).toHaveBeenCalledOnce();

		controller.toggle();
		expect(controller.isVisible()).toBe(true);
		expect(custom).toHaveBeenCalledTimes(2);
		expect(components).toHaveLength(2);

		// Cross the overlay promise and its catch/finally chain while the replacement is active.
		await flushOverlay();
		await flushOverlay();
		expect(controller.isVisible()).toBe(true);
		requestRender.mockClear();
		controller.requestRender();
		expect(requestRender).toHaveBeenCalledTimes(2);

		controller.dispose();
		expect(controller.isVisible()).toBe(false);
		expect(closeCallbacks[1]).toHaveBeenCalledOnce();
	});

	it("animates live activity on one timer only while visible", async () => {
		vi.useFakeTimers();
		let running = true;
		const requestRender = vi.fn();
		const tui = fakeTui(requestRender);
		const custom = vi.fn((factory, customOptions) => {
			return new Promise<undefined>((resolve) => {
				const handle = { hide: vi.fn() };
				factory(tui as never, theme as never, {} as never, resolve);
				customOptions.onHandle?.(handle as never);
			});
		});
		const controller = createSidebarController({
			ctx: { mode: "tui", ui: { custom } } as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			shouldAnimate: () => running,
			animationIntervalMs: 10,
		});
		vi.advanceTimersByTime(30);
		expect(requestRender).not.toHaveBeenCalled();

		controller.show();
		await flushOverlay();
		controller.show();
		requestRender.mockClear();
		vi.advanceTimersByTime(30);
		expect(requestRender).toHaveBeenCalledTimes(3);

		controller.requestRender();
		expect(requestRender).toHaveBeenCalledTimes(5);
		vi.advanceTimersByTime(10);
		expect(requestRender).toHaveBeenCalledTimes(6);

		running = false;
		controller.requestRender();
		expect(requestRender).toHaveBeenCalledTimes(8);
		vi.advanceTimersByTime(30);
		expect(requestRender).toHaveBeenCalledTimes(8);
	});

	it("stops animation on hide, overlay closure, dispose, and stale generation", async () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = fakeTui(requestRender);
		const doneCallbacks: Array<(value: undefined) => void> = [];
		const custom = vi.fn((factory, customOptions) => {
			return new Promise<undefined>((resolve) => {
				const done = (value: undefined) => resolve(value);
				doneCallbacks.push(done);
				const handle = { hide: vi.fn() };
				factory(tui as never, theme as never, {} as never, done);
				customOptions.onHandle?.(handle as never);
			});
		});
		const controller = createSidebarController({
			ctx: { mode: "tui", ui: { custom } } as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			shouldAnimate: () => true,
			animationIntervalMs: 10,
		});

		controller.show();
		await flushOverlay();
		requestRender.mockClear();
		vi.advanceTimersByTime(10);
		expect(requestRender).toHaveBeenCalledOnce();
		controller.hide();
		requestRender.mockClear();
		vi.advanceTimersByTime(30);
		expect(requestRender).not.toHaveBeenCalled();

		controller.show();
		await flushOverlay();
		requestRender.mockClear();
		vi.advanceTimersByTime(10);
		expect(requestRender).toHaveBeenCalledOnce();
		doneCallbacks[1]?.(undefined);
		await flushOverlay();
		requestRender.mockClear();
		vi.advanceTimersByTime(30);
		expect(requestRender).not.toHaveBeenCalled();

		controller.show();
		await flushOverlay();
		controller.hide();
		controller.show();
		await flushOverlay();
		doneCallbacks[2]?.(undefined);
		await flushOverlay();
		requestRender.mockClear();
		vi.advanceTimersByTime(10);
		expect(requestRender).toHaveBeenCalledOnce();
		controller.dispose();
		requestRender.mockClear();
		vi.advanceTimersByTime(30);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("enters Resize mode through the composed sidebar controller", () => {
		let input: ((data: string) => unknown) | undefined;
		const tui = fakeTui();
		const custom = vi.fn((factory, customOptions) => {
			factory(tui as never, theme as never, {} as never, vi.fn());
			customOptions.onHandle?.({ hide: vi.fn() });
			return new Promise(() => undefined);
		});
		const controller = createSidebarController({
			ctx: {
				mode: "tui",
				ui: {
					custom,
					onTerminalInput: vi.fn((handler) => {
						input = handler;
						return vi.fn();
					}),
				},
			} as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
		});

		controller.show();
		expect(controller.beginResize()).toBe(true);
		expect(controller.isResizing()).toBe(true);
		expect(controller.getWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
		expect(input).toBeTypeOf("function");
	});

	it("cleans composed Resize state and restores full-width rendering on hide", () => {
		let input: ((data: string) => unknown) | undefined;
		const tui = fakeTui();
		const custom = vi.fn((factory, customOptions) => {
			factory(tui as never, theme as never, {} as never, vi.fn());
			customOptions.onHandle?.({ hide: vi.fn() });
			return new Promise(() => undefined);
		});
		const controller = createSidebarController({
			ctx: {
				mode: "tui",
				ui: {
					custom,
					onTerminalInput: vi.fn((handler) => {
						input = handler;
						return vi.fn();
					}),
				},
			} as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
		});

		controller.show();
		expect(controller.beginResize()).toBe(true);
		input?.("\u001b[D");
		expect(controller.getWidth()).toBe(DEFAULT_SIDEBAR_WIDTH + 1);
		expect(tui.render(120)).toEqual([`main:${120 - DEFAULT_SIDEBAR_WIDTH - 1}`]);

		controller.hide();

		expect(controller.isResizing()).toBe(false);
		expect(tui.render(120)).toEqual(["main:120"]);
	});

	it("continues overlay cleanup when the external TUI render request throws", async () => {
		vi.useFakeTimers();
		const renderError = new Error("request render failed");
		const requestRender = vi.fn();
		const tui = fakeTui(requestRender);
		let finishOverlay: ((value: undefined) => void) | undefined;
		const custom = vi.fn(
			(factory, customOptions) =>
				new Promise<undefined>((resolve) => {
					finishOverlay = resolve;
					factory(tui as never, theme as never, {} as never, resolve);
					customOptions.onHandle?.({ hide: vi.fn() });
				}),
		);
		const onError = vi.fn();
		const controller = createSidebarController({
			ctx: { mode: "tui", ui: { custom } } as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			shouldAnimate: () => true,
			animationIntervalMs: 10,
			onError,
		});

		controller.show();
		expect(vi.getTimerCount()).toBe(1);
		requestRender.mockImplementation(() => {
			throw renderError;
		});
		finishOverlay?.(undefined);
		await flushOverlay();

		expect(controller.isVisible()).toBe(false);
		expect(controller.isResizing()).toBe(false);
		expect(tui.render(120)).toEqual(["main:120"]);
		expect(vi.getTimerCount()).toBe(0);
		expect(onError).toHaveBeenCalledWith(renderError);

		expect(() => controller.show()).not.toThrow();
		expect(controller.isVisible()).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("makes show after dispose a no-op", async () => {
		const tui = fakeTui();
		const doneCallbacks: Array<ReturnType<typeof vi.fn>> = [];
		const custom = vi.fn(
			(factory, customOptions) =>
				new Promise<undefined>((resolve) => {
					const done = vi.fn((value: undefined) => resolve(value));
					doneCallbacks.push(done);
					factory(tui as never, theme as never, {} as never, done);
					customOptions.onHandle?.({ hide: vi.fn() });
				}),
		);
		const controller = createSidebarController({
			ctx: { mode: "tui", ui: { custom } } as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
		});

		controller.show();
		expect(tui.render(120)).toEqual([`main:${120 - DEFAULT_SIDEBAR_WIDTH}`]);
		controller.dispose();
		await flushOverlay();

		controller.show();

		expect(controller.isVisible()).toBe(false);
		expect(custom).toHaveBeenCalledOnce();
		expect(doneCallbacks[0]).toHaveBeenCalledOnce();
		expect(tui.render(120)).toEqual(["main:120"]);
	});

	it("aborts overlay activation when a replacement TUI cannot attach", async () => {
		vi.useFakeTimers();
		const firstTui = fakeTui();
		const replacementTui = fakeTui();
		const tuis = [firstTui, replacementTui];
		const doneCallbacks: Array<ReturnType<typeof vi.fn>> = [];
		const handles: Array<{ hide: ReturnType<typeof vi.fn> }> = [];
		const onError = vi.fn();
		const custom = vi.fn((factory, customOptions) => {
			const tui = tuis[doneCallbacks.length];
			return new Promise<undefined>((resolve) => {
				const done = vi.fn((value: undefined) => resolve(value));
				const handle = { hide: vi.fn() };
				doneCallbacks.push(done);
				handles.push(handle);
				factory(tui as never, theme as never, {} as never, done);
				customOptions.onHandle?.(handle as never);
			});
		});
		const controller = createSidebarController({
			ctx: { mode: "tui", ui: { custom } } as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			shouldAnimate: () => true,
			animationIntervalMs: 10,
			onError,
		});

		controller.show();
		controller.hide();
		await flushOverlay();
		controller.show();
		await flushOverlay();

		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("another TUI") }),
		);
		expect(controller.isVisible()).toBe(false);
		expect(doneCallbacks[1]).toHaveBeenCalledOnce();
		expect(handles[1]?.hide).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		expect(firstTui.render(120)).toEqual(["main:120"]);
		expect(replacementTui.render(120)).toEqual(["main:120"]);
	});

	it("reports unsupported modes without enabling the sidebar", () => {
		const onError = vi.fn();
		const custom = vi.fn();
		const controller = createSidebarController({
			ctx: { mode: "rpc", ui: { custom } } as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			onError,
		});
		controller.show();
		expect(controller.isVisible()).toBe(false);
		expect(custom).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("TUI") }),
		);
	});
});

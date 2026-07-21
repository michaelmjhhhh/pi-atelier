import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_RUN_ACTIVITY, type RunActivitySnapshot } from "../src/run-activity.js";
import {
	buildSidebarSnapshot,
	createSidebarComponent,
	createSidebarController,
	renderSidebarLines,
	sidebarOverlayOptions,
} from "../src/sidebar.js";
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
		expect(text).not.toMatch(/PI ATELIER|ATELIER|▛▀▜|◆|●|✓/);
		expect(contentRows(lines)[0]).toBe("PROJECT");
		expect(contentRows(lines).some((row) => /^PROJECT ─/.test(row))).toBe(false);
		expect(contentRows(lines)).toContain("feature/sidebar · modified");
		expect(contentRows(lines)).toContain("Working · gitifying");
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
			  "PROJECT",
			  "pi-atelier",
			  "/Users/example/projects/pi-atelier",
			  "feature/sidebar · modified",
			  "",
			  "AGENT",
			  "gpt-5.6-sol",
			  "openai-codex · medium",
			  "Working · gitifying",
			  "",
			  "CONTEXT",
			  "32k / 400k                            8.1%",
			  "███░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░",
			  "auto compact",
			  "",
			  "SESSION",
			  "6 entries · ephemeral",
			  "",
			  "USAGE",
			  "INPUT                OUTPUT",
			  "50.0k                1.9k",
			  "CACHE                HIT",
			  "100.0k               96.0%",
			  "COST                 ACCESS",
			  "$0.479               subscription",
			  "",
			  "TOOLS",
			  "8 / 12 active",
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
			expect(rows.join("\n")).toContain("PROJECT");
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

	it("right-aligns context percentage and fills the available bar width", () => {
		const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false));
		const contextIndex = rows.indexOf("CONTEXT");
		expect(rows[contextIndex + 1]).toMatch(/^32k \/ 400k\s+8\.1%$/);
		expect(visibleWidth(rows[contextIndex + 2] ?? "")).toBe(42);
	});

	it("uses an attached non-capturing overlay with responsive visibility", () => {
		const options = sidebarOverlayOptions();
		expect(options).toMatchObject({
			anchor: "top-right",
			width: 44,
			margin: 0,
			nonCapturing: true,
		});
		expect(options.visible?.(87, 40)).toBe(false);
		expect(options.visible?.(88, 40)).toBe(true);
		expect(options.visible?.(160, 40)).toBe(true);
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

	it("renders usage as aligned muted labels followed by value rows", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const unnamedTheme = { fg, bold: theme.bold, italic: theme.italic };
		const lines = renderSidebarLines(snapshot(), DEFAULT_CONFIG, unnamedTheme, 44, 36, true);
		const rows = contentRows(lines);
		const inputLabel = rows.indexOf("INPUT                OUTPUT");
		expect(inputLabel).toBeGreaterThan(-1);
		expect(rows[inputLabel + 1]).toBe("50.0k                1.9k");
		expect(rows[inputLabel + 2]).toBe("CACHE                HIT");
		expect(rows[inputLabel + 3]).toBe("100.0k               96.0%");
		expect(rows[inputLabel + 4]).toBe("COST                 ACCESS");
		expect(rows[inputLabel + 5]).toBe("$0.479               subscription");
		for (const label of ["INPUT", "OUTPUT", "CACHE", "HIT", "COST", "ACCESS"]) {
			expect(fg).toHaveBeenCalledWith("muted", label);
		}
	});

	it("renders quiet section labels without ornamental rules", () => {
		const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false));
		for (const heading of ["PROJECT", "AGENT", "CONTEXT", "SESSION", "USAGE", "TOOLS"]) {
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

	it("drops short-height groups by approved rank while preserving display order", () => {
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
		const fullRows = contentRows(renderSidebarLines(ranked, DEFAULT_CONFIG, theme, 44, 60, false, 20_000));
		const fullHeight = fullRows.findLastIndex((row) => row !== "") + 1;
		expect(fullRows.findIndex((row) => /^read\s+active-a/.test(row))).toBeLessThan(
			fullRows.indexOf("CONTEXT"),
		);

		let rows = contentRows(
			renderSidebarLines(ranked, DEFAULT_CONFIG, theme, 44, fullHeight - 1, false, 20_000),
		);
		expect(rows).not.toContain("tests passing");
		expect(rows).toEqual(expect.arrayContaining([expect.stringContaining("oldest")]));

		rows = contentRows(renderSidebarLines(ranked, DEFAULT_CONFIG, theme, 44, fullHeight - 2, false, 20_000));
		expect(rows).not.toEqual(expect.arrayContaining([expect.stringContaining("oldest")]));
		expect(rows).toEqual(expect.arrayContaining([expect.stringContaining("middle")]));

		rows = contentRows(renderSidebarLines(ranked, DEFAULT_CONFIG, theme, 44, fullHeight - 3, false, 20_000));
		expect(rows).not.toEqual(expect.arrayContaining([expect.stringContaining("middle")]));
		expect(rows).toEqual(expect.arrayContaining([expect.stringContaining("newest")]));
		expect(rows).toContain("tools 3 done · 1 failed");

		rows = contentRows(renderSidebarLines(ranked, DEFAULT_CONFIG, theme, 44, fullHeight - 4, false, 20_000));
		expect(rows).not.toContain("tools 3 done · 1 failed");
		expect(rows).toEqual(expect.arrayContaining([expect.stringContaining("newest")]));

		rows = contentRows(renderSidebarLines(ranked, DEFAULT_CONFIG, theme, 44, fullHeight - 6, false, 20_000));
		expect(rows).not.toEqual(expect.arrayContaining([expect.stringContaining("newest")]));
		expect(rows).toContain("TOOLS");

		rows = contentRows(renderSidebarLines(ranked, DEFAULT_CONFIG, theme, 44, fullHeight - 7, false, 20_000));
		expect(rows).not.toContain("TOOLS");
		expect(rows).toContain("USAGE");

		rows = contentRows(renderSidebarLines(ranked, DEFAULT_CONFIG, theme, 44, fullHeight - 15, false, 20_000));
		expect(rows).not.toContain("USAGE");
		expect(rows).toContain("SESSION");

		rows = contentRows(renderSidebarLines(ranked, DEFAULT_CONFIG, theme, 44, fullHeight - 18, false, 20_000));
		expect(rows).not.toContain("SESSION");
		expect(rows).toContain("CONTEXT");
	});

	it("normalizes and renders exact activated tools in two columns", () => {
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

		const rows = contentRows(renderSidebarLines(toolsSnapshot, DEFAULT_CONFIG, theme, 44, 36, false));
		const toolsIndex = rows.indexOf("TOOLS");
		expect(rows[toolsIndex + 1]).toBe("3 / 7 active");
		expect(rows[toolsIndex + 2]).toBe("bash                 edit");
		expect(rows[toolsIndex + 3]).toBe("read");
		expect(rows.join("\n")).not.toContain("[31m");
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
		const fullRows = contentRows(renderSidebarLines(toolsSnapshot, DEFAULT_CONFIG, theme, 44, 60, false));
		const fullHeight = fullRows.findLastIndex((row) => row !== "") + 1;
		const constrained = contentRows(
			renderSidebarLines(toolsSnapshot, DEFAULT_CONFIG, theme, 44, fullHeight - 1, false),
		);
		expect(constrained).toContain("4 / 7 active");
		expect(constrained).toContain("bash                 edit");
		expect(constrained).not.toContain("read                 write");
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
		expect(rows[toolsIndex + 1]).toBe("0 / 7 active");
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
		expect(rows[toolsIndex + 1]).toBe("8 / 12 active");
		expect(rows.slice(toolsIndex + 2)).not.toContain("—");
		expect(rows).toEqual(expect.not.arrayContaining([expect.stringMatching(/^STATUS /)]));
	});

	it("appends sanitized extension status details when present", () => {
		const statusSnapshot = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: [] },
			cwd: "/tmp/project",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: ["tests \u001b[31mpassing", "api\nready", "   "],
		});
		const rows = contentRows(renderSidebarLines(statusSnapshot, DEFAULT_CONFIG, theme, 44, 36, false));
		const toolsIndex = rows.indexOf("TOOLS");
		expect(rows[toolsIndex + 1]).toBe("8 / 12 active");
		expect(rows).toContain("tests passing");
		expect(rows).toContain("api ready");
		expect(rows.join("\n")).not.toContain("[31m");
		expect(rows).toEqual(expect.not.arrayContaining([expect.stringMatching(/^STATUS /)]));
	});

	it("drops extension status detail rows before the tool count in shorter rails", () => {
		const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 29, false));
		expect(rows).toContain("8 / 12 active");
		expect(rows).not.toContain("tests passing");
	});

	it("keeps only the required hierarchy in a compact 15 row rail", () => {
		const text = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 15, false).join("\n");
		expect(text).not.toContain("▛▀▜");
		expect(text).toContain("PROJECT");
		expect(text).toContain("AGENT");
		expect(text).toContain("CONTEXT");
		expect(text).not.toContain("SESSION");
		expect(text).not.toContain("USAGE");
		expect(text).not.toContain("TOOLS");
		expect(text).not.toContain("tests passing");
		expect(text).not.toContain("active");
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
				components.push(
					factory({ requestRender, terminal: { rows: 36 } } as never, theme as never, {} as never, done),
				);
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
			overlayOptions: expect.objectContaining({
				anchor: "top-right",
				width: 44,
				nonCapturing: true,
			}),
			onHandle: expect.any(Function),
		});
		expect(components).toHaveLength(1);
		controller.show();
		expect(custom).toHaveBeenCalledOnce();

		controller.requestRender();
		expect(requestRender).toHaveBeenCalledOnce();
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

		// Cross both the overlay promise and its chained finally() while the replacement is active.
		await Promise.resolve();
		await Promise.resolve();
		expect(controller.isVisible()).toBe(true);
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
		const custom = vi.fn((factory, customOptions) => {
			return new Promise<undefined>((resolve) => {
				const handle = { hide: vi.fn() };
				factory({ requestRender, terminal: { rows: 36 } } as never, theme as never, {} as never, resolve);
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
		vi.advanceTimersByTime(30);
		expect(requestRender).toHaveBeenCalledTimes(3);

		controller.requestRender();
		expect(requestRender).toHaveBeenCalledTimes(4);
		vi.advanceTimersByTime(10);
		expect(requestRender).toHaveBeenCalledTimes(5);

		running = false;
		controller.requestRender();
		expect(requestRender).toHaveBeenCalledTimes(6);
		vi.advanceTimersByTime(30);
		expect(requestRender).toHaveBeenCalledTimes(6);
	});

	it("stops animation on hide, overlay closure, dispose, and stale generation", async () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const doneCallbacks: Array<(value: undefined) => void> = [];
		const custom = vi.fn((factory, customOptions) => {
			return new Promise<undefined>((resolve) => {
				const done = (value: undefined) => resolve(value);
				doneCallbacks.push(done);
				const handle = { hide: vi.fn() };
				factory({ requestRender, terminal: { rows: 36 } } as never, theme as never, {} as never, done);
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
		vi.advanceTimersByTime(10);
		expect(requestRender).toHaveBeenCalledTimes(1);
		controller.hide();
		vi.advanceTimersByTime(30);
		expect(requestRender).toHaveBeenCalledTimes(1);

		controller.show();
		await flushOverlay();
		vi.advanceTimersByTime(10);
		expect(requestRender).toHaveBeenCalledTimes(2);
		doneCallbacks[1]?.(undefined);
		await flushOverlay();
		vi.advanceTimersByTime(30);
		expect(requestRender).toHaveBeenCalledTimes(2);

		controller.show();
		await flushOverlay();
		vi.advanceTimersByTime(10);
		expect(requestRender).toHaveBeenCalledTimes(3);
		controller.dispose();
		vi.advanceTimersByTime(30);
		expect(requestRender).toHaveBeenCalledTimes(3);

		controller.show();
		await flushOverlay();
		controller.hide();
		controller.show();
		await flushOverlay();
		doneCallbacks[3]?.(undefined);
		await flushOverlay();
		vi.advanceTimersByTime(10);
		expect(requestRender).toHaveBeenCalledTimes(4);
		controller.dispose();
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

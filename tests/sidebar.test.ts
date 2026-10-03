import { disposeAfterTest } from "./helpers/cleanup.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { fakeTui, overlayHost } from "./helpers/overlay-host.js";
import { settleMicrotasks } from "./helpers/async.js";
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
import { type AtelierState } from "../src/types.js";

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

const theme = {
	name: "dark",
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
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
	workspacePulse: {
		status: "changed",
		data: {
			root: "/Users/example/projects/pi-atelier",
			relativeCwd: "",
			branch: "feature/sidebar",
			snapshot: {
				trackedFiles: 5,
				untrackedFiles: 2,
				linesAdded: 182,
				linesRemoved: 47,
				binaryFiles: 0,
				submodules: 0,
				conflicts: 0,
			},
		},
	},
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
		state: { ...state, extensionStatuses: ["tests passing"] },
		cwd: "/Users/example/projects/pi-atelier",
		sessionName: "Sidebar implementation",
		sessionFile: "/tmp/session.jsonl",
		branchEntryCount: 38,
		activeToolCount: 8,
		availableToolCount: 12,
		runActivity: EMPTY_RUN_ACTIVITY,
	});
}

function withActivity(runActivity: Partial<RunActivitySnapshot>) {
	return { ...snapshot(), runActivity: { ...structuredClone(EMPTY_RUN_ACTIVITY), ...runActivity } };
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
	return lines.map((line) => {
		const row = stripAnsi(line).slice(2).trimEnd();
		const title = row.match(/^╭─ [✦✧] ([A-Z]+) ─*╮$/)?.[1];
		if (title) return title;
		if (/^╰─+╯$/.test(row)) return "";
		if (row.startsWith("│ ") && row.endsWith(" │")) return row.slice(2, -2).trimEnd();
		return row;
	});
}

function renderRows(
	value: ReturnType<typeof snapshot>,
	{
		config = DEFAULT_CONFIG,
		width = 44,
		height = 60,
		color = true,
		now,
	}: { config?: typeof DEFAULT_CONFIG; width?: number; height?: number; color?: boolean; now?: number } = {},
) {
	return contentRows(
		renderSidebarLines(value, config, theme, width, height, {
			colorEnabled: color,
			...(now === undefined ? {} : { now }),
		}),
	);
}

const flushOverlay = settleMicrotasks;

describe("sidebar snapshot and layout", () => {
	it("composes visible panels in persisted order and keeps unavailable entries out of rendering", () => {
		const ordered = {
			...DEFAULT_CONFIG,
			sidebarPanelLayout: [
				{ id: "vendor:queue" as const, visible: true },
				{ id: "tools" as const, visible: true },
				{ id: "activity" as const, visible: true },
				...DEFAULT_CONFIG.sidebarPanelLayout
					.filter((entry) => !["tools", "activity"].includes(entry.id))
					.map((entry) => ({ ...entry, visible: !["agent", "todos"].includes(entry.id) })),
			],
		};
		const lines = renderSidebarLines(
			{
				...snapshot(),
				sidebarPanels: [
					{
						id: "vendor:queue",
						title: "Queue",
						rows: [{ text: "queued 2" }],
						source: "vendor",
					},
				],
			},
			ordered,
			theme,
			44,
			36,
		);
		const text = contentRows(lines).join("\n");
		expect(text.indexOf("QUEUE")).toBeGreaterThanOrEqual(0);
		expect(text.indexOf("QUEUE")).toBeLessThan(text.indexOf("TOOLS"));
		expect(text).not.toContain("AGENT");
	});

	it("renders an explicit empty state when every configured-visible panel is unavailable", () => {
		const hiddenBuiltins = DEFAULT_CONFIG.sidebarPanelLayout.map((entry) => ({ ...entry, visible: false }));
		const emptyConfig = {
			...DEFAULT_CONFIG,
			sidebarPanelLayout: [{ id: "vendor:missing" as const, visible: true }, ...hiddenBuiltins],
		};
		const rows = renderRows(snapshot(), { config: emptyConfig, height: 20 });
		expect(rows).toContain("No available panels");
		expect(rows).toContain("Open /atelier Settings");
	});

	it("renders a full-height dock with elegant terminal-native panels", () => {
		const lines = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 60, {
			colorEnabled: false,
			now: 0,
		});
		const text = lines.join("\n");
		expect(lines).toHaveLength(60);
		expect(lines.every((line) => visibleWidth(line) <= 44)).toBe(true);
		expect(lines.every((line) => stripAnsi(line).startsWith("  "))).toBe(true);
		expect(text).toContain("╭─ ✦ AGENT ");
		expect(text).toContain("╭─ ✦ CONTEXT ");
		expect(text).toContain("╰────────────────");
		expect(contentRows(lines)[0]).toBe("AGENT");
		expect(contentRows(lines)).toContainEqual(expect.stringMatching(/^. feature\/sidebar$/u));
		expect(contentRows(lines)).toContainEqual(expect.stringMatching(/^gpt-5\.6-sol$/));
	});

	it("renders a scan-first Workspace Pulse without repeating the repository root path", () => {
		const rows = renderRows(snapshot(), { color: false, now: 0 });

		expect(rows).toContainEqual(expect.stringMatching(/^Changed\s+5 files  \+182  −47$/));
		expect(rows).toContainEqual(expect.stringMatching(/^Untracked\s+2$/));
		expect(rows).not.toContain("/Users/example/projects/pi-atelier");
		expect(rows).toContainEqual(expect.stringMatching(/^Session\s+Sidebar implementation$/));
		expect(rows).toContainEqual(expect.stringMatching(/^History\s+38 entries$/));
	});

	it.each([
		[{ status: "inspecting" as const }, "inspecting…"],
		[{ status: "not-repo" as const }, "not a Git repository"],
		[{ status: "unavailable" as const }, "Git unavailable"],
	])("renders the %s Pulse state explicitly", (workspacePulse, expected) => {
		const { branch: _branch, ...withoutBranch } = snapshot();
		const rows = renderRows({ ...withoutBranch, workspacePulse, dirty: false }, { color: false, now: 0 });
		expect(rows).toContain(expected);
	});

	it("keeps conflict and stale signals visible without expanding every Git category", () => {
		if (!("data" in state.workspacePulse)) throw new Error("expected fixture Pulse data");
		const data = {
			...state.workspacePulse.data,
			relativeCwd: "packages/api",
			snapshot: {
				...state.workspacePulse.data.snapshot,
				binaryFiles: 1,
				submodules: 1,
				conflicts: 2,
			},
		};
		const conflictRows = renderRows(
			{ ...snapshot(), workspacePulse: { status: "conflict", data } },
			{ color: false, now: 0 },
		);
		expect(conflictRows).toContain("./packages/api");
		expect(conflictRows).toContainEqual(expect.stringMatching(/^Conflicts\s+2$/));
		expect(conflictRows).toContainEqual(expect.stringMatching(/^Submodules\s+1$/));

		const staleRows = renderRows(
			{ ...snapshot(), workspacePulse: { status: "stale", data } },
			{ color: false, now: 0 },
		);
		expect(staleRows).toContainEqual(expect.stringMatching(/^Git\s+Stale$/));

		const compactRows = renderRows(
			{ ...snapshot(), workspacePulse: { status: "stale", data } },
			{ width: 28, color: false, now: 0 },
		);
		expect(compactRows).toContainEqual(expect.stringMatching(/^Git\s+Stale$/));
		expect(compactRows).toContainEqual(expect.stringMatching(/^Lines\s+\+182  −47$/));
		expect(compactRows).toContainEqual(expect.stringMatching(/^Binary\s+1$/));
	});

	it("drops Session and optional Pulse detail before the Workspace identity and core summary", () => {
		const rows = renderRows(snapshot(), { height: 27, color: false, now: 0 });

		expect(rows).toContain("WORKSPACE");
		expect(rows).toContainEqual(expect.stringMatching(/^. feature\/sidebar$/u));
		expect(rows).toContainEqual(expect.stringMatching(/^Changed\s+5 files  \+182  −47$/));
		expect(rows).not.toContainEqual(expect.stringMatching(/^Untracked\s+2$/));
		expect(rows).not.toContainEqual(expect.stringMatching(/^Session\s+Sidebar implementation$/));
		expect(rows).not.toContainEqual(expect.stringMatching(/^History\s+38 entries$/));
	});

	it("pulses only the working Agent jewel while keeping other crowns stable", () => {
		const bright = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 60, {
			colorEnabled: false,
			now: 0,
		}).join("\n");
		const soft = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 60, {
			colorEnabled: false,
			now: 1_000,
		}).join("\n");
		expect(bright).toContain("╭─ ✦ AGENT ");
		expect(soft).toContain("╭─ ✧ AGENT ");
		expect(bright).toContain("╭─ ✦ CONTEXT ");
		expect(soft).toContain("╭─ ✦ CONTEXT ");
	});

	it("tints panel crowns with their semantic jewel roles", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		renderSidebarLines(snapshot(), DEFAULT_CONFIG, { fg, bold: theme.bold }, 44, 60, {
			colorEnabled: true,
			now: 0,
		});
		expect(fg).toHaveBeenCalledWith("mdHeading", "╭─ ✦ ");
		expect(fg).toHaveBeenCalledWith("success", "╭─ ✦ ");
		expect(fg).toHaveBeenCalledWith("syntaxType", "╭─ ✦ ");
		expect(fg).toHaveBeenCalledWith("accent", "╭─ ✦ ");
		expect(fg).toHaveBeenCalledWith("syntaxString", "╭─ ✦ ");
	});

	it("renders organized sections without exceeding width", () => {
		for (const width of [32, 40, 44]) {
			const rows = renderRows(snapshot(), { width: width, color: false });
			expect(rows.join("\n")).toContain("WORKSPACE");
			expect(rows.join("\n")).toContain("CONTEXT");
			expect(rows).toContain("TOOLS");
			expect(
				renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, width, 60, { colorEnabled: false }).every(
					(line) => visibleWidth(line) <= width,
				),
			).toBe(true);
		}
	});

	it("keeps labeled metrics readable in narrow and wide panels", () => {
		const expandedConfig = { ...DEFAULT_CONFIG, showSidebarToolNames: true };
		const compact = renderRows(snapshot(), { config: expandedConfig, width: 28, color: false });
		expect(compact).toContain("◆ Working · GITIFYING");
		expect(compact).toContain("gpt-5.6-sol");
		expect(compact).toContain("openai-codex");
		expect(compact).toContainEqual(expect.stringMatching(/^Thinking\s+medium$/));
		const compactContext = compact.indexOf("CONTEXT");
		expect(compact[compactContext + 1]).toMatch(/^[█░]+\s+8\.1%$/);
		expect(compact[compactContext + 2]).toMatch(/^Tokens\s+32k \/ 400k$/);
		expect(compact).toContain("pi-atelier");
		expect(compact).toContainEqual(expect.stringMatching(/^. feature\/sidebar$/u));
		expect(compact).toContainEqual(expect.stringMatching(/^Input\s+50\.0k$/));
		expect(compact).toContainEqual(expect.stringMatching(/^Cache read\s+100\.0k$/));
		expect(compact).toContainEqual(expect.stringMatching(/^Enabled\s+8 \/ 12$/));

		const regular = renderRows(snapshot(), { config: expandedConfig, color: false });
		expect(regular).toContainEqual(expect.stringMatching(/^gpt-5\.6-sol$/));
		expect(regular).toContainEqual(expect.stringMatching(/^Billing\s+Subscription$/));
		expect(regular).toContainEqual(expect.stringMatching(/^. feature\/sidebar$/u));
		expect(regular).toContainEqual(expect.stringMatching(/^Enabled\s+8 \/ 12$/));
	});

	it("preserves the labeled hierarchy across the compact threshold", () => {
		const expandedConfig = { ...DEFAULT_CONFIG, showSidebarToolNames: true };
		const compact = renderRows(snapshot(), { config: expandedConfig, width: 39, color: false });
		expect(compact).toContain("◆ Working · GITIFYING");
		expect(compact).toContain("gpt-5.6-sol");
		expect(compact).not.toContainEqual(expect.stringMatching(/^◆ Working.*gpt-5\.6-sol$/));

		for (const width of [40, 43, 44]) {
			const regular = renderRows(snapshot(), { config: expandedConfig, width: width, color: false });
			expect(regular).toContainEqual(expect.stringMatching(/^gpt-5\.6-sol$/));
			expect(regular).toContainEqual(expect.stringMatching(/^openai-codex/));
			expect(regular).toContainEqual(expect.stringMatching(/^Enabled\s+8 \/ 12$/));
		}
	});

	it("renders a context meter and labeled token count that adapt to width", () => {
		const narrow = renderRows(snapshot(), { width: 28, color: false });
		const narrowContext = narrow.indexOf("CONTEXT");
		expect(narrow[narrowContext + 1]).toMatch(/^[█░]+\s+8\.1%$/);
		expect(narrow[narrowContext + 2]).toMatch(/^Tokens\s+32k \/ 400k$/);

		for (const width of [40, 44, 72]) {
			const rows = renderRows(snapshot(), { width: width, color: false });
			const contextIndex = rows.indexOf("CONTEXT");
			expect(rows[contextIndex + 1]).toMatch(/^[█░]+\s+8\.1%$/);
			expect(rows[contextIndex + 2]).toMatch(/^Tokens\s+32k \/ 400k$/);
			expect(visibleWidth(rows[contextIndex + 1] ?? "")).toBeLessThanOrEqual(width - 6);
		}
	});

	it("omits a standalone unavailable marker when session name is missing", () => {
		const missingSession = buildSidebarSnapshot({
			state,
			cwd: "/tmp/project",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
		});
		const rows = renderRows(missingSession, { color: false });
		const workspaceIndex = rows.indexOf("WORKSPACE");
		const usageIndex = rows.indexOf("USAGE");
		expect(workspaceIndex).toBeGreaterThanOrEqual(0);
		expect(usageIndex).toBeGreaterThan(workspaceIndex);
		const workspaceRows = rows.slice(workspaceIndex + 1, usageIndex);
		expect(workspaceRows).not.toContain("—");
		expect(workspaceRows).toContainEqual(expect.stringMatching(/^Storage\s+Temporary$/));
	});

	it("does not render the session file path", () => {
		const text = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 60, { colorEnabled: false }).join(
			"\n",
		);
		expect(text).not.toContain("session.jsonl");
	});

	it("renders labeled session persistence", () => {
		const persisted = buildSidebarSnapshot({
			state,
			cwd: "/tmp/project",
			sessionName: "Task session",
			sessionFile: "/tmp/session.jsonl",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
		});
		expect(renderRows(persisted, { color: false })).toContainEqual(
			expect.stringMatching(/^Storage\s+Saved$/),
		);
	});

	it("renders populated usage as aligned labeled rows", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const unnamedTheme = { fg, bold: theme.bold };
		const rows = contentRows(
			renderSidebarLines(snapshot(), DEFAULT_CONFIG, unnamedTheme, 44, 60, { colorEnabled: true }),
		);
		const usageIndex = rows.indexOf("USAGE");
		expect(rows[usageIndex + 1]).toMatch(/^Input\s+50\.0k$/);
		expect(rows[usageIndex + 2]).toMatch(/^Output\s+1\.9k$/);
		expect(rows[usageIndex + 3]).toMatch(/^Cache read\s+100\.0k$/);
		for (const label of ["Input", "Output", "Cache read", "Cache hit", "Cost"]) {
			expect(fg).toHaveBeenCalledWith("muted", label);
		}
		for (const width of [44, 56, 72]) {
			const wideRows = renderRows(snapshot(), { width: width, color: false });
			const wideUsage = wideRows.indexOf("USAGE");
			expect(wideRows[wideUsage + 1]).toMatch(/^Input\s+50\.0k$/);
			expect(wideRows[wideUsage + 2]).toMatch(/^Output\s+1\.9k$/);
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
		const rows = renderRows(unavailable, { color: false });
		expect(rows).not.toContain("USAGE");
		expect(rows).toContainEqual(expect.stringMatching(/^Billing\s+Subscription$/));
	});

	it("keeps a live Turn's ACTIVITY to current work without tool history", () => {
		const rows = renderRows(withActivity(activeActivity()), { color: false, now: 20_000 });
		expect(rows).toContain("ACTIVITY");
		expect(rows).toContain("Turn 3 · running 19s");
		expect(rows).toEqual(expect.arrayContaining([expect.stringMatching(/^read\s+src\/state\.ts\s+18s$/)]));
		expect(rows).not.toEqual(expect.arrayContaining([expect.stringMatching(/^bash\s+npm test\s+done 4s$/)]));
		expect(rows).not.toContain("tools 2 done · 1 failed");
	});

	it.each([
		{ completedCount: 2, failedCount: 0, expected: "tools 2 done · 0 failed" },
		{ completedCount: 0, failedCount: 1, expected: "tools 0 done · 1 failed" },
	])("renders both aggregate sides for %#", ({ completedCount, failedCount, expected }) => {
		const rows = renderRows(
			withActivity({
				phase: "settled",
				startedAt: 10_000,
				durationMs: 5_000,
				activeTools: [],
				recentTools: [],
				completedCount,
				failedCount,
			}),
			{ color: false, now: 20_000 },
		);
		expect(rows).toContain(expected);
	});

	it("renders labeled response performance in Activity", () => {
		const ttftOnly = renderRows(
			withActivity({
				phase: "running",
				turnNumber: 1,
				startedAt: 1_000,
				performance: { ttftMs: 820 },
				activeTools: [],
				recentTools: [],
				completedCount: 0,
				failedCount: 0,
			}),
			{ color: false, now: 2_000 },
		);
		expect(ttftOnly).toContainEqual(expect.stringMatching(/^First token\s+820ms$/));

		const estimated = renderRows(
			withActivity({
				phase: "running",
				startedAt: 1_000,
				performance: { ttftMs: 820, tokensPerSecond: 42.34, estimated: true },
				activeTools: [],
				recentTools: [],
				completedCount: 0,
				failedCount: 0,
			}),
			{ color: false, now: 2_000 },
		);
		expect(estimated).toContainEqual(expect.stringMatching(/^Output speed\s+~42\.3 tok\/s$/));

		const completed = renderRows(
			withActivity({
				phase: "settled",
				startedAt: 1_000,
				durationMs: 4_000,
				performance: { ttftMs: 1_420, tokensPerSecond: 47.34 },
				activeTools: [],
				recentTools: [],
				completedCount: 0,
				failedCount: 0,
			}),
			{ color: false, now: 5_000 },
		);
		expect(completed).toContainEqual(expect.stringMatching(/^Output speed\s+47\.3 tok\/s$/));
	});

	it("keeps the run summary and response placeholders when height drops tool activity", () => {
		const performanceActivity = withActivity({
			...activeActivity(),
			performance: { ttftMs: 820, tokensPerSecond: 48 },
		});
		let constrainedRows: string[] | undefined;
		for (let height = 60; height > 0; height -= 1) {
			const rows = renderRows(performanceActivity, { height: height, color: false, now: 20_000 });
			if (
				rows.some((row) => /^Output speed\s+48\.0 tok\/s$/.test(row)) &&
				rows.some((row) => row.includes("Turn 3")) &&
				!rows.some((row) => /^read\s+src\/state\.ts/.test(row))
			) {
				constrainedRows = rows;
				break;
			}
		}

		expect(constrainedRows).toBeDefined();
	});

	it.each<{
		name: string;
		activity: Partial<RunActivitySnapshot>;
		present: (string | RegExp)[];
		absent: string[];
	}>([
		{ name: "idle placeholders", activity: {}, present: [/^First token\s+—$/], absent: ["Ready"] },
		{
			name: "settled activity",
			activity: {
				phase: "settled",
				turnNumber: 4,
				startedAt: 1_000,
				durationMs: 6_500,
				failedCount: 1,
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
			},
			present: ["Last run · 6s", /^edit\s+src\/sidebar\.ts\s+failed 2s$/],
			absent: ["Turn 4 · settled 6s"],
		},
		{
			name: "idle recent tools",
			activity: {
				completedCount: 1,
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
			},
			present: [/^bash\s+npm test\s+done 1s$/, "tools 1 done · 0 failed"],
			absent: [],
		},
		{
			name: "idle active tools",
			activity: {
				startedAt: 10_000,
				activeTools: [
					{ id: "idle-active", name: "read", summary: "src/a.ts", status: "running", startedAt: 15_000 },
				],
			},
			present: [/^read\s+src\/a\.ts\s+5s$/],
			absent: [],
		},
		{ name: "idle counts", activity: { failedCount: 2 }, present: ["tools 0 done · 2 failed"], absent: [] },
	])("renders $name", ({ activity, present, absent }) => {
		const rows = renderRows(withActivity(activity), { color: false, now: 20_000 });
		expect(rows).toContain("ACTIVITY");
		for (const expected of present) {
			expect(rows).toContainEqual(typeof expected === "string" ? expected : expect.stringMatching(expected));
		}
		for (const unexpected of absent) expect(rows).not.toContain(unexpected);
	});

	it("folds extra live tools into the current work row during a Turn", () => {
		const rows = renderRows(
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
			{ color: false, now: 20_000 },
		);
		expect(rows).toEqual(expect.arrayContaining([expect.stringMatching(/^grep\s+later\s+7s · \+2$/)]));
		expect(rows).not.toEqual(expect.arrayContaining([expect.stringMatching(/^read\s+same-a/)]));
		expect(rows).not.toEqual(expect.arrayContaining([expect.stringMatching(/^bash\s+same-b/)]));
		expect(rows.findIndex((row) => /^write\s+recent/.test(row))).toBe(-1);
	});

	it("caps recent tools, deduplicates active IDs, and bounds long summaries", () => {
		const rows = renderRows(
			withActivity({
				phase: "settled",
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
			{ width: 34, color: false, now: 20_000 },
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
		const liveFg = vi.fn((_color: string, text: string) => text);
		renderSidebarLines(
			withActivity({
				phase: "running",
				startedAt: 10_000,
				activeTools: [
					{ id: "active", name: "read", summary: "src/a.ts", status: "running", startedAt: 10_000 },
				],
				recentTools: [],
				completedCount: 0,
				failedCount: 0,
			}),
			DEFAULT_CONFIG,
			{ fg: liveFg, bold: theme.bold },
			44,
			60,
			{ colorEnabled: true, now: 20_000 },
		);
		expect(liveFg).toHaveBeenCalledWith("mdHeading", "10s");

		const settledFg = vi.fn((_color: string, text: string) => text);
		renderSidebarLines(
			withActivity({
				phase: "settled",
				startedAt: 10_000,
				durationMs: 10_000,
				activeTools: [],
				recentTools: [
					{ id: "ok", name: "bash", summary: "ok", status: "done", startedAt: 9_000, durationMs: 1_000 },
					{ id: "bad", name: "edit", summary: "bad", status: "failed", startedAt: 8_000, durationMs: 1_000 },
				],
				completedCount: 1,
				failedCount: 1,
			}),
			DEFAULT_CONFIG,
			{ fg: settledFg, bold: theme.bold },
			44,
			60,
			{ colorEnabled: true, now: 20_000 },
		);
		expect(settledFg).toHaveBeenCalledWith("thinkingLow", "done 1s");
		expect(settledFg).toHaveBeenCalledWith("error", "failed 1s");
	});

	it("drops workspace details, tools, then usage as height contracts", () => {
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

		const fullRows = renderRows(ranked, { color: false, now: 20_000 });
		expect(fullRows).toContainEqual(expect.stringMatching(/^Session\s+Sidebar implementation$/));
		expect(fullRows).toContainEqual(expect.stringMatching(/^History\s+38 entries$/));
		expect(fullRows).toContain("TOOLS");
		expect(fullRows).toContain("USAGE");
		expect(fullRows).toContain("WORKSPACE");
		expect(fullRows.findIndex((row) => /^bash\s+active-b/.test(row))).toBeGreaterThanOrEqual(0);
		expect(fullRows.findIndex((row) => /^bash\s+active-b/.test(row))).toBeLessThan(
			fullRows.indexOf("CONTEXT"),
		);

		const withoutSession = renderRows(ranked, { height: 40, color: false, now: 20_000 });
		expect(withoutSession).toContain("TOOLS");
		expect(withoutSession).toContain("USAGE");
		expect(withoutSession).toContain("WORKSPACE");
		expect(withoutSession).not.toContainEqual(expect.stringMatching(/^Session\s+Sidebar implementation$/));
		expect(withoutSession).not.toContainEqual(expect.stringMatching(/^History\s+38 entries$/));

		const withoutTools = renderRows(ranked, { height: 36, color: false, now: 20_000 });
		expect(withoutTools).not.toContain("TOOLS");
		expect(withoutTools).toContain("USAGE");
		expect(withoutTools).toContain("WORKSPACE");

		const coreOnly = renderRows(ranked, { height: 30, color: false, now: 20_000 });
		expect(coreOnly).not.toContain("TOOLS");
		expect(coreOnly).not.toContain("USAGE");
		expect(coreOnly).toContain("WORKSPACE");
		expect(coreOnly).toContainEqual(expect.stringMatching(/^Changed\s+5 files  \+182  −47$/));
		expect(coreOnly).not.toContainEqual(expect.stringMatching(/^Session\s+Sidebar implementation$/));
		expect(coreOnly).not.toContainEqual(expect.stringMatching(/^History\s+38 entries$/));
		expect(coreOnly).toContain("AGENT");
		expect(coreOnly).toContain("CONTEXT");
	});

	it("normalizes tools, collapses names by default, and expands them from configuration", () => {
		const toolsSnapshot = buildSidebarSnapshot({
			state: state,
			cwd: "/tmp/project",
			branchEntryCount: 6,
			activeToolCount: 3,
			availableToolCount: 7,
			activeToolNames: ["read", "\u001b[31mbash", " edit\n", "read", "   "],
		});
		expect(toolsSnapshot.activeToolNames).toEqual(["bash", "edit", "read"]);

		const collapsed = renderRows(toolsSnapshot, { color: false });
		const collapsedIndex = collapsed.indexOf("TOOLS");
		expect(collapsed[collapsedIndex + 1]).toMatch(/^Enabled\s+3 \/ 7$/);
		expect(collapsed).not.toContain("bash  edit");

		const expandedConfig = { ...DEFAULT_CONFIG, showSidebarToolNames: true };
		const expanded = renderRows(toolsSnapshot, { config: expandedConfig, color: false });
		const expandedIndex = expanded.indexOf("TOOLS");
		expect(expanded[expandedIndex + 1]).toMatch(/^Enabled\s+3 \/ 7$/);
		expect(expanded[expandedIndex + 2]).toBe("bash  edit");
		expect(expanded[expandedIndex + 3]).toBe("read");
		expect(expanded.join("\n")).not.toContain("[31m");

		for (const width of [44, 56, 72]) {
			const wide = renderRows(toolsSnapshot, { config: expandedConfig, width: width, color: false });
			const wideIndex = wide.indexOf("TOOLS");
			expect(wide[wideIndex + 2]).toBe("bash  edit");
			expect(wide[wideIndex + 3]).toBe("read");
		}

		for (const width of [28, 39]) {
			const narrow = renderRows(toolsSnapshot, { config: expandedConfig, width: width, color: false });
			const narrowIndex = narrow.indexOf("TOOLS");
			expect(narrow[narrowIndex + 1]).toMatch(/^Enabled\s+3 \/ 7$/);
			expect(narrow).not.toContain("bash  edit");
			expect(narrow).not.toContain("read");
		}
	});

	it("drops activated tool-name rows before the tool count", () => {
		const toolsSnapshot = buildSidebarSnapshot({
			state: state,
			cwd: "/tmp/project",
			branchEntryCount: 6,
			activeToolCount: 4,
			availableToolCount: 7,
			activeToolNames: ["write", "read", "edit", "bash"],
		});
		const expandedConfig = { ...DEFAULT_CONFIG, showSidebarToolNames: true };
		const fullRows = renderRows(toolsSnapshot, { config: expandedConfig, color: false });
		const fullHeight = fullRows.findLastIndex((row) => row !== "") + 3;
		const constrained = renderRows(toolsSnapshot, {
			config: expandedConfig,
			height: fullHeight - 1,
			color: false,
		});
		expect(constrained).toContainEqual(expect.stringMatching(/^Enabled\s+4 \/ 7$/));
		expect(constrained).toContain("bash  edit");
		expect(constrained).not.toContain("read  write");
	});

	it("renders no tool-name placeholder when none are active", () => {
		const toolsSnapshot = buildSidebarSnapshot({
			state: state,
			cwd: "/tmp/project",
			branchEntryCount: 0,
			activeToolCount: 0,
			availableToolCount: 7,
			activeToolNames: [],
		});
		const rows = renderRows(toolsSnapshot, { color: false });
		const toolsIndex = rows.indexOf("TOOLS");
		expect(rows[toolsIndex + 1]).toMatch(/^Enabled\s+0 \/ 7$/);
		expect(rows[toolsIndex + 2]).toBe("");
	});

	it("renders tool count without standalone status placeholder when extension statuses are empty", () => {
		const emptyStatuses = buildSidebarSnapshot({
			state: state,
			cwd: "/tmp/project",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
		});
		const rows = renderRows(emptyStatuses, { color: false });
		const toolsIndex = rows.indexOf("TOOLS");
		expect(toolsIndex).toBeGreaterThan(-1);
		expect(rows[toolsIndex + 1]).toMatch(/^Enabled\s+8 \/ 12$/);
		expect(rows.slice(toolsIndex + 2)).not.toContain("—");
	});

	it("shows only sanitized warning and error extension statuses", () => {
		const statusSnapshot = buildSidebarSnapshot({
			state: {
				...state,
				extensionStatuses: ["tests \u001b[31mpassing", "api\nready", "sync warning", "index failed", "   "],
			},
			cwd: "/tmp/project",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
		});
		const rows = renderRows(statusSnapshot, { color: false });
		expect(rows).toContain("ALERTS");
		expect(rows).toContain("▲ sync warning");
		expect(rows).toContain("✕ index failed");
		expect(rows).not.toContain("tests passing");
		expect(rows).not.toContain("api ready");
		expect(rows.join("\n")).not.toContain("[31m");
	});

	it("suppresses routine healthy extension statuses", () => {
		const rows = renderRows(snapshot(), { color: false });
		expect(rows).toContainEqual(expect.stringMatching(/^Enabled\s+8 \/ 12$/));
		expect(rows).not.toContain("tests passing");
		expect(rows).not.toContain("ALERTS");
	});

	it("keeps only the required hierarchy in a compact 12 row rail", () => {
		const text = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 12, { colorEnabled: false }).join(
			"\n",
		);
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
		});
		const lines = renderSidebarLines(missing, DEFAULT_CONFIG, theme, 32, 60, { colorEnabled: false });
		expect(lines.join("\n")).toContain("—");
		expect(lines.join("\n")).toContain("Temporary");
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
		const lines = renderSidebarLines(long, DEFAULT_CONFIG, theme, 34, 36, { colorEnabled: false });
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
			{ colorEnabled: false },
		);
		expect(fg).toHaveBeenCalledWith(expectedRole, expect.stringContaining(`${percent.toFixed(1)}%`));
	});

	it("hides Agent while retaining every populated sibling panel", () => {
		const configWithoutAgent = {
			...DEFAULT_CONFIG,
			sidebarPanelLayout: DEFAULT_CONFIG.sidebarPanelLayout.map((entry) => ({
				...entry,
				visible: entry.id !== "agent",
			})),
		};
		const populated = {
			...snapshot(),
			todos: [
				{ id: 1, text: "Visible TODO", status: "pending" as const },
				{ id: 2, text: "Completed TODO", status: "completed" as const },
			],
		};
		const rows = renderRows(populated, { config: configWithoutAgent, height: 64, color: false, now: 0 });
		expect(rows).not.toContain("AGENT");
		for (const panel of ["ACTIVITY", "TODOS", "CONTEXT", "WORKSPACE", "USAGE", "TOOLS"]) {
			expect(rows).toContain(panel);
		}
		expect(rows.some((row) => row.includes("Visible TODO"))).toBe(true);
	});
});

describe("sidebar component and overlay", () => {
	it("shows a visible Resize state and active divider styling", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const component = createSidebarComponent({
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			getHeight: () => 36,
			isResizing: () => true,
			theme: { fg, bold: theme.bold },
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
			expect(lines.every((line) => stripAnsi(line).startsWith("  "))).toBe(true);
			expect(contentRows(lines)[0]).toBe("Sidebar unavailable");
			expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
		},
	);

	it("keeps one overlay alive and supports repeated lifecycle operations", async () => {
		const requestRender = vi.fn();
		const tui = fakeTui(requestRender);
		const { custom, overlays } = overlayHost(() => tui);
		const controller = disposeAfterTest(
			createSidebarController({
				ctx: { cwd: "/tmp/project", mode: "tui", ui: { custom } } as never,
				getSnapshot: snapshot,
				getConfig: () => DEFAULT_CONFIG,
			}),
		);

		expect(controller.isVisible()).toBe(false);
		controller.show();
		expect(controller.isVisible()).toBe(true);
		expect(custom).toHaveBeenCalledOnce();
		expect(custom.mock.calls[0]?.[1]).toMatchObject({
			overlay: true,
			overlayOptions: expect.any(Function),
			onHandle: expect.any(Function),
		});
		expect(overlays).toHaveLength(1);
		expect(overlays[0]!.layout()).toMatchObject({
			anchor: "top-right",
			width: DEFAULT_SIDEBAR_WIDTH,
			nonCapturing: true,
		});
		controller.show();
		expect(custom).toHaveBeenCalledOnce();

		requestRender.mockClear();
		controller.requestRender();
		expect(requestRender).toHaveBeenCalled();
		controller.hide();
		expect(controller.isVisible()).toBe(false);
		expect(overlays[0]!.done).toHaveBeenCalledOnce();
		expect(overlays[0]!.handle.hide).not.toHaveBeenCalled();
		controller.hide();
		expect(overlays[0]!.done).toHaveBeenCalledOnce();

		controller.toggle();
		expect(controller.isVisible()).toBe(true);
		expect(custom).toHaveBeenCalledTimes(2);
		expect(overlays).toHaveLength(2);

		// Cross the overlay promise and its catch/finally chain while the replacement is active.
		await flushOverlay();
		expect(controller.isVisible()).toBe(true);
		requestRender.mockClear();
		controller.requestRender();
		expect(requestRender).toHaveBeenCalled();

		controller.dispose();
		expect(controller.isVisible()).toBe(false);
		expect(overlays[1]!.done).toHaveBeenCalledOnce();
	});

	it("animates live activity on one timer only while visible", async () => {
		vi.useFakeTimers();
		let running = true;
		const requestRender = vi.fn();
		const tui = fakeTui(requestRender);
		const { custom } = overlayHost(() => tui);
		const controller = disposeAfterTest(
			createSidebarController({
				ctx: { cwd: "/tmp/project", mode: "tui", ui: { custom } } as never,
				getSnapshot: snapshot,
				getConfig: () => DEFAULT_CONFIG,
				shouldAnimate: () => running,
			}),
		);
		vi.advanceTimersByTime(3_000);
		expect(requestRender).not.toHaveBeenCalled();

		controller.show();
		await flushOverlay();
		controller.show();
		requestRender.mockClear();
		vi.advanceTimersByTime(3_000);
		expect(requestRender).toHaveBeenCalledTimes(3);

		controller.requestRender();
		requestRender.mockClear();
		vi.advanceTimersByTime(1_000);
		expect(requestRender).toHaveBeenCalledOnce();

		running = false;
		controller.requestRender();
		requestRender.mockClear();
		vi.advanceTimersByTime(3_000);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("stops animation on hide, overlay closure, dispose, and stale generation", async () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = fakeTui(requestRender);
		const { custom, overlays } = overlayHost(() => tui);
		const controller = disposeAfterTest(
			createSidebarController({
				ctx: { cwd: "/tmp/project", mode: "tui", ui: { custom } } as never,
				getSnapshot: snapshot,
				getConfig: () => DEFAULT_CONFIG,
				shouldAnimate: () => true,
			}),
		);

		controller.show();
		await flushOverlay();
		requestRender.mockClear();
		vi.advanceTimersByTime(1_000);
		expect(requestRender).toHaveBeenCalledOnce();
		controller.hide();
		requestRender.mockClear();
		vi.advanceTimersByTime(3_000);
		expect(requestRender).not.toHaveBeenCalled();

		controller.show();
		await flushOverlay();
		requestRender.mockClear();
		vi.advanceTimersByTime(1_000);
		expect(requestRender).toHaveBeenCalledOnce();
		overlays[1]!.done(undefined);
		await flushOverlay();
		requestRender.mockClear();
		vi.advanceTimersByTime(3_000);
		expect(requestRender).not.toHaveBeenCalled();

		controller.show();
		await flushOverlay();
		controller.hide();
		controller.show();
		await flushOverlay();
		overlays[2]!.done(undefined);
		await flushOverlay();
		requestRender.mockClear();
		vi.advanceTimersByTime(1_000);
		expect(requestRender).toHaveBeenCalledOnce();
		controller.dispose();
		requestRender.mockClear();
		vi.advanceTimersByTime(3_000);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("cancels Resize when the sidebar hides", () => {
		let input: ((data: string) => unknown) | undefined;
		const tui = fakeTui();
		const { custom } = overlayHost(() => tui);
		const controller = disposeAfterTest(
			createSidebarController({
				ctx: {
					cwd: "/tmp/project",
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
			}),
		);

		controller.show();
		expect(controller.beginResize()).toBe(true);
		input?.("\u001b[D");

		controller.hide();

		expect(controller.isResizing()).toBe(false);
	});

	it("continues overlay cleanup when the external TUI render request throws", async () => {
		vi.useFakeTimers();
		const renderError = new Error("request render failed");
		const requestRender = vi.fn();
		const tui = fakeTui(requestRender);
		const { custom, overlays } = overlayHost(() => tui);
		const onError = vi.fn();
		const controller = disposeAfterTest(
			createSidebarController({
				ctx: { cwd: "/tmp/project", mode: "tui", ui: { custom } } as never,
				getSnapshot: snapshot,
				getConfig: () => DEFAULT_CONFIG,
				shouldAnimate: () => true,
				onError,
			}),
		);

		controller.show();
		expect(vi.getTimerCount()).toBe(1);
		requestRender.mockImplementation(() => {
			throw renderError;
		});
		overlays[0]!.done();
		await flushOverlay();

		expect(controller.isVisible()).toBe(false);
		expect(controller.isResizing()).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		expect(onError).toHaveBeenCalledWith(renderError);

		expect(() => controller.show()).not.toThrow();
		expect(controller.isVisible()).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("makes show after dispose a no-op", async () => {
		const tui = fakeTui();
		const { custom, overlays } = overlayHost(() => tui);
		const controller = disposeAfterTest(
			createSidebarController({
				ctx: { cwd: "/tmp/project", mode: "tui", ui: { custom } } as never,
				getSnapshot: snapshot,
				getConfig: () => DEFAULT_CONFIG,
			}),
		);

		controller.show();
		controller.dispose();
		await flushOverlay();

		controller.show();

		expect(controller.isVisible()).toBe(false);
		expect(custom).toHaveBeenCalledOnce();
		expect(overlays[0]!.done).toHaveBeenCalledOnce();
	});

	it("aborts overlay activation when a replacement TUI cannot attach", async () => {
		vi.useFakeTimers();
		const firstTui = fakeTui();
		const replacementTui = fakeTui();
		const tuis = [firstTui, replacementTui];
		const onError = vi.fn();
		const { custom, overlays } = overlayHost(() => tuis.shift()!);
		const controller = disposeAfterTest(
			createSidebarController({
				ctx: { cwd: "/tmp/project", mode: "tui", ui: { custom } } as never,
				getSnapshot: snapshot,
				getConfig: () => DEFAULT_CONFIG,
				shouldAnimate: () => true,
				onError,
			}),
		);

		controller.show();
		controller.hide();
		await flushOverlay();
		controller.show();
		await flushOverlay();

		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("another TUI") }),
		);
		expect(controller.isVisible()).toBe(false);
		expect(overlays[1]!.done).toHaveBeenCalledOnce();
		expect(overlays[1]!.handle.hide).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reports unsupported modes without enabling the sidebar", () => {
		const onError = vi.fn();
		const custom = vi.fn();
		const controller = disposeAfterTest(
			createSidebarController({
				ctx: { cwd: "/tmp/project", mode: "rpc", ui: { custom } } as never,
				getSnapshot: snapshot,
				getConfig: () => DEFAULT_CONFIG,
				onError,
			}),
		);
		controller.show();
		expect(controller.isVisible()).toBe(false);
		expect(custom).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("TUI") }),
		);
	});
});

describe("todos panel", () => {
	it("omits todos panel when list is empty", () => {
		const rows = renderRows(snapshot(), { height: 36, color: false });
		expect(rows).not.toContain("TODOS");
	});

	it("keeps only the in-progress todo during a live Turn", () => {
		const snapWithTodos = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: ["tests passing"] },
			cwd: "/Users/example/projects/pi-atelier",
			sessionName: "Sidebar implementation",
			sessionFile: "/tmp/session.jsonl",
			branchEntryCount: 38,
			activeToolCount: 8,
			availableToolCount: 12,
			runActivity: activeActivity(),
			todos: [
				{ id: 1, text: "Review diff", status: "completed" },
				{ id: 2, text: "Write tests", status: "in_progress" },
				{ id: 3, text: "Commit changes", status: "pending" },
			],
		});
		const rows = renderRows(snapWithTodos, { height: 48, color: false, now: 20_000 });
		expect(rows).toContain("TODOS");
		expect(rows).toContain("1/3");
		expect(rows).toContain("◐ #2 Write tests");
		expect(rows).not.toContain("✓ #1 Review diff");
		expect(rows).not.toContain("○ #3 Commit changes");
	});

	it("renders todos with all 3 status states", () => {
		const snapWithTodos = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: ["tests passing"] },
			cwd: "/Users/example/projects/pi-atelier",
			sessionName: "Sidebar implementation",
			sessionFile: "/tmp/session.jsonl",
			branchEntryCount: 38,
			activeToolCount: 8,
			availableToolCount: 12,
			runActivity: EMPTY_RUN_ACTIVITY,
			todos: [
				{ id: 1, text: "Review diff", status: "completed" },
				{ id: 2, text: "Write tests", status: "in_progress" },
				{ id: 3, text: "Commit changes", status: "pending" },
			],
		});
		const rows = renderRows(snapWithTodos, { height: 36, color: false });
		expect(rows).toContain("TODOS");
		expect(rows).toContain("1/3");
		expect(rows).toContain("✓ #1 Review diff");
		expect(rows).toContain("◐ #2 Write tests");
		expect(rows).toContain("○ #3 Commit changes");
	});

	it("hides todos panel when disabled in the layout", () => {
		const snapWithTodos = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: ["tests passing"] },
			cwd: "/Users/example/projects/pi-atelier",
			sessionName: "Sidebar implementation",
			sessionFile: "/tmp/session.jsonl",
			branchEntryCount: 38,
			activeToolCount: 8,
			availableToolCount: 12,
			runActivity: EMPTY_RUN_ACTIVITY,
			todos: [{ id: 1, text: "Task", status: "pending" }],
		});
		const config = {
			...DEFAULT_CONFIG,
			sidebarPanelLayout: DEFAULT_CONFIG.sidebarPanelLayout.map((entry) => ({
				...entry,
				visible: entry.id !== "todos",
			})),
		};
		const rows = renderRows(snapWithTodos, { config: config, height: 36, color: false });
		expect(rows).not.toContain("TODOS");
	});

	it("sanitizes ansi codes in todo text", () => {
		const snapWithTodos = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: ["tests passing"] },
			cwd: "/Users/example/projects/pi-atelier",
			sessionName: "Sidebar implementation",
			sessionFile: "/tmp/session.jsonl",
			branchEntryCount: 38,
			activeToolCount: 8,
			availableToolCount: 12,
			runActivity: EMPTY_RUN_ACTIVITY,
			todos: [{ id: 1, text: "Task\u001b[31mred", status: "pending" }],
		});
		const lines = renderSidebarLines(snapWithTodos, DEFAULT_CONFIG, theme, 44, 36, { colorEnabled: false });
		expect(lines.join("")).not.toContain("[31m");
		const rows = contentRows(lines);
		expect(rows).toContain("○ #1 Taskred");
	});
});

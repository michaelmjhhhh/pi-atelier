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
				trackedFiles: 4,
				untrackedFiles: 2,
				linesAdded: 182,
				linesRemoved: 47,
				binaryFiles: 1,
				submodules: 0,
				conflicts: 0,
				files: [
					{ path: "src/state.ts", status: "modified", added: 120, removed: 30 },
					{ path: "src/sidebar.ts", status: "modified", added: 50, removed: 12 },
					{ path: "README.md", status: "modified", added: 12, removed: 5 },
					{ path: "logo.png", status: "binary" },
					{ path: "new.ts", status: "new" },
					{ path: "notes.md", status: "new" },
				],
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
		sessionName: "Sidebar implementation",
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

const CROWN = /^╭─ [✦✧] (.+?) ─+(?: (.+) )?╮$/;

/** Rendered rows without frames: a crown becomes its title (and summary), a bottom border a blank row. */
function contentRows(lines: string[]) {
	return lines.map((line) => {
		const row = stripAnsi(line).slice(2).trimEnd();
		const crown = row.match(CROWN);
		if (crown) return crown[2] ? `${crown[1]}  ${crown[2]}` : (crown[1] ?? "");
		if (/^╰─+╯$/.test(row)) return "";
		if (row.startsWith("│ ") && row.endsWith(" │")) return row.slice(2, -2).trimEnd();
		return row;
	});
}

const ALL_PANELS = {
	...DEFAULT_CONFIG,
	sidebarPanelLayout: DEFAULT_CONFIG.sidebarPanelLayout.map((entry) => ({ ...entry, visible: true })),
};

const emptyPulse = {
	trackedFiles: 0,
	untrackedFiles: 0,
	linesAdded: 0,
	linesRemoved: 0,
	binaryFiles: 0,
	submodules: 0,
	conflicts: 0,
	files: [],
};

/** Index of a section heading, which may carry a summary on its right. */
function headingIndex(rows: readonly string[], title: string): number {
	return rows.findIndex((row) => row === title || row.startsWith(`${title}  `));
}

/** The rows of a section, between its heading and the blank spacer. */
function sectionRows(rows: readonly string[], title: string): string[] {
	const start = headingIndex(rows, title);
	if (start < 0) return [];
	const end = rows.indexOf("", start + 1);
	return rows.slice(start + 1, end < 0 ? undefined : end);
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
		const rows = contentRows(lines);
		expect(rows.indexOf("QUEUE")).toBeGreaterThanOrEqual(0);
		expect(rows.indexOf("QUEUE")).toBeLessThan(headingIndex(rows, "TOOLS"));
		expect(headingIndex(rows, "TOOLS")).toBeLessThan(rows.findIndex((row) => /^[◆◇] Working/.test(row)));
		expect(headingIndex(rows, "AGENT")).toBe(-1);
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

	it("renders a full-height dock of neutral frames", () => {
		const lines = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 60, {
			colorEnabled: false,
			now: 0,
		});
		expect(lines).toHaveLength(60);
		expect(lines.every((line) => visibleWidth(line) <= 44)).toBe(true);
		expect(lines.every((line) => stripAnsi(line).startsWith("  "))).toBe(true);
		expect(stripAnsi(lines[0] ?? "")).toMatch(/^  ╭─ ✦ ACTIVITY ─+╮$/);
		const rows = contentRows(lines);
		expect(rows.slice(0, 4)).toEqual(["ACTIVITY", "◆ Working", "", ""]);
		expect(headingIndex(rows, "CONTEXT")).toBeGreaterThan(0);
		expect(headingIndex(rows, "CHANGED FILES")).toBeGreaterThan(headingIndex(rows, "CONTEXT"));
		// Model, usage, and tool counts are already in the footer.
		for (const hidden of ["AGENT", "USAGE", "TOOLS"]) expect(headingIndex(rows, hidden)).toBe(-1);
	});

	it("lists changed files with right-aligned line counts", () => {
		const rows = renderRows(snapshot(), { color: false, now: 0 });
		const files = sectionRows(rows, "CHANGED FILES");
		expect(rows[headingIndex(rows, "CHANGED FILES")]).toMatch(/^CHANGED FILES\s+\+182\s+−47$/);
		expect(files).toEqual([
			expect.stringMatching(/^src\/state\.ts\s+\+120\s+−30$/),
			expect.stringMatching(/^src\/sidebar\.ts\s+\+50\s+−12$/),
			expect.stringMatching(/^README\.md\s+\+12\s+−5$/),
			expect.stringMatching(/^logo\.png\s+binary$/),
			expect.stringMatching(/^new\.ts\s+new$/),
			"1 more",
		]);
		// Counts and labels all end at the frame's inner edge.
		expect(new Set(files.slice(0, 5).map((row) => visibleWidth(row))).size).toBe(1);
		expect(rows.join("\n")).not.toContain("/Users/example/projects/pi-atelier");
	});

	it.each([
		[{ status: "inspecting" as const }, "Checking…"],
		[{ status: "not-repo" as const }, "Not a Git repository"],
		[{ status: "unavailable" as const }, "Git unavailable"],
	])("renders the %s Pulse state explicitly", (workspacePulse, expected) => {
		const rows = renderRows({ ...snapshot(), workspacePulse, dirty: false }, { color: false, now: 0 });
		expect(sectionRows(rows, "CHANGED FILES")).toEqual([expected]);
	});

	it("flags conflicts, clean trees, and stale data", () => {
		if (!("data" in state.workspacePulse)) throw new Error("expected fixture Pulse data");
		const data = state.workspacePulse.data;
		const conflictData = {
			...data,
			snapshot: {
				...data.snapshot,
				conflicts: 1,
				files: [{ path: "merge.ts", status: "conflict" as const, added: 3, removed: 4 }],
			},
		};
		const conflictRows = renderRows(
			{ ...snapshot(), workspacePulse: { status: "conflict", data: conflictData } },
			{ color: false, now: 0 },
		);
		expect(sectionRows(conflictRows, "CHANGED FILES")[0]).toMatch(/^merge\.ts\s+\+3\s+−4$/);
		const conflictFg = vi.fn((_color: string, text: string) => text);
		renderSidebarLines(
			{ ...snapshot(), workspacePulse: { status: "conflict", data: conflictData } },
			DEFAULT_CONFIG,
			{ fg: conflictFg, bold: theme.bold },
			44,
			60,
			{ colorEnabled: true, now: 0 },
		);
		expect(conflictFg).toHaveBeenCalledWith("error", "merge.ts");

		const cleanRows = renderRows(
			{ ...snapshot(), workspacePulse: { status: "clean", data: { ...data, snapshot: emptyPulse } } },
			{ color: false, now: 0 },
		);
		expect(sectionRows(cleanRows, "CHANGED FILES")).toEqual(["No changes"]);

		const staleRows = renderRows(
			{ ...snapshot(), workspacePulse: { status: "stale", data } },
			{ color: false, now: 0 },
		);
		expect(sectionRows(staleRows, "CHANGED FILES").at(-1)).toBe("May be out of date");
	});

	it("drops the overflow count, then later files, before the first changed file", () => {
		const rowsAt = (height: number) => renderRows(snapshot(), { height, color: false, now: 0 });
		const goneAt = (present: (rows: string[]) => boolean) => {
			for (let height = 60; height > 0; height -= 1) if (!present(rowsAt(height))) return height;
			return 0;
		};
		const moreGone = goneAt((rows) => rows.includes("1 more"));
		const lastFileGone = goneAt((rows) => rows.some((row) => row.startsWith("new.ts")));
		const firstFileGone = goneAt((rows) => rows.some((row) => row.startsWith("src/state.ts")));
		expect(moreGone).toBeGreaterThan(lastFileGone);
		expect(lastFileGone).toBeGreaterThan(firstFileGone);
		// The first file and its heading leave together.
		expect(headingIndex(rowsAt(firstFileGone), "CHANGED FILES")).toBe(-1);
	});

	it("pulses only the jewel of the lit Activity frame while working", () => {
		const crowns = (value: ReturnType<typeof snapshot>, now: number) =>
			renderSidebarLines(value, DEFAULT_CONFIG, theme, 44, 60, { colorEnabled: false, now })
				.map((line) => stripAnsi(line))
				.filter((line) => line.includes("╭─"))
				.join("\n");
		expect(crowns(snapshot(), 0)).toContain("╭─ ✦ ACTIVITY");
		expect(crowns(snapshot(), 1_000)).toContain("╭─ ✧ ACTIVITY");
		expect(crowns(snapshot(), 1_000)).toContain("╭─ ✦ CONTEXT");
		const ready = { ...snapshot(), activity: "ready" as const };
		expect(crowns(ready, 1_000)).toContain("╭─ ✦ ACTIVITY");
		expect(renderRows(ready, { color: false, now: 1_000 })[1]).toBe("● Ready");
	});

	it("paints each title in its panel's color and keeps frames neutral", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		renderSidebarLines(snapshot(), ALL_PANELS, { fg, bold: theme.bold }, 44, 60, {
			colorEnabled: true,
			now: 0,
		});
		for (const [color, heading] of [
			["syntaxType", "CONTEXT"],
			["accent", "CHANGED FILES"],
			["thinkingLow", "AGENT"],
			["syntaxFunction", "USAGE"],
			["syntaxString", "TOOLS"],
		]) {
			expect(fg).toHaveBeenCalledWith(color, heading);
		}
		// A lit frame's title takes the state color.
		expect(fg).toHaveBeenCalledWith("mdHeading", "ACTIVITY");
		expect(fg).toHaveBeenCalledWith("mdHeading", "Working");
		expect(fg).toHaveBeenCalledWith("success", "+182");
		expect(fg).toHaveBeenCalledWith("error", "−47");
		// Only the working Activity frame takes a state color; the rest stay neutral.
		expect(fg).toHaveBeenCalledWith("mdHeading", "╭─ ");
		expect(fg.mock.calls.filter(([, text]) => text === "╭─ ").map(([color]) => color)).toEqual([
			"dim",
			"mdHeading",
			"dim",
			"dim",
			"dim",
			"dim",
		]);
	});

	it("renders organized sections without exceeding width", () => {
		for (const width of [28, 32, 40, 44]) {
			const rows = renderRows(snapshot(), { config: ALL_PANELS, width: width, color: false });
			for (const heading of ["AGENT", "CONTEXT", "CHANGED FILES", "USAGE", "TOOLS"]) {
				expect(headingIndex(rows, heading)).toBeGreaterThanOrEqual(0);
			}
			expect(
				renderSidebarLines(snapshot(), ALL_PANELS, theme, width, 60, { colorEnabled: false }).every(
					(line) => visibleWidth(line) <= width,
				),
			).toBe(true);
		}
	});

	it("shows one Agent fact per row in narrow and wide panels", () => {
		for (const width of [28, 44, 72]) {
			const agent = sectionRows(renderRows(snapshot(), { config: ALL_PANELS, width, color: false }), "AGENT");
			expect(agent[0]).toMatch(/^Model\s+gpt-5\.6-sol$/);
			expect(agent[1]).toMatch(/^Provider\s+openai-codex$/);
			expect(agent[2]).toMatch(/^Thinking\s+medium$/);
			expect(agent[3]).toMatch(/^Billing\s+Subscription$/);
		}
		const wide = sectionRows(renderRows(snapshot(), { config: ALL_PANELS, color: false }), "AGENT");
		expect(wide[4]).toMatch(/^Session\s+Sidebar implementation$/);
	});

	it("shows the session name in Agent only when the session has one", () => {
		const unnamed = buildSidebarSnapshot({
			state,
			activeToolCount: 8,
			availableToolCount: 12,
		});
		const agent = sectionRows(renderRows(unnamed, { config: ALL_PANELS, color: false }), "AGENT");
		expect(agent).toHaveLength(4);
		expect(agent.join("\n")).not.toContain("Session");
		expect(agent).not.toContain("—");
	});

	it("renders a context meter with the token count on the crown when it fits", () => {
		for (const width of [40, 44, 72]) {
			const rows = renderRows(snapshot(), { width: width, color: false });
			const contextIndex = headingIndex(rows, "CONTEXT");
			expect(rows[contextIndex]).toMatch(/^CONTEXT\s+32k of 400k$/);
			expect(rows[contextIndex + 1]).toMatch(/^[█▏▎▍▌▋▊▉░]+ 8\.1%$/);
			expect(visibleWidth(rows[contextIndex + 1] ?? "")).toBe(width - 6);
		}
		// Too narrow for the full count: the frame carries the short form instead.
		const narrow = renderRows(snapshot(), { width: 28, color: false });
		expect(narrow[headingIndex(narrow, "CONTEXT")]).toMatch(/^CONTEXT\s+32k\/400k$/);
		expect(sectionRows(narrow, "CONTEXT")).toEqual([expect.stringMatching(/^[█▏▎▍▌▋▊▉░]+ 8\.1%$/)]);
	});

	it("renders populated usage as one labeled row per value", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const rows = contentRows(
			renderSidebarLines(snapshot(), ALL_PANELS, { fg, bold: theme.bold }, 44, 60, { colorEnabled: true }),
		);
		expect(sectionRows(rows, "USAGE")).toEqual([
			expect.stringMatching(/^Input\s+50\.0k$/),
			expect.stringMatching(/^Output\s+1\.9k$/),
			expect.stringMatching(/^Cache read\s+100\.0k$/),
			expect.stringMatching(/^Cache hit\s+96\.0%$/),
			expect.stringMatching(/^Cost\s+\$0\.479$/),
		]);
		for (const label of ["Input", "Output", "Cache read", "Cache hit", "Cost"]) {
			expect(fg).toHaveBeenCalledWith("muted", label);
		}
	});

	it("hides unavailable usage", () => {
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
		expect(headingIndex(renderRows(unavailable, { config: ALL_PANELS, color: false }), "USAGE")).toBe(-1);
	});

	it("keeps a live Turn's activity to running tools without tool history", () => {
		const rows = renderRows(withActivity(activeActivity()), { color: false, now: 20_000 });
		expect(rows[1]).toMatch(/^◆ Working\s+Turn 3  19s$/);
		expect(rows[2]).toMatch(/^◐ read\s+src\/state\.ts\s+18s$/);
		expect(rows[3]).toBe("");
		expect(rows.join("\n")).not.toMatch(/npm test/);
		expect(rows.join("\n")).not.toMatch(/\d+ tools?\b/);
	});

	it.each([
		{ completedCount: 2, failedCount: 0, expected: /^2 tools$/ },
		{ completedCount: 0, failedCount: 1, expected: /^1 tool, 1 failed$/ },
	])("renders the tool count for %#", ({ completedCount, failedCount, expected }) => {
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
		expect(rows[1]).toMatch(/^◆ Working\s+last run 5s$/);
		expect(rows).toContainEqual(expect.stringMatching(expected));
	});

	it("keeps the status row when height drops tool activity", () => {
		let constrainedRows: string[] | undefined;
		for (let height = 60; height > 0; height -= 1) {
			const rows = renderRows(withActivity(activeActivity()), { height: height, color: false, now: 20_000 });
			if (rows[1]?.includes("Turn 3") && !rows.some((row) => /^◐ read/.test(row))) {
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
		{ name: "idle status", activity: {}, present: ["◆ Working"], absent: ["First token —"] },
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
			present: [/^◆ Working\s+last run 6s$/, /^✗ edit\s+src\/sidebar\.ts\s+2s$/],
			absent: ["Turn 4"],
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
			present: [/^✓ bash\s+npm test\s+1s$/],
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
			present: [/^◐ read\s+src\/a\.ts\s+5s$/],
			absent: [],
		},
		{
			name: "idle counts",
			activity: { failedCount: 2 },
			present: [/^2 tools, 2 failed$/],
			absent: [],
		},
	])("renders $name", ({ activity, present, absent }) => {
		const rows = renderRows(withActivity(activity), { color: false, now: 20_000 });
		for (const expected of present) {
			expect(rows).toContainEqual(typeof expected === "string" ? expected : expect.stringMatching(expected));
		}
		for (const unexpected of absent) expect(rows).not.toContain(unexpected);
	});

	it("lists the newest three running tools during a Turn and counts the rest", () => {
		const rows = renderRows(
			withActivity({
				phase: "running",
				turnNumber: 1,
				startedAt: 10_000,
				activeTools: [
					{ id: "second", name: "grep", summary: "later", status: "running", startedAt: 13_000 },
					{ id: "first", name: "read", summary: "same-a", status: "running", startedAt: 12_000 },
					{ id: "third", name: "bash", summary: "same-b", status: "running", startedAt: 12_000 },
					{ id: "oldest", name: "find", summary: "earliest", status: "running", startedAt: 11_000 },
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
		expect(rows.slice(2, 6)).toEqual([
			expect.stringMatching(/^◐ read\s+same-a\s+8s$/),
			expect.stringMatching(/^◐ bash\s+same-b\s+8s$/),
			expect.stringMatching(/^◐ grep\s+later\s+7s$/),
			"1 more running",
		]);
		expect(rows.join("\n")).not.toContain("earliest");
		expect(rows.findIndex((row) => /write\s+recent/.test(row))).toBe(-1);
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
		const recentRows = rows.filter((row) => /^✓ (bash|edit|write)\s+/.test(row));
		expect(recentRows).toHaveLength(3);
		expect(recentRows[0]).toMatch(/^✓ bash\s+n+…\s+1s$/);
		expect(recentRows[1]).toMatch(/^✓ edit\s+middle\s+1s$/);
		expect(recentRows[2]).toMatch(/^✓ write\s+older\s+1s$/);
		expect(rows).not.toEqual(expect.arrayContaining([expect.stringContaining("duplicate")]));
		expect(rows).not.toEqual(expect.arrayContaining([expect.stringContaining("oldest")]));
		expect(rows.every((row) => visibleWidth(row) <= 31)).toBe(true);
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
		expect(settledFg).toHaveBeenCalledWith("thinkingLow", "✓");
		expect(settledFg).toHaveBeenCalledWith("error", "✗");
		expect(settledFg).toHaveBeenCalledWith("error", "1s");
	});

	it("drops tool names, then further changed files, then usage as height contracts", () => {
		const ranked = { ...withActivity(activeActivity()), activeToolNames: ["bash", "read"] };
		const config = { ...ALL_PANELS, showSidebarToolNames: true };
		const rowsAt = (height: number) => renderRows(ranked, { config, height, color: false, now: 20_000 });
		const goneAt = (present: (rows: string[]) => boolean) => {
			for (let height = 80; height > 0; height -= 1) if (!present(rowsAt(height))) return height;
			return 0;
		};
		const fullRows = rowsAt(80);
		expect(fullRows).toContain("bash  read");
		expect(headingIndex(fullRows, "USAGE")).toBeGreaterThan(-1);
		const namesGone = goneAt((rows) => rows.includes("bash  read"));
		const filesGone = goneAt((rows) => rows.some((row) => row.startsWith("src/sidebar.ts")));
		const usageGone = goneAt((rows) => headingIndex(rows, "USAGE") >= 0);
		expect(namesGone).toBeGreaterThan(filesGone);
		expect(filesGone).toBeGreaterThan(usageGone);

		const coreOnly = rowsAt(usageGone);
		expect(coreOnly).toContainEqual(expect.stringMatching(/^src\/state\.ts\s+\+120/));
		expect(coreOnly).toContainEqual(expect.stringMatching(/^[◆◇] Working/));
		expect(headingIndex(coreOnly, "CONTEXT")).toBeGreaterThan(-1);
	});

	it("normalizes tools, collapses names by default, and expands them from configuration", () => {
		const toolsSnapshot = buildSidebarSnapshot({
			state: state,
			activeToolCount: 3,
			availableToolCount: 7,
			activeToolNames: ["read", "\u001b[31mbash", " edit\n", "read", "   "],
		});
		expect(toolsSnapshot.activeToolNames).toEqual(["bash", "edit", "read"]);

		const collapsed = renderRows(toolsSnapshot, { config: ALL_PANELS, color: false });
		expect(sectionRows(collapsed, "TOOLS")).toEqual([expect.stringMatching(/^Enabled\s+3 of 7$/)]);

		const expandedConfig = { ...ALL_PANELS, showSidebarToolNames: true };
		const expanded = renderRows(toolsSnapshot, { config: expandedConfig, color: false });
		expect(expanded[headingIndex(expanded, "TOOLS")]).toMatch(/^TOOLS\s+3 of 7$/);
		expect(sectionRows(expanded, "TOOLS")).toEqual(["bash  edit", "read"]);
		expect(expanded.join("\n")).not.toContain("[31m");

		for (const width of [44, 56, 72]) {
			const wide = renderRows(toolsSnapshot, { config: expandedConfig, width: width, color: false });
			expect(sectionRows(wide, "TOOLS")).toEqual(["bash  edit", "read"]);
		}

		for (const width of [28, 39]) {
			const narrow = renderRows(toolsSnapshot, { config: expandedConfig, width: width, color: false });
			expect(sectionRows(narrow, "TOOLS")).toEqual([expect.stringMatching(/^Enabled\s+3 of 7$/)]);
		}
	});

	it("drops activated tool-name rows before the tool count", () => {
		const toolsSnapshot = buildSidebarSnapshot({
			state: state,
			activeToolCount: 4,
			availableToolCount: 7,
			activeToolNames: ["write", "read", "edit", "bash"],
		});
		const expandedConfig = { ...ALL_PANELS, showSidebarToolNames: true };
		const fullRows = renderRows(toolsSnapshot, { config: expandedConfig, color: false });
		const fullHeight = fullRows.findLastIndex((row) => row !== "") + 3;
		const constrained = renderRows(toolsSnapshot, {
			config: expandedConfig,
			height: fullHeight - 1,
			color: false,
		});
		expect(constrained[headingIndex(constrained, "TOOLS")]).toMatch(/^TOOLS\s+4 of 7$/);
		expect(constrained).toContain("bash  edit");
		expect(constrained).not.toContain("read  write");
	});

	it("renders the enabled count without a placeholder when no tools are active", () => {
		const toolsSnapshot = buildSidebarSnapshot({
			state: state,
			activeToolCount: 0,
			availableToolCount: 7,
			activeToolNames: [],
		});
		const rows = renderRows(toolsSnapshot, {
			config: { ...ALL_PANELS, showSidebarToolNames: true },
			color: false,
		});
		expect(sectionRows(rows, "TOOLS")).toEqual([expect.stringMatching(/^Enabled\s+0 of 7$/)]);
	});

	it("shows only sanitized warning and error extension statuses", () => {
		const statusSnapshot = buildSidebarSnapshot({
			state: {
				...state,
				extensionStatuses: ["tests \u001b[31mpassing", "api\nready", "sync warning", "index failed", "   "],
			},
			activeToolCount: 8,
			availableToolCount: 12,
		});
		const rows = renderRows(statusSnapshot, { color: false });
		expect(sectionRows(rows, "ALERTS")).toEqual(["▲ sync warning", "✕ index failed"]);
		expect(rows).not.toContain("tests passing");
		expect(rows).not.toContain("api ready");
		expect(rows.join("\n")).not.toContain("[31m");
	});

	it("suppresses routine healthy extension statuses", () => {
		const rows = renderRows(snapshot(), { color: false });
		expect(rows).not.toContain("tests passing");
		expect(headingIndex(rows, "ALERTS")).toBe(-1);
	});

	it("keeps only the status and context in an 8 row rail", () => {
		const rows = renderRows(snapshot(), { config: ALL_PANELS, height: 8, color: false, now: 0 });
		expect(rows[1]).toBe("◆ Working");
		expect(headingIndex(rows, "CONTEXT")).toBeGreaterThan(0);
		for (const heading of ["CHANGED FILES", "AGENT", "USAGE", "TOOLS"]) {
			expect(headingIndex(rows, heading)).toBe(-1);
		}
		expect(rows).not.toContain("tests passing");
	});

	it("renders missing metadata as unavailable", () => {
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
			activeToolCount: 0,
			availableToolCount: 0,
		});
		const lines = renderSidebarLines(missing, ALL_PANELS, theme, 32, 60, { colorEnabled: false });
		const rows = contentRows(lines);
		expect(sectionRows(rows, "AGENT")[0]).toMatch(/^Model\s+—$/);
		expect(sectionRows(rows, "CONTEXT")).toEqual(["Unavailable"]);
		expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
	});

	it("sanitizes and truncates long values without breaking the layout", () => {
		const long = {
			...snapshot(),
			modelId: `model\u001b[31m${"界".repeat(60)}`,
			branch: `feature/${"x".repeat(100)}`,
			sessionName: `release\n${"y".repeat(100)}`,
			extensionStatuses: [`status\t${"z".repeat(100)}`],
		};
		const lines = renderSidebarLines(long, ALL_PANELS, theme, 34, 36, { colorEnabled: false });
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
			...ALL_PANELS,
			sidebarPanelLayout: ALL_PANELS.sidebarPanelLayout.map((entry) => ({
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
		expect(headingIndex(rows, "AGENT")).toBe(-1);
		expect(rows[1]).toBe("◆ Working");
		for (const heading of ["TODOS", "CONTEXT", "CHANGED FILES", "USAGE", "TOOLS"]) {
			expect(headingIndex(rows, heading)).toBeGreaterThan(-1);
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
	function todoSnapshot(
		todos: NonNullable<Parameters<typeof buildSidebarSnapshot>[0]["todos"]>,
		runActivity: RunActivitySnapshot = EMPTY_RUN_ACTIVITY,
	) {
		return buildSidebarSnapshot({
			state: { ...state, extensionStatuses: ["tests passing"] },
			sessionName: "Sidebar implementation",
			activeToolCount: 8,
			availableToolCount: 12,
			runActivity,
			todos,
		});
	}

	const threeStates = [
		{ id: 1, text: "Review diff", status: "completed" as const },
		{ id: 2, text: "Write tests", status: "in_progress" as const },
		{ id: 3, text: "Commit changes", status: "pending" as const },
	];

	it("omits todos panel when list is empty", () => {
		const rows = renderRows(snapshot(), { height: 36, color: false });
		expect(headingIndex(rows, "TODOS")).toBe(-1);
	});

	it("shows the whole list with progress during a live Turn", () => {
		const rows = renderRows(todoSnapshot(threeStates, activeActivity()), {
			height: 48,
			color: false,
			now: 20_000,
		});
		expect(rows[headingIndex(rows, "TODOS")]).toMatch(/^TODOS\s+1 of 3$/);
		expect(sectionRows(rows, "TODOS")).toEqual(["✓ Review diff", "◐ Write tests", "○ Commit changes"]);
	});

	it("renders todos with all 3 status states", () => {
		const rows = renderRows(todoSnapshot(threeStates), { height: 36, color: false });
		expect(rows[headingIndex(rows, "TODOS")]).toMatch(/^TODOS\s+1 of 3$/);
		expect(sectionRows(rows, "TODOS")).toEqual(["✓ Review diff", "◐ Write tests", "○ Commit changes"]);
	});

	it("hides todos panel when disabled in the layout", () => {
		const config = {
			...DEFAULT_CONFIG,
			sidebarPanelLayout: DEFAULT_CONFIG.sidebarPanelLayout.map((entry) => ({
				...entry,
				visible: entry.visible && entry.id !== "todos",
			})),
		};
		const rows = renderRows(todoSnapshot([{ id: 1, text: "Task", status: "pending" }]), {
			config: config,
			height: 36,
			color: false,
		});
		expect(headingIndex(rows, "TODOS")).toBe(-1);
	});

	it("sanitizes ansi codes in todo text", () => {
		const lines = renderSidebarLines(
			todoSnapshot([{ id: 1, text: "Task\u001b[31mred", status: "pending" }]),
			DEFAULT_CONFIG,
			theme,
			44,
			36,
			{ colorEnabled: false },
		);
		expect(lines.join("")).not.toContain("[31m");
		expect(contentRows(lines)).toContain("○ Taskred");
	});
});

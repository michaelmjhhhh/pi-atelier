import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { renderFooterLine } from "../src/footer.js";
import { renderHeaderRail } from "../src/header-rail.js";
import { renderSidebarLines, buildSidebarSnapshot } from "../src/sidebar.js";
import { EMPTY_RUN_ACTIVITY } from "../src/run-activity.js";
import { createInertAtelierState } from "../src/state.js";
import type { NormalizedTodo } from "../src/types.js";

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const state = {
	...createInertAtelierState(null),
	activity: "working" as const,
	workingLabel: "READING",
	modelId: "gpt-5.6-sol",
	thinkingLevel: "medium",
	branch: "feature/plain-ui",
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
		subscription: false,
		contextTokens: 32_400,
		contextWindow: 400_000,
		contextPercent: 8.1,
		autoCompact: true,
	},
};
const snapshot = buildSidebarSnapshot({
	state,
	cwd: "/tmp/project",
	branchEntryCount: 38,
	activeToolCount: 8,
	availableToolCount: 12,
	runActivity: {
		...EMPTY_RUN_ACTIVITY,
		phase: "settled",
		turnNumber: 3,
		startedAt: 1_000,
		activeTools: [
			{ id: "read-1", name: "read", summary: "src/sidebar.ts", status: "running", startedAt: 2_000 },
		],
	},
	todos: [
		{ id: 1, text: "Pending task", status: "pending" },
		{ id: 2, text: "Current task", status: "in_progress" },
		{ id: 3, text: "Finished task", status: "completed" },
	] as NormalizedTodo[],
});

function renderSurfaces(width: number, nerdFont: boolean): string[] {
	const config = { ...DEFAULT_CONFIG, nerdFont };
	return [
		renderFooterLine(state, config, theme, width),
		...renderHeaderRail(snapshot, config, theme, width, {}),
		...renderSidebarLines(snapshot, config, theme, width, 80, { colorEnabled: false, now: 1_000 }),
	];
}

describe("plain text UI", () => {
	it.each([40, 80, 120])("renders footer, header rail, and sidebar as ASCII at %i columns", (width) => {
		for (const line of renderSurfaces(width, false)) {
			expect(
				[...line].every((character) => character.codePointAt(0)! < 128),
				line,
			).toBe(true);
		}
	});

	it("uses the plain TODO markers and preserves Nerd Font icons", () => {
		const plainSidebar = renderSidebarLines(
			snapshot,
			{ ...DEFAULT_CONFIG, nerdFont: false },
			theme,
			120,
			80,
			{
				colorEnabled: false,
				now: 1_000,
			},
		).join("\n");
		expect(renderFooterLine(state, { ...DEFAULT_CONFIG, nerdFont: false }, theme, 120)).toContain(
			"* READING",
		);
		expect(plainSidebar).toContain("branch: feature/plain-ui");
		expect(plainSidebar).toContain("* AGENT");
		expect(plainSidebar).toContain("[ ] #1 Pending task");
		expect(plainSidebar).toContain("[>] #2 Current task");
		expect(plainSidebar).toContain("[x] #3 Finished task");
		expect(renderSurfaces(120, true).join("\n")).toContain("\uf418");
	});
});

import { describe, expect, it } from "vitest";
import { buildSidebarSnapshot } from "../src/sidebar.js";
import { isSectionExpanded, sectionDetailRows, sectionSummary, toggleSection } from "../src/rail-sections.js";
import { EMPTY_RUN_ACTIVITY } from "../src/run-activity.js";
import { createInertAtelierState } from "../src/state.js";

const snapshot = buildSidebarSnapshot({
	state: {
		...createInertAtelierState(null),
		activity: "working",
		modelId: "gpt-test",
		thinkingLevel: "high",
		branch: "feature/rail",
		workspacePulse: {
			status: "changed",
			data: {
				root: "/tmp/project",
				relativeCwd: "",
				branch: "feature/rail",
				snapshot: {
					trackedFiles: 2,
					untrackedFiles: 1,
					linesAdded: 0,
					linesRemoved: 0,
					binaryFiles: 0,
					submodules: 0,
					conflicts: 0,
				},
			},
		},
		metrics: {
			usageAvailable: true,
			costAvailable: true,
			input: 12,
			output: 8,
			cacheRead: 4,
			cacheWrite: 0,
			cost: 0,
			subscription: false,
			contextTokens: 25,
			contextWindow: 100,
			contextPercent: 25,
			autoCompact: null,
		},
	},
	cwd: "/tmp/project",
	branchEntryCount: 0,
	activeToolCount: 2,
	availableToolCount: 5,
	runActivity: { ...EMPTY_RUN_ACTIVITY, phase: "running" },
	todos: [
		{ id: 1, text: "Done", status: "completed" },
		{ id: 2, text: "Next", status: "pending" },
	],
});

describe("rail section expansion", () => {
	it("defaults sections to expanded and round-trips a toggle", () => {
		expect(isSectionExpanded({}, "agent")).toBe(true);
		const collapsed = toggleSection({}, "agent");
		expect(isSectionExpanded(collapsed, "agent")).toBe(false);
		expect(isSectionExpanded(toggleSection(collapsed, "agent"), "agent")).toBe(true);
	});

	it("treats unknown section IDs as expanded and toggles them safely", () => {
		expect(isSectionExpanded({}, "unknown")).toBe(true);
		expect(isSectionExpanded(toggleSection({}, "unknown"), "unknown")).toBe(false);
	});

	it.each([
		["agent", "gpt-test · high"],
		["context", "25% · 25/100"],
		["workspace", "feature/rail ±3"],
		["workflows", ""],
		["todos", "1/2"],
	] as const)("summarizes %s", (id, expected) => {
		expect(sectionSummary(snapshot, id)).toBe(expected);
	});

	it("reports saved subagent runs and running agents", () => {
		const withRuns = {
			...snapshot,
			subagentUsage: {
				runs: [
					{ id: "1", runId: "1", agent: "a", metadataPath: "/tmp/1_meta.json", cost: 0, priced: false },
					{ id: "2", runId: "2", agent: "b", metadataPath: "/tmp/2_meta.json", cost: 0, priced: false },
				],
				pending: 3,
				unavailable: 0,
				limited: false,
				costHistory: [],
				historyUnavailable: 0,
			},
		};
		expect(sectionSummary(withRuns, "workflows")).toBe("2 runs · 3 agents");
		expect(sectionSummary(snapshot, "unknown")).toBe("");
	});

	it("returns the sidebar-backed agent, context, workspace, todo, and usage details", () => {
		expect(sectionDetailRows(snapshot, "agent")).toEqual([
			"Model: gpt-test",
			"Thinking: high",
			"Billing: Metered",
		]);
		expect(sectionDetailRows(snapshot, "context")).toEqual(["Tokens / window: 25 / 100", "Percent: 25.0%"]);
		expect(sectionDetailRows(snapshot, "workspace")).toEqual([
			"Branch: feature/rail",
			"Changed files: 3",
			"Dirty: yes",
		]);
		expect(sectionDetailRows(snapshot, "todos")).toEqual(["✓: Done", "○: Next"]);
		expect(sectionDetailRows(snapshot, "usage")).toEqual([
			"Input: 12",
			"Output: 8",
			"Cache read: 4",
			"Cost: $0.00",
		]);
	});

	it("returns no details for an empty snapshot", () => {
		const empty = buildSidebarSnapshot({
			state: createInertAtelierState(null),
			cwd: "/tmp/project",
			branchEntryCount: 0,
			activeToolCount: 0,
			availableToolCount: 0,
		});
		expect(sectionDetailRows(empty, "agent")).toEqual([]);
		expect(sectionDetailRows(empty, "context")).toEqual([]);
		expect(sectionDetailRows(empty, "workspace")).toEqual([]);
		expect(sectionDetailRows(empty, "todos")).toEqual([]);
		expect(sectionDetailRows(empty, "usage")).toEqual([]);
	});

	it("counts alerts using plain text and ignores ANSI-only markup", () => {
		const withAlerts = { ...snapshot, extensionStatuses: ["\u001b[31mwarning\u001b[0m", "ready"] };
		expect(sectionSummary(withAlerts, "alerts")).toBe("1 alerts");
	});
});

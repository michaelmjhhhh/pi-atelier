import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { renderHeaderRail } from "../src/header-rail.js";
import { buildSidebarSnapshot } from "../src/sidebar.js";
import { EMPTY_RUN_ACTIVITY } from "../src/run-activity.js";
import { createInertAtelierState } from "../src/state.js";

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const snapshot = buildSidebarSnapshot({
	state: {
		...createInertAtelierState(null),
		activity: "working",
		modelId: "gpt-5.6-sol",
		thinkingLevel: "medium",
		branch: "feature/sidebar",
		metrics: {
			usageAvailable: true,
			costAvailable: true,
			input: 50_000,
			output: 1_900,
			cacheRead: 100_000,
			cacheWrite: 0,
			cost: 0.479,
			subscription: false,
			contextTokens: 32_400,
			contextWindow: 400_000,
			contextPercent: 8.1,
			autoCompact: null,
		},
	},
	cwd: "/tmp/project",
	branchEntryCount: 38,
	activeToolCount: 8,
	availableToolCount: 12,
	runActivity: { ...EMPTY_RUN_ACTIVITY, phase: "running" },
});

const render = (width: number, expansion = {}) =>
	renderHeaderRail(snapshot, DEFAULT_CONFIG, theme, width, expansion);

describe("top header rail", () => {
	it.each([1, 2, 3, 4])("caps output at the configured %i rows", (headerRailRows) => {
		const lines = renderHeaderRail(snapshot, { ...DEFAULT_CONFIG, headerRailRows }, theme, 120, {});
		expect(lines.length).toBeLessThanOrEqual(headerRailRows);
	});

	it("shows distinct expanded and collapsed markers", () => {
		expect(render(120)[0]).toContain("▾ AGENT");
		expect(render(120, { agent: false }).join("\n")).toContain("▸ AGENT");
	});

	it("uses text fallback markers without Nerd Font mode", () => {
		const plain = renderHeaderRail(snapshot, { ...DEFAULT_CONFIG, nerdFont: false }, theme, 120, {
			agent: false,
		});
		expect(plain.join("\n")).toContain("[+] AGENT");
	});

	it.each([20, 40, 80])("never exceeds %i columns", (width) => {
		const lines = render(width);
		expect(lines.length).toBeLessThanOrEqual(2);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	it("marks hidden details when the row cap prevents rendering them", () => {
		const lines = renderHeaderRail(snapshot, { ...DEFAULT_CONFIG, headerRailRows: 2 }, theme, 120, {});
		expect(lines).toHaveLength(2);
		expect(lines[1]).toMatch(/… \+\d+$/);
	});

	it("renders expanded details and omits them when collapsed", () => {
		const expanded = renderHeaderRail(snapshot, { ...DEFAULT_CONFIG, headerRailRows: 4 }, theme, 120, {});
		expect(expanded[0]).toContain("▾ AGENT");
		expect(expanded.slice(1).join("\n")).toContain("AGENT Model: gpt-5.6-sol");
		const collapsed = renderHeaderRail(snapshot, { ...DEFAULT_CONFIG, headerRailRows: 4 }, theme, 120, {
			agent: false,
		});
		expect(collapsed.join("\n")).not.toContain("AGENT Model:");
	});

	it.each([76, 120])("keeps rows nonblank and within %i columns", (width) => {
		const lines = renderHeaderRail(snapshot, { ...DEFAULT_CONFIG, headerRailRows: 4 }, theme, width, {});
		expect(lines.every((line) => line.trim().length > 0)).toBe(true);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	it("returns no rows for an empty snapshot", () => {
		const empty = buildSidebarSnapshot({
			state: createInertAtelierState(null),
			cwd: "/tmp/project",
			branchEntryCount: 0,
			activeToolCount: 0,
			availableToolCount: 0,
		});
		expect(renderHeaderRail(empty, DEFAULT_CONFIG, theme, 120, {})).toEqual([]);
	});

	it("shows workspace details in the standard 120-column rail", () => {
		const lines = render(120);
		expect(lines[0]).toContain("▾ WORKSPACE");
		expect(lines[0]).toMatch(/… \+\d+$/);
		expect(lines[1]).toContain("AGENT Model:");
	});

	it("leaves Activity and Context to the footer when placed at the top", () => {
		const lines = renderHeaderRail(
			snapshot,
			{ ...DEFAULT_CONFIG, panelPlacement: "top", headerRailRows: 4 },
			theme,
			240,
			{ workspace: false },
		);
		const rendered = lines.join("\n");
		expect(rendered).not.toContain("ACTIVITY");
		expect(rendered).not.toContain("CONTEXT");
		for (const section of ["AGENT", "WORKSPACE", "TOOLS"]) expect(rendered).toContain(section);
	});

	it("keeps every section for right placement and when placement is not overridden", () => {
		const right = renderHeaderRail(snapshot, { ...DEFAULT_CONFIG, panelPlacement: "right" }, theme, 240, {});
		expect(right.join("\n")).toContain("ACTIVITY");
		expect(right.join("\n")).toContain("CONTEXT");
		expect(render(240).join("\n")).toContain("ACTIVITY");
		expect(render(240).join("\n")).toContain("CONTEXT");
	});

	it("hides summaries for collapsed sections and marks focus only when requested", () => {
		const collapsed = renderHeaderRail(snapshot, DEFAULT_CONFIG, theme, 120, { agent: false });
		expect(collapsed.join("\n")).toContain("▸ AGENT");
		expect(collapsed.join("\n")).not.toContain("gpt-5.6-sol");
		const focused = renderHeaderRail(snapshot, DEFAULT_CONFIG, theme, 120, {}, "agent");
		expect(focused.join("\n")).toContain("<▾ AGENT gpt-5.6-sol · medium>");
	});
});

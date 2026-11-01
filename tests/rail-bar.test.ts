import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { EMPTY_RUN_ACTIVITY } from "../src/run-activity.js";
import { buildSidebarSnapshot } from "../src/sidebar.js";
import { createInertAtelierState } from "../src/state.js";
import { createRailBar, hitTestRail, railBarLines } from "../src/rail-bar.js";
import { compatMouseHandler, type CompatMouseEvent, type MouseRegionComponent } from "../src/pi-compat.js";
import type { ThemeLike } from "../src/palette.js";

const theme: ThemeLike = { fg: (_role, text) => text, bold: (text) => text };
const snapshot = buildSidebarSnapshot({
	state: {
		...createInertAtelierState(null),
		activity: "working",
		modelId: "gpt-5.6-sol",
		thinkingLevel: "medium",
		branch: "feature/surface-model",
		metrics: {
			...createInertAtelierState(null).metrics,
			usageAvailable: true,
			costAvailable: true,
			input: 51_000,
			cost: 1.42,
		},
	},
	cwd: "/tmp/project",
	branchEntryCount: 38,
	activeToolCount: 8,
	availableToolCount: 12,
	runActivity: { ...EMPTY_RUN_ACTIVITY, phase: "running" },
	todos: [{ id: 1, text: "Rail top con card", status: "in_progress" }],
});
const sections = [
	"agent",
	"activity",
	"alerts",
	"todos",
	"context",
	"workspace",
	"usage",
	"subagents",
	"tools",
] as const;
const renderedSections = sections.filter((id) => id !== "activity" && id !== "context");
const config = {
	...DEFAULT_CONFIG,
	panelPlacement: "top" as const,
	railTopHeight: 6,
	sidebarPanelLayout: sections.map((id) => ({ id, visible: true })),
};
function cardStarts(line: string): number[] {
	return [...line.matchAll(/╭/gu)].map((match) => match.index ?? 0);
}

describe("top card strip", () => {
	it.each([76, 120, 145])("packs sidebar cards at %i columns", (width) => {
		const lines = railBarLines(
			snapshot,
			{ ...config, sectionExpansion: Object.fromEntries(sections.map((id) => [id, false])) },
			theme,
			width,
			40,
			Object.fromEntries(sections.map((id) => [id, false])),
		);
		const starts = cardStarts(lines[0]!);
		const spans = starts.map((start) => lines[0]!.indexOf("╮", start) + 1 - start);
		expect(spans.length).toBe(width === 76 ? 3 : width === 120 ? 4 : 5);
		expect(spans.every((span) => span >= 24 && span <= 48)).toBe(true);
		for (let index = 1; index < starts.length; index++)
			expect(starts[index]! - (starts[index - 1]! + spans[index - 1]!)).toBe(1);
		expect(lines.every((line) => visibleWidth(line) <= width && !/\s$/u.test(line))).toBe(true);
		expect(lines[0]!.startsWith("  ")).toBe(true);
	});

	it("renders collapsed cards as three rows and counts hidden sections", () => {
		const expansion = Object.fromEntries(sections.map((id) => [id, false]));
		const lines = railBarLines(
			snapshot,
			{ ...config, sectionExpansion: expansion },
			theme,
			76,
			40,
			expansion,
		);
		const firstStart = lines[0]!.indexOf("╭");
		const firstEnd = lines[0]!.indexOf("╮", firstStart);
		const bottom = lines.findIndex((line) => line[firstStart] === "╰" && line[firstEnd] === "╯");
		expect(bottom).toBe(2);
		expect(lines.at(-1)).toBe("  … +4");
	});

	it("truncates expanded card details with an ellipsis at the height cap", () => {
		const onlyAgent = {
			...config,
			railTopHeight: 3,
			sidebarPanelLayout: [{ id: "agent" as const, visible: true }],
		};
		const lines = railBarLines(snapshot, onlyAgent, theme, 76, 40, { agent: true });
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("…");
	});

	it("maps clicks across each card and excludes the leading gutter", () => {
		const expansion = Object.fromEntries(sections.map((id) => [id, false]));
		const lines = railBarLines(
			snapshot,
			{ ...config, sectionExpansion: expansion },
			theme,
			145,
			40,
			expansion,
		);
		const starts = cardStarts(lines[0]!);
		for (const [index, start] of starts.entries()) {
			const end = lines[0]!.indexOf("╮", start) + 1;
			const column = start + Math.floor((end - start) / 2);
			expect(hitTestRail(lines, 0, column)).toBe(renderedSections[index]);
			expect(hitTestRail(lines, 1, column)).toBe(renderedSections[index]);
		}
		expect(hitTestRail(lines, 0, 0)).toBeUndefined();
		const firstEnd = lines[0]!.indexOf("╮") + 1;
		expect(hitTestRail(lines, 0, firstEnd)).toBeUndefined();
	});

	it("uses ASCII card chrome and details in Plain text mode", () => {
		const plain = railBarLines(
			snapshot,
			{ ...config, nerdFont: false, sidebarPanelLayout: [{ id: "todos" as const, visible: true }] },
			theme,
			76,
			40,
			{ todos: true },
		);
		expect(plain[0]).toMatch(/^  \+- \* TODOS/u);
		expect(plain.join("\n")).not.toMatch(/[╭╮╰╯─│✦✧◆◐✓…]/u);
	});

	it("excludes footer-owned Activity and Context sections in top placement", () => {
		const lines = railBarLines(snapshot, config, theme, 145, 40, {});
		expect(lines.join("\n")).not.toContain("ACTIVITY");
		expect(lines.join("\n")).not.toContain("CONTEXT");
	});

	it("keeps right placement on the existing compact header rail", () => {
		const lines = railBarLines(snapshot, { ...config, panelPlacement: "right" }, theme, 145, 40, {});
		expect(lines.join("\n")).toContain("▾ AGENT");
		expect(lines.join("\n")).not.toContain("╭");
	});

	it("keeps the width and terminal-height gates", () => {
		expect(railBarLines(snapshot, config, theme, 63, 40, {})).toEqual([]);
		expect(railBarLines(snapshot, config, theme, 120, 19, {})).toEqual([]);
		expect(railBarLines(snapshot, config, theme, 64, 20, {}).length).toBeGreaterThanOrEqual(3);
	});

	it("honors the three-row minimum height cap even when cards are hidden", () => {
		const lines = railBarLines(snapshot, { ...config, railTopHeight: 1 }, theme, 64, 20, {});
		expect(lines).toHaveLength(3);
		expect(lines.at(-1)).toContain("… +");
		expect(lines.every((line) => visibleWidth(line) <= 64 && !/\s$/u.test(line))).toBe(true);
	});

	it("renders without mouse support on hosts without MouseRegion", () => {
		const onSectionClick = vi.fn();
		const bar = createRailBar(() => ["▾ AGENT model"], onSectionClick, {});
		bar.render(120);
		expect(bar.render(120)).toEqual(["▾ AGENT model"]);
		const handleMouse = compatMouseHandler(bar as MouseRegionComponent);
		handleMouse?.({ type: "click", button: "left", x: 2, y: 0 });
		expect(handleMouse).toBeUndefined();
		expect(onSectionClick).not.toHaveBeenCalled();
	});

	it("toggles once on click, not on press or release", () => {
		const onSectionClick = vi.fn();
		class FakeMouseRegion implements MouseRegionComponent {
			constructor(
				private readonly child: { render(width: number): string[]; invalidate(): void },
				private readonly handle: (event: CompatMouseEvent) => unknown,
			) {}
			render(width: number) {
				return this.child.render(width);
			}
			invalidate() {
				this.child.invalidate();
			}
			handleMouse = (event: never): never => this.handle(event) as never;
		}
		const bar = createRailBar(() => ["▾ AGENT model"], onSectionClick, { MouseRegion: FakeMouseRegion });
		bar.render(120);
		const event = (type: "press" | "release" | "click") => ({
			type,
			button: "left" as const,
			x: 2,
			y: 0,
			screenX: 2,
			screenY: 0,
			width: 120,
			height: 1,
			shift: false,
			alt: false,
			ctrl: false,
		});
		const handleMouse = compatMouseHandler(bar as MouseRegionComponent);
		handleMouse?.(event("press"));
		handleMouse?.(event("release"));
		expect(onSectionClick).not.toHaveBeenCalled();
		handleMouse?.(event("click"));
		expect(onSectionClick).toHaveBeenCalledOnce();
	});
});

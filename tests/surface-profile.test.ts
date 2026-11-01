import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { AtelierEditor } from "../src/editor.js";
import { renderFooterLine } from "../src/footer.js";
import { railBarLines } from "../src/rail-bar.js";
import { buildSidebarSnapshot, renderSidebarLines } from "../src/sidebar.js";
import { createInertAtelierState } from "../src/state.js";
import type { ThemeLike } from "../src/palette.js";

const theme: ThemeLike = { fg: (_role, text) => text, bold: (text) => text };
const state = {
	...createInertAtelierState(null),
	activity: "ready" as const,
	metrics: { ...createInertAtelierState(null).metrics, contextPercent: 27, contextWindow: 100_000 },
};
const snapshot = buildSidebarSnapshot({
	state,
	cwd: "/tmp/project",
	branchEntryCount: 2,
	activeToolCount: 0,
	availableToolCount: 4,
});

const dimensions = [
	[40, 12],
	[76, 40],
	[76, 38],
	[145, 2],
	[145, 4],
	[120, 40],
	[160, 50],
] as const;

describe("responsive surface profile", () => {
	it.each(dimensions)("renders the complete surface at %i×%i", (width, rows) => {
		const tui = { requestRender() {}, terminal: { columns: width, rows } };
		const editor = new AtelierEditor(
			tui as never,
			{ borderColor: (text: string) => text, selectList: {} } as never,
			{ matches: () => false } as never,
		);
		const config = { ...DEFAULT_CONFIG, panelPlacement: "top" as const };
		const footer = renderFooterLine(state, config, theme, width, { rows });
		const editorLines = editor.render(width);
		const topStrip = railBarLines(snapshot, config, theme, width, rows, {});
		const sidebar =
			width >= 104 && rows >= 20
				? renderSidebarLines(snapshot, { ...config, panelPlacement: "right" }, theme, 28, rows)
				: [];
		const allLines = [footer, ...editorLines, ...topStrip, ...sidebar];

		expect(allLines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(footer).toContain("READY");
		expect(footer).toContain("27.0%");
		for (const panelLines of [topStrip, sidebar]) {
			for (let index = 0; index < panelLines.length; index += 1) {
				if (panelLines[index]?.includes("╭") || panelLines[index]?.includes("+--")) {
					expect(panelLines[index + 1]?.trim().length).toBeGreaterThan(0);
				}
			}
		}
		if (rows <= 4) expect(editorLines.some((line) => /[╭╮╰╯│]/u.test(line))).toBe(false);
		if (width < 64 || rows < 20) expect(topStrip).toEqual([]);
	});
});

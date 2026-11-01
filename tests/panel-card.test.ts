import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderPanelCard } from "../src/panel-card.js";
import { createPalette } from "../src/palette.js";
import { renderSidebarLines, buildSidebarSnapshot } from "../src/sidebar.js";
import { createInertAtelierState } from "../src/state.js";
import { DEFAULT_CONFIG } from "../src/config.js";

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const palette = createPalette(theme, false);

describe("renderPanelCard", () => {
	it("retains the sidebar card chrome and exact width", () => {
		expect(renderPanelCard("TODOS", "✦", "accent", ["1/3"], 42, false, palette, theme)).toEqual([
			"╭─ ✦ TODOS ──────────────────────────────╮",
			"│ 1/3                                    │",
			"╰────────────────────────────────────────╯",
		]);
	});

	it("matches the right sidebar card borders", () => {
		const snapshot = buildSidebarSnapshot({
			state: createInertAtelierState(null),
			cwd: "/tmp/project",
			branchEntryCount: 0,
			activeToolCount: 0,
			availableToolCount: 0,
			todos: [{ id: 1, text: "One", status: "pending" }],
		});
		const config = {
			...DEFAULT_CONFIG,
			sidebarPanelLayout: DEFAULT_CONFIG.sidebarPanelLayout.map((entry) => ({
				...entry,
				visible: entry.id === "todos",
			})),
		};
		const sidebar = renderSidebarLines(snapshot, config, theme, 44, 20, { colorEnabled: false });
		const top = sidebar.find((line) => line.includes("╭─ ✦ TODOS"));
		const bottom = sidebar.find((line) => line.includes("╰"));
		const card = renderPanelCard("TODOS", "✦", "accent", ["1/3"], 42, false, palette, theme);
		expect(top?.slice(2)).toBe(card[0]);
		expect(bottom?.slice(2)).toBe(card.at(-1));
	});

	it("closes long titles at the requested width", () => {
		const card = renderPanelCard(
			"A VERY LONG PANEL TITLE",
			"✦",
			"accent",
			["summary"],
			24,
			false,
			palette,
			theme,
		);
		expect(visibleWidth(card[0]!)).toBe(24);
		expect(card[0]?.endsWith("╮")).toBe(true);
		expect(visibleWidth(card.at(-1)!)).toBe(24);
	});

	it("renders collapsed cards in exactly three rows", () => {
		expect(
			renderPanelCard("▸ TODOS", "✦", "accent", ["1/3", "ignored"], 24, true, palette, theme),
		).toHaveLength(3);
		expect(renderPanelCard("▸ TODOS", "✦", "accent", [], 24, true, palette, theme)).toHaveLength(3);
	});
});

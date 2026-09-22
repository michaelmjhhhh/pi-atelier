import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { resolveDisplayLayers } from "../src/config.js";
import { createSettingsWorkspace } from "../src/settings-workspace.js";
import {
	DEFAULT_CONFIG,
	type AtelierConfig,
	type DisplayLayerState,
	type DisplayPatch,
} from "../src/types.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
};

function harness(
	initialLayers: DisplayLayerState = {},
	renderConfig: AtelierConfig = DEFAULT_CONFIG,
	sidebarSettings: () => readonly {
		id: AtelierConfig["sidebarPanelLayout"][number]["id"];
		title: string;
		available: boolean;
		visible: boolean;
	}[] = () =>
		DEFAULT_CONFIG.sidebarPanelLayout.map((entry) => ({
			id: entry.id,
			title: entry.id === "agent" ? "Agent" : entry.id,
			available: entry.id !== "tools",
			visible: entry.visible,
		})),
	viewportHeight?: () => number,
) {
	let layers: DisplayLayerState = structuredClone(initialLayers);
	const render = vi.fn();
	const live = vi.fn();
	const close = vi.fn();
	const persist = vi.fn<(patch: DisplayPatch) => Promise<void>>().mockResolvedValue(undefined);
	const component = createSettingsWorkspace({
		getDisplaySettings: () => resolveDisplayLayers(layers).display,
		getDisplayProvenance: () => resolveDisplayLayers(layers).provenance,
		getSessionDisplayOverride: () => layers.session as never,
		replaceSessionDisplayOverride: (value) => {
			const { session: _old, ...lower } = layers;
			layers = value ? { ...lower, session: structuredClone(value) as Record<string, unknown> } : lower;
		},
		clearSessionDisplayOverride: () => {
			const { session: _old, ...lower } = layers;
			layers = lower;
		},
		persistUserDisplayPatch: persist,
		applySavedUserDisplayPatch: (patch) => {
			layers = { ...layers, user: { ...layers.user, ...structuredClone(patch) } };
		},
		getRenderConfig: () => renderConfig,
		getSidebarPanelLayout: sidebarSettings,
		...(viewportHeight ? { getViewportHeight: viewportHeight } : {}),
		theme,
		colorEnabled: false,
		requestWorkspaceRender: render,
		requestLiveRender: live,
		close,
	});
	return {
		component,
		render,
		live,
		close,
		persist,
		get layers() {
			return layers;
		},
	};
}

const text = (component: ReturnType<typeof createSettingsWorkspace>, width = 120) =>
	component.render(width).join("\n");

describe("Display Settings Workspace", () => {
	it("merges newly discovered contributed panels into draft rows and saves enabled panels", async () => {
		let discovered = false;
		const configuredLayout = [
			{ id: "vendor:missing" as const, visible: true },
			...DEFAULT_CONFIG.sidebarPanelLayout,
		];
		const renderConfig = { ...DEFAULT_CONFIG, sidebarPanelLayout: configuredLayout };
		const h = harness({}, renderConfig, () => [
			...configuredLayout.map((entry) => ({
				id: entry.id,
				title: entry.id === "vendor:missing" ? "Missing" : entry.id,
				available: entry.id !== "vendor:missing" && entry.id !== "tools",
				visible: entry.visible,
			})),
			...(discovered
				? [{ id: "vendor:queue" as const, title: "Queue", available: true, visible: false }]
				: []),
		]);
		discovered = true;
		expect(text(h.component)).toContain("Queue");
		expect(text(h.component)).toContain("Missing  unavailable");

		// Two display rows, nine segments, and three actions precede the configured layout.
		for (let index = 0; index < 14 + configuredLayout.length; index += 1) h.component.handleInput("\u001b[B");
		h.component.handleInput(" ");
		h.component.handleInput("s");
		await vi.waitFor(() => expect(h.persist).toHaveBeenCalled());
		expect(h.persist.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				sidebarPanelLayout: expect.arrayContaining([
					{ id: "vendor:missing", visible: true },
					{ id: "vendor:queue", visible: true },
				]),
			}),
		);
		expect(h.persist.mock.calls[0]?.[0].sidebarPanelLayout?.map((entry) => entry.id)).toEqual([
			...configuredLayout.map((entry) => entry.id),
			"vendor:queue",
		]);
	});

	it("defensively sanitizes contributed titles before Settings interpolation", () => {
		const h = harness({}, DEFAULT_CONFIG, () =>
			DEFAULT_CONFIG.sidebarPanelLayout.map((entry) => ({
				id: entry.id,
				title: entry.id === "agent" ? "\u001b[31mSafe\nTitle" : entry.id,
				available: true,
				visible: entry.visible,
			})),
		);
		const rendered = text(h.component);
		expect(rendered).toContain("Safe Title");
		expect(rendered).not.toContain("[31m");
	});

	it("applies a complete preset continuously as one Session mutation and one Undo step", () => {
		const h = harness();
		h.component.handleInput(" ");
		expect(resolveDisplayLayers(h.layers).display).toMatchObject({ preset: "minimal", density: "compact" });
		expect(text(h.component)).toContain("minimal");
		expect(h.live).toHaveBeenCalledOnce();
		h.component.handleInput("u");
		expect(h.layers.session).toBeUndefined();
		expect(resolveDisplayLayers(h.layers).display.preset).toBe("editorial");
	});

	it("accumulates Segment edits, protects required entries, and retains overrides on close", () => {
		const h = harness();
		// Focus performance (preset, density, brand, activity, metrics, performance).
		for (let index = 0; index < 5; index += 1) h.component.handleInput("\u001b[B");
		h.component.handleInput(" ");
		expect(
			resolveDisplayLayers(h.layers).display.segmentLayout.find((entry) => entry.id === "performance")
				?.visible,
		).toBe(true);
		// metrics is required and rejects toggling.
		h.component.handleInput("\u001b[A");
		h.component.handleInput(" ");
		expect(text(h.component)).toContain("metrics is required");
		h.component.handleInput("\u001b");
		expect(h.close).toHaveBeenCalledOnce();
		expect(h.layers.session).toBeDefined();
	});

	it("supports Revert and one-step Undo of Revert without touching lower layers", () => {
		const h = harness();
		h.component.handleInput(" ");
		h.component.handleInput("r");
		expect(h.layers.session).toBeUndefined();
		h.component.handleInput("u");
		expect(resolveDisplayLayers(h.layers).display.preset).toBe("minimal");
	});

	it("persists the current Display as the User default and keeps the workspace open", async () => {
		const h = harness();
		h.component.handleInput(" ");
		h.component.handleInput("s");
		await vi.waitFor(() => expect(text(h.component)).toContain("Saved as User default"));
		expect(h.persist).toHaveBeenCalledOnce();
		expect(h.layers.user).toMatchObject({ preset: "minimal", density: "compact" });
		expect(h.close).not.toHaveBeenCalled();
	});

	it("saves only Display fields and keeps failed saves and Undo history intact", async () => {
		const h = harness();
		h.component.handleInput(" ");
		h.persist.mockRejectedValueOnce(new Error("disk full"));
		h.component.handleInput("s");
		await vi.waitFor(() => expect(text(h.component)).toContain("Save failed: disk full"));
		expect(h.layers.session).toBeDefined();
		h.component.handleInput("u");
		expect(h.layers.session).toBeUndefined();
		expect(h.persist.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({ preset: "minimal", density: "compact", segmentLayout: expect.any(Array) }),
		);
		expect(Object.keys(h.persist.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
			"density",
			"preset",
			"segmentLayout",
		]);
	});

	it.each([40, 80, 120])(
		"renders one native-background rounded frame without overflow at %s columns",
		(width) => {
			const h = harness();
			const lines = h.component.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(
				lines.filter(
					(line) => line.includes("╭") || line.includes("╮") || line.includes("╰") || line.includes("╯"),
				),
			).toHaveLength(2);
			expect(lines[0]).toContain("╭");
			expect(lines.at(-1)).toContain("╰");
		},
	);

	it("shows provenance without repeating the complete layout", () => {
		const h = harness({
			user: {
				density: "compact",
				segmentLayout: DEFAULT_CONFIG.segmentLayout.map((entry) => ({ ...entry })),
			},
		});
		const rendered = text(h.component);
		expect(rendered).toContain("Density      compact       user");
		expect(rendered).toContain("order user");
		expect(rendered).not.toContain("brand › activity");
		expect(rendered.indexOf("1  ○ brand")).toBeLessThan(rendered.indexOf("2  ● activity"));
		expect(rendered.indexOf("2  ● activity")).toBeLessThan(rendered.indexOf("3  ◆ metrics"));
	});

	it.each([40, 80, 120])("uses one real responsive Status Rail preview at %s columns", (width) => {
		const h = harness({
			user: {
				segmentLayout: DEFAULT_CONFIG.segmentLayout.map((entry) => ({ ...entry, visible: true })),
			},
		});
		const lines = h.component.render(width);
		const previewStart = lines.findIndex((line) => line.includes(" Preview "));
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(previewStart).toBeGreaterThan(0);
		expect(lines[previewStart + 1]).toContain("CRAFTING");
		expect(lines[previewStart + 2]).toContain("└");
		expect(lines.join("\n")).not.toContain("brand        ATELIER");
	});

	it("bounds the Display Settings frame to the live viewport without clipping its border", () => {
		const h = harness({}, DEFAULT_CONFIG, undefined, () => 39);
		const lines = h.component.render(126);
		expect(lines).toHaveLength(39);
		expect(lines[0]).toContain("╭");
		expect(lines.at(-1)).toContain("╰");
		expect(lines.every((line) => visibleWidth(line) <= 126)).toBe(true);
	});

	it.each([0, 1, 2, 3, 4])("keeps every line within a tiny viewport of %s rows", (viewport) => {
		const h = harness({}, DEFAULT_CONFIG, undefined, () => viewport);
		const lines = h.component.render(126);
		expect(lines).toHaveLength(viewport);
		expect(lines.every((line) => visibleWidth(line) <= 126)).toBe(true);
		if (viewport >= 2) {
			expect(lines[0]).toContain("╭");
			expect(lines.at(-1)).toContain("╰");
		} else {
			expect(lines.join("\n")).not.toContain("╭");
		}
	});

	it("keeps top, middle, and bottom scroll states structurally focused", () => {
		const top = harness({}, DEFAULT_CONFIG, undefined, () => 39);
		const topLines = text(top.component);
		expect(topLines).toContain("↓ more");
		expect(topLines).not.toContain("↑ more");

		const middle = harness({}, DEFAULT_CONFIG, undefined, () => 15);
		const middleLines = text(middle.component);
		expect(middleLines).toContain("↑ more");
		expect(middleLines).toContain("↓ more");

		for (let index = 0; index < 100; index += 1) middle.component.handleInput("\u001b[B");
		const bottomLines = text(middle.component);
		expect(bottomLines).toContain("↑ more");
		expect(bottomLines).not.toContain("↓ more");
	});

	it("does not treat a contributed title containing the focus glyph as the focused row", () => {
		const h = harness(
			{},
			DEFAULT_CONFIG,
			() =>
				DEFAULT_CONFIG.sidebarPanelLayout.map((entry) => ({
					id: entry.id,
					title: entry.id === "agent" ? "Contributed › title" : entry.id,
					available: true,
					visible: entry.visible,
				})),
			() => 39,
		);
		for (let index = 0; index < 100; index += 1) h.component.handleInput("\u001b[B");
		const lines = h.component.render(126);
		expect(lines.join("\n")).toContain("Contributed › title");
		expect(lines.join("\n")).toContain("› Restore default");
		expect(lines).toHaveLength(39);
		expect(lines.every((line) => visibleWidth(line) <= 126)).toBe(true);
	});

	it("keeps the focused last Sidebar action visible while scrolling", () => {
		const h = harness({}, DEFAULT_CONFIG, undefined, () => 39);
		for (let index = 0; index < 100; index += 1) h.component.handleInput("\u001b[B");
		const lines = h.component.render(126);
		expect(lines.join("\n")).toContain("› Restore default");
		expect(lines.at(-1)).toContain("╰");
		expect(lines).toHaveLength(39);
	});

	it("shows deterministic scroll indicators and adapts to live viewport resizing", () => {
		let viewport = 39;
		const h = harness({}, DEFAULT_CONFIG, undefined, () => viewport);
		for (let index = 0; index < 100; index += 1) h.component.handleInput("\u001b[B");
		const bottom = h.component.render(126).join("\n");
		expect(bottom).toContain("↑ more");
		expect(bottom).not.toContain("↓ more");

		viewport = 30;
		const smaller = h.component.render(126);
		expect(smaller).toHaveLength(30);
		expect(smaller.join("\n")).toContain("› Restore default");
		expect(smaller.join("\n")).toContain("↑ more");

		viewport = 50;
		const larger = h.component.render(126);
		expect(larger).toHaveLength(50);
		expect(larger.join("\n")).toContain("› Restore default");
		expect(larger.join("\n")).not.toContain("↓ more");
		expect(larger.every((line) => visibleWidth(line) <= 126)).toBe(true);
	});

	it("keeps value, provenance, and action shortcut columns fixed", () => {
		const h = harness();
		const before = h.component.render(120);
		h.component.handleInput("\u001b[B");
		const after = h.component.render(120);
		for (const label of ["Preset", "Density"]) {
			const beforeLine = before.find((line) => line.includes(label));
			const afterLine = after.find((line) => line.includes(label));
			expect(beforeLine).toBeDefined();
			expect(afterLine).toBeDefined();
			expect(beforeLine?.indexOf(label === "Preset" ? "editorial" : "comfortable")).toBe(
				afterLine?.indexOf(label === "Preset" ? "editorial" : "comfortable"),
			);
			expect(beforeLine?.indexOf("product")).toBe(afterLine?.indexOf("product"));
		}
		const save = before.find((line) => line.includes("Save default"));
		const revert = before.find((line) => line.includes("Revert session"));
		const undo = before.find((line) => line.includes("Undo"));
		expect(save?.lastIndexOf("S")).toBe(revert?.lastIndexOf("R"));
		expect(revert?.lastIndexOf("R")).toBe(undo?.lastIndexOf("—"));
	});

	it("uses stacked panels narrowly and equal-bottom side-by-side panels widely", () => {
		const h = harness();
		const narrow = h.component.render(40);
		expect(narrow.findIndex((line) => line.includes(" Display "))).toBeLessThan(
			narrow.findIndex((line) => line.includes(" Segment Editor ")),
		);
		const wide = h.component.render(120);
		const sideBySide = wide.find((line) => line.includes(" Display ") && line.includes(" Segment Editor "));
		expect(sideBySide).toBeDefined();
		expect(wide.some((line) => (line.match(/└/g) ?? []).length === 2)).toBe(true);
	});
});

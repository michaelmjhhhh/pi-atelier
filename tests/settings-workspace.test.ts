import { plainTheme as theme } from "./helpers/render.js";
import { settleMicrotasks } from "./helpers/async.js";
import { requiredRow } from "./helpers/render.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { resolveDisplayLayers, DEFAULT_CONFIG } from "../src/config.js";
import { createSettingsWorkspace, type SettingsPage } from "../src/settings-workspace.js";
import { type AtelierConfig, type DisplayLayerState, type DisplayPatch } from "../src/types.js";

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
	initialPage: SettingsPage = "rail",
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
		getSidebarPanelSettings: sidebarSettings,
		preferences: {
			setNerdFont: vi.fn().mockResolvedValue(undefined),
			setShowFooter: vi.fn().mockResolvedValue(undefined),
			setCompletionNotifications: vi.fn().mockResolvedValue(undefined),
			setPrefillEnabled: vi.fn().mockResolvedValue(undefined),
			setSidebarStyle: vi.fn().mockResolvedValue(undefined),
			setSidebarAnchor: vi.fn().mockResolvedValue(undefined),
			setReserveSidebarToolRows: vi.fn().mockResolvedValue(undefined),
			setShowSidebarOnStartup: vi.fn().mockResolvedValue(undefined),
			isToolListExpanded: () => false,
			toggleToolList: vi.fn().mockResolvedValue(undefined),
			setSessionRecap: vi.fn().mockResolvedValue(undefined),
			setSessionRecapModel: vi.fn().mockResolvedValue(undefined),
			getRecapModels: () => [],
		},
		initialPage,
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

describe("Settings Workspace", () => {
	it("merges newly discovered contributed panels into draft rows and saves enabled panels", async () => {
		let discovered = false;
		const configuredLayout = [
			{ id: "vendor:missing" as const, visible: true },
			...DEFAULT_CONFIG.sidebarPanelLayout,
		];
		const renderConfig = { ...DEFAULT_CONFIG, sidebarPanelLayout: configuredLayout };
		const h = harness(
			{},
			renderConfig,
			() => [
				...configuredLayout.map((entry) => ({
					id: entry.id,
					title: entry.id === "vendor:missing" ? "Missing" : entry.id,
					available: entry.id !== "vendor:missing" && entry.id !== "tools",
					visible: entry.visible,
				})),
				...(discovered
					? [{ id: "vendor:queue" as const, title: "Queue", available: true, visible: false }]
					: []),
			],
			undefined,
			"sidebar",
		);
		discovered = true;
		expect(text(h.component)).toContain("Queue");
		expect(text(h.component)).toMatch(/● Missing +unavailable/);

		// Six Sidebar settings and the configured layout precede the discovered panel.
		for (let index = 0; index < configuredLayout.length + 6; index += 1) h.component.handleInput("\u001b[B");
		h.component.handleInput(" ");
		h.component.handleInput("s");
		expect(h.persist).toHaveBeenCalled();
		await settleMicrotasks();
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

	it("accumulates Segment edits and retains overrides on close", () => {
		const h = harness();
		// Focus performance: preset, density, pi, brand, activity, and metrics precede it.
		for (let index = 0; index < 6; index += 1) h.component.handleInput("\u001b[B");
		h.component.handleInput(" ");
		expect(
			resolveDisplayLayers(h.layers).display.segmentLayout.find((entry) => entry.id === "performance")
				?.visible,
		).toBe(true);
		// Metrics can be hidden too.
		h.component.handleInput("\u001b[A");
		h.component.handleInput(" ");
		expect(
			resolveDisplayLayers(h.layers).display.segmentLayout.find((entry) => entry.id === "metrics")?.visible,
		).toBe(false);
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
		await settleMicrotasks();
		expect(text(h.component)).toContain("Saved as your default");
		expect(h.persist).toHaveBeenCalledOnce();
		expect(h.layers.user).toMatchObject({ preset: "minimal", density: "compact" });
		expect(h.close).not.toHaveBeenCalled();
	});

	it("saves only Display fields and keeps failed saves and Undo history intact", async () => {
		const h = harness();
		h.component.handleInput(" ");
		h.persist.mockRejectedValueOnce(new Error("disk full"));
		h.component.handleInput("s");
		await settleMicrotasks();
		expect(text(h.component)).toContain("Save failed: disk full");
		expect(h.layers.session).toBeDefined();
		h.component.handleInput("u");
		expect(h.layers.session).toBeUndefined();
		expect(h.persist.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({ preset: "minimal", density: "compact", segmentLayout: expect.any(Array) }),
		);
		expect(Object.keys(h.persist.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
			"density",
			"hiddenFooterFields",
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
		expect(rendered).toMatch(/Density +compact +saved/);
		expect(rendered.indexOf("○ Brand")).toBeLessThan(rendered.indexOf("● Activity"));
		expect(rendered.indexOf("● Activity")).toBeLessThan(rendered.indexOf("● Tokens & cost"));
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
	});

	it("bounds the Settings frame to the live viewport and the tallest page without clipping its border", () => {
		let viewport = 39;
		const h = harness({}, DEFAULT_CONFIG, undefined, () => viewport);
		const natural = h.component.render(126);
		expect(natural.length).toBeLessThan(39);
		viewport = 20;
		const lines = h.component.render(126);
		expect(lines).toHaveLength(20);
		expect(lines[0]).toContain("╭");
		expect(lines.at(-1)).toContain("╰");
		expect(lines.every((line) => visibleWidth(line) <= 126)).toBe(true);
		// Every page keeps the same height.
		viewport = 39;
		h.component.handleInput("\t");
		expect(h.component.render(126)).toHaveLength(natural.length);
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
		const h = harness({}, DEFAULT_CONFIG, undefined, () => 14, "sidebar");
		const topLines = text(h.component, 126);
		expect(topLines).toContain("↓ more");
		expect(topLines).not.toContain("↑ more");

		for (let index = 0; index < 8; index += 1) h.component.handleInput("\u001b[B");
		const middleLines = text(h.component, 126);
		expect(middleLines).toContain("↑ more");
		expect(middleLines).toContain("↓ more");

		for (let index = 0; index < 100; index += 1) h.component.handleInput("\u001b[B");
		const bottomLines = text(h.component, 126);
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
			"sidebar",
		);
		for (let index = 0; index < 100; index += 1) h.component.handleInput("\u001b[B");
		const lines = h.component.render(126);
		expect(lines.join("\n")).toContain("Contributed › title");
		expect(lines.join("\n")).toContain("› ○ tools");
		expect(lines.filter((line) => line.includes("›"))).toHaveLength(2);
		expect(lines.every((line) => visibleWidth(line) <= 126)).toBe(true);
	});

	it("keeps the focused last Sidebar panel visible while scrolling", () => {
		const h = harness({}, DEFAULT_CONFIG, undefined, () => 14, "sidebar");
		for (let index = 0; index < 100; index += 1) h.component.handleInput("\u001b[B");
		const lines = h.component.render(126);
		expect(lines.join("\n")).toContain("› ○ tools");
		expect(lines.at(-1)).toContain("╰");
		expect(lines).toHaveLength(14);
	});

	it("shows deterministic scroll indicators and adapts to live viewport resizing", () => {
		let viewport = 13;
		const h = harness({}, DEFAULT_CONFIG, undefined, () => viewport, "sidebar");
		for (let index = 0; index < 100; index += 1) h.component.handleInput("\u001b[B");
		const bottom = h.component.render(60).join("\n");
		expect(bottom).toContain("↑ more");
		expect(bottom).not.toContain("↓ more");

		viewport = 12;
		const smaller = h.component.render(126);
		expect(smaller).toHaveLength(12);
		expect(smaller.join("\n")).toContain("› ○ tools");
		expect(smaller.join("\n")).toContain("↑ more");

		viewport = 50;
		const larger = h.component.render(126);
		expect(larger.length).toBeLessThan(50);
		expect(larger.join("\n")).toContain("› ○ tools");
		expect(larger.join("\n")).not.toContain("↓ more");
		expect(larger.every((line) => visibleWidth(line) <= 126)).toBe(true);
	});

	it("keeps value and provenance columns fixed", () => {
		const h = harness();
		const before = h.component.render(120);
		h.component.handleInput("\u001b[B");
		const after = h.component.render(120);
		for (const label of ["Preset", "Density"]) {
			const beforeLine = requiredRow(before, label);
			const afterLine = requiredRow(after, label);
			expect(beforeLine.indexOf(label === "Preset" ? "editorial" : "comfortable")).toBe(
				afterLine.indexOf(label === "Preset" ? "editorial" : "comfortable"),
			);
			expect(beforeLine.indexOf("default")).toBe(afterLine.indexOf("default"));
		}
	});
});

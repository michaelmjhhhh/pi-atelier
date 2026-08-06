import { describe, expect, it, vi } from "vitest";
import { resolveDisplayLayers } from "../src/config.js";

const rootMenuItems = vi.hoisted(() => [] as Array<Array<Record<string, unknown>>>);
vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
	return {
		...actual,
		SelectList: class extends actual.SelectList {
			constructor(items: any[], ...rest: any[]) {
				rootMenuItems.push(items);
				super(items, ...(rest as [any, any]));
			}
		},
	};
});

import { derivePresetIdentity } from "../src/display.js";
import {
	createMenuActions,
	openAtelierControlCenter,
	openAtelierMenu,
	renderMenuBorder,
	renderMenuFrame,
	type SidebarControls,
} from "../src/menu.js";
import { DEFAULT_CONFIG, type DisplayPatch } from "../src/types.js";
import { getDisplaySettingsViewportHeight } from "../src/settings-workspace.js";

function harness() {
	let config = {
		...DEFAULT_CONFIG,
		segmentLayout: DEFAULT_CONFIG.segmentLayout.map((entry) => ({ ...entry })),
	};
	const runtime = {
		getConfig: vi.fn(() => config),
		getDisplaySettings: vi.fn(() => ({
			preset: config.preset,
			density: config.density,
			segmentLayout: config.segmentLayout.map((entry) => ({ ...entry })),
		})),
		getDisplayProvenance: vi.fn(() => resolveDisplayLayers({}).provenance),
		getSessionDisplayOverride: vi.fn(() => undefined),
		replaceSessionDisplayOverride: vi.fn(),
		clearSessionDisplayOverride: vi.fn(),
		applySavedUserDisplayPatch: vi.fn(),
		getSidebarPanelSettings: vi.fn(() =>
			DEFAULT_CONFIG.sidebarPanelLayout.map((entry) => ({
				id: entry.id,
				title: entry.id,
				available: true,
				visible: entry.visible,
			})),
		),
		setSessionDisplayPatch: vi.fn((patch: DisplayPatch) => {
			config = { ...config, ...patch };
			config.preset = derivePresetIdentity(config);
		}),
		setConfig: vi.fn((next) => {
			config = next;
		}),
		refreshUsage: vi.fn(),
	};
	const pi = {
		setModel: vi.fn().mockResolvedValue(true),
		getThinkingLevel: vi.fn().mockReturnValue("medium"),
		setThinkingLevel: vi.fn(),
		getAllTools: vi.fn().mockReturnValue([{ name: "read" }, { name: "bash" }]),
		getActiveTools: vi.fn().mockReturnValue(["read"]),
		setActiveTools: vi.fn(),
		setSessionName: vi.fn(),
	};
	const ctx = {
		model: { id: "old", provider: "provider" },
		ui: { notify: vi.fn(), input: vi.fn(), confirm: vi.fn(), custom: vi.fn() },
		compact: vi.fn(),
	};
	const save = vi.fn().mockResolvedValue(undefined);
	const savePatch = vi.fn().mockResolvedValue(undefined);
	const actions = createMenuActions(
		pi as never,
		ctx as never,
		runtime as never,
		"/tmp/user.json",
		save,
		savePatch,
	);
	return { actions, pi, ctx, runtime, save, savePatch };
}

describe("Control Center presentation", () => {
	function contextWithSelections(
		values: string[],
		terminal: { columns: number; rows: number } = { columns: 140, rows: 42 },
		customComponents: unknown[] = [],
	) {
		return {
			mode: "tui",
			model: { id: "old", provider: "provider" },
			modelRegistry: { getAvailable: vi.fn().mockReturnValue([]) },
			sessionManager: { getSessionFile: vi.fn().mockReturnValue("/tmp/session.jsonl") },
			compact: vi.fn(),
			ui: {
				notify: vi.fn(),
				custom: vi.fn((factory: (...args: any[]) => unknown, _options?: unknown) => {
					const value = values.shift();
					customComponents.push(
						factory(
							{ requestRender: vi.fn(), terminal },
							{
								fg: (_color: string, text: string) => text,
								bold: (text: string) => text,
								italic: (text: string) => text,
							},
							{},
							vi.fn(),
						),
					);
					return Promise.resolve(value);
				}),
			},
		};
	}

	it("partitions Settings, Controls, and Actions at the root with current Sidebar state", async () => {
		rootMenuItems.length = 0;
		const sidebar: SidebarControls = {
			isVisible: vi.fn(() => true),
			toggle: vi.fn(),
			isToolListExpanded: vi.fn(() => false),
			toggleToolList: vi.fn().mockResolvedValue(undefined),
		};
		await openAtelierMenu(
			{} as never,
			contextWithSelections(["close"]) as never,
			harness().runtime as never,
			"/tmp/user.json",
			sidebar,
		);
		expect(rootMenuItems[0]?.map((item) => item.label)).toEqual(["Settings", "Controls", "Actions", "Close"]);
		expect(rootMenuItems[0]?.find((item) => item.value === "controls")?.description).toContain("Sidebar: On");
	});

	it.each([
		[
			"settings",
			[
				"Display: editorial",
				"Sidebar on startup: On",
				"Completion notifications: On",
				"Sidebar tool list: Collapsed",
				"Back",
			],
		],
		["actions", ["Session details", "Rename session", "Compact session", "Back"]],
	] as const)("routes the %s root category to its destination", async (category, expectedLabels) => {
		rootMenuItems.length = 0;
		const sidebar: SidebarControls = {
			isVisible: vi.fn(() => true),
			toggle: vi.fn(),
			isToolListExpanded: vi.fn(() => false),
			toggleToolList: vi.fn().mockResolvedValue(undefined),
		};
		await openAtelierMenu(
			{} as never,
			contextWithSelections([category, "back", "close"]) as never,
			harness().runtime as never,
			"/tmp/user.json",
			sidebar,
		);
		expect(rootMenuItems[1]?.map((item) => item.label)).toEqual(expectedLabels);
	});

	it("toggles and persists Sidebar startup from Settings", async () => {
		rootMenuItems.length = 0;
		const h = harness();
		const sidebar: SidebarControls = {
			isVisible: vi.fn(() => true),
			toggle: vi.fn(),
			isToolListExpanded: vi.fn(() => false),
			toggleToolList: vi.fn().mockResolvedValue(undefined),
		};

		await openAtelierControlCenter(
			h.pi as never,
			contextWithSelections(["settings", "sidebar-startup", "back", "close"]) as never,
			h.runtime as never,
			"/tmp/user.json",
			sidebar,
			undefined,
			h.savePatch,
		);

		expect(h.runtime.getConfig().showSidebarOnStartup).toBe(false);
		expect(h.savePatch).toHaveBeenCalledWith("/tmp/user.json", { showSidebarOnStartup: false });
	});

	it("routes Control Center Settings → Display to the workspace", async () => {
		rootMenuItems.length = 0;
		const ctx = contextWithSelections(["settings", "display", "workspace-close", "back", "close"]);
		const sidebar: SidebarControls = {
			isVisible: vi.fn(() => true),
			toggle: vi.fn(),
			isToolListExpanded: vi.fn(() => false),
			toggleToolList: vi.fn().mockResolvedValue(undefined),
		};
		await openAtelierControlCenter(
			{} as never,
			ctx as never,
			harness().runtime as never,
			"/tmp/user.json",
			sidebar,
		);
		expect(ctx.ui.custom).toHaveBeenCalledTimes(5);
		expect(ctx.ui.custom.mock.calls[2]?.[1]).toMatchObject({
			overlay: true,
			overlayOptions: expect.objectContaining({ width: "90%" }),
		});
	});

	it("derives the workspace viewport from live terminal rows and Pi overlay rounding", async () => {
		rootMenuItems.length = 0;
		const terminal = { columns: 140, rows: 42 };
		const customComponents: unknown[] = [];
		const ctx = contextWithSelections(
			["settings", "display", "workspace-close", "back", "close"],
			terminal,
			customComponents,
		);
		const sidebar: SidebarControls = {
			isVisible: vi.fn(() => true),
			toggle: vi.fn(),
			isToolListExpanded: vi.fn(() => false),
			toggleToolList: vi.fn().mockResolvedValue(undefined),
		};
		await openAtelierControlCenter(
			{} as never,
			ctx as never,
			harness().runtime as never,
			"/tmp/user.json",
			sidebar,
		);
		const workspace = customComponents[2] as { render(width: number): string[] };
		expect(ctx.ui.custom.mock.calls[2]?.[1]).toMatchObject({
			overlay: true,
			overlayOptions: expect.objectContaining({ maxHeight: "95%", margin: 1 }),
		});
		expect(getDisplaySettingsViewportHeight(42)).toBe(39);
		expect(getDisplaySettingsViewportHeight(30)).toBe(28);
		expect(getDisplaySettingsViewportHeight(50)).toBe(47);
		expect(workspace.render(126)).toHaveLength(39);
		terminal.rows = 30;
		expect(workspace.render(126)).toHaveLength(28);
		terminal.rows = 50;
		expect(workspace.render(126)).toHaveLength(47);
	});

	it("keeps Sidebar visibility in Controls and session-scoped", async () => {
		rootMenuItems.length = 0;
		const sidebar: SidebarControls = {
			isVisible: vi.fn(() => true),
			toggle: vi.fn(),
			isToolListExpanded: vi.fn(() => false),
			toggleToolList: vi.fn().mockResolvedValue(undefined),
		};
		await openAtelierMenu(
			{
				getThinkingLevel: vi.fn().mockReturnValue("medium"),
				getActiveTools: vi.fn().mockReturnValue([]),
			} as never,
			contextWithSelections(["controls", "sidebar", "back", "close"]) as never,
			harness().runtime as never,
			"/tmp/user.json",
			sidebar,
		);
		expect(sidebar.toggle).toHaveBeenCalledOnce();
	});

	it("uses a heavy theme-aware border that fills the available width", () => {
		const theme = { fg: vi.fn((_color: string, text: string) => text), bold: vi.fn((text: string) => text) };
		expect(renderMenuBorder(theme, 6)).toBe("━━━━━━");
		expect(theme.fg).toHaveBeenCalledWith("borderAccent", "━━━━━━");
	});

	it("frames every content row with heavy vertical borders and corners", () => {
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		expect(renderMenuFrame(theme, ["Hi"], 8)).toEqual(["┏━━━━━━┓", "┃Hi    ┃", "┗━━━━━━┛"]);
	});
});

describe("menu actions", () => {
	it.each([
		["editorial", ["activity", "metrics", "context", "model", "git", "statuses", "menu"]],
		["minimal", ["activity", "metrics", "context", "model", "menu"]],
		["classic", ["metrics", "context", "model", "git", "statuses"]],
	] as const)("applies the complete %s template", (preset, visible) => {
		const h = harness();
		h.actions.setPreset(preset);
		expect(h.runtime.getConfig().segmentLayout).toHaveLength(9);
		expect(
			h.runtime
				.getConfig()
				.segmentLayout.filter((entry) => entry.visible)
				.map((entry) => entry.id),
		).toEqual(visible);
		expect(h.runtime.getConfig().preset).toBe(preset);
	});

	it("toggles in place, protects required entries, and reorders across hidden neighbors", () => {
		const h = harness();
		const initialOrder = h.runtime.getConfig().segmentLayout.map((entry) => entry.id);
		h.actions.toggleSegment("performance");
		h.actions.toggleSegment("metrics");
		expect(h.runtime.getConfig().segmentLayout.map((entry) => entry.id)).toEqual(initialOrder);
		expect(h.runtime.getConfig().segmentLayout.find((entry) => entry.id === "performance")?.visible).toBe(
			true,
		);
		expect(h.runtime.getConfig().segmentLayout.find((entry) => entry.id === "metrics")?.visible).toBe(true);
		h.actions.moveSegment("context", "earlier");
		expect(
			h.runtime
				.getConfig()
				.segmentLayout.map((entry) => entry.id)
				.slice(2, 5),
		).toEqual(["metrics", "context", "performance"]);
		expect(h.runtime.getConfig().preset).toBe("custom");
	});

	it("keeps the prior model when authentication fails", async () => {
		const h = harness();
		h.pi.setModel.mockResolvedValue(false);
		await h.actions.selectModel({ id: "new", provider: "provider" } as never);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("authentication"), "error");
		expect(h.runtime.refreshUsage).not.toHaveBeenCalled();
	});

	it("restores model and thinking level when refresh fails after mutation", async () => {
		const h = harness();
		h.runtime.refreshUsage.mockImplementation(() => {
			throw new Error("refresh failed");
		});
		await h.actions.selectModel({ id: "new", provider: "provider" } as never);
		expect(h.pi.setModel).toHaveBeenLastCalledWith(h.ctx.model);
		h.actions.setThinkingLevel("high");
		expect(h.pi.setThinkingLevel).toHaveBeenLastCalledWith("medium");
	});

	it("filters unknown tools before applying selection", () => {
		const h = harness();
		h.actions.setTools(["read", "missing"]);
		expect(h.pi.setActiveTools).toHaveBeenCalledWith(["read"]);
	});

	it("persists the global Sidebar startup preference", async () => {
		const h = harness();

		await h.actions.setShowSidebarOnStartup(false);

		expect(h.runtime.getConfig().showSidebarOnStartup).toBe(false);
		expect(h.savePatch).toHaveBeenCalledWith("/tmp/user.json", { showSidebarOnStartup: false });
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Sidebar will start hidden", "info");
	});

	it("persists only completion notifications while display changes remain session-scoped", async () => {
		const h = harness();
		h.actions.setPreset("minimal");
		await h.actions.setCompletionNotifications(false);
		expect(h.runtime.getConfig().completionNotifications).toBe(false);
		expect(h.savePatch).toHaveBeenCalledWith("/tmp/user.json", { completionNotifications: false });
		expect(h.save).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Completion notifications disabled", "info");
	});

	it("persists display changes only after explicit save", async () => {
		const h = harness();
		h.actions.setPreset("minimal");
		expect(h.save).not.toHaveBeenCalled();
		await h.actions.saveDisplayDefaults();
		expect(h.savePatch).toHaveBeenCalledWith("/tmp/user.json", h.runtime.getDisplaySettings());
		expect(h.save).not.toHaveBeenCalled();
	});

	it("restores the ornament-free Status Rail defaults when selecting editorial", () => {
		const h = harness();
		h.actions.setPreset("minimal");
		h.actions.setDensity("compact");
		h.actions.setOrnament("restrained");
		h.actions.setPreset("editorial");
		expect(h.runtime.getConfig()).toMatchObject({
			preset: "editorial",
			segmentLayout: DEFAULT_CONFIG.segmentLayout,
			density: "comfortable",
		});
	});

	it("maps classic to its compatible segments and presentation", () => {
		const h = harness();
		h.actions.setPreset("minimal");
		h.actions.setDensity("compact");
		h.actions.setOrnament("restrained");
		h.actions.setPreset("classic");
		expect(h.runtime.getConfig()).toMatchObject({
			preset: "classic",
			density: "comfortable",
		});
		expect(
			h.runtime
				.getConfig()
				.segmentLayout.filter((entry) => entry.visible)
				.map((entry) => entry.id),
		).toEqual(["metrics", "context", "model", "git", "statuses"]);
	});

	it("renames a session only after non-empty input", async () => {
		const h = harness();
		h.ctx.ui.custom.mockImplementationOnce((factory: (...args: any[]) => any) => {
			let result: string | undefined;
			const component = factory(
				{ requestRender: vi.fn(), terminal: { rows: 36 } },
				{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
				{},
				(value: string | undefined) => {
					result = value;
				},
			);
			component.handleInput("\r");
			return Promise.resolve(result);
		});
		await h.actions.renameSession();
		expect(h.pi.setSessionName).toHaveBeenCalledWith("Release prep");
	});

	it("rolls back tools and reports synchronous action failures", () => {
		const h = harness();
		h.pi.setActiveTools.mockImplementationOnce(() => {
			throw new Error("tool failure");
		});
		h.actions.setTools(["bash"]);
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith(["read"]);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("tool failure"), "error");
	});

	it("updates density, ornament, and segment order through display controls", () => {
		const h = harness();
		h.actions.setDensity("compact");
		h.actions.setOrnament("none");
		h.actions.moveSegment("context", "earlier");
		expect(h.runtime.getConfig()).toMatchObject({ density: "compact", preset: "custom" });
		expect(h.runtime.getConfig().segmentLayout.findIndex((entry) => entry.id === "context")).toBeLessThan(
			h.runtime.getConfig().segmentLayout.findIndex((entry) => entry.id === "performance"),
		);
	});

	it("does not compact without confirmation", async () => {
		const h = harness();
		h.ctx.ui.confirm.mockResolvedValue(false);
		await h.actions.compactSession();
		expect(h.ctx.compact).not.toHaveBeenCalled();
	});
});

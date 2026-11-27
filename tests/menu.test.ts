import { deferred } from "./helpers/async.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDisplayLayers, DEFAULT_CONFIG } from "../src/config.js";

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

import {
	createMenuActions,
	openAtelierControlCenter,
	openSettingsWorkspace,
	type SidebarControls,
} from "../src/menu.js";
import { getSettingsViewportHeight } from "../src/settings-workspace.js";

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
			hiddenFooterFields: [...config.hiddenFooterFields],
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
	};
	const ctx = {
		model: { id: "old", provider: "provider" },
		ui: { notify: vi.fn(), custom: vi.fn() },
	};
	const savePatch = vi.fn().mockResolvedValue(undefined);
	const actions = createMenuActions(pi as never, ctx as never, runtime as never, "/tmp/user.json", savePatch);
	return { actions, pi, ctx, runtime, savePatch };
}

function sidebarControls(): SidebarControls {
	return {
		getStatus: vi.fn(() => ({ mode: "manual" as const, enabled: true, presentation: "shown" as const })),
		setMode: vi.fn(),
		toggle: vi.fn(),
		isToolListExpanded: vi.fn(() => false),
		toggleToolList: vi.fn().mockResolvedValue(undefined),
		getSidebarPanelSettings: vi.fn(() =>
			DEFAULT_CONFIG.sidebarPanelLayout.map((entry) => ({
				id: entry.id,
				title: entry.id,
				available: true,
				visible: entry.visible,
			})),
		),
	};
}

describe("Control Center presentation", () => {
	beforeEach(() => {
		rootMenuItems.length = 0;
	});

	function contextWithSelections(
		values: string[],
		terminal: { columns: number; rows: number } = { columns: 140, rows: 42 },
		customComponents: unknown[] = [],
	) {
		return {
			mode: "tui",
			model: { id: "old", provider: "provider" },
			modelRegistry: { getAvailable: vi.fn().mockReturnValue([]) },
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

	it("partitions Settings and Controls at the root with current Sidebar state", async () => {
		const sidebar = sidebarControls();
		await openAtelierControlCenter(
			{} as never,
			contextWithSelections(["close"]) as never,
			harness().runtime as never,
			"/tmp/user.json",
			sidebar,
		);
		expect(rootMenuItems[0]?.map((item) => item.label)).toEqual(["Settings", "Controls", "Close"]);
		expect(rootMenuItems[0]?.find((item) => item.value === "controls")?.description).toContain(
			"Sidebar: Manual",
		);
	});

	it("opens the Settings workspace from the Control Center root", async () => {
		const ctx = contextWithSelections(["settings", undefined as never, "close"]);
		await openAtelierControlCenter(
			{} as never,
			ctx as never,
			harness().runtime as never,
			"/tmp/user.json",
			sidebarControls(),
		);
		expect(rootMenuItems).toHaveLength(2);
		expect(ctx.ui.custom).toHaveBeenCalledTimes(3);
		expect(ctx.ui.custom.mock.calls[1]?.[1]).toMatchObject({
			overlay: true,
			overlayOptions: expect.objectContaining({ width: "90%" }),
		});
	});

	it("releases a normally closed Settings workspace from its lifetime", async () => {
		const registrations = new Set<() => void>();
		const callbacks: Array<() => void> = [];
		const components: any[] = [];
		const pending = deferred<void>();
		const h = harness();
		(h.ctx as any).mode = "tui";
		(h.ctx.ui.custom as any).mockImplementation((factory: (...args: any[]) => any) => {
			const done = vi.fn(() => pending.resolve(undefined));
			components.push(
				factory(
					{ requestRender: vi.fn(), terminal: { columns: 140, rows: 42 } },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
					{},
					done,
				),
			);
			return pending.promise;
		});
		const lifetime = {
			isActive: () => true,
			register: (cancel: () => void) => {
				registrations.add(cancel);
				callbacks.push(cancel);
				return () => registrations.delete(cancel);
			},
		};
		const opening = openSettingsWorkspace(
			h.pi as never,
			h.ctx as never,
			h.runtime as never,
			"/tmp/user.json",
			sidebarControls(),
			() => undefined,
			h.savePatch,
			{ lifetime },
		);
		expect(components).toHaveLength(1);
		components[0].handleInput("\u001b");
		await opening;

		expect(registrations).toHaveLength(0);
		const getDisplaySettings = h.runtime.getDisplaySettings;
		getDisplaySettings.mockClear();
		for (const callback of callbacks) callback();
		expect(components[0].render(80)).toEqual([]);
		expect(getDisplaySettings).not.toHaveBeenCalled();
	});

	it("persists status rail changes through the active callbacks", async () => {
		const h = harness();
		const components: any[] = [];
		const ctx = contextWithSelections([], { columns: 140, rows: 42 }, components);
		const requestAllRenders = vi.fn();
		await openSettingsWorkspace(
			h.pi as never,
			ctx as never,
			h.runtime as never,
			"/tmp/user.json",
			sidebarControls(),
			requestAllRenders,
			h.savePatch,
			{ page: "rail" },
		);

		const workspace = components[0] as { handleInput(data: string): void };
		workspace.handleInput(" ");
		workspace.handleInput("s");
		expect(h.savePatch).toHaveBeenCalledOnce();
		expect(requestAllRenders).toHaveBeenCalled();
		expect(h.savePatch).toHaveBeenCalledWith(
			"/tmp/user.json",
			expect.objectContaining({ preset: expect.any(String) }),
		);
	});

	it("propagates Control Center renders through the active callbacks", async () => {
		const h = harness();
		const components: any[] = [];
		const ctx = contextWithSelections(
			["settings", undefined as never, "close"],
			{ columns: 140, rows: 42 },
			components,
		);
		const requestAllRenders = vi.fn();
		const sidebar = sidebarControls();
		await openAtelierControlCenter(
			h.pi as never,
			ctx as never,
			h.runtime as never,
			"/tmp/user.json",
			sidebar,
			requestAllRenders,
			h.savePatch,
		);
		// General opens first; Enter on Font applies and saves it at once.
		const workspace = components[1] as { handleInput(data: string): void };
		workspace.handleInput("\r");
		expect(h.savePatch).toHaveBeenCalledWith("/tmp/user.json", { nerdFont: true });
		expect(requestAllRenders).toHaveBeenCalled();
	});

	it("toggles and persists Sidebar startup from Settings", async () => {
		const h = harness();
		const components: any[] = [];
		await openSettingsWorkspace(
			h.pi as never,
			contextWithSelections([], { columns: 140, rows: 42 }, components) as never,
			h.runtime as never,
			"/tmp/user.json",
			sidebarControls(),
			undefined,
			h.savePatch,
			{ page: "sidebar" },
		);
		const workspace = components[0] as { handleInput(data: string): void };
		for (let index = 0; index < 3; index += 1) workspace.handleInput("\u001b[B");
		workspace.handleInput("\r");

		expect(h.runtime.getConfig().showSidebarOnStartup).toBe(false);
		expect(h.savePatch).toHaveBeenCalledWith("/tmp/user.json", { showSidebarOnStartup: false });
	});

	it("derives the workspace viewport from live terminal rows and Pi overlay rounding", async () => {
		const terminal = { columns: 140, rows: 42 };
		const customComponents: unknown[] = [];
		const ctx = contextWithSelections(["settings", undefined as never, "close"], terminal, customComponents);
		const sidebar = sidebarControls();
		await openAtelierControlCenter(
			{} as never,
			ctx as never,
			harness().runtime as never,
			"/tmp/user.json",
			sidebar,
		);
		const workspace = customComponents[1] as { render(width: number): string[] };
		expect(ctx.ui.custom.mock.calls[1]?.[1]).toMatchObject({
			overlay: true,
			overlayOptions: expect.objectContaining({ maxHeight: "95%", margin: 1 }),
		});
		expect(getSettingsViewportHeight(42)).toBe(39);
		expect(getSettingsViewportHeight(20)).toBe(18);
		expect(getSettingsViewportHeight(16)).toBe(14);
		terminal.rows = 20;
		expect(workspace.render(126)).toHaveLength(18);
		terminal.rows = 16;
		expect(workspace.render(126)).toHaveLength(14);
	});

	it("toggles Sidebar visibility from Controls", async () => {
		const sidebar = sidebarControls();
		await openAtelierControlCenter(
			{
				getThinkingLevel: vi.fn().mockReturnValue("medium"),
				getActiveTools: vi.fn().mockReturnValue([]),
			} as never,
			contextWithSelections(["controls", "sidebar", "toggle", "back", "close"]) as never,
			harness().runtime as never,
			"/tmp/user.json",
			sidebar,
		);
		expect(sidebar.toggle).toHaveBeenCalledOnce();
	});
});

describe("menu actions", () => {
	it("keeps the prior model when authentication fails", async () => {
		const h = harness();
		h.pi.setModel.mockResolvedValue(false);
		await h.actions.selectModel({ id: "new", provider: "provider" } as never);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("authentication"), "error");
		expect(h.runtime.refreshUsage).not.toHaveBeenCalled();
	});

	it("does not refresh or notify after a stale model selection completes", async () => {
		const h = harness();
		const pending = deferred<boolean>();
		let active = true;
		h.pi.setModel.mockReturnValue(pending.promise);
		const actions = createMenuActions(
			h.pi as never,
			h.ctx as never,
			h.runtime as never,
			"/tmp/user.json",
			h.savePatch,
			{
				lifetime: {
					isActive: () => active,
					register: () => () => undefined,
				},
			},
		);
		const selection = actions.selectModel({ id: "new", provider: "provider" } as never);
		active = false;
		pending.resolve(true);
		await selection;
		expect(h.runtime.refreshUsage).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).not.toHaveBeenCalled();
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

	it("persists only completion notifications", async () => {
		const h = harness();
		await h.actions.setCompletionNotifications(false);
		expect(h.runtime.getConfig().completionNotifications).toBe(false);
		expect(h.savePatch).toHaveBeenCalledWith("/tmp/user.json", { completionNotifications: false });
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Notifications off", "info");
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
});

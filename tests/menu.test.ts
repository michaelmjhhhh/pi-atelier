import { describe, expect, it, vi } from "vitest";

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
	openAtelierMenu,
	renderMenuBorder,
	renderMenuFrame,
	type SidebarControls,
} from "../src/menu.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function harness() {
	let config = { ...DEFAULT_CONFIG, segments: [...DEFAULT_CONFIG.segments] };
	const runtime = {
		getConfig: vi.fn(() => config),
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
		ui: { notify: vi.fn(), input: vi.fn(), confirm: vi.fn() },
		compact: vi.fn(),
	};
	const save = vi.fn().mockResolvedValue(undefined);
	const actions = createMenuActions(pi as never, ctx as never, runtime as never, "/tmp/user.json", save);
	return { actions, pi, ctx, runtime, save };
}

describe("menu presentation", () => {
	it.each([
		[
			false,
			{
				value: "sidebar",
				label: "Sidebar: Off",
				description: "Show the docked information rail",
			},
		],
		[
			true,
			{
				value: "sidebar",
				label: "Sidebar: On",
				description: "Hide the docked information rail",
			},
		],
	] as const)("shows and toggles the dynamic sidebar state (%s)", async (visible, expected) => {
		rootMenuItems.length = 0;
		const sidebar: SidebarControls = {
			isVisible: vi.fn(() => visible),
			toggle: vi.fn(),
			isToolListExpanded: vi.fn(() => false),
			toggleToolList: vi.fn().mockResolvedValue(undefined),
		};
		let invocation = 0;
		const ctx = {
			mode: "tui",
			ui: {
				custom: vi.fn(
					(factory: (...args: any[]) => unknown) =>
						new Promise((resolve) => {
							const value = invocation++ === 0 ? "sidebar" : "close";
							factory(
								{ requestRender: vi.fn() },
								{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
								{},
								resolve,
							);
							resolve(value);
						}),
				),
			},
		};

		await openAtelierMenu({} as never, ctx as never, harness().runtime as never, "/tmp/user.json", sidebar);

		expect(rootMenuItems[0]).toContainEqual(expected);
		expect(sidebar.toggle).toHaveBeenCalledOnce();
	});

	it("shows and toggles collapsed sidebar tool details", async () => {
		rootMenuItems.length = 0;
		const sidebar: SidebarControls = {
			isVisible: vi.fn(() => true),
			toggle: vi.fn(),
			isToolListExpanded: vi.fn(() => false),
			toggleToolList: vi.fn().mockResolvedValue(undefined),
		};
		let invocation = 0;
		const ctx = {
			mode: "tui",
			ui: {
				custom: vi.fn(
					(factory: (...args: any[]) => unknown) =>
						new Promise((resolve) => {
							const value = invocation++ === 0 ? "sidebar-tools" : "close";
							factory(
								{ requestRender: vi.fn() },
								{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
								{},
								resolve,
							);
							resolve(value);
						}),
				),
			},
		};

		await openAtelierMenu({} as never, ctx as never, harness().runtime as never, "/tmp/user.json", sidebar);

		expect(rootMenuItems[0]).toContainEqual({
			value: "sidebar-tools",
			label: "Tool list: Collapsed",
			description: "Show active tool names in the sidebar",
		});
		expect(sidebar.toggleToolList).toHaveBeenCalledOnce();
	});

	it("uses a heavy theme-aware border that fills the available width", () => {
		const theme = {
			fg: vi.fn((_color: string, text: string) => text),
			bold: vi.fn((text: string) => text),
		};
		expect(renderMenuBorder(theme, 6)).toBe("━━━━━━");
		expect(theme.fg).toHaveBeenCalledWith("borderAccent", "━━━━━━");
		expect(theme.bold).toHaveBeenCalled();
	});

	it("frames every content row with heavy vertical borders and corners", () => {
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		expect(renderMenuFrame(theme, ["Hi"], 8)).toEqual(["┏━━━━━━┓", "┃Hi    ┃", "┗━━━━━━┛"]);
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

	it("persists display changes only after explicit save", async () => {
		const h = harness();
		h.actions.setPreset("minimal");
		expect(h.save).not.toHaveBeenCalled();
		await h.actions.saveDisplayDefaults();
		expect(h.save).toHaveBeenCalledOnce();
		expect(h.runtime.setConfig).toHaveBeenCalled();
	});

	it("restores the ornament-free Status Rail defaults when selecting editorial", () => {
		const h = harness();
		h.actions.setPreset("minimal");
		h.actions.setDensity("compact");
		h.actions.setOrnament("restrained");
		h.actions.setPreset("editorial");
		expect(h.runtime.getConfig()).toMatchObject({
			preset: "editorial",
			segments: DEFAULT_CONFIG.segments,
			ornament: "none",
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
			segments: ["metrics", "context", "model", "git", "statuses"],
			density: "comfortable",
			ornament: "none",
		});
	});

	it("renames a session only after non-empty input", async () => {
		const h = harness();
		h.ctx.ui.input.mockResolvedValue("  Release prep  ");
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
		expect(h.runtime.getConfig()).toMatchObject({ density: "compact", ornament: "none" });
		expect(h.runtime.getConfig().segments.indexOf("context")).toBeLessThan(
			h.runtime.getConfig().segments.indexOf("metrics"),
		);
	});

	it("does not compact without confirmation", async () => {
		const h = harness();
		h.ctx.ui.confirm.mockResolvedValue(false);
		await h.actions.compactSession();
		expect(h.ctx.compact).not.toHaveBeenCalled();
	});
});

import { plainTheme } from "./helpers/render.js";
import { describe, expect, it, vi } from "vitest";

import { SIDEBAR_PANEL_EVENT_CHANNEL } from "../extensions/index.js";
import { AtelierEditor } from "../src/editor.js";

import { settleMicrotasks } from "./helpers/async.js";
import {
	harness,
	replacementContext,
	start,
	command,
	renderOverlayText,
	mountComposer,
	withPersistedUserConfig,
} from "./helpers/extension.js";

describe("extension registration", () => {
	it("discovers and renders a structured contributed panel through pi.events", async () => {
		const h = harness();
		await withPersistedUserConfig(
			{
				sidebarPanelLayout: [
					{ id: "vendor:queue", visible: true },
					...Array.from({ length: 8 }, (_, index) => ({
						id: ["agent", "activity", "alerts", "todos", "context", "workspace", "usage", "tools"][index],
						visible: false,
					})),
				],
			},
			async () => {
				await start(h);
				h.pi.events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
					version: 1,
					type: "register",
					source: "vendor",
					revision: 1,
					panel: { id: "vendor:queue", title: "Queue", rows: ["queued 2"] },
				});
				await command(h, "sidebar on");
				const rendered = h.overlays.at(-1)?.component.render(44).join("\\n") ?? "";
				expect(rendered).toContain("QUEUE");
				expect(rendered).toContain("queued 2");
			},
		);
	});

	it("registers the command and installs one footer in TUI mode", async () => {
		const h = harness();
		expect(h.commands.has("atelier")).toBe(true);
		await start(h);
		expect(h.setFooter).toHaveBeenCalledTimes(1);
		expect(h.setEditorComponent).toHaveBeenCalledTimes(1);
		const editorFactory = h.setEditorComponent.mock.calls[0]?.[0];
		const editor = editorFactory(
			{ requestRender: vi.fn(), terminal: { rows: 24, columns: 80 } },
			{ borderColor: (text: string) => text, selectList: {} },
			{ matches: () => false },
		);
		expect(editor).toBeInstanceOf(AtelierEditor);
		expect(editor.render(32)[0]).toMatch(/^╭─+╮$/);
		expect(h.shortcuts).toContain("f6");
		expect(h.shortcuts).toContain("ctrl+shift+r");
	});

	it.each([
		{ columns: 80, rows: 6 },
		{ columns: 18, rows: 24 },
		{ columns: 20, rows: 24 },
		{ columns: 22, rows: 24 },
	])("keeps complete context in the footer at $columns×$rows", async ({ columns, rows }) => {
		const h = harness();
		await start(h);
		const { tui, editor, footer } = mountComposer(h);
		try {
			expect(editor.render(80)[0]).toContain("● READY");
			footer.render(80);
			Object.assign(tui.terminal, { columns, rows });
			expect(editor.render(columns)[0]).not.toContain("● READY");
			const fallback = footer.render(columns).join("\n");
			expect(fallback).toContain("● READY");
			expect(fallback).toContain("10.0%");

			Object.assign(tui.terminal, { columns: 80, rows: 24 });
			expect(editor.render(80)[0]).toContain("10.0%");
			expect(footer.render(80).join("\n")).not.toContain("10.0%");
		} finally {
			footer.dispose();
		}
	});

	it("routes f6 to the Control Center", async () => {
		const h = harness("tui", "linux", true);
		await start(h);
		const before = h.custom.mock.calls.length;

		const opening = h.shortcutHandlers.get("f6")?.(h.ctx);
		await h.mounted(1);
		expect(h.overlays).toHaveLength(2);

		expect(h.custom.mock.calls.length).toBe(before + 1);
		expect(renderOverlayText(h, h.overlays.length - 1, 80)).toContain("Atelier Control Center");
		h.overlays.at(-1)?.component.handleInput("\u001b");
		await opening;
	});

	it("does not install terminal UI outside TUI mode", async () => {
		const h = harness("print");
		await start(h);
		expect(h.setFooter).not.toHaveBeenCalled();
		expect(h.setEditorComponent).not.toHaveBeenCalled();
	});

	it("starts with the Sidebar hidden when the global preference is off", async () => {
		await withPersistedUserConfig({ showSidebarOnStartup: false }, async () => {
			const h = harness();

			await start(h);

			expect(h.overlays).toHaveLength(0);
			expect(h.setFooter).toHaveBeenCalledOnce();
			await command(h, "sidebar on");
			expect(h.overlays).toHaveLength(1);
		});
	});

	it("starts enabled and toggles the persistent sidebar on -> off -> on", async () => {
		const h = harness();
		await start(h);
		expect(h.overlays).toHaveLength(1);
		expect(h.overlays[0]?.options).toMatchObject({
			overlay: true,
			overlayOptions: expect.any(Function),
			onHandle: expect.any(Function),
		});
		expect(h.overlays[0]?.layout()).toMatchObject({ nonCapturing: true });
		await command(h, "sidebar");
		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		await command(h, "sidebar");
		expect(h.custom).toHaveBeenCalledTimes(2);
	});

	it("supports idempotent sidebar on and off commands", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");
		await command(h, "sidebar on");
		expect(h.custom).toHaveBeenCalledOnce();
		await command(h, "sidebar off");
		await command(h, "sidebar off");
		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
	});

	it("toggles and persists sidebar tool-name details", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");
		const toolNameRow = /│ read\s+│/;
		expect(renderOverlayText(h, 0, 44)).not.toMatch(toolNameRow);

		await command(h, "sidebar tools on");

		expect(h.saveConfigPatch).toHaveBeenLastCalledWith(expect.stringContaining("pi-atelier.json"), {
			showSidebarToolNames: true,
		});
		expect(renderOverlayText(h, 0, 44)).toMatch(toolNameRow);
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Sidebar tool list expanded", "info");

		await command(h, "sidebar tools off");
		expect(h.saveConfigPatch).toHaveBeenLastCalledWith(expect.stringContaining("pi-atelier.json"), {
			showSidebarToolNames: false,
		});
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Sidebar tool list collapsed", "info");
	});

	it.each(["sidebar maybe", "sidebar on extra"])("warns for invalid syntax: %s", async (args) => {
		const h = harness();
		await start(h);
		await command(h, args);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Usage: /atelier sidebar [on|off]", "warning");
		expect(h.custom).toHaveBeenCalledOnce();
	});

	it("warns for invalid sidebar tool-list syntax", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar tools maybe");
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Usage: /atelier sidebar tools [on|off]", "warning");
		expect(h.saveConfigPatch).not.toHaveBeenCalled();
	});

	it("mounts the sidebar as a non-capturing overlay at the default width", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");
		expect(h.overlays[0]?.layout()).toMatchObject({ width: 44, nonCapturing: true });
	});

	it("enters Resize mode with Ctrl+Shift+R only for the active visible sidebar", async () => {
		const h = harness();
		await start(h);
		await h.shortcutHandlers.get("ctrl+shift+r")?.(h.ctx);
		expect(h.terminalWrite).toHaveBeenCalledWith("\u001b[?1002h\u001b[?1006h");

		await command(h, "sidebar off");
		h.terminalWrite.mockClear();
		await h.shortcutHandlers.get("ctrl+shift+r")?.(h.ctx);
		expect(h.terminalWrite).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("sidebar"), "warning");

		const staleCtx = h.ctx;
		const currentCtx = replacementContext(h.ctx, "Replacement session");
		await start(h, currentCtx);
		const writeCount = h.terminalWrite.mock.calls.length;
		await h.shortcutHandlers.get("ctrl+shift+r")?.(staleCtx);
		expect(h.terminalWrite).toHaveBeenCalledTimes(writeCount);
		expect(staleCtx.ui.notify).toHaveBeenLastCalledWith(
			"Show the Pi Atelier sidebar before resizing it",
			"warning",
		);
	});

	it("disable closes the sidebar and restores mouse state", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");
		await h.shortcutHandlers.get("ctrl+shift+r")?.(h.ctx);

		await command(h, "disable");

		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		expect(h.terminalWrite).toHaveBeenLastCalledWith("\u001b[?1006l\u001b[?1002l");
		expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
		expect(h.setEditorComponent).toHaveBeenLastCalledWith(undefined);
	});

	it("disable clears the session's own footer, not the invoking context's", async () => {
		const h = harness();
		await start(h);
		h.setFooter.mockClear();
		h.setEditorComponent.mockClear();
		// Pi hands commands a context object that shares the session manager but not the UI.
		const distinctUi = {
			...h.ctx,
			ui: { ...h.ctx.ui, setFooter: vi.fn(), setEditorComponent: vi.fn(), notify: vi.fn() },
		};

		await command(h, "disable", distinctUi);

		expect(h.setFooter).toHaveBeenCalledWith(undefined);
		expect(h.setEditorComponent).toHaveBeenCalledWith(undefined);
		expect(distinctUi.ui.setFooter).not.toHaveBeenCalled();
		expect(distinctUi.ui.setEditorComponent).not.toHaveBeenCalled();
	});

	it("disposes a mounted footer when setFooter removal throws", async () => {
		const h = harness();
		let mountedFooter: any;
		const unsubscribe = vi.fn();
		let branchChange: (() => void) | undefined;
		h.setFooter.mockImplementation((value: unknown) => {
			if (value === undefined) throw new Error("footer removal failed");
			if (typeof value === "function") {
				mountedFooter = value({ requestRender: vi.fn() }, plainTheme, {
					getGitBranch: () => undefined,
					getExtensionStatuses: () => new Map(),
					onBranchChange: (callback: () => void) => {
						branchChange = callback;
						return unsubscribe;
					},
				});
			}
		});
		await start(h);
		mountedFooter.render(120);

		await h.dispatch("session_shutdown", { reason: "quit" });

		expect(mountedFooter).toBeDefined();
		expect(unsubscribe).toHaveBeenCalledOnce();
		branchChange?.();
		await h.dispatch("session_shutdown", { reason: "quit" });
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("disables a retained footer safely and does not revive it after enable", async () => {
		const h = harness();
		const mounted: Array<{
			component: any;
			requestRender: ReturnType<typeof vi.fn>;
			branchChange: () => void;
			unsubscribe: ReturnType<typeof vi.fn>;
		}> = [];
		h.setFooter.mockImplementation((value: unknown) => {
			if (value === undefined) throw new Error("footer removal failed");
			if (typeof value !== "function") return;
			const requestRender = vi.fn();
			let branchChange: (() => void) | undefined;
			const unsubscribe = vi.fn();
			const component = value({ requestRender }, plainTheme, {
				getGitBranch: () => undefined,
				getExtensionStatuses: () => new Map([["live", "live footer"]]),
				onBranchChange: (onChange: () => void) => {
					branchChange = onChange;
					return unsubscribe;
				},
			});
			mounted.push({ component, requestRender, branchChange: () => branchChange?.(), unsubscribe });
		});

		await start(h);
		expect(mounted).toHaveLength(1);
		const oldFooter = mounted[0];
		expect(oldFooter).toBeDefined();
		expect(oldFooter?.component.render(120).join("\n")).toContain("live footer");

		await expect(command(h, "disable")).resolves.toBeUndefined();
		expect(oldFooter?.unsubscribe).toHaveBeenCalledOnce();
		expect(oldFooter?.component.render(120).join("\n")).not.toContain("live footer");
		oldFooter?.branchChange();
		expect(oldFooter?.requestRender).not.toHaveBeenCalled();

		await command(h, "enable");
		expect(mounted).toHaveLength(2);
		oldFooter?.branchChange();
		expect(oldFooter?.requestRender).not.toHaveBeenCalled();
		const newFooter = mounted[1];
		expect(newFooter).toBeDefined();
		newFooter?.branchChange();
		expect(newFooter?.requestRender).toHaveBeenCalledOnce();

		await h.dispatch("session_shutdown", { reason: "quit" });
		expect(newFooter?.unsubscribe).toHaveBeenCalledOnce();
		expect(oldFooter?.unsubscribe).toHaveBeenCalledOnce();
	});

	it("passes command state to the menu controller", async () => {
		const h = harness("tui", "linux", true);
		await start(h);
		await command(h, "sidebar on");
		const opening = command(h, "");
		await h.mounted(1);
		expect(h.overlays).toHaveLength(2);
		const menu = renderOverlayText(h, 1, 80);
		expect(menu).toContain("Sidebar: On");
		h.overlays[1]?.component.handleInput("\u001b");
		await opening;
	});

	it("passes contributed titles through the public Display seam and persists enabling them", async () => {
		await withPersistedUserConfig(
			{
				sidebarPanelLayout: [{ id: "vendor:missing", visible: true }],
			},
			async () => {
				const h = harness("tui", "linux", true);
				await start(h);
				h.pi.events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
					version: 1,
					type: "register",
					source: "vendor",
					revision: 1,
					panel: { id: "vendor:queue", title: "Queue title", rows: ["queued"] },
				});
				const opening = command(h, "display");
				await h.mounted(1);
				expect(h.overlays).toHaveLength(2);
				const workspace = h.overlays.at(-1)!.component;
				const rendered = workspace?.render(120).join("\n") ?? "";
				expect(rendered).toContain("vendor:missing");

				// Two display rows, nine segments, and three actions precede configured panels.
				for (let index = 0; index < 14 + 10; index += 1) workspace?.handleInput("\u001b[B");
				const focusedRendered = workspace?.render(120).join("\n") ?? "";
				expect(focusedRendered).toContain("Queue title");
				expect(focusedRendered).toContain("unavailable");
				workspace?.handleInput(" ");
				workspace?.handleInput("s");
				expect(h.saveConfigPatch).toHaveBeenCalled();
				await settleMicrotasks();
				const patch = h.saveConfigPatch.mock.calls.at(-1)?.[1] as {
					sidebarPanelLayout?: Array<{ id: string; visible: boolean }>;
				};
				expect(patch.sidebarPanelLayout).toEqual(
					expect.arrayContaining([
						{ id: "vendor:missing", visible: true },
						{ id: "vendor:queue", visible: true },
					]),
				);
				expect(patch.sidebarPanelLayout?.map((entry) => entry.id)).toEqual([
					"vendor:missing",
					"agent",
					"activity",
					"alerts",
					"todos",
					"context",
					"workspace",
					"usage",
					"subagents",
					"tools",
					"vendor:queue",
				]);
				workspace?.handleInput("\u001b");
				await opening;
			},
		);
	});

	it("passes NO_COLOR through to sidebar rendering", async () => {
		const h = harness();
		vi.stubEnv("NO_COLOR", "1");
		try {
			await start(h);
			await command(h, "sidebar on");
			expect(renderOverlayText(h, 0, 44)).not.toContain("\u001b[38;2;");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("opens the Display workspace directly and rejects it outside TUI mode", async () => {
		const h = harness("tui", "linux", true);
		await start(h);
		const before = h.custom.mock.calls.length;
		const opening = command(h, "display");
		await h.mounted(1);
		expect(h.overlays).toHaveLength(2);
		expect(h.custom.mock.calls.length).toBe(before + 1);
		expect(renderOverlayText(h, h.overlays.length - 1, 80)).toContain("DISPLAY SETTINGS");
		h.overlays.at(-1)?.component.handleInput("\u001b");
		await opening;

		const printed = harness("print");
		await command(printed, "display");
		expect(printed.custom).not.toHaveBeenCalled();
		expect(printed.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("TUI mode"), "warning");
	});

	it("warns instead of opening the sidebar outside TUI mode", async () => {
		const h = harness("print");
		await command(h, "sidebar");
		expect(h.custom).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("TUI mode"), "warning");
	});

	it("invalidates the sidebar once per actual footer status change", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");
		h.overlays[0]?.requestRender.mockClear();
		let statuses = new Map([["one", "extension one"]]);
		const footer = h.setFooter.mock.calls[0]?.[0](
			{ requestRender: vi.fn() },
			{
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
				italic: (text: string) => text,
			},
			{
				getGitBranch: () => undefined,
				getExtensionStatuses: () => statuses,
				onBranchChange: () => () => undefined,
			},
		);
		footer.render(120);
		expect(h.overlays[0]?.requestRender).toHaveBeenCalled();
		h.overlays[0]?.requestRender.mockClear();
		footer.render(120);
		expect(h.overlays[0]?.requestRender).not.toHaveBeenCalled();
		statuses = new Map([["one", "extension two"]]);
		footer.render(120);
		expect(h.overlays[0]?.requestRender).toHaveBeenCalled();
	});
});

import { plainTheme } from "./helpers/render.js";
import { describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { SIDEBAR_PANEL_EVENT_CHANNEL } from "../extensions/index.js";

import { loadConfig as loadAtelierConfig, saveUserConfigPatch as persistConfigPatch } from "../src/config.js";
import { deferred, settleMicrotasks } from "./helpers/async.js";
import {
	loadTestConfig,
	loadConfigAfter,
	harness,
	replacementContext,
	start,
	todoBranchEntry,
	command,
	renderOverlayText,
	mountComposer,
	renderFooter,
	queueWorkspacePulseInspection,
	execResult,
} from "./helpers/extension.js";

describe("extension session", () => {
	it("moves session identity back to the footer while a selector replaces the editor", async () => {
		const h = harness();
		await start(h);
		const { editor, footer } = mountComposer(h);
		try {
			const header = editor.render(80)[0];
			for (const text of ["● READY", "project", "main", "10.0%"]) expect(header).toContain(text);
			const telemetry = footer.render(80).join("\n");
			expect(telemetry).toContain("F6");
			for (const text of ["● READY", "project", "main", "10.0%"]) expect(telemetry).not.toContain(text);

			// Pi selectors replace the editor without disposing it or rendering it again.
			const selectorFooter = footer.render(80).join("\n");
			for (const text of ["● READY", "project", "main", "10.0%"]) expect(selectorFooter).toContain(text);

			expect(editor.render(80)[0]).toContain("● READY");
			expect(footer.render(80).join("\n")).not.toContain("● READY");
		} finally {
			footer.dispose();
		}
	});

	it("registers the resize shortcut exactly once across session replacement", async () => {
		const h = harness();
		await start(h);
		await start(h, replacementContext(h.ctx, "Replacement session"));

		expect(h.pi.registerShortcut.mock.calls.filter(([key]) => key === "ctrl+shift+r")).toHaveLength(1);
	});

	it("retires active TUI state when a non-TUI session starts", async () => {
		const h = harness("tui", "darwin");
		await start(h);
		expect(h.getEventBusHandlerCount(SIDEBAR_PANEL_EVENT_CHANNEL)).toBe(1);
		expect(h.getEventBusHandlerCount("rpiv:ask-user:blocked")).toBe(1);
		h.pi.events.emit("rpiv:ask-user:blocked", { active: true });
		expect(h.spawnNotificationProcess).toHaveBeenCalledOnce();

		const printContext = { ...replacementContext(h.ctx, "Print session"), mode: "print" as const };
		await start(h, printContext);

		expect(h.getEventBusHandlerCount(SIDEBAR_PANEL_EVENT_CHANNEL)).toBe(0);
		expect(h.getEventBusHandlerCount("rpiv:ask-user:blocked")).toBe(0);
		expect(h.notificationProcess.kill).toHaveBeenCalledOnce();
		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
		expect(h.setEditorComponent).toHaveBeenLastCalledWith(undefined);
		h.pi.events.emit("rpiv:ask-user:blocked", { active: false });
		h.pi.events.emit("rpiv:ask-user:blocked", { active: true });
		expect(h.spawnNotificationProcess).toHaveBeenCalledOnce();
		await command(h, "sidebar on", h.ctx);
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Pi Atelier is not active in this session", "warning");
	});

	it("does not publish an in-flight TUI initializer after a newer non-TUI session starts", async () => {
		const load = deferred<void>();
		const deferredLoadConfig = vi
			.fn<typeof loadAtelierConfig>()
			.mockImplementationOnce(loadConfigAfter(load));
		const h = harness("tui", "linux", false, { loadConfig: deferredLoadConfig });

		const starting = start(h);
		expect(deferredLoadConfig).toHaveBeenCalledOnce();
		const printContext = { ...replacementContext(h.ctx, "Newer print session"), mode: "print" as const };
		await start(h, printContext);
		load.resolve(undefined);
		await starting;

		expect(h.setFooter).not.toHaveBeenCalled();
		expect(h.custom).not.toHaveBeenCalled();
		expect(h.getEventBusHandlerCount("rpiv:ask-user:blocked")).toBe(0);
	});

	it("clears the retired footer when a TUI session with a distinct UI replaces it", async () => {
		const h = harness();
		await start(h);
		const replacementSetFooter = vi.fn();
		const replacementNotify = vi.fn();
		const replacementCtx = {
			...replacementContext(h.ctx, "Distinct UI replacement"),
			ui: {
				...h.ctx.ui,
				setFooter: replacementSetFooter,
				notify: replacementNotify,
			},
		};

		await start(h, replacementCtx);

		expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
		expect(replacementSetFooter).toHaveBeenCalledOnce();
		expect(replacementSetFooter).toHaveBeenLastCalledWith(expect.any(Function));
		expect(replacementSetFooter).not.toHaveBeenCalledWith(undefined);
		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		expect(renderOverlayText(h, 1)).toContain("Distinct UI replacement");
	});

	it.each([
		["Control Center", ""],
		["Display Settings", "display"],
	])("closes a session-owned %s overlay during replacement", async (_label, args) => {
		const h = harness("tui", "linux", true);
		await start(h);

		const opening = command(h, args);
		await h.mounted(1);
		expect(h.overlays).toHaveLength(2);
		const overlay = h.overlays[1]!;

		await start(h, replacementContext(h.ctx, "Replacement session"));
		await opening;

		expect(overlay.done).toHaveBeenCalledOnce();
		expect(overlay.closed).toBe(true);
		expect(renderOverlayText(h, 2)).toContain("Replacement session");
	});

	it.each([
		["Display", "display"],
		["Control Center", ""],
	])("settles a retired %s command when host done throws", async (_label, args) => {
		const h = harness("tui", "linux", true);
		await start(h);
		const opening = command(h, args);
		await h.mounted(1);
		expect(h.overlays).toHaveLength(2);
		const overlay = h.overlays[1]!;
		overlay.done.mockImplementation(() => {
			throw new Error("overlay close failed");
		});

		await start(h, replacementContext(h.ctx, "Replacement session"));

		expect(overlay.closed).toBe(false);
		expect(() => overlay.component.render(80)).not.toThrow();
		expect(overlay.component.render(80)).toEqual([]);
		overlay.requestRender.mockClear();
		expect(() => overlay.component.handleInput(" ")).not.toThrow();
		expect(overlay.requestRender).not.toHaveBeenCalled();
		expect(renderOverlayText(h, 2)).toContain("Replacement session");
		await expect(opening).resolves.toBeUndefined();
	});

	it("renders an inert retired Control Center tool overlay", async () => {
		initTheme("dark");
		const h = harness("tui", "linux", true);
		const setActiveTools = vi.fn();
		(h.pi as any).setActiveTools = setActiveTools;
		await start(h);
		void command(h, "");
		await h.mounted(1);
		expect(h.overlays).toHaveLength(2);
		const root = h.overlays[1]!;
		root.component.handleInput("\u001b[B");
		root.component.handleInput("\r");
		await h.mounted(2);
		expect(h.overlays).toHaveLength(3);
		const controls = h.overlays[2]!;
		controls.component.handleInput("\u001b[B");
		controls.component.handleInput("\u001b[B");
		controls.component.handleInput("\r");
		await h.mounted(3);
		expect(h.overlays).toHaveLength(4);
		const toolSettings = h.overlays[3]!;
		toolSettings.done.mockImplementation(() => {
			throw new Error("tool overlay close failed");
		});

		await start(h, replacementContext(h.ctx, "Replacement session"));

		expect(toolSettings.closed).toBe(false);
		expect(() => toolSettings.component.render(80)).not.toThrow();
		expect(toolSettings.component.render(80)).toEqual([]);
		setActiveTools.mockClear();
		expect(() => toolSettings.component.handleInput(" ")).not.toThrow();
		expect(setActiveTools).not.toHaveBeenCalled();
		expect(renderOverlayText(h, 4)).toContain("Replacement session");
	});

	it("keeps cleanup exception-safe when independent disposers throw", async () => {
		const h = harness(
			"tui",
			"darwin",
			false,
			{},
			{
				throwOnEventUnsubscribe: [SIDEBAR_PANEL_EVENT_CHANNEL],
			},
		);
		await start(h);
		h.pi.events.emit("rpiv:ask-user:blocked", { active: true });
		expect(h.spawnNotificationProcess).toHaveBeenCalledOnce();
		h.setFooter.mockImplementation((value) => {
			if (value === undefined) throw new Error("footer cleanup failed");
		});

		await h.dispatch("session_shutdown", { reason: "quit" });

		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		expect(h.notificationProcess.kill).toHaveBeenCalledOnce();
		expect(h.getEventBusHandlerCount("rpiv:ask-user:blocked")).toBe(0);
		await command(h, "sidebar on");
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Pi Atelier is not active in this session", "warning");
	});

	it("keeps a candidate-local failure from replacing the current session", async () => {
		const throwOnSubscribe: string[] = [];
		const h = harness("tui", "darwin", false, {}, { throwOnEventSubscribe: throwOnSubscribe });
		await start(h);
		await h.dispatch("agent_start", { type: "agent_start" });
		await h.dispatch("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "active-tool",
			toolName: "read",
			args: { path: "/tmp/project/current.ts" },
		});
		h.pi.events.emit("rpiv:ask-user:blocked", { active: true });
		expect(h.spawnNotificationProcess).toHaveBeenCalledOnce();
		const currentBeforeFailure = renderOverlayText(h);
		expect(currentBeforeFailure).toContain("Test session");
		expect(currentBeforeFailure).toContain("current.ts");
		throwOnSubscribe.push("rpiv:ask-user:blocked");
		const failingCtx = replacementContext(h.ctx, "Failing candidate");
		failingCtx.sessionManager.getBranch.mockReturnValue([
			todoBranchEntry({ todos: [{ id: 1, text: "Candidate TODO", done: false }], nextId: 2 }),
		]);

		await start(h, failingCtx);

		expect(h.ctx.ui.notify).toHaveBeenCalledWith(
			"Pi Atelier could not start: subscribe failed: rpiv:ask-user:blocked",
			"error",
		);
		expect(h.overlays).toHaveLength(1);
		expect(h.overlays[0]?.done).not.toHaveBeenCalled();
		expect(h.getEventBusHandlerCount(SIDEBAR_PANEL_EVENT_CHANNEL)).toBe(1);
		expect(h.getEventBusHandlerCount("rpiv:ask-user:blocked")).toBe(1);

		h.pi.events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
			version: 1,
			type: "register",
			source: "vendor",
			revision: 1,
			panel: { id: "vendor:candidate", title: "Candidate Panel", rows: ["candidate row"] },
		});
		await h.dispatch("agent_start", { type: "agent_start" }, failingCtx);
		await h.dispatch(
			"tool_execution_start",
			{
				type: "tool_execution_start",
				toolCallId: "candidate-tool",
				toolName: "read",
				args: { path: "/tmp/project/candidate.ts" },
			},
			failingCtx,
		);

		const currentAfterFailure = renderOverlayText(h);
		expect(currentAfterFailure).toContain("Test session");
		expect(currentAfterFailure).toContain("current.ts");
		expect(currentAfterFailure).not.toContain("Failing candidate");
		expect(currentAfterFailure).not.toContain("Candidate TODO");
		expect(currentAfterFailure).not.toContain("Candidate Panel");
		expect(currentAfterFailure).not.toContain("candidate.ts");
		expect(h.spawnNotificationProcess).toHaveBeenCalledOnce();
	});

	it("keeps active Sidebar snapshot failures visible", async () => {
		const h = harness();
		await start(h);
		h.ctx.sessionManager.getBranch.mockImplementation(() => {
			throw new Error("snapshot read failed");
		});

		const sidebar = renderOverlayText(h);
		expect(sidebar).toContain("Sidebar unavailable");
		expect(sidebar).toContain("snapshot read failed");
	});

	it("renders an inert stale Sidebar snapshot if overlay removal fails", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			todoBranchEntry({ todos: [{ id: 1, text: "Retired TODO", done: false }], nextId: 2 }),
		]);
		await start(h);
		const footer = renderFooter(
			h.setFooter.mock.calls[0]?.[0],
			vi.fn(),
			() => new Map([["stale", "retired extension failed"]]),
		);
		expect(footer.render(120).join("\n")).toContain("retired extension failed");
		expect(renderOverlayText(h)).toContain("Retired TODO");
		h.overlays[0]?.done.mockImplementation(() => {
			throw new Error("overlay close failed");
		});
		const oldSessionManager = h.ctx.sessionManager;
		oldSessionManager.getBranch.mockClear();
		oldSessionManager.getSessionName.mockClear();
		oldSessionManager.getSessionFile.mockClear();
		h.overlays[0]?.requestRender.mockClear();

		await start(h, replacementContext(h.ctx, "Replacement session"));
		oldSessionManager.getBranch.mockClear();
		oldSessionManager.getSessionName.mockClear();
		oldSessionManager.getSessionFile.mockClear();
		h.overlays[0]?.requestRender.mockClear();

		expect(() => renderOverlayText(h, 0)).not.toThrow();
		const staleSidebar = renderOverlayText(h, 0);
		expect(staleSidebar).not.toContain("Test session");
		expect(staleSidebar).not.toContain("Retired TODO");
		expect(staleSidebar).not.toContain("retired extension failed");
		expect(staleSidebar).not.toContain("TODOS");
		expect(oldSessionManager.getBranch).not.toHaveBeenCalled();
		expect(oldSessionManager.getSessionName).not.toHaveBeenCalled();
		expect(oldSessionManager.getSessionFile).not.toHaveBeenCalled();
		expect(h.overlays[0]?.requestRender).not.toHaveBeenCalled();
		expect(renderOverlayText(h, 1)).toContain("Replacement session");
	});

	it("does not publish deferred Display saves after replacement", async () => {
		const saved = deferred<void>();
		const saving = deferred<void>();
		const saveConfigPatch = vi.fn<typeof persistConfigPatch>().mockImplementation(async () => {
			saving.resolve();
			await saved.promise;
		});
		const h = harness("tui", "linux", true, { saveConfigPatch });
		await start(h);
		const opening = command(h, "display");
		await h.mounted(1);
		expect(h.overlays).toHaveLength(2);
		const displaySettings = h.overlays[1]!;

		displaySettings.component.handleInput(" ");
		displaySettings.component.handleInput("s");
		await saving.promise;
		expect(saveConfigPatch).toHaveBeenCalledOnce();

		await start(h, replacementContext(h.ctx, "Replacement session"));
		await opening;
		displaySettings.requestRender.mockClear();
		saved.resolve(undefined);
		await settleMicrotasks();

		expect(displaySettings.requestRender).not.toHaveBeenCalled();
		expect(renderOverlayText(h, 2)).toContain("Replacement session");
	});

	it("suppresses deferred Control Center save notifications after replacement", async () => {
		const saved = deferred<void>();
		const saving = deferred<void>();
		const saveConfigPatch = vi.fn<typeof persistConfigPatch>().mockImplementation(async () => {
			saving.resolve();
			await saved.promise;
		});
		const h = harness("tui", "linux", true, { saveConfigPatch });
		await start(h);
		const opening = command(h, "");
		await h.mounted(1);
		expect(h.overlays).toHaveLength(2);
		h.overlays[1]!.component.handleInput("\r");
		await h.mounted(2);
		expect(h.overlays).toHaveLength(3);
		h.overlays[2]!.component.handleInput("\u001b[B");
		h.overlays[2]!.component.handleInput("\r");
		await saving.promise;
		expect(saveConfigPatch).toHaveBeenCalledOnce();

		await start(h, replacementContext(h.ctx, "Replacement session"));
		saved.resolve(undefined);
		await opening;

		expect(h.ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Sidebar will start"), "info");
		expect(h.ctx.ui.notify).not.toHaveBeenCalledWith(
			expect.stringContaining("Sidebar startup preference could not be saved"),
			"warning",
		);
		expect(renderOverlayText(h, h.overlays.length - 1)).toContain("Replacement session");
	});

	it("closes nested Control Center model prompts during replacement", async () => {
		const h = harness("tui", "linux", true);
		(h.ctx.modelRegistry as any).getAvailable = vi.fn().mockReturnValue([{ provider: "test", id: "model" }]);
		await start(h);
		const opening = command(h, "");
		await h.mounted(1);
		expect(h.overlays).toHaveLength(2);
		h.overlays[1]!.component.handleInput("\u001b[B");
		h.overlays[1]!.component.handleInput("\r");
		await h.mounted(2);
		expect(h.overlays).toHaveLength(3);
		h.overlays[2]!.component.handleInput("\u001b[B");
		h.overlays[2]!.component.handleInput("\r");
		await h.mounted(3);
		expect(h.overlays).toHaveLength(4);
		const modelPrompt = h.overlays[3]!;

		await start(h, replacementContext(h.ctx, "Replacement session"));
		await opening;

		expect(modelPrompt.done).toHaveBeenCalledOnce();
		expect(modelPrompt.closed).toBe(true);
		expect(renderOverlayText(h, h.overlays.length - 1)).toContain("Replacement session");
	});

	it("closes an enabled sidebar and resize input during shutdown", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");
		await h.shortcutHandlers.get("ctrl+shift+r")?.(h.ctx);
		expect(h.terminalWrite).toHaveBeenLastCalledWith("\u001b[?1002h\u001b[?1006h");
		expect(h.terminalInput).toEqual(expect.any(Function));

		await h.dispatch("session_shutdown", { reason: "quit" });

		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
		expect(h.setEditorComponent).toHaveBeenLastCalledWith(undefined);
		expect(h.terminalWrite).toHaveBeenLastCalledWith("\u001b[?1006l\u001b[?1002l");
		expect(h.terminalInputUnsubscribe).toHaveBeenCalledOnce();
		expect(h.terminalInput).toBeUndefined();
	});

	it("clears session-owned sidebar state during shutdown", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			todoBranchEntry({
				tasks: [{ id: 1, subject: "Shutdown stale TODO", status: "in_progress" }],
				nextId: 2,
			}),
		]);
		await start(h);
		await h.dispatch("agent_start", { type: "agent_start" });
		await h.dispatch("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1_000 });
		await h.dispatch("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "shutdown-tool",
			toolName: "read",
			args: { path: "/tmp/project/shutdown-stale.ts" },
		});
		const beforeShutdown = renderOverlayText(h);
		expect(beforeShutdown).toContain("Shutdown stale TODO");
		expect(beforeShutdown).toContain("shutdown-stale.ts");

		await h.dispatch("session_shutdown", { reason: "quit" });
		const replacementCtx = replacementContext(h.ctx, "Post-shutdown session");
		replacementCtx.sessionManager.getBranch.mockReturnValue([]);
		await start(h, replacementCtx);

		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		const replacementSidebar = renderOverlayText(h, h.overlays.length - 1);
		expect(replacementSidebar).toContain("Post-shutdown session");
		expect(replacementSidebar).not.toContain("Shutdown stale TODO");
		expect(replacementSidebar).not.toContain("shutdown-stale.ts");
		expect(replacementSidebar).not.toContain("TODOS");
	});

	it("does not retain published state when initialization fails", async () => {
		const h = harness("tui", "darwin");
		await start(h);
		h.pi.events.emit("rpiv:ask-user:blocked", { active: true });
		expect(h.spawnNotificationProcess).toHaveBeenCalledOnce();

		const failingCtx = replacementContext(h.ctx, "Failing session");
		failingCtx.sessionManager.getBranch.mockReturnValue([
			todoBranchEntry({ todos: [{ id: 1, text: "Failure stale TODO", done: false }], nextId: 2 }),
		]);
		const failedFooterRender = vi.fn();
		h.setFooter.mockImplementation((footer) => {
			if (typeof footer !== "function") return;
			renderFooter(footer, failedFooterRender);
			throw new Error("footer install failed");
		});

		await start(h, failingCtx);

		expect(h.notificationProcess.kill).toHaveBeenCalledOnce();
		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
		expect(h.getEventBusHandlerCount("rpiv:ask-user:blocked")).toBe(0);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(
			"Pi Atelier could not start: footer install failed",
			"error",
		);
		// A failing initializer never opens a sidebar, so only the first session's overlay exists.
		expect(h.overlays).toHaveLength(1);

		failedFooterRender.mockClear();
		failingCtx.sessionManager.getBranch.mockReturnValue([
			todoBranchEntry({ todos: [{ id: 2, text: "Resurrected TODO", done: false }], nextId: 3 }),
		]);
		await h.dispatch("session_tree", { type: "session_tree" }, failingCtx);
		expect(failedFooterRender).not.toHaveBeenCalled();

		h.pi.events.emit("rpiv:ask-user:blocked", { active: false });
		h.pi.events.emit("rpiv:ask-user:blocked", { active: true });
		expect(h.spawnNotificationProcess).toHaveBeenCalledOnce();

		const overlayCount = h.overlays.length;
		await command(h, "sidebar on", failingCtx);
		expect(h.overlays).toHaveLength(overlayCount);
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Pi Atelier is not active in this session", "warning");
	});

	it("does not leak TODOs from a failed initialization into the next session", async () => {
		const h = harness();
		await start(h);

		const failingCtx = replacementContext(h.ctx, "Failing session");
		failingCtx.sessionManager.getBranch.mockReturnValue([
			todoBranchEntry({ todos: [{ id: 1, text: "Failure stale TODO", done: false }], nextId: 2 }),
		]);
		let failNextFooterInstall = true;
		h.setFooter.mockImplementation((footer) => {
			if (!failNextFooterInstall || typeof footer !== "function") return;
			failNextFooterInstall = false;
			throw new Error("footer install failed");
		});
		await start(h, failingCtx);

		expect(h.ctx.ui.notify).toHaveBeenCalledWith(
			"Pi Atelier could not start: footer install failed",
			"error",
		);
		expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
		expect(h.overlays).toHaveLength(1);
		await command(h, "sidebar on", failingCtx);
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Pi Atelier is not active in this session", "warning");

		const recoveredCtx = replacementContext(h.ctx, "Recovered session");
		recoveredCtx.sessionManager.getBranch.mockReturnValue([]);
		await start(h, recoveredCtx);
		expect(h.getEventBusHandlerCount("rpiv:ask-user:blocked")).toBe(1);

		const recoveredSidebar = renderOverlayText(h, h.overlays.length - 1);
		expect(recoveredSidebar).toContain("Recovered session");
		expect(recoveredSidebar).not.toContain("Failure stale TODO");
		expect(recoveredSidebar).not.toContain("TODOS");
	});

	it("cancels pending system notifications during shutdown", async () => {
		const h = harness("tui", "darwin");
		await start(h);
		h.pi.events.emit("rpiv:ask-user:blocked", { active: true });
		expect(h.spawnNotificationProcess).toHaveBeenCalledOnce();
		expect(h.notificationProcess.kill).not.toHaveBeenCalled();

		await h.dispatch("session_shutdown", { reason: "quit" });

		expect(h.notificationProcess.kill).toHaveBeenCalled();
	});

	it("stops a scheduled workspace pulse refresh after shutdown", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			h.ctx.isProjectTrusted.mockReturnValue(true);
			await start(h);
			const timersBeforeSchedule = vi.getTimerCount();
			await h.dispatch("tool_execution_end", {
				type: "tool_execution_end",
				toolCallId: "pulse-tool",
				toolName: "write",
				result: { output: "" },
			});
			expect(vi.getTimerCount()).toBeGreaterThan(timersBeforeSchedule);
			const execCallsBeforeShutdown = h.pi.exec.mock.calls.length;

			await h.dispatch("session_shutdown", { reason: "quit" });
			expect(vi.getTimerCount()).toBe(timersBeforeSchedule);
			await vi.advanceTimersByTimeAsync(1_000);

			expect(h.pi.exec.mock.calls.length).toBe(execCallsBeforeShutdown);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not publish an in-flight workspace pulse refresh after shutdown", async () => {
		const active = harness();
		const inspected = queueWorkspacePulseInspection(active);
		await start(active);
		await inspected;
		await settleMicrotasks();
		// Positive control: a published pulse does reach the sidebar.
		expect(renderOverlayText(active)).toContain("stale-branch");
		expect(renderOverlayText(active)).toContain("1 tracked");
		await active.dispatch("session_shutdown", { reason: "quit" }, active.ctx);
		expect(active.overlays[0]?.done).toHaveBeenCalledOnce();

		const discovery = deferred<ReturnType<typeof execResult>>();
		const h = harness();
		queueWorkspacePulseInspection(h, discovery.promise);
		await start(h);
		expect(h.pi.exec).toHaveBeenCalledOnce();

		await h.dispatch("session_shutdown", { reason: "quit" });
		h.overlays[0]?.requestRender.mockClear();
		discovery.resolve(execResult("true\n/tmp/project\n"));
		await settleMicrotasks();

		expect(h.pi.exec).toHaveBeenCalledOnce();
		expect(h.overlays[0]?.requestRender).not.toHaveBeenCalled();
	});

	it("detaches branch callbacks from a retired footer after removal fails", async () => {
		const h = harness();
		await start(h);
		let branchChange: (() => void) | undefined;
		const requestRender = vi.fn();
		const factory = h.setFooter.mock.calls[0]?.[0];
		expect(factory).toEqual(expect.any(Function));
		const footer = factory({ requestRender }, plainTheme, {
			getGitBranch: () => undefined,
			getExtensionStatuses: () => new Map(),
			onBranchChange: (callback: () => void) => {
				branchChange = callback;
				return () => undefined;
			},
		});
		footer.render(120);
		h.setFooter.mockImplementation((value: unknown) => {
			if (value === undefined) throw new Error("footer removal failed");
		});

		await h.dispatch("session_shutdown", { reason: "quit" });
		branchChange?.();
		expect(branchChange).toEqual(expect.any(Function));
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("stops reporting retired data from a footer that outlives its own removal", async () => {
		const h = harness();
		await start(h);
		const footer = renderFooter(
			h.setFooter.mock.calls[0]?.[0],
			vi.fn(),
			() => new Map([["one", "atelier index failed"]]),
		);
		expect(footer.render(120).join("\n")).toContain("atelier index failed");
		// Pi disposes the mounted footer inside `setFooter`; if that throws, the old footer stays live.
		h.setFooter.mockImplementation((value: unknown) => {
			if (value === undefined) throw new Error("footer removal failed");
		});
		await h.dispatch("session_shutdown", { reason: "quit" });

		expect(() => footer.render(120)).not.toThrow();
		expect(footer.render(120).join("\n")).not.toContain("atelier index failed");
	});

	it("does not publish an initializer that completes after shutdown", async () => {
		const load = deferred<void>();
		const deferredLoadConfig = vi
			.fn<typeof loadAtelierConfig>()
			.mockImplementationOnce(loadConfigAfter(load));
		const h = harness("tui", "linux", false, { loadConfig: deferredLoadConfig });

		const starting = start(h);
		expect(deferredLoadConfig).toHaveBeenCalledOnce();
		await h.dispatch("session_shutdown", { reason: "quit" });
		load.resolve(undefined);
		await starting;

		expect(h.setFooter).not.toHaveBeenCalled();
		expect(h.custom).not.toHaveBeenCalled();
		expect(h.overlays).toHaveLength(0);
		await command(h, "sidebar on");
		expect(h.custom).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Pi Atelier is not active in this session", "warning");
	});

	it("keeps the newer initializer authoritative when an older one completes last", async () => {
		const firstLoad = deferred<void>();
		const secondLoad = deferred<void>();
		const deferredLoadConfig = vi
			.fn<typeof loadAtelierConfig>()
			.mockImplementationOnce(loadConfigAfter(firstLoad))
			.mockImplementationOnce(loadConfigAfter(secondLoad));
		const h = harness("tui", "linux", false, { loadConfig: deferredLoadConfig });

		const firstStart = start(h);
		expect(deferredLoadConfig).toHaveBeenCalledTimes(1);
		const newerContext = replacementContext(h.ctx, "Newer");
		const secondStart = start(h, newerContext);
		expect(deferredLoadConfig).toHaveBeenCalledTimes(2);
		secondLoad.resolve(undefined);
		await secondStart;
		expect(h.overlays).toHaveLength(1);
		expect(renderOverlayText(h, 0, 44)).toContain("Newer");

		firstLoad.resolve(undefined);
		await firstStart;

		expect(h.overlays).toHaveLength(1);
		expect(h.overlays[0]?.done).not.toHaveBeenCalled();
		expect(renderOverlayText(h, 0, 44)).toContain("Newer");
		expect(h.setFooter).toHaveBeenCalledTimes(1);
	});

	it("ignores stale shutdown while a newer initializer is still loading", async () => {
		const firstLoad = deferred<void>();
		const secondLoad = deferred<void>();
		const deferredLoadConfig = vi
			.fn<typeof loadAtelierConfig>()
			.mockImplementationOnce(loadConfigAfter(firstLoad))
			.mockImplementationOnce(loadConfigAfter(secondLoad));
		const h = harness("tui", "linux", false, { loadConfig: deferredLoadConfig });

		const firstStart = start(h);
		expect(deferredLoadConfig).toHaveBeenCalledTimes(1);
		const newerContext = replacementContext(h.ctx, "Newer");
		const secondStart = start(h, newerContext);
		expect(deferredLoadConfig).toHaveBeenCalledTimes(2);

		await h.dispatch("session_shutdown", { reason: "quit" });
		secondLoad.resolve(undefined);
		await secondStart;
		firstLoad.resolve(undefined);
		await firstStart;

		expect(h.overlays).toHaveLength(1);
		expect(renderOverlayText(h)).toContain("Newer");
		expect(h.overlays[0]?.done).not.toHaveBeenCalled();
	});

	it("cancels the matching in-flight initializer without tearing down the active session", async () => {
		const replacementLoad = deferred<void>();
		const deferredLoadConfig = vi
			.fn<typeof loadAtelierConfig>()
			.mockImplementationOnce(loadTestConfig)
			.mockImplementationOnce(loadConfigAfter(replacementLoad));
		const h = harness("tui", "linux", false, { loadConfig: deferredLoadConfig });
		await start(h);
		const activeFooterRender = vi.fn();
		const activeFooterFactory = h.setFooter.mock.calls[0]?.[0];
		expect(activeFooterFactory).toEqual(expect.any(Function));
		renderFooter(activeFooterFactory, activeFooterRender);
		activeFooterRender.mockClear();
		const replacementContextValue = replacementContext(h.ctx, "Cancelled replacement");
		const replacementStart = start(h, replacementContextValue);
		expect(deferredLoadConfig).toHaveBeenCalledTimes(2);

		await h.dispatch("session_shutdown", { reason: "quit" }, replacementContextValue);
		replacementLoad.resolve(undefined);
		await replacementStart;

		expect(h.overlays).toHaveLength(1);
		expect(h.overlays[0]?.done).not.toHaveBeenCalled();
		expect(renderOverlayText(h)).toContain("Test session");
		await h.dispatch("session_tree", { type: "session_tree" });
		expect(activeFooterRender).toHaveBeenCalled();
	});

	it("closes the old sidebar and starts the replacement visible on session reload", async () => {
		const h = harness();
		await start(h);

		await start(h);

		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		expect(h.custom).toHaveBeenCalledTimes(2);
		expect(h.overlays[1]?.done).not.toHaveBeenCalled();
	});

	it.each(["sidebar off", "disable", "enable"])("ignores stale session command: %s", async (args) => {
		const h = harness();
		const staleContext = h.ctx;
		await start(h, staleContext);
		const currentContext = replacementContext(h.ctx, "Replacement session");
		await start(h, currentContext);
		h.setFooter.mockClear();

		await command(h, args, staleContext);

		expect(h.overlays[1]?.done).not.toHaveBeenCalled();
		expect(renderOverlayText(h, 1)).toContain("Replacement session");
		expect(h.setFooter).not.toHaveBeenCalled();
		expect(staleContext.ui.notify).toHaveBeenLastCalledWith(
			"Pi Atelier is not active in this session",
			"warning",
		);
	});

	it("reopens by default on reload after an explicit session-scoped close", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar off");
		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();

		await start(h);

		expect(h.custom).toHaveBeenCalledTimes(2);
		expect(h.overlays[1]?.done).not.toHaveBeenCalled();
	});

	it("replaces and removes the ask-user blocked listener with the session lifecycle", async () => {
		const h = harness("tui", "darwin");
		await start(h);
		expect(h.getEventBusHandlerCount("rpiv:ask-user:blocked")).toBe(1);

		const currentCtx = replacementContext(h.ctx, "Replacement session");
		await start(h, currentCtx);
		expect(h.getEventBusHandlerCount("rpiv:ask-user:blocked")).toBe(1);
		await h.dispatch("agent_start", { type: "agent_start" }, currentCtx);

		h.pi.events.emit("rpiv:ask-user:blocked", { active: true });
		expect(h.spawnNotificationProcess).toHaveBeenCalledTimes(1);

		await h.dispatch("session_shutdown", { reason: "quit" }, currentCtx);
		expect(h.getEventBusHandlerCount("rpiv:ask-user:blocked")).toBe(0);
		h.pi.events.emit("rpiv:ask-user:blocked", { active: false });
		h.pi.events.emit("rpiv:ask-user:blocked", { active: true });
		expect(h.spawnNotificationProcess).toHaveBeenCalledTimes(1);
	});

	it("clears run activity across session reload and shutdown", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");
		await h.dispatch("agent_start", { type: "agent_start" });
		await h.dispatch("turn_start", { type: "turn_start", turnIndex: 5, timestamp: 1_000 });
		await h.dispatch("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "old-tool",
			toolName: "read",
			args: { path: "/tmp/project/old.ts" },
		});
		expect(renderOverlayText(h, 0, 44)).toContain("old.ts");

		await start(h);
		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		await command(h, "sidebar on");
		const replacementText = renderOverlayText(h, 1, 44);
		expect(replacementText).toContain("ACTIVITY");
		expect(replacementText).toMatch(/First token\s+—/);
		expect(replacementText).not.toContain("old.ts");

		const replacementRenderCount = h.overlays[1]?.requestRender.mock.calls.length ?? 0;
		await h.dispatch("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "old-tool",
			toolName: "read",
			result: { content: [] },
			isError: false,
		});
		expect(h.overlays[1]?.requestRender.mock.calls.length).toBe(replacementRenderCount);
		expect(renderOverlayText(h, 1, 44)).not.toContain("old.ts");

		await h.dispatch("session_shutdown", { reason: "quit" });
		expect(h.overlays[1]?.done).toHaveBeenCalledOnce();
		const shutdownRenderCount = h.overlays[1]?.requestRender.mock.calls.length ?? 0;
		await h.dispatch("agent_start", { type: "agent_start" });
		expect(h.overlays[1]?.requestRender.mock.calls.length).toBe(shutdownRenderCount);
	});

	it("ignores stale activity events after a replacement session becomes active", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		try {
			const h = harness();
			const oldCtx = h.ctx;
			const currentCtx = replacementContext(h.ctx, "Replacement session");
			await start(h, oldCtx);
			await command(h, "sidebar on", oldCtx);

			await start(h, currentCtx);
			expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
			await command(h, "sidebar on", currentCtx);

			await h.dispatch("agent_start", { type: "agent_start" }, currentCtx);
			await h.dispatch("turn_start", { type: "turn_start", turnIndex: 6, timestamp: 1_000 }, currentCtx);
			await h.dispatch(
				"tool_execution_start",
				{
					type: "tool_execution_start",
					toolCallId: "current-tool",
					toolName: "bash",
					args: { command: "npm run current" },
				},
				currentCtx,
			);

			const activeRenderCount = h.overlays[1]?.requestRender.mock.calls.length ?? 0;
			const activeText = renderOverlayText(h, 1, 44);
			expect(activeText).toContain("Replacement session");
			expect(activeText).toContain("ACTIVITY");
			expect(activeText).toContain("Turn 7");
			expect(activeText).toContain("running");
			expect(activeText).toContain("bash");
			expect(activeText).toContain("npm run current");
			expect(activeText).toContain("Working");

			await h.dispatch("agent_start", { type: "agent_start" }, oldCtx);
			await h.dispatch(
				"tool_execution_start",
				{
					type: "tool_execution_start",
					toolCallId: "stale-tool",
					toolName: "read",
					args: { path: "/tmp/project/stale.ts" },
				},
				oldCtx,
			);
			await h.dispatch("agent_settled", { type: "agent_settled" }, oldCtx);

			expect(h.overlays[1]?.requestRender.mock.calls.length).toBe(activeRenderCount);
			expect(renderOverlayText(h, 1, 44)).toBe(activeText);
			expect(renderOverlayText(h, 1, 44)).not.toContain("stale.ts");

			await h.dispatch(
				"tool_execution_end",
				{
					type: "tool_execution_end",
					toolCallId: "current-tool",
					toolName: "bash",
					result: { stdout: "" },
					isError: false,
				},
				currentCtx,
			);
			await h.dispatch("agent_settled", { type: "agent_settled" }, currentCtx);

			expect(h.overlays[1]?.requestRender.mock.calls.length).toBeGreaterThan(activeRenderCount);
			const settledText = renderOverlayText(h, 1, 44);
			expect(settledText).toContain("Last run · <1s");
			expect(settledText).not.toContain("Turn 7");
			expect(settledText).not.toContain("settled");
			expect(settledText).toContain("done");
			expect(settledText).toContain("Ready");
			expect(settledText).not.toContain("stale.ts");
		} finally {
			vi.useRealTimers();
		}
	});
});

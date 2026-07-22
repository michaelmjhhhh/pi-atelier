import { describe, expect, it, vi } from "vitest";
import atelierExtension from "../extensions/index.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const gitResult = (branch: string) => ({
	stdout: `## ${branch}\n`,
	stderr: "",
	code: 0,
	killed: false,
});

function harness(mode: "tui" | "print" = "tui") {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const commands = new Map<string, any>();
	const shortcuts: string[] = [];
	const shortcutHandlers = new Map<string, (ctx: any) => Promise<void> | void>();
	const setFooter = vi.fn();
	let terminalInput: ((data: string) => unknown) | undefined;
	const terminalWrite = vi.fn();
	const baseRender = vi.fn((width: number) => [`main:${width}`]);
	const overlays: Array<{
		component: any;
		done: ReturnType<typeof vi.fn>;
		handle: { hide: ReturnType<typeof vi.fn> };
		options: any;
		requestRender: ReturnType<typeof vi.fn>;
		tui: any;
	}> = [];
	const pi = {
		on: vi.fn((name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler)),
		registerCommand: vi.fn((name: string, options: any) => commands.set(name, options)),
		registerShortcut: vi.fn((key: string, options: any) => {
			shortcuts.push(key);
			shortcutHandlers.set(key, options.handler);
		}),
		exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
		getThinkingLevel: vi.fn().mockReturnValue("medium"),
		getActiveTools: vi.fn().mockReturnValue(["read"]),
		getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
	};
	const custom = vi.fn((factory: (...args: any[]) => any, options: any) => {
		const requestRender = vi.fn();
		const tui = {
			render: baseRender,
			terminal: { columns: 120, rows: 36, width: 120, write: terminalWrite },
			requestRender,
		};
		let resolve!: (value: undefined) => void;
		const pending = new Promise<undefined>((done) => {
			resolve = done;
		});
		const done = vi.fn(() => resolve(undefined));
		const handle = { hide: vi.fn() };
		const component = factory(
			tui,
			{
				name: "dark",
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
				italic: (text: string) => text,
			},
			{},
			done,
		);
		requestRender.mockClear();
		overlays.push({ component, done, handle, options, requestRender, tui });
		options?.onHandle?.(handle);
		const overlayOptions =
			typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
		if (!overlayOptions?.nonCapturing) done();
		return pending;
	});
	const ctx = {
		mode,
		cwd: "/tmp/project",
		isProjectTrusted: vi.fn().mockReturnValue(false),
		getContextUsage: vi.fn().mockReturnValue({ tokens: 10, contextWindow: 100, percent: 10 }),
		model: undefined,
		modelRegistry: { isUsingOAuth: vi.fn().mockReturnValue(false) },
		sessionManager: {
			getEntries: vi.fn().mockReturnValue([]),
			getBranch: vi.fn().mockReturnValue([]),
			getSessionName: vi.fn().mockReturnValue("Test session"),
			getSessionFile: vi.fn().mockReturnValue("/tmp/session.jsonl"),
		},
		ui: {
			setFooter,
			notify: vi.fn(),
			theme: {},
			custom,
			onTerminalInput: vi.fn((handler) => {
				terminalInput = handler;
				return vi.fn();
			}),
		},
	};
	atelierExtension(pi as never);
	return {
		handlers,
		commands,
		shortcuts,
		shortcutHandlers,
		setFooter,
		ctx,
		pi,
		overlays,
		custom,
		terminalWrite,
		baseRender,
		get terminalInput() {
			return terminalInput;
		},
	};
}

function replacementContext(
	base: ReturnType<typeof harness>["ctx"],
	sessionName: string,
): ReturnType<typeof harness>["ctx"] {
	return {
		...base,
		sessionManager: {
			...base.sessionManager,
			getSessionName: vi.fn().mockReturnValue(sessionName),
			getSessionFile: vi.fn().mockReturnValue(`/tmp/${sessionName.toLowerCase().replace(/\s+/g, "-")}.jsonl`),
		},
	};
}

async function start(h: ReturnType<typeof harness>, ctx = h.ctx) {
	await h.handlers.get("session_start")?.({ reason: "startup" }, ctx);
}

async function command(h: ReturnType<typeof harness>, args: string, ctx = h.ctx) {
	await h.commands.get("atelier").handler(args, ctx);
}

describe("extension registration", () => {
	it("registers the command and installs one footer in TUI mode", async () => {
		const h = harness();
		expect(h.commands.has("atelier")).toBe(true);
		await start(h);
		expect(h.setFooter).toHaveBeenCalledTimes(1);
		expect(h.shortcuts).toContain("alt+a");
		expect(h.shortcuts).toContain("ctrl+shift+r");
	});

	it("registers the resize shortcut exactly once across session replacement", async () => {
		const h = harness();
		await start(h);
		await start(h, replacementContext(h.ctx, "Replacement session"));

		expect(h.pi.registerShortcut.mock.calls.filter(([key]) => key === "ctrl+shift+r")).toHaveLength(1);
	});

	it("does not install terminal UI outside TUI mode", async () => {
		const h = harness("print");
		await start(h);
		expect(h.setFooter).not.toHaveBeenCalled();
	});

	it("starts disabled and toggles the persistent sidebar off -> on -> off", async () => {
		const h = harness();
		await start(h);
		expect(h.custom).not.toHaveBeenCalled();
		await command(h, "sidebar");
		expect(h.overlays).toHaveLength(1);
		expect(h.overlays[0]?.options).toMatchObject({
			overlay: true,
			overlayOptions: expect.any(Function),
			onHandle: expect.any(Function),
		});
		expect(h.overlays[0]?.options.overlayOptions()).toMatchObject({ nonCapturing: true });
		await command(h, "sidebar");
		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		expect(h.custom).toHaveBeenCalledTimes(1);
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

	it.each(["sidebar maybe", "sidebar on extra"])("warns for invalid syntax: %s", async (args) => {
		const h = harness();
		await start(h);
		await command(h, args);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Usage: /atelier sidebar [on|off]", "warning");
		expect(h.custom).not.toHaveBeenCalled();
	});

	it("reflows the Pi workspace beside the visible sidebar", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");

		expect(h.overlays[0]?.options.overlayOptions()).toMatchObject({ width: 44 });
		expect(h.overlays[0]?.tui.render(120)).toEqual(["main:76"]);

		await command(h, "sidebar off");
		expect(h.overlays[0]?.tui.render(120)).toEqual(["main:120"]);
	});

	it("enters Resize mode with Ctrl+Shift+R only for the active visible sidebar", async () => {
		const h = harness();
		await start(h);
		await h.shortcutHandlers.get("ctrl+shift+r")?.(h.ctx);
		expect(h.terminalWrite).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("sidebar"), "warning");

		await command(h, "sidebar on");
		await h.shortcutHandlers.get("ctrl+shift+r")?.(h.ctx);
		expect(h.terminalWrite).toHaveBeenCalledWith("\u001b[?1002h\u001b[?1006h");

		const staleCtx = h.ctx;
		const currentCtx = replacementContext(h.ctx, "Replacement session");
		await start(h, currentCtx);
		await command(h, "sidebar on", currentCtx);
		const writeCount = h.terminalWrite.mock.calls.length;
		await h.shortcutHandlers.get("ctrl+shift+r")?.(staleCtx);
		expect(h.terminalWrite).toHaveBeenCalledTimes(writeCount);
		expect(staleCtx.ui.notify).toHaveBeenLastCalledWith(
			"Show the Pi Atelier sidebar before resizing it",
			"warning",
		);
	});

	it("disable closes the sidebar and restores render and mouse state", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");
		await h.shortcutHandlers.get("ctrl+shift+r")?.(h.ctx);

		await command(h, "disable");

		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		expect(h.terminalWrite).toHaveBeenLastCalledWith("\u001b[?1006l\u001b[?1002l");
		expect(h.overlays[0]?.tui.render(120)).toEqual(["main:120"]);
		expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
	});

	it("closes an enabled sidebar during shutdown", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");
		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
	});

	it("does not publish an initializer that completes after shutdown", async () => {
		const h = harness();
		const git = deferred<ReturnType<typeof gitResult>>();
		h.pi.exec.mockReturnValueOnce(git.promise);

		const starting = start(h);
		await vi.waitFor(() => expect(h.pi.exec).toHaveBeenCalledOnce());
		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
		git.resolve(gitResult("stale"));
		await starting;

		expect(h.setFooter).not.toHaveBeenCalled();
		await command(h, "sidebar on");
		expect(h.custom).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Pi Atelier is not active in this session", "warning");
	});

	it("keeps the newer initializer authoritative when an older one completes last", async () => {
		const h = harness();
		const firstGit = deferred<ReturnType<typeof gitResult>>();
		const secondGit = deferred<ReturnType<typeof gitResult>>();
		h.pi.exec.mockReturnValueOnce(firstGit.promise).mockReturnValueOnce(secondGit.promise);

		const firstStart = start(h);
		await vi.waitFor(() => expect(h.pi.exec).toHaveBeenCalledTimes(1));
		const secondStart = start(h);
		await vi.waitFor(() => expect(h.pi.exec).toHaveBeenCalledTimes(2));
		secondGit.resolve(gitResult("newer"));
		await secondStart;
		await command(h, "sidebar on");
		expect(h.overlays[0]?.component.render(44).join("\n")).toContain("newer");

		firstGit.resolve(gitResult("stale"));
		await firstStart;

		expect(h.overlays[0]?.done).not.toHaveBeenCalled();
		expect(h.overlays[0]?.component.render(44).join("\n")).toContain("newer");
		expect(h.overlays[0]?.component.render(44).join("\n")).not.toContain("stale");
		expect(h.setFooter).toHaveBeenCalledOnce();
	});

	it("closes the old sidebar and starts the replacement hidden on session reload", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");

		await start(h);

		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		expect(h.custom).toHaveBeenCalledOnce();
		await command(h, "sidebar on");
		expect(h.custom).toHaveBeenCalledTimes(2);
	});

	it("passes command state to the menu controller", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");
		await command(h, "");
		const menu = h.overlays[1]?.component.render(80).join("\n");
		expect(menu).toContain("Sidebar: On");
	});

	it("passes NO_COLOR through to sidebar rendering", async () => {
		const h = harness();
		vi.stubEnv("NO_COLOR", "1");
		try {
			await start(h);
			await command(h, "sidebar on");
			expect(h.overlays[0]?.component.render(44).join("\n")).not.toContain("\u001b[38;2;");
		} finally {
			vi.unstubAllEnvs();
		}
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
		footer.render(120);
		expect(h.overlays[0]?.requestRender).toHaveBeenCalledTimes(2);
		statuses = new Map([["one", "extension two"]]);
		footer.render(120);
		expect(h.overlays[0]?.requestRender).toHaveBeenCalledTimes(4);
	});

	it("shows exact activated tools without listing inactive tools", async () => {
		const h = harness();
		h.pi.getActiveTools.mockReturnValue(["write", "read", "bash", "edit"]);
		h.pi.getAllTools.mockReturnValue([
			{ name: "write" },
			{ name: "read" },
			{ name: "bash" },
			{ name: "edit" },
			{ name: "grep" },
		]);
		await start(h);
		await command(h, "sidebar on");

		const text = h.overlays[0]?.component.render(44).join("\n") ?? "";
		expect(text).toContain("4 / 5 active");
		expect(text).toContain("bash");
		expect(text).toContain("edit");
		expect(text).toContain("read");
		expect(text).toContain("write");
		expect(text).not.toContain("grep");
	});

	it("forwards run and turn events into sidebar activity without putting tool history in the footer", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");

		expect(h.handlers.has("turn_start")).toBe(true);
		expect(h.handlers.has("tool_execution_start")).toBe(true);
		expect(h.handlers.has("tool_execution_end")).toBe(true);

		await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 2, timestamp: 1_000 }, h.ctx);
		await h.handlers.get("tool_execution_start")?.(
			{
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "bash",
				args: { command: "npm test -- tests/extension.test.ts" },
			},
			h.ctx,
		);

		const sidebarText = h.overlays[0]?.component.render(44).join("\n") ?? "";
		expect(sidebarText).toContain("ACTIVITY");
		expect(sidebarText).toContain("Turn 3");
		expect(sidebarText).toContain("running");
		expect(sidebarText).toContain("bash");
		expect(sidebarText).toContain("npm test");
		expect(sidebarText).toContain("Working");
		expect(h.overlays[0]?.requestRender.mock.calls.length).toBeGreaterThan(0);

		const footer = h.setFooter.mock.calls[0]?.[0](
			{ requestRender: vi.fn() },
			{
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
				italic: (text: string) => text,
			},
			{
				getGitBranch: () => undefined,
				getExtensionStatuses: () => new Map(),
				onBranchChange: () => () => undefined,
			},
		);
		const footerText = footer.render(160).join("\n");
		expect(footerText).toContain("●");
		expect(footerText).not.toContain("bash");
		expect(footerText).not.toContain("npm test");
	});

	it("updates recent tool results and settles the sidebar without continuing animation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		try {
			const h = harness();
			await start(h);
			await command(h, "sidebar on");

			await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
			await h.handlers.get("tool_execution_start")?.(
				{
					type: "tool_execution_start",
					toolCallId: "read-1",
					toolName: "read",
					args: { path: "/tmp/project/src/run-activity.ts" },
				},
				h.ctx,
			);
			vi.setSystemTime(2_500);
			await h.handlers.get("tool_execution_end")?.(
				{
					type: "tool_execution_end",
					toolCallId: "read-1",
					toolName: "read",
					result: { content: [] },
					isError: false,
				},
				h.ctx,
			);

			const withResult = h.overlays[0]?.component.render(44).join("\n") ?? "";
			expect(withResult).toContain("read");
			expect(withResult).toContain("src/run-activity.ts");
			expect(withResult).toContain("done 1s");
			expect(withResult).toContain("tools 1 done · 0 failed");

			const rendersBeforeTick = h.overlays[0]?.requestRender.mock.calls.length ?? 0;
			vi.advanceTimersByTime(1_000);
			expect(h.overlays[0]?.requestRender.mock.calls.length).toBeGreaterThan(rendersBeforeTick);

			vi.setSystemTime(4_000);
			await h.handlers.get("agent_settled")?.({ type: "agent_settled" }, h.ctx);
			const settledRenderCount = h.overlays[0]?.requestRender.mock.calls.length ?? 0;
			const settledText = h.overlays[0]?.component.render(44).join("\n") ?? "";
			expect(settledText).toContain("Last run · 3s");
			expect(settledText).not.toContain("settled 3s");
			expect(settledText).toContain("Ready");

			vi.advanceTimersByTime(3_000);
			expect(h.overlays[0]?.requestRender.mock.calls.length).toBe(settledRenderCount);
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears run activity across session reload and shutdown", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");
		await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 5, timestamp: 1_000 }, h.ctx);
		await h.handlers.get("tool_execution_start")?.(
			{
				type: "tool_execution_start",
				toolCallId: "old-tool",
				toolName: "read",
				args: { path: "/tmp/project/old.ts" },
			},
			h.ctx,
		);
		expect(h.overlays[0]?.component.render(44).join("\n")).toContain("old.ts");

		await start(h);
		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		await command(h, "sidebar on");
		const replacementText = h.overlays[1]?.component.render(44).join("\n") ?? "";
		expect(replacementText).not.toContain("ACTIVITY");
		expect(replacementText).not.toContain("old.ts");

		const replacementRenderCount = h.overlays[1]?.requestRender.mock.calls.length ?? 0;
		await h.handlers.get("tool_execution_end")?.(
			{
				type: "tool_execution_end",
				toolCallId: "old-tool",
				toolName: "read",
				result: { content: [] },
				isError: false,
			},
			h.ctx,
		);
		expect(h.overlays[1]?.requestRender.mock.calls.length).toBe(replacementRenderCount);
		expect(h.overlays[1]?.component.render(44).join("\n")).not.toContain("old.ts");

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
		expect(h.overlays[1]?.done).toHaveBeenCalledOnce();
		const shutdownRenderCount = h.overlays[1]?.requestRender.mock.calls.length ?? 0;
		await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
		expect(h.overlays[1]?.requestRender.mock.calls.length).toBe(shutdownRenderCount);
	});

	it("accepts fresh Pi event contexts for the active session", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");
		const eventCtx = { ...h.ctx };

		await h.handlers.get("agent_start")?.({ type: "agent_start" }, eventCtx);
		await h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0, timestamp: 1_000 }, eventCtx);

		const text = h.overlays[0]?.component.render(44).join("\n") ?? "";
		expect(text).toContain("Working");
		expect(text).toContain("ACTIVITY");
		expect(text).toContain("Turn 1");
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

			await h.handlers.get("agent_start")?.({ type: "agent_start" }, currentCtx);
			await h.handlers.get("turn_start")?.(
				{ type: "turn_start", turnIndex: 6, timestamp: 1_000 },
				currentCtx,
			);
			await h.handlers.get("tool_execution_start")?.(
				{
					type: "tool_execution_start",
					toolCallId: "current-tool",
					toolName: "bash",
					args: { command: "npm run current" },
				},
				currentCtx,
			);

			const activeRenderCount = h.overlays[1]?.requestRender.mock.calls.length ?? 0;
			const activeText = h.overlays[1]?.component.render(44).join("\n") ?? "";
			expect(activeText).toContain("Replacement session");
			expect(activeText).toContain("ACTIVITY");
			expect(activeText).toContain("Turn 7");
			expect(activeText).toContain("running");
			expect(activeText).toContain("bash");
			expect(activeText).toContain("npm run current");
			expect(activeText).toContain("Working");

			await h.handlers.get("agent_start")?.({ type: "agent_start" }, oldCtx);
			await h.handlers.get("tool_execution_start")?.(
				{
					type: "tool_execution_start",
					toolCallId: "stale-tool",
					toolName: "read",
					args: { path: "/tmp/project/stale.ts" },
				},
				oldCtx,
			);
			await h.handlers.get("agent_settled")?.({ type: "agent_settled" }, oldCtx);

			expect(h.overlays[1]?.requestRender.mock.calls.length).toBe(activeRenderCount);
			expect(h.overlays[1]?.component.render(44).join("\n")).toBe(activeText);
			expect(h.overlays[1]?.component.render(44).join("\n")).not.toContain("stale.ts");

			await h.handlers.get("tool_execution_end")?.(
				{
					type: "tool_execution_end",
					toolCallId: "current-tool",
					toolName: "bash",
					result: { stdout: "" },
					isError: false,
				},
				currentCtx,
			);
			await h.handlers.get("agent_settled")?.({ type: "agent_settled" }, currentCtx);

			expect(h.overlays[1]?.requestRender.mock.calls.length).toBeGreaterThan(activeRenderCount);
			const settledText = h.overlays[1]?.component.render(44).join("\n") ?? "";
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

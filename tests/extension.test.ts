import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import atelierExtension, { SIDEBAR_PANEL_EVENT_CHANNEL } from "../extensions/index.js";
import { saveUserConfigPatch as persistConfigPatch } from "../src/config.js";

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

function harness(
	mode: "tui" | "print" = "tui",
	notificationPlatform: NodeJS.Platform = "linux",
	interactiveMenus = false,
) {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const commands = new Map<string, any>();
	const eventBusHandlers = new Map<string, Set<(data: unknown) => void>>();
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
		events: {
			on: vi.fn((channel: string, handler: (data: unknown) => void) => {
				const channelHandlers = eventBusHandlers.get(channel) ?? new Set();
				channelHandlers.add(handler);
				eventBusHandlers.set(channel, channelHandlers);
				return () => channelHandlers.delete(handler);
			}),
			emit: vi.fn((channel: string, data: unknown) => {
				for (const handler of eventBusHandlers.get(channel) ?? []) handler(data);
			}),
		},
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
	const custom = vi.fn((factory: (...args: any[]) => any, options: any): Promise<any> => {
		const requestRender = vi.fn();
		const tui = {
			render: baseRender,
			terminal: { columns: 120, rows: 36, width: 120, write: terminalWrite },
			requestRender,
		};
		let resolve!: (value: any) => void;
		const pending = new Promise<any>((done) => {
			resolve = done;
		});
		const done = vi.fn((value?: any) => resolve(value));
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
		if (!overlayOptions?.nonCapturing && !interactiveMenus) done();
		return pending;
	});
	const ctx = {
		mode,
		cwd: "/tmp/project",
		isProjectTrusted: vi.fn().mockReturnValue(false),
		isIdle: vi.fn().mockReturnValue(true),
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
			select: vi.fn(),
			custom,
			onTerminalInput: vi.fn((handler) => {
				terminalInput = handler;
				return vi.fn();
			}),
		},
	};
	const saveConfig = vi.fn().mockResolvedValue(undefined);
	const saveConfigPatch = vi.fn().mockResolvedValue(undefined);
	const notificationProcess = {
		kill: vi.fn(() => true),
		once: vi.fn().mockReturnThis(),
		unref: vi.fn(),
	};
	const spawnNotificationProcess = vi.fn(() => notificationProcess);
	atelierExtension(pi as never, {
		saveConfig,
		saveConfigPatch,
		notificationPlatform,
		spawnNotificationProcess,
	});
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
		saveConfig,
		saveConfigPatch,
		spawnNotificationProcess,
		notificationProcess,
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

async function withPersistedUserConfig(
	config: Record<string, unknown>,
	run: () => Promise<void>,
): Promise<void> {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await mkdtemp(join(tmpdir(), "pi-atelier-extension-"));
	try {
		await writeFile(join(agentDir, "pi-atelier.json"), JSON.stringify(config), "utf8");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await run();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(agentDir, { recursive: true, force: true });
	}
}

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

	it("does not let a built-in panel event spoof the Display settings", async () => {
		const h = harness();
		await start(h);
		h.pi.events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
			version: 1,
			type: "register",
			source: "vendor",
			revision: 1,
			panel: { id: "agent", title: "Spoofed Agent", rows: ["attacker"] },
		});
		await command(h, "display");
		expect(h.overlays.at(-1)?.component.render(120).join("\n")).not.toContain("Spoofed Agent");
	});

	it("registers the command and installs one footer in TUI mode", async () => {
		const h = harness();
		expect(h.commands.has("atelier")).toBe(true);
		await start(h);
		expect(h.setFooter).toHaveBeenCalledTimes(1);
		expect(h.shortcuts).toContain("alt+a");
		expect(h.shortcuts).toContain("ctrl+shift+r");
	});

	it("routes alt+a to the Control Center", async () => {
		const h = harness();
		await start(h);
		const before = h.custom.mock.calls.length;

		await h.shortcutHandlers.get("alt+a")?.(h.ctx);

		expect(h.custom.mock.calls.length).toBe(before + 1);
		expect(h.overlays.at(-1)?.component.render(80).join("\n")).toContain("Atelier Control Center");
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

	it("starts enabled and toggles the persistent sidebar on -> off -> on", async () => {
		const h = harness();
		await start(h);
		expect(h.overlays).toHaveLength(1);
		expect(h.overlays[0]?.options).toMatchObject({
			overlay: true,
			overlayOptions: expect.any(Function),
			onHandle: expect.any(Function),
		});
		expect(h.overlays[0]?.options.overlayOptions()).toMatchObject({ nonCapturing: true });
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
		expect(h.overlays[0]?.component.render(44).join("\n")).not.toContain("\n│ read");

		await command(h, "sidebar tools on");

		expect(h.saveConfigPatch).toHaveBeenLastCalledWith(expect.stringContaining("pi-atelier.json"), {
			showSidebarToolNames: true,
		});
		expect(h.overlays[0]?.component.render(44).join("\n")).toContain("read");
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
		expect(h.saveConfig).not.toHaveBeenCalled();
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

		expect(h.setFooter.mock.calls).toEqual([[expect.any(Function)], [undefined]]);
		expect(h.custom).toHaveBeenCalledOnce();
		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		await command(h, "sidebar on");
		expect(h.custom).toHaveBeenCalledOnce();
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Pi Atelier is not active in this session", "warning");
	});

	it("keeps the newer initializer authoritative when an older one completes last", async () => {
		const h = harness();
		const firstGit = deferred<ReturnType<typeof gitResult>>();
		const secondGit = deferred<ReturnType<typeof gitResult>>();
		h.pi.exec.mockReturnValueOnce(firstGit.promise).mockReturnValueOnce(secondGit.promise);

		const firstStart = start(h);
		await vi.waitFor(() => expect(h.pi.exec).toHaveBeenCalledTimes(1));
		const newerContext = replacementContext(h.ctx, "Newer");
		const secondStart = start(h, newerContext);
		await vi.waitFor(() => expect(h.pi.exec).toHaveBeenCalledTimes(2));
		secondGit.resolve(gitResult("newer"));
		await secondStart;
		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		expect(h.overlays[1]?.component.render(44).join("\n")).toContain("Newer");

		firstGit.resolve(gitResult("stale"));
		await firstStart;

		expect(h.overlays[1]?.done).not.toHaveBeenCalled();
		expect(h.overlays[1]?.component.render(44).join("\n")).toContain("Newer");
		expect(h.overlays[1]?.component.render(44).join("\n")).not.toContain("stale");
		expect(h.setFooter).toHaveBeenCalledTimes(2);
	});

	it("closes the old sidebar and starts the replacement visible on session reload", async () => {
		const h = harness();
		await start(h);

		await start(h);

		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		expect(h.custom).toHaveBeenCalledTimes(2);
		expect(h.overlays[1]?.done).not.toHaveBeenCalled();
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

	it("passes command state to the menu controller", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");
		await command(h, "");
		const menu = h.overlays[1]?.component.render(80).join("\n");
		expect(menu).toContain("Sidebar: On");
	});

	it("passes contributed titles through the public Display seam and persists enabling them", async () => {
		await withPersistedUserConfig(
			{
				sidebarPanelLayout: [{ id: "vendor:missing", visible: true }],
			},
			async () => {
				const h = harness();
				await start(h);
				h.pi.events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
					version: 1,
					type: "register",
					source: "vendor",
					revision: 1,
					panel: { id: "vendor:queue", title: "Queue title", rows: ["queued"] },
				});
				await command(h, "display");
				const workspace = h.overlays.at(-1)?.component;
				const rendered = workspace?.render(120).join("\n") ?? "";
				expect(rendered).toContain("vendor:missing");

				// Two display rows, nine segments, and three actions precede configured panels.
				for (let index = 0; index < 14 + 9; index += 1) workspace?.handleInput("\u001b[B");
				const focusedRendered = workspace?.render(120).join("\n") ?? "";
				expect(focusedRendered).toContain("Queue title");
				expect(focusedRendered).toContain("unavailable");
				workspace?.handleInput(" ");
				workspace?.handleInput("s");
				await vi.waitFor(() => expect(h.saveConfigPatch).toHaveBeenCalled());
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
					"tools",
					"vendor:queue",
				]);
			},
		);
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

	it("opens the Display workspace directly and rejects it outside TUI mode", async () => {
		const h = harness();
		await start(h);
		const before = h.custom.mock.calls.length;
		await command(h, "display");
		expect(h.custom.mock.calls.length).toBe(before + 1);
		expect(h.overlays.at(-1)?.component.render(80).join("\n")).toContain("DISPLAY SETTINGS");

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
		footer.render(120);
		expect(h.overlays[0]?.requestRender).toHaveBeenCalledTimes(2);
		statuses = new Map([["one", "extension two"]]);
		footer.render(120);
		expect(h.overlays[0]?.requestRender).toHaveBeenCalledTimes(4);
	});

	it("collapses activated tool names at narrow sidebar widths", async () => {
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

		const text = h.overlays[0]?.component.render(39).join("\n") ?? "";
		expect(text).toContain("4 / 5 active");
		expect(text).toContain("▸");
		expect(text).not.toContain("bash");
		expect(text).not.toContain("edit");
		expect(text).not.toContain("read");
		expect(text).not.toContain("write");
		expect(text).not.toContain("grep");
	});

	it("sends only one native notification when a turn settles", async () => {
		const h = harness("tui", "darwin");
		await start(h);
		await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.handlers.get("agent_settled")?.({ type: "agent_settled" }, h.ctx);
		await h.handlers.get("agent_settled")?.({ type: "agent_settled" }, h.ctx);

		expect(h.spawnNotificationProcess).toHaveBeenCalledTimes(1);
		expect(h.ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("rearms settlement delivery from turn_start when agent_start was missed", async () => {
		const h = harness("tui", "darwin");
		await start(h);
		await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.handlers.get("agent_settled")?.({ type: "agent_settled" }, h.ctx);

		await h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 1 }, h.ctx);
		await h.handlers.get("agent_settled")?.({ type: "agent_settled" }, h.ctx);

		expect(h.spawnNotificationProcess).toHaveBeenCalledTimes(2);
	});

	it("does not notify settlement when another extension has already started a run", async () => {
		const h = harness();
		await start(h);
		await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
		h.ctx.isIdle.mockReturnValue(false);
		await h.handlers.get("agent_settled")?.({ type: "agent_settled" }, h.ctx);

		expect(h.ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("sends one native notification for each actual ask-user blocked interval", async () => {
		const h = harness("tui", "darwin");
		await start(h);
		await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);

		h.pi.events.emit("rpiv:ask-user:blocked", { active: true });
		h.pi.events.emit("rpiv:ask-user:blocked", { active: true });
		h.pi.events.emit("rpiv:ask-user:blocked", { active: false });
		h.pi.events.emit("rpiv:ask-user:blocked", { active: true });

		expect(h.spawnNotificationProcess).toHaveBeenCalledTimes(2);
		expect(h.ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("replaces and removes the ask-user blocked listener with the session lifecycle", async () => {
		const h = harness("tui", "darwin");
		await start(h);
		const currentCtx = replacementContext(h.ctx, "Replacement session");
		await start(h, currentCtx);
		await h.handlers.get("agent_start")?.({ type: "agent_start" }, currentCtx);

		h.pi.events.emit("rpiv:ask-user:blocked", { active: true });
		expect(h.spawnNotificationProcess).toHaveBeenCalledTimes(1);

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, currentCtx);
		h.pi.events.emit("rpiv:ask-user:blocked", { active: false });
		h.pi.events.emit("rpiv:ask-user:blocked", { active: true });
		expect(h.spawnNotificationProcess).toHaveBeenCalledTimes(1);
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

	it("renders live response performance in the configured footer", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		try {
			const h = harness();
			await start(h);
			await command(h, "display");
			const workspace = h.overlays.at(-1)?.component;
			for (let index = 0; index < 5; index += 1) workspace.handleInput("\u001b[B");
			workspace.handleInput(" ");

			const footerRequestRender = vi.fn();
			const footer = h.setFooter.mock.calls[0]?.[0](
				{ requestRender: footerRequestRender },
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
			expect(footer.render(160).join("\n")).toContain("TTFT ~ · TPS ~");

			vi.setSystemTime(1_100);
			await h.handlers.get("before_provider_request")?.(
				{ type: "before_provider_request", payload: {} },
				h.ctx,
			);
			vi.setSystemTime(1_920);
			await h.handlers.get("message_update")?.(
				{
					type: "message_update",
					message: { role: "assistant", content: [{ type: "thinking", thinking: "token" }] },
					assistantMessageEvent: { type: "thinking_delta", delta: "token" },
				},
				h.ctx,
			);

			expect(footerRequestRender).toHaveBeenCalled();
			expect(footer.render(160).join("\n")).toContain("TTFT 820ms · TPS ~");

			vi.setSystemTime(2_920);
			await h.handlers.get("message_update")?.(
				{
					type: "message_update",
					message: { role: "assistant", content: [{ type: "text", text: "x".repeat(80) }] },
					assistantMessageEvent: { type: "text_delta", delta: "more output" },
				},
				h.ctx,
			);
			expect(footer.render(160).join("\n")).toContain("TTFT 820ms · TPS ~20.0");

			vi.setSystemTime(4_420);
			await h.handlers.get("message_end")?.(
				{
					type: "message_end",
					message: { role: "assistant", usage: { output: 120 } },
				},
				h.ctx,
			);
			expect(footer.render(160).join("\n")).toContain("TTFT 820ms · TPS 48.0");
		} finally {
			vi.useRealTimers();
		}
	});

	it("measures TTFT from provider dispatch and final TPS from streamed generation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		try {
			const h = harness();
			await start(h);
			await command(h, "sidebar on");
			await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);

			vi.setSystemTime(1_100);
			await h.handlers.get("before_provider_request")?.(
				{ type: "before_provider_request", payload: {} },
				h.ctx,
			);
			vi.setSystemTime(1_920);
			await h.handlers.get("message_update")?.(
				{
					type: "message_update",
					message: { role: "assistant", content: [{ type: "thinking", thinking: "token" }] },
					assistantMessageEvent: { type: "thinking_delta", delta: "token" },
				},
				h.ctx,
			);

			const streamingText = h.overlays[0]?.component.render(44).join("\n") ?? "";
			expect(streamingText).toContain("TTFT 820ms · TPS ~");

			vi.setSystemTime(2_920);
			await h.handlers.get("message_update")?.(
				{
					type: "message_update",
					message: { role: "assistant", content: [{ type: "text", text: "x".repeat(80) }] },
					assistantMessageEvent: { type: "text_delta", delta: "more output" },
				},
				h.ctx,
			);
			const estimatedText = h.overlays[0]?.component.render(44).join("\n") ?? "";
			expect(estimatedText).toContain("TTFT 820ms · TPS ~20.0");

			vi.setSystemTime(4_420);
			await h.handlers.get("message_end")?.(
				{
					type: "message_end",
					message: { role: "assistant", usage: { output: 120 } },
				},
				h.ctx,
			);

			const completedText = h.overlays[0]?.component.render(44).join("\n") ?? "";
			expect(completedText).toContain("TTFT 820ms · TPS 48.0");
		} finally {
			vi.useRealTimers();
		}
	});

	it("refreshes Workspace Pulse when a new Turn starts", async () => {
		const h = harness();
		await start(h);
		await vi.waitFor(() => expect(h.pi.exec.mock.calls.length).toBeGreaterThan(0));
		const inspectionsAfterStart = h.pi.exec.mock.calls.length;

		await h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0 }, h.ctx);

		await vi.waitFor(() => expect(h.pi.exec).toHaveBeenCalledTimes(inspectionsAfterStart + 1));
	});

	it("coalesces rapid tool completions into one Workspace Pulse refresh", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			await start(h);
			const inspectionsAfterStart = h.pi.exec.mock.calls.length;

			for (const toolCallId of ["one", "two", "three"]) {
				await h.handlers.get("tool_execution_end")?.(
					{
						type: "tool_execution_end",
						toolCallId,
						toolName: "write",
						result: { content: [] },
						isError: false,
					},
					h.ctx,
				);
			}

			await vi.advanceTimersByTimeAsync(249);
			expect(h.pi.exec).toHaveBeenCalledTimes(inspectionsAfterStart);
			await vi.advanceTimersByTimeAsync(1);
			expect(h.pi.exec).toHaveBeenCalledTimes(inspectionsAfterStart + 1);
		} finally {
			vi.useRealTimers();
		}
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
		expect(replacementText).toContain("ACTIVITY");
		expect(replacementText).toContain("TTFT ~ · TPS ~");
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
describe("tool_result handler for todos", () => {
	it("collapses old format todos when sidebar is visible", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");

		const toolResultHandler = h.handlers.get("tool_result");
		expect(toolResultHandler).toBeDefined();

		const event = {
			toolName: "todo",
			details: {
				todos: [
					{ id: 1, text: "Done task", done: true },
					{ id: 2, text: "Pending task", done: false },
				],
				nextId: 3,
			},
		};
		const result = await toolResultHandler!(event, h.ctx);
		expect(result).toEqual({
			content: [{ type: "text", text: "1/2 done · see sidebar" }],
		});
	});

	it("collapses new format tasks when sidebar is visible", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");

		const toolResultHandler = h.handlers.get("tool_result");
		expect(toolResultHandler).toBeDefined();

		const event = {
			toolName: "todo",
			details: {
				tasks: [
					{ id: 1, subject: "Done", status: "completed" },
					{ id: 2, subject: "Working", status: "in_progress" },
					{ id: 3, subject: "Pending", status: "pending" },
				],
				nextId: 4,
			},
		};
		const result = await toolResultHandler!(event, h.ctx);
		expect(result).toEqual({
			content: [{ type: "text", text: "1/3 done · see sidebar" }],
		});
	});

	it("preserves cached todos for error and malformed results", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: { todos: [{ id: 1, text: "Initial task", done: false }], nextId: 2 },
				},
			},
		]);
		await start(h);
		await command(h, "sidebar on");

		const toolResultHandler = h.handlers.get("tool_result");
		expect(toolResultHandler).toBeDefined();
		const errorResult = await toolResultHandler!(
			{
				toolName: "todo",
				isError: true,
				details: { todos: [{ id: 2, text: "Failed task", done: false }], nextId: 3 },
			},
			h.ctx,
		);
		expect(errorResult).toBeUndefined();

		const malformedResult = await toolResultHandler!(
			{ toolName: "todo", isError: false, details: { todos: "not an array", nextId: 1 } },
			h.ctx,
		);
		expect(malformedResult).toBeUndefined();

		await command(h, "sidebar off");
		await command(h, "sidebar on");
		expect(h.overlays.at(-1)).toBeDefined();
		const sidebarText = h.overlays.at(-1)!.component.render(44).join("\n");
		expect(sidebarText).toContain("Initial task");
		expect(sidebarText).not.toContain("Failed task");
	});

	it("does not collapse tasks with unknown statuses", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");

		const toolResultHandler = h.handlers.get("tool_result");

		// All tasks have unknown/deleted status
		const badEvent = {
			toolName: "todo",
			details: {
				tasks: [{ id: 1, subject: "Deleted", status: "deleted" }],
				nextId: 2,
			},
		};
		const result = await toolResultHandler!(badEvent, h.ctx);
		expect(result).toBeUndefined();
	});

	it("ignores non-todo tool results", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");

		const toolResultHandler = h.handlers.get("tool_result");

		const event = { toolName: "read", details: {} };
		const result = await toolResultHandler!(event, h.ctx);
		expect(result).toBeUndefined();
	});

	it("does not collapse when persisted showSidebarTodos is false", async () => {
		await withPersistedUserConfig({ showSidebarTodos: false }, async () => {
			const h = harness();
			await start(h);
			await command(h, "sidebar on");

			expect(h.overlays[0]).toBeDefined();
			const sidebarText = h.overlays[0]!.component.render(44).join("\n");
			expect(sidebarText).not.toContain("TODOS");

			const toolResultHandler = h.handlers.get("tool_result");
			expect(toolResultHandler).toBeDefined();
			const result = await toolResultHandler!(
				{
					toolName: "todo",
					details: { todos: [{ id: 1, text: "Task", done: false }], nextId: 2 },
				},
				h.ctx,
			);
			expect(result).toBeUndefined();
		});
	});
});
describe("sidebar todos integration", () => {
	it("shows TODOS panel reconstructed from old format branch entries", async () => {
		const h = harness();
		// Seed branch with old-format todo tool result
		h.ctx.sessionManager.getBranch.mockReturnValue([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						todos: [
							{ id: 1, text: "Completed task", done: true },
							{ id: 2, text: "Pending task", done: false },
						],
						nextId: 3,
					},
				},
			},
		]);
		await start(h);
		await command(h, "sidebar on");

		const sidebarText = h.overlays[0]?.component.render(44).join("\n") ?? "";
		expect(sidebarText).toContain("TODOS");
		expect(sidebarText).toContain("1/2");
		expect(sidebarText).toContain("Completed task");
		expect(sidebarText).toContain("Pending task");
	});

	it("skips error TODO results during branch reconstruction", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					isError: false,
					details: { todos: [{ id: 1, text: "Successful task", done: false }], nextId: 2 },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					isError: true,
					details: { todos: [{ id: 2, text: "Failed task", done: false }], nextId: 3 },
				},
			},
		]);
		await start(h);
		await command(h, "sidebar on");

		expect(h.overlays[0]).toBeDefined();
		const sidebarText = h.overlays[0]!.component.render(44).join("\n");
		expect(sidebarText).toContain("Successful task");
		expect(sidebarText).not.toContain("Failed task");
	});

	it("shows TODOS panel reconstructed from new format branch entries", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						tasks: [
							{ id: 1, subject: "Done", status: "completed" },
							{ id: 2, subject: "Working", status: "in_progress" },
							{ id: 3, subject: "Pending", status: "pending" },
						],
						nextId: 4,
					},
				},
			},
		]);
		await start(h);
		await command(h, "sidebar on");

		const sidebarText = h.overlays[0]?.component.render(44).join("\n") ?? "";
		expect(sidebarText).toContain("TODOS");
		expect(sidebarText).toContain("1/3");
		expect(sidebarText).toContain("Done");
		expect(sidebarText).toContain("Working");
		expect(sidebarText).toContain("Pending");
	});

	it("reconstructs and clears cached todos when the active branch changes", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: { todos: [{ id: 1, text: "First branch task", done: false }], nextId: 2 },
				},
			},
		]);
		await start(h);
		await command(h, "sidebar on");
		expect(h.overlays[0]).toBeDefined();
		const sidebarOverlay = h.overlays[0]!;
		expect(sidebarOverlay.component.render(44).join("\n")).toContain("First branch task");

		h.ctx.sessionManager.getBranch.mockReturnValue([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: { tasks: [{ id: 2, subject: "Second branch task", status: "pending" }], nextId: 3 },
				},
			},
		]);
		const sessionTreeHandler = h.handlers.get("session_tree");
		expect(sessionTreeHandler).toBeDefined();
		const previousRenderCount = sidebarOverlay.requestRender.mock.calls.length;
		await sessionTreeHandler!({ type: "session_tree", newLeafId: "second", oldLeafId: "first" }, h.ctx);
		expect(sidebarOverlay.requestRender.mock.calls.length).toBeGreaterThan(previousRenderCount);
		let sidebarText = sidebarOverlay.component.render(44).join("\n");
		expect(sidebarText).toContain("Second branch task");
		expect(sidebarText).not.toContain("First branch task");

		h.ctx.sessionManager.getBranch.mockReturnValue([]);
		await sessionTreeHandler!({ type: "session_tree", newLeafId: null, oldLeafId: "second" }, h.ctx);
		sidebarText = sidebarOverlay.component.render(44).join("\n");
		expect(sidebarText).not.toContain("Second branch task");
		expect(sidebarText).not.toContain("TODOS");
	});

	it("filters out tasks with unknown statuses from sidebar", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						tasks: [
							{ id: 1, subject: "Valid", status: "pending" },
							{ id: 2, subject: "Deleted", status: "deleted" },
							{ id: 3, subject: "Unknown", status: "foobar" },
						],
						nextId: 4,
					},
				},
			},
		]);
		await start(h);
		await command(h, "sidebar on");

		const sidebarText = h.overlays[0]?.component.render(44).join("\n") ?? "";
		expect(sidebarText).toContain("TODOS");
		expect(sidebarText).toContain("0/1");
		expect(sidebarText).toContain("Valid");
		expect(sidebarText).not.toContain("Deleted");
		expect(sidebarText).not.toContain("Unknown");
	});

	it("updates sidebar todos after tool_result event", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						todos: [{ id: 1, text: "Initial task", done: false }],
						nextId: 2,
					},
				},
			},
		]);
		await start(h);
		await command(h, "sidebar on");

		let sidebarText = h.overlays[0]?.component.render(44).join("\n") ?? "";
		expect(sidebarText).toContain("0/1");
		expect(sidebarText).toContain("Initial task");

		// Trigger new todo result
		const toolResultHandler = h.handlers.get("tool_result");
		await toolResultHandler!(
			{
				toolName: "todo",
				details: {
					todos: [
						{ id: 1, text: "Initial task", done: true },
						{ id: 2, text: "New task", done: false },
					],
					nextId: 3,
				},
			},
			h.ctx,
		);

		sidebarText = h.overlays[0]?.component.render(44).join("\n") ?? "";
		expect(sidebarText).toContain("1/2");
		expect(sidebarText).toContain("Initial task");
		expect(sidebarText).toContain("New task");
	});

	it("updates cached todos while the sidebar is hidden", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: { todos: [{ id: 1, text: "Initial task", done: false }], nextId: 2 },
				},
			},
		]);
		await start(h);
		await command(h, "sidebar off");

		const toolResultHandler = h.handlers.get("tool_result");
		expect(toolResultHandler).toBeDefined();
		const result = await toolResultHandler!(
			{
				toolName: "todo",
				details: { todos: [{ id: 2, text: "Hidden update", done: false }], nextId: 3 },
			},
			h.ctx,
		);
		expect(result).toBeUndefined();

		await command(h, "sidebar on");
		expect(h.overlays.at(-1)).toBeDefined();
		const sidebarText = h.overlays.at(-1)!.component.render(44).join("\n");
		expect(sidebarText).toContain("Hidden update");
		expect(sidebarText).not.toContain("Initial task");
	});

	it("clears cached todos when a valid empty list arrives", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: { todos: [{ id: 1, text: "Stale task", done: false }], nextId: 2 },
				},
			},
		]);
		await start(h);
		await command(h, "sidebar on");

		const toolResultHandler = h.handlers.get("tool_result");
		expect(toolResultHandler).toBeDefined();
		const result = await toolResultHandler!({ toolName: "todo", details: { todos: [], nextId: 1 } }, h.ctx);
		expect(result).toBeUndefined();

		await command(h, "sidebar off");
		await command(h, "sidebar on");
		expect(h.overlays.at(-1)).toBeDefined();
		const sidebarText = h.overlays.at(-1)!.component.render(44).join("\n");
		expect(sidebarText).not.toContain("Stale task");
		expect(sidebarText).not.toContain("TODOS");
	});

	it("clears cached todos when all task statuses are filtered out", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: { todos: [{ id: 1, text: "Stale task", done: false }], nextId: 2 },
				},
			},
		]);
		await start(h);
		await command(h, "sidebar on");

		const toolResultHandler = h.handlers.get("tool_result");
		expect(toolResultHandler).toBeDefined();
		const result = await toolResultHandler!(
			{
				toolName: "todo",
				details: { tasks: [{ id: 2, subject: "Deleted task", status: "deleted" }], nextId: 3 },
			},
			h.ctx,
		);
		expect(result).toBeUndefined();

		await command(h, "sidebar off");
		await command(h, "sidebar on");
		expect(h.overlays.at(-1)).toBeDefined();
		const sidebarText = h.overlays.at(-1)!.component.render(44).join("\n");
		expect(sidebarText).not.toContain("Stale task");
		expect(sidebarText).not.toContain("TODOS");
	});

	it("persists hidden Agent independently from populated TODOS across session reload", async () => {
		await withPersistedUserConfig({ showSidebarAgent: false }, async () => {
			const h = harness();
			h.ctx.sessionManager.getBranch.mockReturnValue([
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "todo",
						details: {
							todos: [
								{ id: 1, text: "Visible TODO", done: false },
								{ id: 2, text: "Completed TODO", done: true },
							],
							nextId: 3,
						},
					},
				},
			]);

			await start(h);
			expect(h.overlays[0]).toBeDefined();
			const initialSidebar = h.overlays[0]!.component.render(44).join("\n");
			expect(initialSidebar).not.toContain("AGENT");
			expect(initialSidebar).toContain("TODOS");
			expect(initialSidebar).toContain("1/2");
			expect(initialSidebar).toContain("Visible TODO");

			await start(h, replacementContext(h.ctx, "Reloaded session"));
			expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
			expect(h.overlays[1]).toBeDefined();
			const reloadedSidebar = h.overlays[1]!.component.render(44).join("\n");
			expect(reloadedSidebar).not.toContain("AGENT");
			expect(reloadedSidebar).toContain("TODOS");
			expect(reloadedSidebar).toContain("1/2");
			expect(reloadedSidebar).toContain("Visible TODO");
		});
	});

	it("hides TODOS panel and preserves full output when persisted showSidebarTodos is false", async () => {
		await withPersistedUserConfig({ showSidebarTodos: false }, async () => {
			const h = harness();
			h.ctx.sessionManager.getBranch.mockReturnValue([
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "todo",
						details: { todos: [{ id: 1, text: "Task", done: false }], nextId: 2 },
					},
				},
			]);
			await start(h);
			await command(h, "sidebar on");

			expect(h.overlays[0]).toBeDefined();
			const sidebarText = h.overlays[0]!.component.render(44).join("\n");
			expect(sidebarText).not.toContain("TODOS");

			const toolResultHandler = h.handlers.get("tool_result");
			expect(toolResultHandler).toBeDefined();
			const result = await toolResultHandler!(
				{
					toolName: "todo",
					details: { todos: [{ id: 1, text: "Task", done: false }], nextId: 2 },
				},
				h.ctx,
			);
			expect(result).toBeUndefined();
		});
	});

	describe("sidebarDisabled config", () => {
		it("does not show the sidebar on startup when sidebarDisabled is true", async () => {
			await withPersistedUserConfig({ sidebarDisabled: true }, async () => {
				const h = harness();
				await start(h);
				expect(h.overlays).toHaveLength(0);
				expect(h.custom).not.toHaveBeenCalled();
			});
		});

		it("still allows showing the sidebar via /atelier sidebar on when sidebarDisabled is true", async () => {
			await withPersistedUserConfig({ sidebarDisabled: true }, async () => {
				const h = harness();
				await start(h);
				await command(h, "sidebar on");
				expect(h.overlays).toHaveLength(1);
				expect(h.overlays[0]?.done).not.toHaveBeenCalled();
			});
		});

		it("shows the sidebar on startup by default when sidebarDisabled is not set", async () => {
			const h = harness();
			await start(h);
			expect(h.overlays).toHaveLength(1);
			expect(h.overlays[0]?.done).not.toHaveBeenCalled();
		});

		it("does not show the sidebar on startup when sidebarDisabled is explicitly true", async () => {
			await withPersistedUserConfig({ sidebarDisabled: true }, async () => {
				const h = harness();
				await start(h);
				expect(h.overlays).toHaveLength(0);
				expect(h.custom).not.toHaveBeenCalled();
			});
		});

		it("shows the sidebar on session reload even when sidebarDisabled was true in the previous session", async () => {
			await withPersistedUserConfig({ sidebarDisabled: true }, async () => {
				const h = harness();
				await start(h);
				expect(h.overlays).toHaveLength(0);

				// Reload without sidebarDisabled — should show
				await withPersistedUserConfig({}, async () => {
					await start(h, replacementContext(h.ctx, "Reloaded"));
					expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
					expect(h.overlays[1]).toBeDefined();
					expect(h.overlays[1]?.done).not.toHaveBeenCalled();
				});
			});
		});
	});
});

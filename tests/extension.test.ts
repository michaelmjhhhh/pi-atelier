import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import atelierExtension, {
	SIDEBAR_PANEL_EVENT_CHANNEL,
	type AtelierExtensionDependencies,
} from "../extensions/index.js";
import { AtelierEditor } from "../src/editor.js";
import {
	loadConfig as loadAtelierConfig,
	saveUserConfig as persistConfig,
	saveUserConfigPatch as persistConfigPatch,
} from "../src/config.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function loadConfigAfter(gate: ReturnType<typeof deferred<void>>): typeof loadAtelierConfig {
	return async (options) => {
		await gate.promise;
		return loadAtelierConfig(options);
	};
}

const execResult = (stdout: string, code = 0) => ({
	stdout,
	stderr: "",
	code,
	killed: false,
});

function harness(
	mode: "tui" | "print" = "tui",
	notificationPlatform: NodeJS.Platform = "linux",
	interactiveMenus = false,
	extensionDependencies: AtelierExtensionDependencies = {},
	options: { throwOnEventUnsubscribe?: readonly string[]; throwOnEventSubscribe?: readonly string[] } = {},
) {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const commands = new Map<string, any>();
	const eventBusHandlers = new Map<string, Set<(data: unknown) => void>>();
	const shortcuts: string[] = [];
	const shortcutHandlers = new Map<string, (ctx: any) => Promise<void> | void>();
	const setFooter = vi.fn();
	const setEditorComponent = vi.fn();
	let terminalInput: ((data: string) => unknown) | undefined;
	let terminalInputUnsubscribe = vi.fn();
	const terminalWrite = vi.fn();
	const baseRender = vi.fn((width: number) => [`main:${width}`]);
	const overlays: Array<{
		component: any;
		done: ReturnType<typeof vi.fn>;
		closed: boolean;
		handle: { hide: ReturnType<typeof vi.fn> };
		options: any;
		requestRender: ReturnType<typeof vi.fn>;
		tui: any;
	}> = [];
	const pi = {
		on: vi.fn((name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler)),
		events: {
			on: vi.fn((channel: string, handler: (data: unknown) => void) => {
				if (options.throwOnEventSubscribe?.includes(channel)) throw new Error(`subscribe failed: ${channel}`);
				const channelHandlers = eventBusHandlers.get(channel) ?? new Set();
				channelHandlers.add(handler);
				eventBusHandlers.set(channel, channelHandlers);
				return () => {
					if (options.throwOnEventUnsubscribe?.includes(channel))
						throw new Error(`unsubscribe failed: ${channel}`);
					return channelHandlers.delete(handler);
				};
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
		setSessionName: vi.fn(),
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
		const done = vi.fn((value?: any) => {
			// Pi pops the overlay off the stack inside `done`, so a closed overlay never renders again.
			const entry = overlays.find((candidate) => candidate.done === done);
			if (entry) entry.closed = true;
			resolve(value);
		});
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
		overlays.push({ component, done, closed: false, handle, options, requestRender, tui });
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
		compact: vi.fn(),
		sessionManager: {
			getEntries: vi.fn().mockReturnValue([]),
			getBranch: vi.fn().mockReturnValue([]),
			getSessionName: vi.fn().mockReturnValue("Test session"),
			getSessionFile: vi.fn().mockReturnValue("/tmp/session.jsonl"),
		},
		ui: {
			setFooter,
			setEditorComponent,
			notify: vi.fn(),
			theme: {},
			select: vi.fn(),
			custom,
			onTerminalInput: vi.fn((handler) => {
				terminalInput = handler;
				terminalInputUnsubscribe = vi.fn(() => {
					if (terminalInput === handler) terminalInput = undefined;
				});
				return terminalInputUnsubscribe;
			}),
		},
	};
	const saveConfigPatch = vi.fn().mockResolvedValue(undefined);
	const notificationProcess = {
		kill: vi.fn(() => true),
		once: vi.fn().mockReturnThis(),
		unref: vi.fn(),
	};
	const spawnNotificationProcess = vi.fn(() => notificationProcess);
	atelierExtension(pi as never, {
		saveConfigPatch,
		notificationPlatform,
		spawnNotificationProcess,
		...extensionDependencies,
	});
	return {
		handlers,
		commands,
		shortcuts,
		shortcutHandlers,
		setFooter,
		setEditorComponent,
		ctx,
		pi,
		overlays,
		custom,
		terminalWrite,
		baseRender,
		saveConfigPatch,
		spawnNotificationProcess,
		notificationProcess,
		getEventBusHandlerCount(channel: string) {
			return eventBusHandlers.get(channel)?.size ?? 0;
		},
		get terminalInput() {
			return terminalInput;
		},
		get terminalInputUnsubscribe() {
			return terminalInputUnsubscribe;
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

/** One persisted `todo` tool result, the shape session branches are reconstructed from. */
function todoBranchEntry(details: unknown, isError?: boolean) {
	return {
		type: "message",
		message: { role: "toolResult", toolName: "todo", ...(isError === undefined ? {} : { isError }), details },
	};
}

async function command(h: ReturnType<typeof harness>, args: string, ctx = h.ctx) {
	await h.commands.get("atelier").handler(args, ctx);
}

function renderOverlayText(h: ReturnType<typeof harness>, index = 0, width = 44): string {
	const overlay = h.overlays[index];
	if (!overlay) return "";
	if (overlay.closed) throw new Error(`overlay ${index} is closed; Pi would not render it`);
	return overlay.component.render(width).join("\n");
}

const FOOTER_THEME = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
};

/** Builds a footer from a captured `setFooter` factory and renders it once, as Pi would. */
function renderFooter(
	factory: any,
	requestRender: () => void,
	getExtensionStatuses: () => Map<string, string> = () => new Map(),
): any {
	const component = factory({ requestRender }, FOOTER_THEME, {
		getGitBranch: () => undefined,
		getExtensionStatuses,
		onBranchChange: () => () => undefined,
	});
	component.render(120);
	return component;
}

function queueWorkspacePulseInspection(
	h: ReturnType<typeof harness>,
	firstResult: Promise<ReturnType<typeof execResult>> = Promise.resolve(execResult("true\n/tmp/project\n")),
): void {
	h.ctx.isProjectTrusted.mockReturnValue(true);
	const results = [
		firstResult,
		Promise.resolve(
			execResult(
				"# branch.oid abcdef\0# branch.head stale-branch\0" +
					"1 .M N... 100644 100644 100644 abcdef abcdef tracked.txt\0? untracked.txt\0",
			),
		),
		Promise.resolve(execResult("treeish\n")),
		Promise.resolve(execResult("5\t2\ttracked.txt\0")),
	];
	h.pi.exec.mockImplementation(() => results.shift() ?? Promise.resolve(execResult("", 1)));
}

async function waitForWorkspacePulseInspection(h: ReturnType<typeof harness>): Promise<void> {
	await vi.waitFor(() => expect(h.pi.exec).toHaveBeenCalledTimes(4));
	await Promise.resolve();
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
	it("keeps the legacy saveConfig dependency source-compatible", () => {
		const saveConfig = vi.fn<typeof persistConfig>().mockResolvedValue(undefined);
		const dependencies: AtelierExtensionDependencies = { saveConfig };

		expect(dependencies.saveConfig).toBe(saveConfig);
	});

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
		expect(h.setEditorComponent).toHaveBeenCalledTimes(1);
		const editorFactory = h.setEditorComponent.mock.calls[0]?.[0];
		expect(editorFactory).toEqual(expect.any(Function));
		const editor = editorFactory(
			{ requestRender: vi.fn(), terminal: { rows: 24, columns: 80 } },
			{ borderColor: (text: string) => text, selectList: {} },
			{ matches: () => false },
		);
		expect(editor).toBeInstanceOf(AtelierEditor);
		expect(editor.render(32)[0]).toMatch(/^╭─+╮$/);
		expect(h.shortcuts).toContain("alt+a");
		expect(h.shortcuts).toContain("ctrl+shift+r");
	});

	it("routes alt+a to the Control Center", async () => {
		const h = harness("tui", "linux", true);
		await start(h);
		const before = h.custom.mock.calls.length;

		const opening = h.shortcutHandlers.get("alt+a")?.(h.ctx);
		await vi.waitFor(() => expect(h.overlays).toHaveLength(2));

		expect(h.custom.mock.calls.length).toBe(before + 1);
		expect(h.overlays.at(-1)?.component.render(80).join("\n")).toContain("Atelier Control Center");
		h.overlays.at(-1)?.component.handleInput("\u001b");
		await opening;
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
		await vi.waitFor(() => expect(deferredLoadConfig).toHaveBeenCalledOnce());
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

	it("closes a session-owned Control Center overlay during replacement", async () => {
		const h = harness("tui", "linux", true);
		await start(h);

		const opening = command(h, "");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(2));
		const controlCenter = h.overlays[1]!;

		await start(h, replacementContext(h.ctx, "Replacement session"));
		await opening;

		expect(controlCenter.done).toHaveBeenCalledOnce();
		expect(controlCenter.closed).toBe(true);
		expect(renderOverlayText(h, 2)).toContain("Replacement session");
	});

	it("closes a session-owned Display Settings overlay during replacement", async () => {
		const h = harness("tui", "linux", true);
		await start(h);

		const opening = command(h, "display");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(2));
		const displaySettings = h.overlays[1]!;

		await start(h, replacementContext(h.ctx, "Replacement session"));
		await opening;

		expect(displaySettings.done).toHaveBeenCalledOnce();
		expect(displaySettings.closed).toBe(true);
		expect(renderOverlayText(h, 2)).toContain("Replacement session");
	});

	it.each([
		["Display", "display"],
		["Control Center", ""],
	])("settles a retired %s command when host done throws", async (_label, args) => {
		const h = harness("tui", "linux", true);
		await start(h);
		const opening = command(h, args);
		await vi.waitFor(() => expect(h.overlays).toHaveLength(2));
		const displaySettings = h.overlays[1]!;
		displaySettings.done.mockImplementation(() => {
			throw new Error("overlay close failed");
		});

		await start(h, replacementContext(h.ctx, "Replacement session"));

		await expect(opening).resolves.toBeUndefined();
		expect(displaySettings.closed).toBe(false);
		expect(() => displaySettings.component.render(80)).not.toThrow();
		expect(displaySettings.component.render(80)).toEqual([]);
		displaySettings.requestRender.mockClear();
		expect(() => displaySettings.component.handleInput(" ")).not.toThrow();
		expect(displaySettings.requestRender).not.toHaveBeenCalled();
		expect(renderOverlayText(h, 2)).toContain("Replacement session");
	});

	it("renders an inert Display workspace when retirement cannot remove its overlay", async () => {
		const h = harness("tui", "linux", true);
		await start(h);
		const opening = command(h, "display");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(2));
		const displaySettings = h.overlays[1]!;
		displaySettings.done.mockImplementation(() => {
			throw new Error("display overlay close failed");
		});

		await start(h, replacementContext(h.ctx, "Replacement session"));

		expect(displaySettings.closed).toBe(false);
		expect(() => displaySettings.component.render(80)).not.toThrow();
		expect(displaySettings.component.render(80)).toEqual([]);
		displaySettings.requestRender.mockClear();
		expect(() => displaySettings.component.handleInput(" ")).not.toThrow();
		expect(displaySettings.requestRender).not.toHaveBeenCalled();
		expect(renderOverlayText(h, 2)).toContain("Replacement session");
	});

	it("renders an inert retired Control Center tool overlay", async () => {
		initTheme("dark");
		const h = harness("tui", "linux", true);
		const setActiveTools = vi.fn();
		(h.pi as any).setActiveTools = setActiveTools;
		await start(h);
		void command(h, "");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(2));
		const root = h.overlays[1]!;
		root.component.handleInput("\u001b[B");
		root.component.handleInput("\r");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(3));
		const controls = h.overlays[2]!;
		controls.component.handleInput("\u001b[B");
		controls.component.handleInput("\u001b[B");
		controls.component.handleInput("\r");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(4));
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

	it("renders an inert retired Control Center text input", async () => {
		const h = harness("tui", "linux", true);
		await start(h);
		void command(h, "");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(2));
		const root = h.overlays[1]!;
		root.component.handleInput("\u001b[B");
		root.component.handleInput("\u001b[B");
		root.component.handleInput("\r");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(3));
		const actions = h.overlays[2]!;
		actions.component.handleInput("\u001b[B");
		actions.component.handleInput("\r");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(4));
		const textInput = h.overlays[3]!;
		textInput.done.mockImplementation(() => {
			throw new Error("text input close failed");
		});

		await start(h, replacementContext(h.ctx, "Replacement session"));

		expect(textInput.closed).toBe(false);
		expect(() => textInput.component.render(80)).not.toThrow();
		expect(textInput.component.render(80)).toEqual([]);
		expect(() => textInput.component.handleInput("new name")).not.toThrow();
		expect(h.pi.setSessionName).not.toHaveBeenCalled();
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

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);

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
		await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.handlers.get("tool_execution_start")?.(
			{
				type: "tool_execution_start",
				toolCallId: "active-tool",
				toolName: "read",
				args: { path: "/tmp/project/current.ts" },
			},
			h.ctx,
		);
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
		await h.handlers.get("agent_start")?.({ type: "agent_start" }, failingCtx);
		await h.handlers.get("tool_execution_start")?.(
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
		const saveConfigPatch = vi.fn<typeof persistConfigPatch>().mockImplementation(async () => {
			await saved.promise;
		});
		const h = harness("tui", "linux", true, { saveConfigPatch });
		await start(h);
		const opening = command(h, "display");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(2));
		const displaySettings = h.overlays[1]!;

		displaySettings.component.handleInput(" ");
		displaySettings.component.handleInput("s");
		await vi.waitFor(() => expect(saveConfigPatch).toHaveBeenCalledOnce());

		await start(h, replacementContext(h.ctx, "Replacement session"));
		await opening;
		displaySettings.requestRender.mockClear();
		saved.resolve(undefined);
		await Promise.resolve();
		await Promise.resolve();

		expect(displaySettings.requestRender).not.toHaveBeenCalled();
		expect(renderOverlayText(h, 2)).toContain("Replacement session");
	});

	it("suppresses deferred Control Center save notifications after replacement", async () => {
		const saved = deferred<void>();
		const saveConfigPatch = vi.fn<typeof persistConfigPatch>().mockImplementation(async () => {
			await saved.promise;
		});
		const h = harness("tui", "linux", true, { saveConfigPatch });
		await start(h);
		const opening = command(h, "");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(2));
		h.overlays[1]!.component.handleInput("\r");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(3));
		h.overlays[2]!.component.handleInput("\u001b[B");
		h.overlays[2]!.component.handleInput("\r");
		await vi.waitFor(() => expect(saveConfigPatch).toHaveBeenCalledOnce());

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
		await vi.waitFor(() => expect(h.overlays).toHaveLength(2));
		h.overlays[1]!.component.handleInput("\u001b[B");
		h.overlays[1]!.component.handleInput("\r");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(3));
		h.overlays[2]!.component.handleInput("\u001b[B");
		h.overlays[2]!.component.handleInput("\r");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(4));
		const modelPrompt = h.overlays[3]!;

		await start(h, replacementContext(h.ctx, "Replacement session"));
		await opening;

		expect(modelPrompt.done).toHaveBeenCalledOnce();
		expect(modelPrompt.closed).toBe(true);
		expect(renderOverlayText(h, h.overlays.length - 1)).toContain("Replacement session");
	});

	it("closes the Control Center rename prompt during replacement", async () => {
		const h = harness("tui", "linux", true);
		await start(h);
		const opening = command(h, "");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(2));
		h.overlays[1]!.component.handleInput("\u001b[B");
		h.overlays[1]!.component.handleInput("\u001b[B");
		h.overlays[1]!.component.handleInput("\r");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(3));
		h.overlays[2]!.component.handleInput("\u001b[B");
		h.overlays[2]!.component.handleInput("\r");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(4));
		const renamePrompt = h.overlays[3]!;

		await start(h, replacementContext(h.ctx, "Replacement session"));
		await opening;

		expect(renamePrompt.done).toHaveBeenCalledOnce();
		expect(renamePrompt.closed).toBe(true);
		expect(h.pi.setSessionName).not.toHaveBeenCalled();
		expect(renderOverlayText(h, h.overlays.length - 1)).toContain("Replacement session");
	});

	it("closes the Control Center compact prompt during replacement", async () => {
		const h = harness("tui", "linux", true);
		await start(h);
		const opening = command(h, "");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(2));
		h.overlays[1]!.component.handleInput("\u001b[B");
		h.overlays[1]!.component.handleInput("\u001b[B");
		h.overlays[1]!.component.handleInput("\r");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(3));
		h.overlays[2]!.component.handleInput("\u001b[B");
		h.overlays[2]!.component.handleInput("\u001b[B");
		h.overlays[2]!.component.handleInput("\r");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(4));
		const compactPrompt = h.overlays[3]!;

		await start(h, replacementContext(h.ctx, "Replacement session"));
		await opening;

		expect(compactPrompt.done).toHaveBeenCalledOnce();
		expect(compactPrompt.closed).toBe(true);
		expect(h.ctx.compact).not.toHaveBeenCalled();
		expect(renderOverlayText(h, h.overlays.length - 1)).toContain("Replacement session");
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
		expect(h.saveConfigPatch).not.toHaveBeenCalled();
	});

	it("keeps Pi rendering untouched beneath the visible sidebar", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");

		expect(h.overlays[0]?.options.overlayOptions()).toMatchObject({ width: 44 });
		expect(h.overlays[0]?.tui.render(120)).toEqual(["main:120"]);

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

	it("closes an enabled sidebar and resize input during shutdown", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");
		await h.shortcutHandlers.get("ctrl+shift+r")?.(h.ctx);
		expect(h.terminalWrite).toHaveBeenLastCalledWith("\u001b[?1002h\u001b[?1006h");
		expect(h.terminalInput).toEqual(expect.any(Function));

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);

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
		await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 1, timestamp: 1_000 }, h.ctx);
		await h.handlers.get("tool_execution_start")?.(
			{
				type: "tool_execution_start",
				toolCallId: "shutdown-tool",
				toolName: "read",
				args: { path: "/tmp/project/shutdown-stale.ts" },
			},
			h.ctx,
		);
		const beforeShutdown = renderOverlayText(h);
		expect(beforeShutdown).toContain("Shutdown stale TODO");
		expect(beforeShutdown).toContain("shutdown-stale.ts");

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
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
		await h.handlers.get("session_tree")?.({ type: "session_tree" }, failingCtx);
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

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);

		expect(h.notificationProcess.kill).toHaveBeenCalled();
	});

	it("waits to inspect Workspace Pulse until the project is trusted", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			expect(h.ctx.isProjectTrusted()).toBe(false);

			await start(h);
			await h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0 }, h.ctx);
			await h.handlers.get("tool_execution_end")?.(
				{
					type: "tool_execution_end",
					toolCallId: "untrusted-pulse-tool",
					toolName: "write",
					result: { output: "" },
				},
				h.ctx,
			);
			await h.handlers.get("turn_end")?.({ type: "turn_end" }, h.ctx);
			await vi.advanceTimersByTimeAsync(1_000);

			expect(h.pi.exec).not.toHaveBeenCalled();

			h.ctx.isProjectTrusted.mockReturnValue(true);
			await h.handlers.get("turn_end")?.({ type: "turn_end" }, h.ctx);

			expect(h.pi.exec).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops an in-flight Workspace Pulse inspection when project trust is revoked", async () => {
		const discovery = deferred<ReturnType<typeof execResult>>();
		const h = harness();
		queueWorkspacePulseInspection(h, discovery.promise);
		await start(h);
		await vi.waitFor(() => expect(h.pi.exec).toHaveBeenCalledOnce());

		h.ctx.isProjectTrusted.mockReturnValue(false);
		discovery.resolve(execResult("true\n/tmp/project\n"));
		await Promise.resolve();
		await Promise.resolve();

		expect(h.pi.exec).toHaveBeenCalledOnce();
	});

	it("stops a scheduled workspace pulse refresh after shutdown", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			h.ctx.isProjectTrusted.mockReturnValue(true);
			await start(h);
			const timersBeforeSchedule = vi.getTimerCount();
			await h.handlers.get("tool_execution_end")?.(
				{
					type: "tool_execution_end",
					toolCallId: "pulse-tool",
					toolName: "write",
					result: { output: "" },
				},
				h.ctx,
			);
			expect(vi.getTimerCount()).toBeGreaterThan(timersBeforeSchedule);
			const execCallsBeforeShutdown = h.pi.exec.mock.calls.length;

			await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
			expect(vi.getTimerCount()).toBe(timersBeforeSchedule);
			await vi.advanceTimersByTimeAsync(1_000);

			expect(h.pi.exec.mock.calls.length).toBe(execCallsBeforeShutdown);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not publish an in-flight workspace pulse refresh after shutdown", async () => {
		const active = harness();
		queueWorkspacePulseInspection(active);
		await start(active);
		await waitForWorkspacePulseInspection(active);
		// Positive control: a published pulse does reach the sidebar.
		expect(renderOverlayText(active)).toContain("stale-branch");
		expect(renderOverlayText(active)).toContain("1 tracked");
		await active.handlers.get("session_shutdown")?.({ reason: "quit" }, active.ctx);
		expect(active.overlays[0]?.done).toHaveBeenCalledOnce();

		const discovery = deferred<ReturnType<typeof execResult>>();
		const h = harness();
		queueWorkspacePulseInspection(h, discovery.promise);
		await start(h);
		await vi.waitFor(() => expect(h.pi.exec).toHaveBeenCalledOnce());

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
		h.overlays[0]?.requestRender.mockClear();
		discovery.resolve(execResult("true\n/tmp/project\n"));
		await Promise.resolve();
		await Promise.resolve();

		expect(h.pi.exec).toHaveBeenCalledOnce();
		expect(h.overlays[0]?.requestRender).not.toHaveBeenCalled();
	});

	it("disposes a mounted footer when setFooter removal throws", async () => {
		const h = harness();
		let mountedFooter: any;
		const unsubscribe = vi.fn();
		let branchChange: (() => void) | undefined;
		h.setFooter.mockImplementation((value: unknown) => {
			if (value === undefined) throw new Error("footer removal failed");
			if (typeof value === "function") {
				mountedFooter = value({ requestRender: vi.fn() }, FOOTER_THEME, {
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

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);

		expect(mountedFooter).toBeDefined();
		expect(unsubscribe).toHaveBeenCalledOnce();
		branchChange?.();
		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("detaches branch callbacks from a retired footer after removal fails", async () => {
		const h = harness();
		await start(h);
		let branchChange: (() => void) | undefined;
		const requestRender = vi.fn();
		const factory = h.setFooter.mock.calls[0]?.[0];
		expect(factory).toEqual(expect.any(Function));
		const footer = factory({ requestRender }, FOOTER_THEME, {
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

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
		branchChange?.();
		expect(branchChange).toEqual(expect.any(Function));
		expect(requestRender).not.toHaveBeenCalled();
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
			const component = value({ requestRender }, FOOTER_THEME, {
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

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
		expect(newFooter?.unsubscribe).toHaveBeenCalledOnce();
		expect(oldFooter?.unsubscribe).toHaveBeenCalledOnce();
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
		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);

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
		await vi.waitFor(() => expect(deferredLoadConfig).toHaveBeenCalledOnce());
		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
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
		await vi.waitFor(() => expect(deferredLoadConfig).toHaveBeenCalledTimes(1));
		const newerContext = replacementContext(h.ctx, "Newer");
		const secondStart = start(h, newerContext);
		await vi.waitFor(() => expect(deferredLoadConfig).toHaveBeenCalledTimes(2));
		secondLoad.resolve(undefined);
		await secondStart;
		expect(h.overlays).toHaveLength(1);
		expect(h.overlays[0]?.component.render(44).join("\n")).toContain("Newer");

		firstLoad.resolve(undefined);
		await firstStart;

		expect(h.overlays).toHaveLength(1);
		expect(h.overlays[0]?.done).not.toHaveBeenCalled();
		expect(h.overlays[0]?.component.render(44).join("\n")).toContain("Newer");
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
		await vi.waitFor(() => expect(deferredLoadConfig).toHaveBeenCalledTimes(1));
		const newerContext = replacementContext(h.ctx, "Newer");
		const secondStart = start(h, newerContext);
		await vi.waitFor(() => expect(deferredLoadConfig).toHaveBeenCalledTimes(2));

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
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
			.mockImplementationOnce(loadAtelierConfig)
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
		await vi.waitFor(() => expect(deferredLoadConfig).toHaveBeenCalledTimes(2));

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, replacementContextValue);
		replacementLoad.resolve(undefined);
		await replacementStart;

		expect(h.overlays).toHaveLength(1);
		expect(h.overlays[0]?.done).not.toHaveBeenCalled();
		expect(renderOverlayText(h)).toContain("Test session");
		await h.handlers.get("session_tree")?.({ type: "session_tree" }, h.ctx);
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

	it("passes command state to the menu controller", async () => {
		const h = harness("tui", "linux", true);
		await start(h);
		await command(h, "sidebar on");
		const opening = command(h, "");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(2));
		const menu = h.overlays[1]?.component.render(80).join("\n");
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
				await vi.waitFor(() => expect(h.overlays).toHaveLength(2));
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
			expect(h.overlays[0]?.component.render(44).join("\n")).not.toContain("\u001b[38;2;");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("opens the Display workspace directly and rejects it outside TUI mode", async () => {
		const h = harness("tui", "linux", true);
		await start(h);
		const before = h.custom.mock.calls.length;
		const opening = command(h, "display");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(2));
		expect(h.custom.mock.calls.length).toBe(before + 1);
		expect(h.overlays.at(-1)?.component.render(80).join("\n")).toContain("DISPLAY SETTINGS");
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
		expect(h.getEventBusHandlerCount("rpiv:ask-user:blocked")).toBe(1);

		const currentCtx = replacementContext(h.ctx, "Replacement session");
		await start(h, currentCtx);
		expect(h.getEventBusHandlerCount("rpiv:ask-user:blocked")).toBe(1);
		await h.handlers.get("agent_start")?.({ type: "agent_start" }, currentCtx);

		h.pi.events.emit("rpiv:ask-user:blocked", { active: true });
		expect(h.spawnNotificationProcess).toHaveBeenCalledTimes(1);

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, currentCtx);
		expect(h.getEventBusHandlerCount("rpiv:ask-user:blocked")).toBe(0);
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
			const h = harness("tui", "linux", true);
			await start(h);
			const opening = command(h, "display");
			await vi.waitFor(() => expect(h.overlays).toHaveLength(2));
			const workspace = h.overlays.at(-1)?.component;
			// Walk to the performance segment by name; its position in the list is not part of this test.
			for (let guard = 20; guard > 0; guard -= 1) {
				if (workspace.render(120).at(-2).includes("performance ·")) break;
				workspace.handleInput("\u001b[B");
			}
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
			workspace.handleInput("\u001b");
			await opening;
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

	it("coalesces a Turn-start Workspace Pulse refresh for 250ms", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			h.ctx.isProjectTrusted.mockReturnValue(true);
			await start(h);
			const inspectionsAfterStart = h.pi.exec.mock.calls.length;

			await h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0 }, h.ctx);
			await vi.advanceTimersByTimeAsync(249);
			expect(h.pi.exec).toHaveBeenCalledTimes(inspectionsAfterStart);
			await vi.advanceTimersByTimeAsync(1);
			expect(h.pi.exec).toHaveBeenCalledTimes(inspectionsAfterStart + 1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("flushes a fresh Workspace Pulse at Turn end without leaving a scheduled duplicate", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			h.ctx.isProjectTrusted.mockReturnValue(true);
			await start(h);
			const inspectionsAfterStart = h.pi.exec.mock.calls.length;

			await h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0 }, h.ctx);
			await h.handlers.get("turn_end")?.({ type: "turn_end" }, h.ctx);
			expect(h.pi.exec).toHaveBeenCalledTimes(inspectionsAfterStart + 1);

			await vi.advanceTimersByTimeAsync(1_000);
			expect(h.pi.exec).toHaveBeenCalledTimes(inspectionsAfterStart + 1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("coalesces rapid tool completions into one Workspace Pulse refresh", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			h.ctx.isProjectTrusted.mockReturnValue(true);
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
			expect(withResult).toContain("Run · running");
			expect(withResult).not.toContain("src/run-activity.ts");
			expect(withResult).not.toContain("done 1s");
			expect(withResult).not.toContain("tools 1 done · 0 failed");

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
			expect(settledText).toContain("read");
			expect(settledText).toContain("src/run-activity.ts");
			expect(settledText).toContain("done 1s");

			vi.advanceTimersByTime(3_000);
			expect(h.overlays[0]?.requestRender.mock.calls.length).toBe(settledRenderCount);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a live Turn overlay to current work without history", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			todoBranchEntry({
				tasks: [
					{ id: 1, subject: "Done live TODO", status: "completed" },
					{ id: 2, subject: "Current live TODO", status: "in_progress" },
					{ id: 3, subject: "Queued live TODO", status: "pending" },
				],
				nextId: 4,
			}),
		]);
		await start(h);
		await command(h, "sidebar on");
		await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 1, timestamp: 1_000 }, h.ctx);
		await h.handlers.get("tool_execution_start")?.(
			{
				type: "tool_execution_start",
				toolCallId: "older",
				toolName: "read",
				args: { path: "/tmp/project/older.ts" },
			},
			h.ctx,
		);
		await h.handlers.get("tool_execution_start")?.(
			{
				type: "tool_execution_start",
				toolCallId: "newer",
				toolName: "write",
				args: { path: "/tmp/project/newer.ts" },
			},
			h.ctx,
		);

		const live = renderOverlayText(h);
		expect(live).toContain("Turn 2 · running");
		expect(live).toContain("newer.ts");
		expect(live).toContain("+1");
		expect(live).not.toContain("older.ts");
		expect(live).toContain("Current live TODO");
		expect(live).not.toContain("Done live TODO");
		expect(live).not.toContain("Queued live TODO");
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
	it.each([
		{
			name: "old format todos",
			details: {
				todos: [
					{ id: 1, text: "Done task", done: true },
					{ id: 2, text: "Pending task", done: false },
				],
				nextId: 3,
			},
			summary: "1/2 done · see sidebar",
		},
		{
			name: "new format tasks",
			details: {
				tasks: [
					{ id: 1, subject: "Done", status: "completed" },
					{ id: 2, subject: "Working", status: "in_progress" },
					{ id: 3, subject: "Pending", status: "pending" },
				],
				nextId: 4,
			},
			summary: "1/3 done · see sidebar",
		},
	])("collapses $name when sidebar is visible", async ({ details, summary }) => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");

		const toolResultHandler = h.handlers.get("tool_result");
		expect(toolResultHandler).toBeDefined();
		const result = await toolResultHandler!({ toolName: "todo", details }, h.ctx);

		expect(result).toEqual({ content: [{ type: "text", text: summary }] });
	});

	it("preserves cached todos for error and malformed results", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			todoBranchEntry({ todos: [{ id: 1, text: "Initial task", done: false }], nextId: 2 }),
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

	it("ignores non-todo tool results", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");

		const toolResultHandler = h.handlers.get("tool_result");

		const event = { toolName: "read", details: {} };
		const result = await toolResultHandler!(event, h.ctx);
		expect(result).toBeUndefined();
	});
});
describe("sidebar todos integration", () => {
	it.each([
		{
			name: "old format",
			details: {
				todos: [
					{ id: 1, text: "Completed task", done: true },
					{ id: 2, text: "Pending task", done: false },
				],
				nextId: 3,
			},
			progress: "1/2",
			texts: ["Completed task", "Pending task"],
		},
		{
			name: "new format",
			details: {
				tasks: [
					{ id: 1, subject: "Done", status: "completed" },
					{ id: 2, subject: "Working", status: "in_progress" },
					{ id: 3, subject: "Pending", status: "pending" },
				],
				nextId: 4,
			},
			progress: "1/3",
			texts: ["Done", "Working", "Pending"],
		},
	])("shows TODOS panel reconstructed from $name branch entries", async ({ details, progress, texts }) => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([todoBranchEntry(details)]);
		await start(h);
		await command(h, "sidebar on");

		const sidebarText = renderOverlayText(h);
		expect(sidebarText).toContain("TODOS");
		expect(sidebarText).toContain(progress);
		for (const text of texts) expect(sidebarText).toContain(text);
	});

	it("skips error TODO results during branch reconstruction", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			todoBranchEntry({ todos: [{ id: 1, text: "Successful task", done: false }], nextId: 2 }, false),
			todoBranchEntry({ todos: [{ id: 2, text: "Failed task", done: false }], nextId: 3 }, true),
		]);
		await start(h);
		await command(h, "sidebar on");

		expect(h.overlays[0]).toBeDefined();
		const sidebarText = h.overlays[0]!.component.render(44).join("\n");
		expect(sidebarText).toContain("Successful task");
		expect(sidebarText).not.toContain("Failed task");
	});

	it("reconstructs and clears cached todos when the active branch changes", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			todoBranchEntry({ todos: [{ id: 1, text: "First branch task", done: false }], nextId: 2 }),
		]);
		await start(h);
		await command(h, "sidebar on");
		expect(h.overlays[0]).toBeDefined();
		const sidebarOverlay = h.overlays[0]!;
		expect(sidebarOverlay.component.render(44).join("\n")).toContain("First branch task");

		h.ctx.sessionManager.getBranch.mockReturnValue([
			todoBranchEntry({ tasks: [{ id: 2, subject: "Second branch task", status: "pending" }], nextId: 3 }),
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
			todoBranchEntry({
				tasks: [
					{ id: 1, subject: "Valid", status: "pending" },
					{ id: 2, subject: "Deleted", status: "deleted" },
					{ id: 3, subject: "Unknown", status: "foobar" },
				],
				nextId: 4,
			}),
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
			todoBranchEntry({
				todos: [{ id: 1, text: "Initial task", done: false }],
				nextId: 2,
			}),
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
			todoBranchEntry({ todos: [{ id: 1, text: "Initial task", done: false }], nextId: 2 }),
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
			todoBranchEntry({ todos: [{ id: 1, text: "Stale task", done: false }], nextId: 2 }),
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
			todoBranchEntry({ todos: [{ id: 1, text: "Stale task", done: false }], nextId: 2 }),
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
				todoBranchEntry({
					todos: [
						{ id: 1, text: "Visible TODO", done: false },
						{ id: 2, text: "Completed TODO", done: true },
					],
					nextId: 3,
				}),
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
				todoBranchEntry({ todos: [{ id: 1, text: "Task", done: false }], nextId: 2 }),
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
});

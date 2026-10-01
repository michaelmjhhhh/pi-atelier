import { fakeTui, overlayHost } from "./overlay-host.js";
import { eventTransport } from "./events.js";
import { deferred, settleMicrotasks } from "./async.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi, onTestFinished } from "vitest";
import { type ExtensionEvent } from "@earendil-works/pi-coding-agent";
import atelierExtension, { type AtelierExtensionDependencies } from "../../extensions/index.js";
import { AtelierEditor } from "../../src/editor.js";
import { loadConfig as loadAtelierConfig, resolveConfig } from "../../src/config.js";
import { plainTheme, stripAnsi } from "./render.js";

let persistedConfig = false;
export const loadTestConfig: typeof loadAtelierConfig = (options) =>
	persistedConfig ? loadAtelierConfig(options) : Promise.resolve(resolveConfig({}));

export function loadConfigAfter(gate: ReturnType<typeof deferred<void>>): typeof loadAtelierConfig {
	return async (options) => {
		await gate.promise;
		return loadTestConfig(options);
	};
}

export const execResult = (stdout = "", code = 0, stderr = "") => ({
	stdout,
	stderr,
	code,
	killed: false,
});

export function harness(
	mode: "tui" | "print" = "tui",
	notificationPlatform: NodeJS.Platform = "linux",
	interactiveMenus = false,
	extensionDependencies: AtelierExtensionDependencies = {},
	options: { throwOnEventUnsubscribe?: readonly string[]; throwOnEventSubscribe?: readonly string[] } = {},
) {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const commands = new Map<string, any>();
	const bus = eventTransport(options);
	const shortcuts: string[] = [];
	const shortcutHandlers = new Map<string, (ctx: any) => Promise<void> | void>();
	const setFooter = vi.fn();
	const setEditorComponent = vi.fn();
	let terminalInput: ((data: string) => unknown) | undefined;
	let terminalInputUnsubscribe = vi.fn();
	const terminalWrite = vi.fn();
	const baseRender = vi.fn((width: number) => [`main:${width}`]);
	const tui = {
		...fakeTui(),
		render: baseRender,
		terminal: { columns: 120, rows: 36, width: 120, write: terminalWrite },
	};
	const host = overlayHost(() => tui, interactiveMenus);
	const { overlays, custom } = host;
	const pi = {
		on: vi.fn((name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler)),
		events: bus.events,
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
			getSessionId: vi.fn().mockReturnValue("test-session"),
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
		loadConfig: loadTestConfig,
		saveConfigPatch,
		notificationPlatform,
		spawnNotificationProcess,
		...extensionDependencies,
	});
	const contexts = new Set<typeof ctx>();
	const handler = (name: ExtensionEvent["type"]) => {
		const registered = handlers.get(name);
		if (!registered) throw new Error(`Missing extension handler: ${name}`);
		return registered;
	};
	onTestFinished(async () => {
		for (const context of contexts) await handler("session_shutdown")({ reason: "quit" }, context);
		await settleMicrotasks();
	});
	return {
		handlers,
		handler,
		dispatch(name: ExtensionEvent["type"], event: unknown, context = ctx) {
			if (name === "session_start") contexts.add(context);
			return handler(name)(event, context);
		},
		commands,
		shortcuts,
		shortcutHandlers,
		setFooter,
		setEditorComponent,
		ctx,
		pi,
		overlays,
		mounted: host.mounted,
		custom,
		terminalWrite,
		baseRender,
		saveConfigPatch,
		spawnNotificationProcess,
		notificationProcess,
		getEventBusHandlerCount(channel: string) {
			return bus.listenerCount(channel);
		},
		get terminalInput() {
			return terminalInput;
		},
		get terminalInputUnsubscribe() {
			return terminalInputUnsubscribe;
		},
	};
}

export function replacementContext(
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

export async function start(h: ReturnType<typeof harness>, ctx = h.ctx) {
	await h.dispatch("session_start", { reason: "startup" }, ctx);
}

/** One persisted `todo` tool result, the shape session branches are reconstructed from. */
export function todoBranchEntry(details: unknown, isError?: boolean) {
	return {
		type: "message",
		message: { role: "toolResult", toolName: "todo", ...(isError === undefined ? {} : { isError }), details },
	};
}

export async function command(h: ReturnType<typeof harness>, args: string, ctx = h.ctx) {
	await h.commands.get("atelier").handler(args, ctx);
}

export function renderOverlayText(h: ReturnType<typeof harness>, index = 0, width = 44): string {
	const overlay = h.overlays[index];
	if (!overlay) throw new Error(`overlay ${index} was not mounted`);
	if (overlay.closed) throw new Error(`overlay ${index} is closed; Pi would not render it`);
	return stripAnsi(overlay.component.render(width).join("\n"));
}

/** Mounts the public editor/footer factories in the order Pi uses them. */
export function mountComposer(h: ReturnType<typeof harness>) {
	const tui = { requestRender: vi.fn(), terminal: { rows: 24, columns: 80 } };
	const footer = h.setFooter.mock.calls[0]?.[0](tui, plainTheme, {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map(),
		onBranchChange: () => () => undefined,
	});
	const editor: AtelierEditor = h.setEditorComponent.mock.calls[0]?.[0](
		tui,
		{ borderColor: (text: string) => text, selectList: {} },
		{ matches: () => false },
	);
	return { tui, footer, editor };
}

/** Builds a footer from a captured `setFooter` factory and renders it once, as Pi would. */
export function renderFooter(
	factory: any,
	requestRender: () => void,
	getExtensionStatuses: () => Map<string, string> = () => new Map(),
): any {
	const component = factory({ requestRender }, plainTheme, {
		getGitBranch: () => undefined,
		getExtensionStatuses,
		onBranchChange: () => () => undefined,
	});
	component.render(120);
	return component;
}

export function queueWorkspacePulseInspection(
	h: ReturnType<typeof harness>,
	firstResult: Promise<ReturnType<typeof execResult>> = Promise.resolve(execResult("true\n/tmp/project\n")),
): Promise<void> {
	const inspected = deferred<void>();
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
	h.pi.exec.mockImplementation(() => {
		const result = results.shift();
		if (results.length === 0) inspected.resolve();
		return result ?? Promise.resolve(execResult("", 1));
	});
	return inspected.promise;
}

export async function withPersistedUserConfig(
	config: Record<string, unknown>,
	run: () => Promise<void>,
): Promise<void> {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await mkdtemp(join(tmpdir(), "pi-atelier-extension-"));
	try {
		await writeFile(join(agentDir, "pi-atelier.json"), JSON.stringify(config), "utf8");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		persistedConfig = true;
		await run();
	} finally {
		persistedConfig = false;
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(agentDir, { recursive: true, force: true });
	}
}

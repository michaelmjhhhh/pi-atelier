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
	const setFooter = vi.fn();
	const overlays: Array<{
		component: any;
		done: ReturnType<typeof vi.fn>;
		handle: { hide: ReturnType<typeof vi.fn> };
		options: any;
		requestRender: ReturnType<typeof vi.fn>;
	}> = [];
	const pi = {
		on: vi.fn((name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler)),
		registerCommand: vi.fn((name: string, options: any) => commands.set(name, options)),
		registerShortcut: vi.fn((key: string) => shortcuts.push(key)),
		exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
		getThinkingLevel: vi.fn().mockReturnValue("medium"),
		getActiveTools: vi.fn().mockReturnValue(["read"]),
		getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
	};
	const custom = vi.fn((factory: (...args: any[]) => any, options: any) => {
		const requestRender = vi.fn();
		let resolve!: (value: undefined) => void;
		const pending = new Promise<undefined>((done) => {
			resolve = done;
		});
		const done = vi.fn(() => resolve(undefined));
		const handle = { hide: vi.fn() };
		const component = factory(
			{ terminal: { columns: 120, rows: 36, width: 120 }, requestRender },
			{
				name: "dark",
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
				italic: (text: string) => text,
			},
			{},
			done,
		);
		overlays.push({ component, done, handle, options, requestRender });
		options?.onHandle?.(handle);
		if (!options?.overlayOptions?.nonCapturing) done();
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
		ui: { setFooter, notify: vi.fn(), theme: {}, custom },
	};
	atelierExtension(pi as never);
	return { handlers, commands, shortcuts, setFooter, ctx, pi, overlays, custom };
}

async function start(h: ReturnType<typeof harness>) {
	await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
}

async function command(h: ReturnType<typeof harness>, args: string) {
	await h.commands.get("atelier").handler(args, h.ctx);
}

describe("extension registration", () => {
	it("registers the command and installs one footer in TUI mode", async () => {
		const h = harness();
		expect(h.commands.has("atelier")).toBe(true);
		await start(h);
		expect(h.setFooter).toHaveBeenCalledTimes(1);
		expect(h.shortcuts).toContain("alt+a");
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
			overlayOptions: expect.objectContaining({ nonCapturing: true }),
			onHandle: expect.any(Function),
		});
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

	it("keeps sidebar and footer enablement independent", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");
		await command(h, "disable");
		expect(h.overlays[0]?.done).not.toHaveBeenCalled();
		await command(h, "sidebar off");
		await command(h, "enable");
		expect(h.custom).toHaveBeenCalledTimes(1);
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
		expect(h.overlays[0]?.requestRender).toHaveBeenCalledTimes(1);
		statuses = new Map([["one", "extension two"]]);
		footer.render(120);
		expect(h.overlays[0]?.requestRender).toHaveBeenCalledTimes(2);
	});
});

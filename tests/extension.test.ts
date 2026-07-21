import { describe, expect, it, vi } from "vitest";
import atelierExtension from "../extensions/index.js";

function harness(mode: "tui" | "print" = "tui") {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const commands = new Map<string, any>();
	const shortcuts: string[] = [];
	const setFooter = vi.fn();
	const pi = {
		on: vi.fn((name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler)),
		registerCommand: vi.fn((name: string, options: any) => commands.set(name, options)),
		registerShortcut: vi.fn((key: string) => shortcuts.push(key)),
		exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
		getThinkingLevel: vi.fn().mockReturnValue("medium"),
		getActiveTools: vi.fn().mockReturnValue(["read"]),
		getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
	};
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
			custom: vi.fn().mockImplementation(async (factory) => {
				factory(
					{ terminal: { width: 120 }, requestRender: vi.fn() },
					{
						fg: (_color: string, text: string) => text,
						bold: (text: string) => text,
						italic: (text: string) => text,
					},
					{},
					() => undefined,
				);
			}),
		},
	};
	atelierExtension(pi as never);
	return { handlers, commands, shortcuts, setFooter, ctx, pi };
}

describe("extension registration", () => {
	it("registers the command and installs one footer in TUI mode", async () => {
		const h = harness();
		expect(h.commands.has("atelier")).toBe(true);
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		expect(h.setFooter).toHaveBeenCalledTimes(1);
		expect(h.shortcuts).toContain("alt+a");
	});

	it("does not install terminal UI outside TUI mode", async () => {
		const h = harness("print");
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		expect(h.setFooter).not.toHaveBeenCalled();
	});

	it("opens the sidebar through /atelier sidebar", async () => {
		const h = harness();
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		await h.commands.get("atelier").handler("sidebar", h.ctx);
		expect(h.ctx.ui.custom).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ overlay: true }),
		);
	});

	it("disables custom sidebar colors when NO_COLOR is present", async () => {
		const h = harness();
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		let component: { render(width: number): string[] } | undefined;
		h.ctx.ui.custom.mockImplementationOnce(async (factory: (...args: any[]) => any) => {
			component = factory(
				{ terminal: { width: 120 }, requestRender: vi.fn() },
				{
					name: "dark",
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				},
				{},
				vi.fn(),
			);
		});

		vi.stubEnv("NO_COLOR", "1");
		try {
			await h.commands.get("atelier").handler("sidebar", h.ctx);
		} finally {
			vi.unstubAllEnvs();
		}

		expect(component).toBeDefined();
		expect(component?.render(44).join("\n")).not.toContain("\u001b[38;2;");
	});

	it("warns instead of opening the sidebar outside TUI mode", async () => {
		const h = harness("print");
		await h.commands.get("atelier").handler("sidebar", h.ctx);
		expect(h.ctx.ui.custom).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("TUI mode"), "warning");
	});

	it("preserves menu routing for bare /atelier", async () => {
		const h = harness();
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		await h.commands.get("atelier").handler("", h.ctx);
		expect(h.ctx.ui.custom).toHaveBeenCalled();
	});

	it("invalidates one open sidebar and rejects duplicate panels", async () => {
		const h = harness();
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		let close: (() => void) | undefined;
		const sidebarRender = vi.fn();
		h.ctx.ui.custom.mockImplementationOnce(
			(factory: (...args: any[]) => unknown) =>
				new Promise<void>((resolve) => {
					close = resolve;
					factory(
						{ terminal: { width: 120 }, requestRender: sidebarRender },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						{},
						resolve,
					);
				}),
		);
		const opening = h.commands.get("atelier").handler("sidebar", h.ctx);
		await vi.waitFor(() => expect(h.ctx.ui.custom).toHaveBeenCalledTimes(1));
		await h.commands.get("atelier").handler("sidebar", h.ctx);
		expect(h.ctx.ui.custom).toHaveBeenCalledTimes(1);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already open"), "info");

		await h.handlers.get("turn_end")?.({}, h.ctx);
		expect(sidebarRender).toHaveBeenCalled();
		close?.();
		await opening;
	});

	it("invalidates the sidebar once per actual footer status change", async () => {
		const h = harness();
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		let close: (() => void) | undefined;
		const sidebarRender = vi.fn();
		h.ctx.ui.custom.mockImplementationOnce(
			(factory: (...args: any[]) => unknown) =>
				new Promise<void>((resolve) => {
					close = resolve;
					factory(
						{ terminal: { width: 120 }, requestRender: sidebarRender },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						{},
						resolve,
					);
				}),
		);
		const opening = h.commands.get("atelier").handler("sidebar", h.ctx);
		await vi.waitFor(() => expect(h.ctx.ui.custom).toHaveBeenCalledTimes(1));

		let statuses = new Map([["one", "extension one"]]);
		const footerFactory = h.setFooter.mock.calls[0]?.[0];
		const footer = footerFactory(
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
		expect(sidebarRender).toHaveBeenCalledTimes(1);
		statuses = new Map([["one", "extension two"]]);
		footer.render(120);
		expect(sidebarRender).toHaveBeenCalledTimes(2);

		close?.();
		await opening;
	});

	it("closes the open sidebar and clears its render callback during shutdown", async () => {
		const h = harness();
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		const sidebarRender = vi.fn();
		h.ctx.ui.custom.mockImplementationOnce(
			(factory: (...args: any[]) => unknown) =>
				new Promise<void>((resolve) => {
					factory(
						{ terminal: { width: 120 }, requestRender: sidebarRender },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						{},
						resolve,
					);
				}),
		);
		const opening = h.commands.get("atelier").handler("sidebar", h.ctx);
		await vi.waitFor(() => expect(h.ctx.ui.custom).toHaveBeenCalledTimes(1));
		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
		await opening;
		await h.handlers.get("turn_end")?.({}, h.ctx);
		expect(sidebarRender).not.toHaveBeenCalled();
		expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
	});

	it("opens the sidebar while the footer is disabled", async () => {
		const h = harness();
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		await h.commands.get("atelier").handler("disable", h.ctx);
		await h.commands.get("atelier").handler("sidebar", h.ctx);
		expect(h.ctx.ui.custom).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ overlay: true }),
		);
	});

	it("restores the built-in footer during shutdown", async () => {
		const h = harness();
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
		expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
	});
});

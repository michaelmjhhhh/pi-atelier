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
		sessionManager: { getEntries: vi.fn().mockReturnValue([]) },
		ui: { setFooter, notify: vi.fn(), theme: {}, custom: vi.fn() },
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

	it("restores the built-in footer during shutdown", async () => {
		const h = harness();
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
		expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
	});
});

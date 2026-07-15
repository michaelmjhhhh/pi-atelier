import { describe, expect, it, vi } from "vitest";
import { createMenuActions } from "../src/menu.js";
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
		setThinkingLevel: vi.fn(),
		getAllTools: vi.fn().mockReturnValue([{ name: "read" }, { name: "bash" }]),
		setActiveTools: vi.fn(),
		setSessionName: vi.fn(),
	};
	const ctx = {
		ui: { notify: vi.fn(), input: vi.fn(), confirm: vi.fn() },
		compact: vi.fn(),
	};
	const save = vi.fn().mockResolvedValue(undefined);
	const actions = createMenuActions(pi as never, ctx as never, runtime as never, "/tmp/user.json", save);
	return { actions, pi, ctx, runtime, save };
}

describe("menu actions", () => {
	it("keeps the prior model when authentication fails", async () => {
		const h = harness();
		h.pi.setModel.mockResolvedValue(false);
		await h.actions.selectModel({ id: "new", provider: "provider" } as never);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("authentication"), "error");
		expect(h.runtime.refreshUsage).not.toHaveBeenCalled();
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

	it("renames a session only after non-empty input", async () => {
		const h = harness();
		h.ctx.ui.input.mockResolvedValue("  Release prep  ");
		await h.actions.renameSession();
		expect(h.pi.setSessionName).toHaveBeenCalledWith("Release prep");
	});

	it("does not compact without confirmation", async () => {
		const h = harness();
		h.ctx.ui.confirm.mockResolvedValue(false);
		await h.actions.compactSession();
		expect(h.ctx.compact).not.toHaveBeenCalled();
	});
});

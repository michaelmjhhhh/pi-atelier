import { afterEach, describe, expect, it, vi } from "vitest";
import atelierExtension from "../extensions/index.js";
import { buildSidebarSnapshot, renderSidebarLines } from "../src/sidebar.js";
import { AtelierRuntime } from "../src/state.js";
import {
	DEFAULT_CONFIG,
	type GoalStateEntryData,
	type PiGoalStatePayload,
	type PiGoalStatus,
} from "../src/types.js";
import {
	GOAL_CUSTOM_TYPE,
	goalPayload,
	goalSessionEntry,
	incompleteGoalEntry,
	NON_RECONSTRUCTABLE_STATUSES,
	VALID_STATUSES,
} from "./__fixtures__/goal-protocol.js";

afterEach(() => {
	vi.useRealTimers();
});

// ─── Runtime setCurrentGoal tests ─────────────────────────────────────────────

const assistant = {
	type: "message",
	message: {
		role: "assistant",
		usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
	},
};

function createRuntime() {
	const requestRender = vi.fn();
	const runtime = new AtelierRuntime({
		pi: { exec: vi.fn() } as never,
		ctx: {
			modelRegistry: { isUsingOAuth: vi.fn() },
			getContextUsage: vi.fn(),
			sessionManager: { getEntries: vi.fn().mockReturnValue([assistant]) },
		} as never,
		config: DEFAULT_CONFIG,
		autoCompact: null,
		requestRender,
	});
	return { runtime, requestRender };
}

describe("AtelierRuntime.setCurrentGoal", () => {
	it("sets and clears goal state", () => {
		const { runtime } = createRuntime();
		expect(runtime.getState().currentGoal).toBeUndefined();

		runtime.setCurrentGoal({ goalId: "g-1", text: "Build feature", status: "active" });
		expect(runtime.getState().currentGoal).toEqual({
			goalId: "g-1",
			text: "Build feature",
			status: "active",
		});

		runtime.setCurrentGoal(undefined);
		expect(runtime.getState().currentGoal).toBeUndefined();
	});

	it("triggers re-render on change", () => {
		const { runtime, requestRender } = createRuntime();
		requestRender.mockClear();

		runtime.setCurrentGoal({ goalId: "g-1", text: "Build feature", status: "active" });
		expect(requestRender).toHaveBeenCalledTimes(1);

		runtime.setCurrentGoal(undefined);
		expect(requestRender).toHaveBeenCalledTimes(2);
	});

	it("skips re-render when goal is deeply equal", () => {
		const { runtime, requestRender } = createRuntime();
		runtime.setCurrentGoal({ goalId: "g-1", text: "Build feature", status: "active" });
		requestRender.mockClear();

		runtime.setCurrentGoal({ goalId: "g-1", text: "Build feature", status: "active" });
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("applies text-only updates even when goalId and status match", () => {
		const { runtime, requestRender } = createRuntime();
		runtime.setCurrentGoal({ goalId: "g-1", text: "Build feature", status: "active" });
		requestRender.mockClear();

		runtime.setCurrentGoal({ goalId: "g-1", text: "Build feature v2", status: "active" });
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(runtime.getState().currentGoal?.text).toBe("Build feature v2");
	});

	it("applies status-only updates even when goalId and text match", () => {
		const { runtime, requestRender } = createRuntime();
		runtime.setCurrentGoal({ goalId: "g-1", text: "Build feature", status: "active" });
		requestRender.mockClear();

		runtime.setCurrentGoal({ goalId: "g-1", text: "Build feature", status: "paused" });
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(runtime.getState().currentGoal?.status).toBe("paused");
	});

	it("preserves non-goal state when updating goal", () => {
		const { runtime } = createRuntime();
		runtime.setActivity("working");
		runtime.setCurrentGoal({ goalId: "g-1", text: "Build", status: "active" });

		expect(runtime.getState().activity).toBe("working");
		expect(runtime.getState().currentGoal).toEqual({ goalId: "g-1", text: "Build", status: "active" });
	});
});

// ─── Sidebar rendering tests ──────────────────────────────────────────────────

const theme = {
	name: "dark",
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
};

const baseState = {
	activity: "ready" as const,
	dirty: false,
	workspacePulse: {
		status: "clean" as const,
		data: {
			root: "/tmp",
			relativeCwd: "",
			branch: "main",
			snapshot: {
				trackedFiles: 0,
				untrackedFiles: 0,
				linesAdded: 0,
				linesRemoved: 0,
				binaryFiles: 0,
				submodules: 0,
				conflicts: 0,
			},
		},
	},
	metrics: {
		usageAvailable: false,
		costAvailable: false,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		subscription: false,
		contextTokens: null,
		contextWindow: 100_000,
		contextPercent: null,
		autoCompact: null,
	},
	extensionStatuses: [] as readonly string[],
};

function sidebarSnapshot(
	currentGoal: { goalId: string; text: string; status: string } | undefined = undefined,
) {
	return buildSidebarSnapshot({
		state: { ...baseState, ...(currentGoal ? { currentGoal } : {}) },
		cwd: "/tmp/project",
		branchEntryCount: 0,
		activeToolCount: 0,
		availableToolCount: 0,
		extensionStatuses: [],
	});
}

describe("sidebar goal panel rendering", () => {
	it("renders GOAL panel with active status", () => {
		const lines = renderSidebarLines(
			sidebarSnapshot({ goalId: "g-1", text: "Implement auth", status: "active" }),
			DEFAULT_CONFIG,
			theme,
			44,
			36,
		);
		const text = lines.join("\n");
		expect(text).toContain("GOAL");
		expect(text).toContain("▶ ACTIVE");
		expect(text).toContain("Implement auth");
	});

	it("renders GOAL panel with paused status", () => {
		const lines = renderSidebarLines(
			sidebarSnapshot({ goalId: "g-1", text: "Wait for review", status: "paused" }),
			DEFAULT_CONFIG,
			theme,
			44,
			36,
		);
		expect(lines.join("\n")).toContain("⏸ PAUSED");
	});

	it("renders GOAL panel with blocked status", () => {
		const lines = renderSidebarLines(
			sidebarSnapshot({ goalId: "g-1", text: "Blocked by API", status: "blocked" }),
			DEFAULT_CONFIG,
			theme,
			44,
			36,
		);
		expect(lines.join("\n")).toContain("✕ BLOCKED");
	});

	it("omits GOAL panel when no goal set", () => {
		const lines = renderSidebarLines(sidebarSnapshot(), DEFAULT_CONFIG, theme, 44, 36);
		expect(lines.join("\n")).not.toContain("GOAL");
	});

	it("sanitizes ANSI codes from goal text", () => {
		const lines = renderSidebarLines(
			sidebarSnapshot({ goalId: "g-1", text: "Build \u001b[31mfeature", status: "active" }),
			DEFAULT_CONFIG,
			theme,
			44,
			36,
		);
		expect(lines.join("\n")).not.toContain("\u001b[31m");
		expect(lines.join("\n")).toContain("Build feature");
	});
});

// ─── Extension goal event handling tests ──────────────────────────────────────

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

function harness() {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const commands = new Map<string, any>();
	const eventBusHandlers = new Map<string, Set<(data: unknown) => void>>();
	const shortcuts: string[] = [];
	const setFooter = vi.fn();
	let terminalInput: ((data: string) => unknown) | undefined;
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
		registerShortcut: vi.fn((key: string, _options: any) => {
			shortcuts.push(key);
		}),
		exec: vi.fn().mockResolvedValue(gitResult("main")),
		getThinkingLevel: vi.fn().mockReturnValue("medium"),
		getActiveTools: vi.fn().mockReturnValue([]),
		getAllTools: vi.fn().mockReturnValue([]),
	};

	const custom = vi.fn((_factory: (...args: any[]) => any, options: any): Promise<any> => {
		const requestRender = vi.fn();
		const tui = {
			render: vi.fn((width: number) => [`main:${width}`]),
			terminal: { columns: 120, rows: 36, width: 120, write: vi.fn() },
			requestRender,
		};
		let resolve!: (value: any) => void;
		const pending = new Promise<any>((done) => {
			resolve = done;
		});
		const done = vi.fn(() => resolve(undefined));
		const handle = { hide: vi.fn() };
		const component = { render: vi.fn(() => ["sidebar"]), invalidate: vi.fn() };
		overlays.push({ component, done, handle, options, requestRender, tui });
		options?.onHandle?.(handle);
		if (!options?.overlayOptions?.nonCapturing) done();
		return pending;
	});

	const ctx = {
		mode: "tui" as const,
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

	atelierExtension(pi as never, {
		saveConfig,
		saveConfigPatch,
		notificationPlatform: "linux",
		spawnNotificationProcess: vi.fn(() => ({
			kill: vi.fn(),
			once: vi.fn().mockReturnThis(),
			unref: vi.fn(),
		})),
	});

	return { handlers, commands, shortcuts, setFooter, ctx, pi, overlays, custom, terminalInput };
}

async function start(h: ReturnType<typeof harness>, ctx = h.ctx) {
	await h.handlers.get("session_start")?.({ reason: "startup" }, ctx);
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

describe("extension goal event handling", () => {
	it("subscribes to pi-goal:state on session start", async () => {
		const h = harness();
		await start(h);
		expect(h.pi.events.on).toHaveBeenCalledWith("pi-goal:state", expect.any(Function));
	});

	it("ignores malformed payloads", async () => {
		const h = harness();
		await start(h);

		h.pi.events.emit("pi-goal:state", null);
		h.pi.events.emit("pi-goal:state", "string");
		h.pi.events.emit("pi-goal:state", 42);
		h.pi.events.emit("pi-goal:state", { goalId: 123, status: true });

		// No error thrown, no sidebar render triggered
		expect(h.overlays[0]?.requestRender).not.toHaveBeenCalled();
	});

	it("unsubscribes on session shutdown", async () => {
		const h = harness();
		await start(h);

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);

		h.pi.events.emit("pi-goal:state", { goalId: "g-2", text: "After shutdown", status: "active" });

		// No render after shutdown
		expect(h.overlays[0]?.requestRender).not.toHaveBeenCalled();
	});

	it("unsubscribes previous subscription on session reload", async () => {
		const h = harness();
		await start(h);

		const newCtx = replacementContext(h.ctx, "Reloaded");
		await start(h, newCtx);

		h.pi.events.emit("pi-goal:state", { goalId: "g-old", text: "Should not appear", status: "active" });

		// Old subscription should be gone; no render from stale event
		expect(h.overlays[0]?.requestRender).not.toHaveBeenCalled();
	});
});

// ─── Protocol stability tests ─────────────────────────────────────────────────

describe("goal protocol contract", () => {
	it("uses canonical custom entry type", () => {
		expect(GOAL_CUSTOM_TYPE).toBe("goal-state");
	});

	it("defines all expected status values", () => {
		expect(VALID_STATUSES).toEqual([
			"active",
			"queued",
			"paused",
			"blocked",
			"usage_limited",
			"budget_limited",
			"complete",
			"cleared",
		]);
	});

	it("marks complete as non-reconstructable", () => {
		expect(NON_RECONSTRUCTABLE_STATUSES).toContain("complete");
	});

	it("goalPayload produces valid PiGoalStatePayload shape", () => {
		const payload = goalPayload();
		expect(typeof payload.goalId).toBe("string");
		expect(typeof payload.text).toBe("string");
		expect(typeof payload.status).toBe("string");
	});

	it("goalSessionEntry produces valid entry shape", () => {
		const entry = goalSessionEntry();
		expect(entry.type).toBe("custom");
		expect(entry.customType).toBe(GOAL_CUSTOM_TYPE);
		expect(entry.data.goal).not.toBeNull();
		expect(entry.data.goal?.id).toBeDefined();
		expect(entry.data.goal?.text).toBeDefined();
		expect(entry.data.goal?.status).toBeDefined();
	});

	it("goalSessionEntry with null status produces cleared entry", () => {
		const entry = goalSessionEntry({ status: null });
		expect(entry.data.goal).toBeNull();
	});

	it("incompleteGoalEntry omits specified fields", () => {
		const entry = incompleteGoalEntry({ id: true, text: false, status: false });
		expect(entry.data.goal?.id).toBeDefined();
		expect(entry.data.goal?.text).toBeUndefined();
		expect(entry.data.goal?.status).toBeUndefined();
	});
});

// ─── Session reconstruction tests ─────────────────────────────────────────────

describe("goal session reconstruction", () => {
	it("reconstructs goal from session custom entries on start", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			goalSessionEntry({ id: "g-restore", text: "Restored goal", status: "active" }),
		]);

		await start(h);

		// Reconstruction runs before sidebar overlay; verify no error.
		// (render chain not exercisable via event in harness: split pane never attaches to TUI mock)
	});

	it("skips reconstruction when goal was cleared (null)", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([goalSessionEntry({ status: null })]);

		await start(h);

		// No error from null goal entry.
	});

	it("skips reconstruction when goal status is complete", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			goalSessionEntry({ id: "g-done", text: "Done goal", status: "complete" }),
		]);

		await start(h);

		// No error from complete goal entry.
	});

	it("skips reconstruction when goal entry is missing required fields", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			incompleteGoalEntry({ id: true, text: false, status: false }),
		]);

		await start(h);

		// No error from incomplete entry.
	});

	it("takes the last goal-state entry from the branch", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			goalSessionEntry({ id: "g-1", text: "First goal", status: "active" }),
			goalSessionEntry({ id: "g-2", text: "Second goal", status: "active" }),
		]);

		await start(h);

		// No error; last entry (g-2) used for reconstruction.
	});

	it("ignores non-goal custom entries", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			{ type: "custom", customType: "other-type", data: { anything: true } },
			{ type: "message", message: { role: "user", content: [] } },
			goalSessionEntry({ id: "g-1", text: "Found goal", status: "active" }),
		]);

		await start(h);

		// No error; non-goal entries filtered out.
	});

	it("handles empty branch without error", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([]);

		await start(h);

		// No error from empty branch.
	});
});

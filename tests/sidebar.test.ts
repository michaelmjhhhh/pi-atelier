import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_RUN_ACTIVITY, type RunActivitySnapshot } from "../src/run-activity.js";
import {
	buildSidebarSnapshot,
	createSidebarComponent,
	createSidebarController,
	createSidebarPanelRegistry,
	isSidebarPanelContributionId,
	isSidebarPanelId,
	isSidebarPanelRequestId,
	isSidebarPanelTextWithinRawLimit,
	registerSidebarPanel,
	renderSidebarLines,
	SIDEBAR_PANEL_EVENT_CHANNEL,
	SIDEBAR_PANEL_MAX_ID_CHARS,
	SIDEBAR_PANEL_MAX_PANELS,
	SIDEBAR_PANEL_MAX_RAW_REQUEST_ID_CODE_UNITS,
	SIDEBAR_PANEL_MAX_RAW_ROW_CODE_UNITS,
	SIDEBAR_PANEL_MAX_RAW_TITLE_CODE_UNITS,
	SIDEBAR_PANEL_MAX_ROW_CHARS,
	SIDEBAR_PANEL_MAX_ROWS,
	SIDEBAR_PANEL_MAX_SOURCE_CHARS,
	SIDEBAR_PANEL_MAX_TITLE_CHARS,
	SIDEBAR_PANEL_MAX_TRACKED_SOURCES,
} from "../src/sidebar.js";
import { DEFAULT_SIDEBAR_WIDTH } from "../src/split-pane.js";
import { type AtelierState, DEFAULT_CONFIG } from "../src/types.js";

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

const theme = {
	name: "dark",
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
};

afterEach(() => {
	vi.useRealTimers();
});

const state: AtelierState = {
	activity: "working",
	workingLabel: "GITIFYING",
	modelId: "gpt-5.6-sol",
	provider: "openai-codex",
	thinkingLevel: "medium",
	branch: "feature/sidebar",
	dirty: true,
	workspacePulse: {
		status: "changed",
		data: {
			root: "/Users/example/projects/pi-atelier",
			relativeCwd: "",
			branch: "feature/sidebar",
			snapshot: {
				trackedFiles: 5,
				untrackedFiles: 2,
				linesAdded: 182,
				linesRemoved: 47,
				binaryFiles: 0,
				submodules: 0,
				conflicts: 0,
			},
		},
	},
	metrics: {
		usageAvailable: true,
		costAvailable: true,
		input: 50_000,
		output: 1_900,
		cacheRead: 100_000,
		cacheWrite: 0,
		cacheHitPercent: 96,
		cost: 0.479,
		subscription: true,
		contextTokens: 32_400,
		contextWindow: 400_000,
		contextPercent: 8.1,
		autoCompact: true,
	},
	extensionStatuses: [],
};

function snapshot() {
	return buildSidebarSnapshot({
		state,
		cwd: "/Users/example/projects/pi-atelier",
		sessionName: "Sidebar implementation",
		sessionFile: "/tmp/session.jsonl",
		branchEntryCount: 38,
		activeToolCount: 8,
		availableToolCount: 12,
		extensionStatuses: ["tests passing"],
		runActivity: EMPTY_RUN_ACTIVITY,
	});
}

function withActivity(runActivity: RunActivitySnapshot) {
	return { ...snapshot(), runActivity };
}

function activeActivity(): RunActivitySnapshot {
	return {
		phase: "running",
		turnNumber: 3,
		startedAt: 1_000,
		activeTools: [
			{
				id: "read-1",
				name: "read",
				summary: "src/state.ts",
				status: "running",
				startedAt: 2_000,
			},
		],
		recentTools: [
			{
				id: "bash-1",
				name: "bash",
				summary: "npm test",
				status: "done",
				startedAt: 12_000,
				durationMs: 4_000,
			},
		],
		completedCount: 2,
		failedCount: 1,
	};
}

function contentRows(lines: string[]) {
	return lines.map((line) => {
		const row = stripAnsi(line).slice(2).trimEnd();
		const title = row.match(/^╭─ [✦✧] ([A-Z]+) ─*╮$/)?.[1];
		if (title) return title;
		if (/^╰─+╯$/.test(row)) return "";
		if (row.startsWith("│ ") && row.endsWith(" │")) return row.slice(2, -2).trimEnd();
		return row;
	});
}

async function flushOverlay() {
	await Promise.resolve();
	await Promise.resolve();
}

function fakeTui(requestRender = vi.fn()) {
	return {
		render: vi.fn((width: number) => [`main:${width}`]),
		requestRender,
		terminal: { columns: 120, rows: 36, write: vi.fn() },
	};
}

describe("sidebar snapshot and layout", () => {
	it("composes visible panels in persisted order and keeps unavailable entries out of rendering", () => {
		const ordered = {
			...DEFAULT_CONFIG,
			showSidebarAgent: false,
			showSidebarTodos: false,
			sidebarPanelLayout: [
				{ id: "vendor:queue" as const, visible: true },
				{ id: "tools" as const, visible: true },
				{ id: "activity" as const, visible: true },
				...DEFAULT_CONFIG.sidebarPanelLayout.filter((entry) => !["tools", "activity"].includes(entry.id)),
			],
		};
		const lines = renderSidebarLines(
			{
				...snapshot(),
				sidebarPanels: [
					{
						id: "vendor:queue",
						title: "Queue",
						rows: [{ text: "queued 2" }],
						available: true,
						source: "vendor",
					},
				],
			},
			ordered,
			theme,
			44,
			36,
		);
		const text = contentRows(lines).join("\n");
		expect(text.indexOf("QUEUE")).toBeGreaterThanOrEqual(0);
		expect(text.indexOf("QUEUE")).toBeLessThan(text.indexOf("TOOLS"));
		expect(text).not.toContain("AGENT");
	});

	it("supports load-order discovery, updates, and removal through the public event seam", () => {
		const listeners = new Set<(data: unknown) => void>();
		const events = {
			on: (_channel: string, handler: (data: unknown) => void) => {
				listeners.add(handler);
				return () => listeners.delete(handler);
			},
			emit: (_channel: string, data: unknown) => {
				for (const listener of [...listeners]) listener(data);
			},
		};
		const publisher = registerSidebarPanel({ events }, { id: "vendor:queue", title: "Queue", rows: ["one"] });
		const changed = vi.fn();
		const registry = createSidebarPanelRegistry({ events, onChange: changed });
		expect(registry.get("vendor:queue")?.title).toBe("Queue");
		publisher.update({
			id: "vendor:queue",
			title: "Updated queue",
			rows: [{ text: "two", role: "warning" }],
		});
		expect(registry.get("vendor:queue")?.rows[0]?.text).toBe("two");
		publisher.dispose();
		expect(registry.get("vendor:queue")).toBeUndefined();
		expect(changed).toHaveBeenCalled();
		expect(SIDEBAR_PANEL_EVENT_CHANNEL).toBe("pi-atelier:sidebar-panels");
		registry.dispose();
	});

	it("accepts namespaced contributors whose source matches the discovery prefix", () => {
		const listeners = new Set<(data: unknown) => void>();
		const emitted: unknown[] = [];
		const events = {
			on: (_channel: string, handler: (data: unknown) => void) => {
				listeners.add(handler);
				return () => listeners.delete(handler);
			},
			emit: (_channel: string, data: unknown) => {
				emitted.push(data);
				for (const listener of [...listeners]) listener(data);
			},
		};
		const registry = createSidebarPanelRegistry({ events, instanceId: "vendor" });
		events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
			version: 1,
			type: "register",
			source: "vendor",
			revision: 1,
			panel: { id: "vendor:queue", title: "Queue", rows: ["ready"] },
		});
		expect(registry.get("vendor:queue")?.source).toBe("vendor");
		expect(emitted[0]).toMatchObject({ type: "discover", requestId: "vendor-1" });
		registry.dispose();
	});

	it("validates contributed IDs and bounded discovery request IDs at both public seams", () => {
		expect(isSidebarPanelContributionId("vendor:queue")).toBe(true);
		for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029", " ", "\t"]) {
			expect(isSidebarPanelContributionId(`vendor:queue${suffix}`)).toBe(false);
		}
		expect(isSidebarPanelContributionId("agent")).toBe(false);
		expect(isSidebarPanelContributionId("Vendor:queue")).toBe(false);
		expect(isSidebarPanelContributionId("vendor:")).toBe(false);
		expect(isSidebarPanelRequestId("normal-request")).toBe(true);
		expect(isSidebarPanelRequestId("π-界🙂")).toBe(true);
		expect(isSidebarPanelRequestId("")).toBe(false);
		expect(isSidebarPanelRequestId(" ")).toBe(false);
		expect(isSidebarPanelRequestId("bad\nrequest")).toBe(false);
		expect(isSidebarPanelRequestId("\ud800")).toBe(false);
		expect(isSidebarPanelRequestId("x".repeat(SIDEBAR_PANEL_MAX_RAW_REQUEST_ID_CODE_UNITS + 1))).toBe(false);

		const emitted: unknown[] = [];
		const listeners = new Set<(data: unknown) => void>();
		const events = {
			on: (_channel: string, handler: (data: unknown) => void) => {
				listeners.add(handler);
				return () => listeners.delete(handler);
			},
			emit: (_channel: string, data: unknown) => {
				emitted.push(data);
				for (const listener of [...listeners]) listener(data);
			},
		};
		const publisher = registerSidebarPanel({ events }, { id: "vendor:queue", title: "Queue", rows: [] });
		const initialRegisterCount = emitted.filter(
			(data) => (data as { type?: unknown }).type === "register",
		).length;
		for (const requestId of ["", " ", "x".repeat(SIDEBAR_PANEL_MAX_RAW_REQUEST_ID_CODE_UNITS + 1), null]) {
			events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, { version: 1, type: "discover", requestId });
		}
		expect(emitted.filter((data) => (data as { type?: unknown }).type === "register")).toHaveLength(
			initialRegisterCount,
		);
		events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
			version: 1,
			type: "discover",
			requestId: "π-界🙂",
		});
		const response = emitted.at(-1) as { type?: string; requestId?: string };
		expect(response).toMatchObject({ type: "register", requestId: "π-界🙂" });

		const registryEvents = {
			on: () => () => undefined,
			emit: (_channel: string, data: unknown) => emitted.push(data),
		};
		const registry = createSidebarPanelRegistry({
			events: registryEvents,
			instanceId: "x".repeat(SIDEBAR_PANEL_MAX_RAW_REQUEST_ID_CODE_UNITS + 1),
		});
		const generated = emitted.at(-1) as { type?: string; requestId?: string };
		expect(generated.type).toBe("discover");
		expect(generated.requestId).toBe("atelier-1");
		expect(generated.requestId?.length).toBeLessThanOrEqual(SIDEBAR_PANEL_MAX_RAW_REQUEST_ID_CODE_UNITS);
		registry.dispose();
		publisher.dispose();
	});

	it("allocates revisions across same-source publishers without coupling transports", () => {
		const makeEvents = () => {
			const listeners = new Set<(data: unknown) => void>();
			const emitted: unknown[] = [];
			return {
				events: {
					on: (_channel: string, handler: (data: unknown) => void) => {
						listeners.add(handler);
						return () => listeners.delete(handler);
					},
					emit: (_channel: string, data: unknown) => {
						emitted.push(data);
						for (const listener of [...listeners]) listener(data);
					},
				},
				emitted,
			};
		};
		const firstTransport = makeEvents();
		const secondTransport = makeEvents();
		const first = registerSidebarPanel(
			{ events: firstTransport.events },
			{ id: "vendor:queue", title: "Queue", rows: ["one"] },
			{ source: "vendor" },
		);
		const second = registerSidebarPanel(
			{ events: firstTransport.events },
			{ id: "vendor:status", title: "Status", rows: ["ready"] },
			{ source: "vendor" },
		);
		registerSidebarPanel(
			{ events: secondTransport.events },
			{ id: "vendor:other", title: "Other", rows: ["isolated"] },
			{ source: "vendor" },
		);

		const registry = createSidebarPanelRegistry({ events: firstTransport.events });
		expect(registry.get("vendor:queue")?.title).toBe("Queue");
		expect(registry.get("vendor:status")?.title).toBe("Status");
		first.update({ id: "vendor:queue", title: "Updated queue", rows: ["two"] });
		second.update({ id: "vendor:status", title: "Updated status", rows: ["busy"] });
		expect(registry.get("vendor:queue")?.rows[0]?.text).toBe("two");
		expect(registry.get("vendor:status")?.rows[0]?.text).toBe("busy");
		first.dispose();
		expect(registry.get("vendor:queue")).toBeUndefined();
		expect(registry.get("vendor:status")?.title).toBe("Updated status");
		expect((firstTransport.emitted[0] as { revision?: number })?.revision).toBe(1);
		expect((secondTransport.emitted[0] as { revision?: number })?.revision).toBe(1);
		second.dispose();
		registry.dispose();
	});

	it("caps helper publisher sources while preserving updates, disposal, and source revisions", () => {
		const listeners = new Set<(data: unknown) => void>();
		const emitted: unknown[] = [];
		const events = {
			on: (_channel: string, handler: (data: unknown) => void) => {
				listeners.add(handler);
				return () => listeners.delete(handler);
			},
			emit: (_channel: string, data: unknown) => {
				emitted.push(data);
				for (const listener of [...listeners]) listener(data);
			},
		};
		const panel = (id: string, title = id) => ({
			id: id as `${string}:${string}`,
			title,
			rows: [],
		});
		const malformed = registerSidebarPanel({ events }, panel("vendor:malformed-source"), {
			source: "s".repeat(SIDEBAR_PANEL_MAX_SOURCE_CHARS + 1),
		});
		malformed.update(panel("vendor:malformed-source", "Should stay inert"));
		malformed.dispose();
		expect(emitted).toEqual([]);
		const publishers = Array.from({ length: SIDEBAR_PANEL_MAX_TRACKED_SOURCES }, (_, index) =>
			registerSidebarPanel({ events }, panel(`vendor:allocator-${index}`), { source: `allocator-${index}` }),
		);
		const registry = createSidebarPanelRegistry({ events });
		expect(registry.getAvailable()).toHaveLength(SIDEBAR_PANEL_MAX_TRACKED_SOURCES);

		const beforeOverflow = emitted.length;
		const overflow = registerSidebarPanel({ events }, panel("vendor:allocator-overflow"), {
			source: "allocator-overflow",
		});
		overflow.update(panel("vendor:allocator-overflow", "Updated overflow"));
		overflow.dispose();
		expect(emitted).toHaveLength(beforeOverflow);
		expect(registry.get("vendor:allocator-overflow")).toBeUndefined();

		publishers[0]?.update(panel("vendor:allocator-0", "Updated tracked"));
		expect(registry.get("vendor:allocator-0")?.title).toBe("Updated tracked");
		publishers[0]?.dispose();
		expect(registry.get("vendor:allocator-0")).toBeUndefined();

		const reused = registerSidebarPanel({ events }, panel("vendor:allocator-reused", "Reused source"), {
			source: "allocator-0",
		});
		expect(registry.get("vendor:allocator-reused")?.title).toBe("Reused source");
		const reusedRevision = (emitted.at(-1) as { revision?: number })?.revision;
		expect(reusedRevision).toBeGreaterThan(1);
		events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
			version: 1,
			type: "register",
			source: "allocator-0",
			revision: (reusedRevision ?? 1) - 1,
			panel: panel("vendor:allocator-reused", "Stale reuse"),
		});
		expect(registry.get("vendor:allocator-reused")?.title).toBe("Reused source");
		reused.dispose();
		expect(registry.get("vendor:allocator-reused")).toBeUndefined();
		for (const publisher of publishers.slice(1)) publisher.dispose();
		registry.dispose();
	});

	it("rejects built-in public contributions before ownership, revisions, or capacity are consumed", () => {
		const registry = createSidebarPanelRegistry();
		// @ts-expect-error Built-in IDs are intentionally rejected by this contributed-panel API.
		expect(registry.register({ id: "agent", title: "Spoofed", rows: [] })).toBe(false);
		for (const id of ["agent", "tools"] as const) {
			registry.handleEvent({
				version: 1,
				type: "register",
				source: "vendor",
				revision: 1,
				panel: { id, title: "Spoofed", rows: [] },
			});
		}
		expect(registry.get("agent")).toBeUndefined();
		expect(registry.get("tools")).toBeUndefined();
		expect(registry.getAvailable()).toEqual([]);
		// The rejected built-in events do not consume the source's first revision.
		registry.handleEvent({
			version: 1,
			type: "register",
			source: "vendor",
			revision: 1,
			panel: { id: "vendor:queue", title: "Queue", rows: [] },
		});
		expect(registry.get("vendor:queue")?.title).toBe("Queue");
		// Nor do they consume a panel slot when the registry is one slot from full.
		const capacityRegistry = createSidebarPanelRegistry();
		for (let index = 0; index < SIDEBAR_PANEL_MAX_PANELS - 1; index += 1) {
			expect(capacityRegistry.register({ id: `vendor:panel-${index}`, title: "Panel", rows: [] })).toBe(true);
		}
		capacityRegistry.handleEvent({
			version: 1,
			type: "register",
			source: "capacity-source",
			revision: 1,
			panel: { id: "activity", title: "Spoofed", rows: [] },
		});
		capacityRegistry.handleEvent({
			version: 1,
			type: "register",
			source: "capacity-source",
			revision: 1,
			panel: { id: "capacity-source:panel", title: "Accepted", rows: [] },
		});
		expect(capacityRegistry.get("capacity-source:panel")?.title).toBe("Accepted");
		expect(capacityRegistry.getAvailable()).toHaveLength(SIDEBAR_PANEL_MAX_PANELS);
		registry.dispose();
		capacityRegistry.dispose();
	});

	it("rejects malformed public events and preserves panel ownership across revisions", () => {
		const registry = createSidebarPanelRegistry();
		for (const event of [
			undefined,
			null,
			{},
			{ version: 2, type: "register" },
			{ version: 1, type: "register", source: "vendor", revision: 1 },
			{
				version: 1,
				type: "register",
				source: "vendor",
				revision: 1,
				panel: { id: "not-namespaced", title: "Bad", rows: [] },
			},
			{
				version: 1,
				type: "register",
				source: "vendor",
				revision: 1,
				panel: { id: "vendor:queue", title: "Queue", rows: [null] },
			},
		])
			registry.handleEvent(event);
		expect(registry.getAvailable()).toEqual([]);

		registry.handleEvent({
			version: 1,
			type: "register",
			source: "vendor",
			revision: 1,
			panel: { id: "vendor:queue", title: "Queue", rows: ["one"] },
		});
		registry.handleEvent({
			version: 1,
			type: "register",
			source: "other",
			revision: 1,
			panel: { id: "vendor:queue", title: "Hijack", rows: ["bad"] },
		});
		registry.handleEvent({
			version: 1,
			type: "register",
			source: "vendor",
			revision: 1,
			panel: { id: "vendor:queue", title: "Stale", rows: ["stale"] },
		});
		expect(registry.get("vendor:queue")?.title).toBe("Queue");
		registry.handleEvent({
			version: 1,
			type: "register",
			source: "vendor",
			revision: 2,
			panel: { id: "vendor:queue", title: "Updated", rows: ["two"] },
		});
		expect(registry.get("vendor:queue")?.title).toBe("Updated");
		registry.handleEvent({
			version: 1,
			type: "unregister",
			source: "other",
			revision: 2,
			id: "vendor:queue",
		});
		expect(registry.get("vendor:queue")?.title).toBe("Updated");
		registry.handleEvent({
			version: 1,
			type: "unregister",
			source: "vendor",
			revision: 3,
			id: "vendor:queue",
		});
		expect(registry.get("vendor:queue")).toBeUndefined();
		registry.dispose();
	});

	it("bounds raw title and row work before sanitization while preserving valid Unicode", () => {
		expect(
			isSidebarPanelTextWithinRawLimit(
				"x".repeat(SIDEBAR_PANEL_MAX_RAW_TITLE_CODE_UNITS),
				SIDEBAR_PANEL_MAX_RAW_TITLE_CODE_UNITS,
			),
		).toBe(true);
		expect(
			isSidebarPanelTextWithinRawLimit(
				"x".repeat(SIDEBAR_PANEL_MAX_RAW_TITLE_CODE_UNITS + 1),
				SIDEBAR_PANEL_MAX_RAW_TITLE_CODE_UNITS,
			),
		).toBe(false);
		const registry = createSidebarPanelRegistry();
		expect(
			registry.register({
				id: "vendor:huge-title",
				title: "x".repeat(1_000_000),
				rows: [],
			}),
		).toBe(false);
		expect(
			registry.register({
				id: "vendor:huge-row-string",
				title: "Valid",
				rows: ["x".repeat(1_000_000)],
			}),
		).toBe(false);
		expect(
			registry.register({
				id: "vendor:huge-row-object",
				title: "Valid",
				rows: [{ text: "x".repeat(1_000_000) }],
			}),
		).toBe(false);
		expect(
			registry.register({
				id: "vendor:unicode",
				title: "é界🙂".repeat(12),
				rows: [{ text: "é界🙂".repeat(40), role: "ready" }],
			}),
		).toBe(true);
		expect(registry.get("vendor:unicode")).toMatchObject({
			title: "é界🙂".repeat(12),
			rows: [{ text: "é界🙂".repeat(40), role: "ready" }],
		});
		registry.dispose();
	});

	it("sanitizes titles and rows and rejects oversized contribution payloads", () => {
		const registry = createSidebarPanelRegistry();
		expect(
			registry.register({
				id: "vendor:safe",
				title: "\u001b[31mQueue\nready\u001b[0m",
				rows: ["one\n two", { text: "\u001b[33mtwo\u001b[0m", role: "warning" }],
			}),
		).toBe(true);
		expect(registry.get("vendor:safe")).toMatchObject({
			title: "Queue ready",
			rows: [{ text: "one two" }, { text: "two", role: "warning" }],
		});
		expect(
			registry.register({
				id: "vendor:long-title",
				title: "t".repeat(SIDEBAR_PANEL_MAX_TITLE_CHARS + 1),
				rows: [],
			}),
		).toBe(false);
		expect(
			registry.register({
				id: "vendor:long-row",
				title: "Long row",
				rows: ["r".repeat(SIDEBAR_PANEL_MAX_ROW_CHARS + 1)],
			}),
		).toBe(false);
		expect(
			registry.register({
				id: "vendor:many-rows",
				title: "Many rows",
				rows: Array.from({ length: SIDEBAR_PANEL_MAX_ROWS + 1 }, () => "row"),
			}),
		).toBe(false);
		expect(registry.getAvailable()).toHaveLength(1);
		registry.dispose();
	});

	it("bounds IDs and source names at direct, event, and publisher seams", () => {
		const registry = createSidebarPanelRegistry();
		const longId = `vendor:${"x".repeat(SIDEBAR_PANEL_MAX_ID_CHARS)}` as `vendor:${string}`;
		const longSource = "s".repeat(SIDEBAR_PANEL_MAX_SOURCE_CHARS + 1);
		const safePanel = { id: "vendor:safe" as const, title: "Safe", rows: [] };

		expect(isSidebarPanelId(longId)).toBe(false);
		expect(registry.register({ ...safePanel, id: longId })).toBe(false);
		expect(registry.unregister(longId, "vendor")).toBe(false);
		expect(registry.register(safePanel, longSource)).toBe(false);
		expect(registry.unregister(safePanel.id, longSource)).toBe(false);
		registry.handleEvent({
			version: 1,
			type: "register",
			source: "vendor",
			revision: 1,
			panel: { ...safePanel, id: longId },
		});
		registry.handleEvent({
			version: 1,
			type: "register",
			source: longSource,
			revision: 1,
			panel: safePanel,
		});
		expect(registry.getAvailable()).toEqual([]);

		const emitted: unknown[] = [];
		const events = {
			on: () => () => undefined,
			emit: (_channel: string, data: unknown) => emitted.push(data),
		};
		const invalidIdPublisher = registerSidebarPanel({ events }, { ...safePanel, id: longId });
		const invalidSourcePublisher = registerSidebarPanel({ events }, safePanel, { source: longSource });
		expect(emitted).toEqual([]);
		invalidIdPublisher.update(safePanel);
		invalidSourcePublisher.update(safePanel);
		invalidIdPublisher.dispose();
		invalidSourcePublisher.dispose();
		expect(emitted).toEqual([]);
		registry.dispose();
	});

	it("caps new panels while allowing updates and unregisters to free capacity", () => {
		const registry = createSidebarPanelRegistry();
		const panel = (id: string, title = id) => ({
			id: id as `vendor:${string}`,
			title,
			rows: [],
		});
		for (let index = 0; index < SIDEBAR_PANEL_MAX_PANELS; index += 1) {
			expect(registry.register(panel(`vendor:panel-${index}`))).toBe(true);
		}
		expect(registry.getAvailable()).toHaveLength(SIDEBAR_PANEL_MAX_PANELS);
		expect(registry.register(panel("vendor:overflow"), "overflow")).toBe(false);

		// A valid update at capacity is accepted and consumes its source revision.
		registry.handleEvent({
			version: 1,
			type: "register",
			source: "vendor",
			revision: 1,
			panel: panel("vendor:panel-0", "Updated at capacity"),
		});
		expect(registry.get("vendor:panel-0")?.title).toBe("Updated at capacity");

		// Capacity-rejected registrations do not consume a source revision, so
		// retrying the same event after capacity is freed succeeds.
		registry.handleEvent({
			version: 1,
			type: "register",
			source: "overflow",
			revision: 1,
			panel: panel("vendor:overflow", "Overflow"),
		});
		expect(registry.get("vendor:overflow")).toBeUndefined();
		registry.handleEvent({
			version: 1,
			type: "unregister",
			source: "vendor",
			revision: 2,
			id: "vendor:panel-0",
		});
		expect(registry.get("vendor:panel-0")).toBeUndefined();
		registry.handleEvent({
			version: 1,
			type: "register",
			source: "overflow",
			revision: 1,
			panel: panel("vendor:overflow", "Retried after capacity"),
		});
		expect(registry.get("vendor:overflow")?.title).toBe("Retried after capacity");
		registry.handleEvent({
			version: 1,
			type: "register",
			source: "overflow",
			revision: 2,
			panel: panel("vendor:overflow", "Accepted after unregister"),
		});
		expect(registry.get("vendor:overflow")?.title).toBe("Accepted after unregister");
		expect(registry.getAvailable()).toHaveLength(SIDEBAR_PANEL_MAX_PANELS);

		// The direct seam gets the same capacity behavior after an unregister.
		expect(registry.unregister("vendor:panel-1", "vendor")).toBe(true);
		expect(registry.register(panel("vendor:direct"), "vendor")).toBe(true);
		expect(registry.getAvailable()).toHaveLength(SIDEBAR_PANEL_MAX_PANELS);
		registry.dispose();
	});

	it("does not track capacity-rejected or invalid-owner sources", () => {
		const panel = (id: string, title = id) => ({
			id: id as `vendor:${string}`,
			title,
			rows: [],
		});
		const capacityRegistry = createSidebarPanelRegistry();
		for (let index = 0; index < SIDEBAR_PANEL_MAX_PANELS; index += 1) {
			expect(capacityRegistry.register(panel(`vendor:full-${index}`), "owner")).toBe(true);
		}
		for (let index = 0; index < SIDEBAR_PANEL_MAX_TRACKED_SOURCES * 2; index += 1) {
			capacityRegistry.handleEvent({
				version: 1,
				type: "register",
				source: `capacity-${index}`,
				revision: 1,
				panel: panel(`capacity-${index}:panel`),
			});
		}
		capacityRegistry.unregister("vendor:full-0", "owner");
		capacityRegistry.handleEvent({
			version: 1,
			type: "register",
			source: "capacity-0",
			revision: 1,
			panel: panel("capacity-0:panel", "Accepted after retry"),
		});
		expect(capacityRegistry.get("capacity-0:panel")?.title).toBe("Accepted after retry");
		capacityRegistry.dispose();

		const ownerRegistry = createSidebarPanelRegistry();
		expect(ownerRegistry.register(panel("vendor:owned"), "owner")).toBe(true);
		for (let index = 0; index < SIDEBAR_PANEL_MAX_TRACKED_SOURCES * 2; index += 1) {
			ownerRegistry.handleEvent({
				version: 1,
				type: "register",
				source: `hijacker-${index}`,
				revision: 1,
				panel: panel("vendor:owned", "Hijacked"),
			});
			ownerRegistry.handleEvent({
				version: 1,
				type: "unregister",
				source: `missing-${index}`,
				revision: 1,
				id: "vendor:missing",
			});
		}
		ownerRegistry.handleEvent({
			version: 1,
			type: "register",
			source: "missing-0",
			revision: 1,
			panel: panel("vendor:missing", "Accepted after missing removal"),
		});
		expect(ownerRegistry.get("vendor:missing")?.title).toBe("Accepted after missing removal");
		ownerRegistry.unregister("vendor:owned", "owner");
		ownerRegistry.handleEvent({
			version: 1,
			type: "register",
			source: "hijacker-0",
			revision: 1,
			panel: panel("vendor:owned", "Accepted after owner removal"),
		});
		expect(ownerRegistry.get("vendor:owned")?.title).toBe("Accepted after owner removal");
		ownerRegistry.dispose();
	});

	it("bounds tracked sources while preserving revisions for active sources", () => {
		const registry = createSidebarPanelRegistry();
		const panel = (id: string, title = id) => ({
			id: id as `${string}:${string}`,
			title,
			rows: [],
		});
		for (let index = 0; index < SIDEBAR_PANEL_MAX_TRACKED_SOURCES; index += 1) {
			registry.handleEvent({
				version: 1,
				type: "register",
				source: `tracked-${index}`,
				revision: 1,
				panel: panel(`tracked-${index}:panel`),
			});
		}
		expect(registry.getAvailable()).toHaveLength(SIDEBAR_PANEL_MAX_TRACKED_SOURCES);
		registry.handleEvent({
			version: 1,
			type: "unregister",
			source: "tracked-0",
			revision: 2,
			id: "tracked-0:panel",
		});
		registry.handleEvent({
			version: 1,
			type: "register",
			source: "overflow-source",
			revision: 1,
			panel: panel("overflow-source:panel"),
		});
		expect(registry.get("overflow-source:panel")).toBeUndefined();

		// A tracked source remains usable for updates and removal after the cap.
		registry.handleEvent({
			version: 1,
			type: "register",
			source: "tracked-1",
			revision: 2,
			panel: panel("tracked-1:panel", "Updated"),
		});
		expect(registry.get("tracked-1:panel")?.title).toBe("Updated");
		registry.handleEvent({
			version: 1,
			type: "unregister",
			source: "tracked-1",
			revision: 3,
			id: "tracked-1:panel",
		});
		expect(registry.get("tracked-1:panel")).toBeUndefined();
		registry.handleEvent({
			version: 1,
			type: "register",
			source: "tracked-1",
			revision: 2,
			panel: panel("tracked-1:panel", "Stale"),
		});
		expect(registry.get("tracked-1:panel")).toBeUndefined();
		registry.dispose();
	});

	it("keeps publisher IDs stable and ignores updates after teardown", () => {
		const emitted: unknown[] = [];
		const listeners = new Set<(data: unknown) => void>();
		const events = {
			on: (_channel: string, handler: (data: unknown) => void) => {
				listeners.add(handler);
				return () => listeners.delete(handler);
			},
			emit: (_channel: string, data: unknown) => {
				emitted.push(data);
				for (const listener of [...listeners]) listener(data);
			},
		};
		const publisher = registerSidebarPanel({ events }, { id: "vendor:queue", title: "Queue", rows: ["one"] });
		const registry = createSidebarPanelRegistry({ events });
		publisher.update({ id: "other:panel", title: "Renamed", rows: ["two"] });
		expect(registry.get("vendor:queue")?.title).toBe("Renamed");
		expect(registry.get("other:panel")).toBeUndefined();
		expect((emitted.at(-1) as { panel?: { id?: string } })?.panel?.id).toBe("vendor:queue");
		publisher.dispose();
		expect(registry.get("vendor:queue")).toBeUndefined();
		registry.dispose();
		publisher.update({ id: "vendor:queue", title: "After dispose", rows: ["three"] });
		expect(registry.getAvailable()).toEqual([]);
	});

	it("builds the approved core overview", () => {
		expect(snapshot()).toMatchObject({
			projectName: "pi-atelier",
			branch: "feature/sidebar",
			dirty: true,
			sessionName: "Sidebar implementation",
			persisted: true,
			branchEntryCount: 38,
			activeToolCount: 8,
			availableToolCount: 12,
		});
	});

	it("sanitizes contributed title and structured row text at render time", () => {
		const config = {
			...DEFAULT_CONFIG,
			sidebarPanelLayout: [
				{ id: "vendor:unsafe" as const, visible: true },
				...DEFAULT_CONFIG.sidebarPanelLayout.map((entry) => ({ ...entry, visible: false })),
			],
		};
		const rendered = renderSidebarLines(
			{
				...snapshot(),
				sidebarPanels: [
					{
						id: "vendor:unsafe",
						title: "\u001b[31mUnsafe\nTitle",
						rows: [{ text: "row\nvalue\u001b[33m", role: "warning" }],
						available: true,
						source: "vendor",
					},
				],
			},
			config,
			theme,
			44,
			20,
			false,
			0,
		).join("\n");
		expect(rendered).toContain("UNSAFE TITLE");
		expect(rendered).toContain("row value");
		expect(rendered).not.toContain("[31m");
		expect(rendered).not.toContain("[33m");
	});

	it("renders an explicit empty state when every configured-visible panel is unavailable", () => {
		const hiddenBuiltins = DEFAULT_CONFIG.sidebarPanelLayout.map((entry) => ({ ...entry, visible: false }));
		const emptyConfig = {
			...DEFAULT_CONFIG,
			showSidebarAgent: false,
			showSidebarTodos: false,
			sidebarPanelLayout: [{ id: "vendor:missing" as const, visible: true }, ...hiddenBuiltins],
		};
		const rows = contentRows(renderSidebarLines(snapshot(), emptyConfig, theme, 44, 20));
		expect(rows).toContain("No available panels");
		expect(rows).toContain("Open /atelier Settings");
	});

	it("renders a full-height dock with elegant terminal-native panels", () => {
		const lines = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false, 0);
		const text = lines.join("\n");
		expect(lines).toHaveLength(36);
		expect(lines.every((line) => visibleWidth(line) <= 44)).toBe(true);
		expect(lines.every((line) => stripAnsi(line).startsWith("│ "))).toBe(true);
		expect(text).toContain("╭─ ✦ AGENT ");
		expect(text).toContain("╭─ ✦ CONTEXT ");
		expect(text).toContain("╰────────────────");
		expect(text).not.toContain("ATELIER");
		expect(text).not.toMatch(/PI ATELIER|ATELIER|▛▀▜/);
		expect(contentRows(lines)[0]).toBe("AGENT");
		expect(contentRows(lines)).toContain("pi-atelier · feature/sidebar ▲");
		expect(contentRows(lines)).toContainEqual(
			expect.stringMatching(/^◆ Working · gitifying\s+gpt-5\.6-sol$/),
		);
	});

	it("renders a scan-first Workspace Pulse without repeating the repository root path", () => {
		const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false, 0));

		expect(rows).toContain("5 tracked  +182  −47");
		expect(rows).toContain("2 untracked");
		expect(rows).not.toContain("/Users/example/projects/pi-atelier");
		expect(rows).toContain("Sidebar implementation");
		expect(rows).toContain("38 entries · persisted");
	});

	it.each([
		[{ status: "inspecting" as const }, "inspecting…"],
		[{ status: "not-repo" as const }, "not a Git repository"],
		[{ status: "unavailable" as const }, "Git unavailable"],
	])("renders the %s Pulse state explicitly", (workspacePulse, expected) => {
		const { branch: _branch, ...withoutBranch } = snapshot();
		const rows = contentRows(
			renderSidebarLines(
				{ ...withoutBranch, workspacePulse, dirty: false },
				DEFAULT_CONFIG,
				theme,
				44,
				36,
				false,
				0,
			),
		);
		expect(rows).toContain(expected);
	});

	it("keeps conflict and stale signals visible without expanding every Git category", () => {
		if (!("data" in state.workspacePulse)) throw new Error("expected fixture Pulse data");
		const data = {
			...state.workspacePulse.data,
			relativeCwd: "packages/api",
			snapshot: {
				...state.workspacePulse.data.snapshot,
				binaryFiles: 1,
				submodules: 1,
				conflicts: 2,
			},
		};
		const conflictRows = contentRows(
			renderSidebarLines(
				{ ...snapshot(), workspacePulse: { status: "conflict", data } },
				DEFAULT_CONFIG,
				theme,
				44,
				36,
				false,
				0,
			),
		);
		expect(conflictRows).toContain("./packages/api");
		expect(conflictRows).toContain("2 conflicts");
		expect(conflictRows).toContain("2 untracked · 1 binary · 1 submodule");

		const staleRows = contentRows(
			renderSidebarLines(
				{ ...snapshot(), workspacePulse: { status: "stale", data } },
				DEFAULT_CONFIG,
				theme,
				44,
				36,
				false,
				0,
			),
		);
		expect(staleRows).toContain("~ stale · 5 tracked  +182  −47");

		const compactRows = contentRows(
			renderSidebarLines(
				{ ...snapshot(), workspacePulse: { status: "stale", data } },
				DEFAULT_CONFIG,
				theme,
				28,
				36,
				false,
				0,
			),
		);
		expect(compactRows).toContain("~ stale · 5 tracked");
		expect(compactRows).toContain("+182  −47");
		expect(compactRows).toContain("?2 · bin1 · sub1");
	});

	it("drops Session and optional Pulse detail before the Workspace identity and core summary", () => {
		const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 20, false, 0));

		expect(rows).toContain("WORKSPACE");
		expect(rows).toContain("pi-atelier · feature/sidebar ▲");
		expect(rows).toContain("5 tracked  +182  −47");
		expect(rows).not.toContain("2 untracked");
		expect(rows).not.toContain("Sidebar implementation");
		expect(rows).not.toContain("38 entries · persisted");
	});

	it("pulses only the working Agent jewel while keeping other crowns stable", () => {
		const bright = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false, 0).join("\n");
		const soft = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false, 400).join("\n");
		expect(bright).toContain("╭─ ✦ AGENT ");
		expect(soft).toContain("╭─ ✧ AGENT ");
		expect(bright).toContain("╭─ ✦ CONTEXT ");
		expect(soft).toContain("╭─ ✦ CONTEXT ");
	});

	it("tints panel crowns with their semantic jewel roles", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		renderSidebarLines(
			snapshot(),
			DEFAULT_CONFIG,
			{ fg, bold: theme.bold, italic: theme.italic },
			44,
			36,
			true,
			0,
		);
		expect(fg).toHaveBeenCalledWith("mdHeading", "╭─ ✦ ");
		expect(fg).toHaveBeenCalledWith("thinkingLow", "╭─ ✦ ");
		expect(fg).toHaveBeenCalledWith("thinkingHigh", "╭─ ✦ ");
		expect(fg).toHaveBeenCalledWith("syntaxType", "╭─ ✦ ");
	});

	it("matches the representative 44x36 no-color docked rail", () => {
		const noSession = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: [] },
			cwd: "/Users/example/projects/pi-atelier",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: [],
		});
		expect(
			contentRows(renderSidebarLines(noSession, DEFAULT_CONFIG, theme, 44, 36, false)),
		).toMatchInlineSnapshot(`
			[
			  "AGENT",
			  "◆ Working · gitifying      gpt-5.6-sol",
			  "OPENAI-CODEX · MEDIUM · SUBSCRIPTION",
			  "",
			  "",
			  "ACTIVITY",
			  "Ready",
			  "TTFT ~ · TPS ~",
			  "",
			  "",
			  "CONTEXT",
			  "32k / 400k                        8.1%",
			  "[■·········]",
			  "",
			  "",
			  "WORKSPACE",
			  "pi-atelier · feature/sidebar ▲",
			  "5 tracked  +182  −47",
			  "2 untracked",
			  "6 entries · ephemeral",
			  "",
			  "",
			  "USAGE",
			  "In 50.0k  Out 1.9k",
			  "Cache 100.0k  Hit 96.0%",
			  "Cost $0.479",
			  "",
			  "",
			  "TOOLS",
			  "8 / 12 active                        ▸",
			  "",
			  "",
			  "",
			  "",
			  "",
			  "",
			]
		`);
	});

	it("renders organized sections without exceeding width", () => {
		for (const width of [32, 40, 44]) {
			const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, width, 36, false));
			expect(rows.join("\n")).not.toContain("ATELIER");
			expect(rows.join("\n")).toContain("WORKSPACE");
			expect(rows.join("\n")).toContain("CONTEXT");
			expect(rows).toContain("TOOLS");
			expect(rows.every((row) => !row.startsWith("STATUS "))).toBe(true);
			expect(
				renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, width, 36, false).every(
					(line) => visibleWidth(line) <= width,
				),
			).toBe(true);
		}
	});

	it("switches all dense sections to compact rows below 40 columns", () => {
		const expandedConfig = { ...DEFAULT_CONFIG, showSidebarToolNames: true };
		const compact = contentRows(renderSidebarLines(snapshot(), expandedConfig, theme, 28, 36, false));
		expect(compact).toContain("◆ Working · gitifying");
		expect(compact).toContain("gpt-5.6-sol");
		expect(compact).toContain("OPENAI-CODEX");
		expect(compact).toContain("MEDIUM · SUBSCRIPTION");
		const compactContext = compact.indexOf("CONTEXT");
		expect(compact[compactContext + 1]).toMatch(/^32k \/ 400k\s+8\.1%$/);
		expect(compact[compactContext + 2]).toMatch(/^\[■·+\]$/);
		expect(compact).toContain("pi-atelier");
		expect(compact).toContain("feature/sidebar ▲");
		expect(compact).toContain("In 50.0k · Out 1.9k");
		expect(compact).toContain("Cache 100.0k · 96.0%");
		expect(compact).toContainEqual(expect.stringMatching(/^8 \/ 12 active\s+▸$/));
		expect(compact).toEqual(expect.not.arrayContaining([expect.stringMatching(/subs$/)]));

		const regular = contentRows(renderSidebarLines(snapshot(), expandedConfig, theme, 44, 36, false));
		expect(regular).toContainEqual(expect.stringMatching(/^◆ Working · gitifying\s+gpt-5\.6-sol$/));
		expect(regular).toContain("OPENAI-CODEX · MEDIUM · SUBSCRIPTION");
		expect(regular).toContain("pi-atelier · feature/sidebar ▲");
		expect(regular).toContainEqual(expect.stringMatching(/^8 \/ 12 active\s+▾$/));
	});

	it("uses compact layout only below 40 frame-inclusive sidebar columns", () => {
		const expandedConfig = { ...DEFAULT_CONFIG, showSidebarToolNames: true };
		const compact = contentRows(renderSidebarLines(snapshot(), expandedConfig, theme, 39, 36, false));
		expect(compact).toContain("◆ Working · gitifying");
		expect(compact).toContain("gpt-5.6-sol");
		expect(compact).not.toContainEqual(expect.stringMatching(/^◆ Working · gitifying\s+gpt-5\.6-sol$/));

		for (const width of [40, 43, 44]) {
			const regular = contentRows(renderSidebarLines(snapshot(), expandedConfig, theme, width, 36, false));
			expect(regular).toContainEqual(expect.stringMatching(/^◆ Working · gitifying\s+gpt-5\.6-sol$/));
			expect(regular).toContainEqual(expect.stringMatching(/^OPENAI-CODEX/));
			expect(regular).toContainEqual(expect.stringMatching(/^8 \/ 12 active\s+▾$/));
		}
	});

	it("renders a compact segmented context meter that adapts to width", () => {
		const narrow = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 28, 36, false));
		const narrowContext = narrow.indexOf("CONTEXT");
		expect(narrow[narrowContext + 1]).toMatch(/^32k \/ 400k\s+8\.1%$/);
		expect(narrow[narrowContext + 2]).toMatch(/^\[■·+\]$/);

		for (const width of [40, 44, 72]) {
			const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, width, 36, false));
			const contextIndex = rows.indexOf("CONTEXT");
			expect(rows[contextIndex + 1]).toMatch(/^32k \/ 400k\s+8\.1%$/);
			expect(rows[contextIndex + 2]).toMatch(/^\[■·+\]$/);
			expect(visibleWidth(rows[contextIndex + 1] ?? "")).toBeLessThanOrEqual(width - 6);
		}
	});

	it("omits a standalone unavailable marker when session name is missing", () => {
		const missingSession = buildSidebarSnapshot({
			state,
			cwd: "/tmp/project",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: [],
		});
		const rows = contentRows(renderSidebarLines(missingSession, DEFAULT_CONFIG, theme, 44, 36, false));
		const sessionIndex = rows.findIndex((row) => row.startsWith("SESSION "));
		const usageIndex = rows.findIndex((row) => row.startsWith("USAGE "));
		expect(rows.slice(sessionIndex + 1, usageIndex)).not.toContain("—");
		expect(rows.slice(sessionIndex + 1, usageIndex)).toContain("6 entries · ephemeral");
	});

	it("does not render the session file path", () => {
		const text = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false).join("\n");
		expect(text).not.toContain("/tmp/session.jsonl");
		expect(text).not.toContain("session.jsonl");
	});

	it("renders session entry count and persistence on one row", () => {
		const persisted = buildSidebarSnapshot({
			state,
			cwd: "/tmp/project",
			sessionName: "Task session",
			sessionFile: "/tmp/session.jsonl",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: [],
		});
		expect(contentRows(renderSidebarLines(persisted, DEFAULT_CONFIG, theme, 44, 36, false))).toContain(
			"6 entries · persisted",
		);
	});

	it("renders populated usage as compact inline metric rows", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const unnamedTheme = { fg, bold: theme.bold, italic: theme.italic };
		const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, unnamedTheme, 44, 36, true));
		const usageIndex = rows.indexOf("USAGE");
		expect(rows[usageIndex + 1]).toBe("In 50.0k  Out 1.9k");
		expect(rows[usageIndex + 2]).toBe("Cache 100.0k  Hit 96.0%");
		expect(rows[usageIndex + 3]).toBe("Cost $0.479");
		for (const label of ["In", "Out", "Cache", "Hit", "Cost"]) {
			expect(fg).toHaveBeenCalledWith("muted", label);
		}
		for (const width of [44, 56, 72]) {
			const wideRows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, width, 36, false));
			const wideUsage = wideRows.indexOf("USAGE");
			expect(wideRows[wideUsage + 1]).toBe("In 50.0k  Out 1.9k");
			expect(wideRows[wideUsage + 2]).toBe("Cache 100.0k  Hit 96.0%");
		}
	});

	it("hides unavailable usage while keeping access under Agent", () => {
		const unavailable = {
			...snapshot(),
			metrics: {
				...state.metrics,
				usageAvailable: false,
				costAvailable: false,
				input: 0,
				output: 0,
				cacheRead: 0,
				cost: 0,
			},
		};
		const rows = contentRows(renderSidebarLines(unavailable, DEFAULT_CONFIG, theme, 44, 36, false));
		expect(rows).not.toContain("USAGE");
		expect(rows).toContain("OPENAI-CODEX · MEDIUM · SUBSCRIPTION");
	});

	it("renders quiet section labels without ornamental rules", () => {
		const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false));
		for (const heading of ["AGENT", "CONTEXT", "WORKSPACE", "USAGE", "TOOLS"]) {
			expect(rows).toContain(heading);
		}
		expect(rows).toEqual(expect.not.arrayContaining([expect.stringMatching(/^[A-Z &]+ ─/)]));
	});

	it("keeps a live Turn's ACTIVITY to current work without tool history", () => {
		const rows = contentRows(
			renderSidebarLines(withActivity(activeActivity()), DEFAULT_CONFIG, theme, 44, 36, false, 20_000),
		);
		expect(rows).toContain("ACTIVITY");
		expect(rows).toContain("Turn 3 · running 19s");
		expect(rows).toEqual(expect.arrayContaining([expect.stringMatching(/^read\s+src\/state\.ts\s+18s$/)]));
		expect(rows).not.toEqual(expect.arrayContaining([expect.stringMatching(/^bash\s+npm test\s+done 4s$/)]));
		expect(rows).not.toContain("tools 2 done · 1 failed");
	});

	it.each([
		{ completedCount: 2, failedCount: 0, expected: "tools 2 done · 0 failed" },
		{ completedCount: 0, failedCount: 1, expected: "tools 0 done · 1 failed" },
	])("renders both aggregate sides for %#", ({ completedCount, failedCount, expected }) => {
		const rows = contentRows(
			renderSidebarLines(
				withActivity({
					phase: "settled",
					startedAt: 10_000,
					durationMs: 5_000,
					activeTools: [],
					recentTools: [],
					completedCount,
					failedCount,
				}),
				DEFAULT_CONFIG,
				theme,
				44,
				36,
				false,
				20_000,
			),
		);
		expect(rows).toContain(expected);
	});

	it("renders response performance as a compact optional Activity row", () => {
		const ttftOnly = contentRows(
			renderSidebarLines(
				withActivity({
					phase: "running",
					turnNumber: 1,
					startedAt: 1_000,
					performance: { ttftMs: 820 },
					activeTools: [],
					recentTools: [],
					completedCount: 0,
					failedCount: 0,
				}),
				DEFAULT_CONFIG,
				theme,
				44,
				36,
				false,
				2_000,
			),
		);
		expect(ttftOnly).toContain("TTFT 820ms · TPS ~");

		const estimated = contentRows(
			renderSidebarLines(
				withActivity({
					phase: "running",
					startedAt: 1_000,
					performance: { ttftMs: 820, tokensPerSecond: 42.34, estimated: true },
					activeTools: [],
					recentTools: [],
					completedCount: 0,
					failedCount: 0,
				}),
				DEFAULT_CONFIG,
				theme,
				44,
				36,
				false,
				2_000,
			),
		);
		expect(estimated).toContain("TTFT 820ms · TPS ~42.3");

		const completed = contentRows(
			renderSidebarLines(
				withActivity({
					phase: "settled",
					startedAt: 1_000,
					durationMs: 4_000,
					performance: { ttftMs: 1_420, tokensPerSecond: 47.34 },
					activeTools: [],
					recentTools: [],
					completedCount: 0,
					failedCount: 0,
				}),
				DEFAULT_CONFIG,
				theme,
				44,
				36,
				false,
				5_000,
			),
		);
		expect(completed).toContain("TTFT 1.4s · TPS 47.3");
	});

	it("keeps the run summary and response placeholders when height drops tool activity", () => {
		const performanceActivity = withActivity({
			...activeActivity(),
			performance: { ttftMs: 820, tokensPerSecond: 48 },
		});
		const constrainedRows = Array.from({ length: 36 }, (_value, index) => 36 - index)
			.map((height) =>
				contentRows(
					renderSidebarLines(performanceActivity, DEFAULT_CONFIG, theme, 44, height, false, 20_000),
				),
			)
			.find(
				(rows) =>
					rows.includes("TTFT 820ms · TPS 48.0") &&
					rows.some((row) => row.includes("Turn 3")) &&
					!rows.some((row) => /^read\s+src\/state\.ts/.test(row)),
			);

		expect(constrainedRows).toBeDefined();
	});

	it("always renders idle placeholders and preserves settled activity", () => {
		const idleRows = contentRows(
			renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false, 20_000),
		);
		expect(idleRows).toContain("ACTIVITY");
		expect(idleRows).toContain("Ready");
		expect(idleRows).toContain("TTFT ~ · TPS ~");

		const settledRows = contentRows(
			renderSidebarLines(
				withActivity({
					phase: "settled",
					turnNumber: 4,
					startedAt: 1_000,
					durationMs: 6_500,
					activeTools: [],
					recentTools: [
						{
							id: "edit-1",
							name: "edit",
							summary: "src/sidebar.ts",
							status: "failed",
							startedAt: 2_000,
							durationMs: 2_000,
						},
					],
					completedCount: 0,
					failedCount: 1,
				}),
				DEFAULT_CONFIG,
				theme,
				44,
				36,
				false,
				20_000,
			),
		);
		expect(settledRows).toContain("Last run · 6s");
		expect(settledRows).not.toContain("Turn 4 · settled 6s");
		expect(settledRows).toEqual(
			expect.arrayContaining([expect.stringMatching(/^edit\s+src\/sidebar\.ts\s+failed 2s$/)]),
		);

		const idleWithRecent = contentRows(
			renderSidebarLines(
				withActivity({
					phase: "idle",
					activeTools: [],
					recentTools: [
						{
							id: "idle-recent",
							name: "bash",
							summary: "npm test",
							status: "done",
							startedAt: 2_000,
							durationMs: 1_000,
						},
					],
					completedCount: 1,
					failedCount: 0,
				}),
				DEFAULT_CONFIG,
				theme,
				44,
				36,
				false,
				20_000,
			),
		);
		expect(idleWithRecent).toContain("ACTIVITY");
		expect(idleWithRecent).toEqual(
			expect.arrayContaining([expect.stringMatching(/^bash\s+npm test\s+done 1s$/)]),
		);
		expect(idleWithRecent).toContain("tools 1 done · 0 failed");

		const idleWithActive = contentRows(
			renderSidebarLines(
				withActivity({
					phase: "idle",
					startedAt: 10_000,
					activeTools: [
						{ id: "idle-active", name: "read", summary: "src/a.ts", status: "running", startedAt: 15_000 },
					],
					recentTools: [],
					completedCount: 0,
					failedCount: 0,
				}),
				DEFAULT_CONFIG,
				theme,
				44,
				36,
				false,
				20_000,
			),
		);
		expect(idleWithActive).toContain("ACTIVITY");
		expect(idleWithActive).toEqual(
			expect.arrayContaining([expect.stringMatching(/^read\s+src\/a\.ts\s+5s$/)]),
		);

		const idleWithCounts = contentRows(
			renderSidebarLines(
				withActivity({
					phase: "idle",
					activeTools: [],
					recentTools: [],
					completedCount: 0,
					failedCount: 2,
				}),
				DEFAULT_CONFIG,
				theme,
				44,
				36,
				false,
				20_000,
			),
		);
		expect(idleWithCounts).toContain("ACTIVITY");
		expect(idleWithCounts).toContain("tools 0 done · 2 failed");
	});

	it("folds extra live tools into the current work row during a Turn", () => {
		const rows = contentRows(
			renderSidebarLines(
				withActivity({
					phase: "running",
					turnNumber: 1,
					startedAt: 10_000,
					activeTools: [
						{ id: "second", name: "grep", summary: "later", status: "running", startedAt: 13_000 },
						{ id: "first", name: "read", summary: "same-a", status: "running", startedAt: 12_000 },
						{ id: "third", name: "bash", summary: "same-b", status: "running", startedAt: 12_000 },
					],
					recentTools: [
						{
							id: "old",
							name: "write",
							summary: "recent",
							status: "done",
							startedAt: 3_000,
							durationMs: 1_000,
						},
					],
					completedCount: 1,
					failedCount: 0,
				}),
				DEFAULT_CONFIG,
				theme,
				44,
				36,
				false,
				20_000,
			),
		);
		expect(rows).toEqual(expect.arrayContaining([expect.stringMatching(/^grep\s+later\s+7s · \+2$/)]));
		expect(rows).not.toEqual(expect.arrayContaining([expect.stringMatching(/^read\s+same-a/)]));
		expect(rows).not.toEqual(expect.arrayContaining([expect.stringMatching(/^bash\s+same-b/)]));
		expect(rows.findIndex((row) => /^write\s+recent/.test(row))).toBe(-1);
	});

	it("caps recent tools, deduplicates active IDs, and bounds long summaries", () => {
		const rows = contentRows(
			renderSidebarLines(
				withActivity({
					phase: "settled",
					startedAt: 0,
					activeTools: [{ id: "dupe", name: "read", summary: "active", status: "running", startedAt: 1_000 }],
					recentTools: [
						{
							id: "new",
							name: "bash",
							summary: "n".repeat(80),
							status: "done",
							startedAt: 9_000,
							durationMs: 1_000,
						},
						{
							id: "dupe",
							name: "read",
							summary: "duplicate",
							status: "done",
							startedAt: 8_000,
							durationMs: 1_000,
						},
						{
							id: "middle",
							name: "edit",
							summary: "middle",
							status: "done",
							startedAt: 7_000,
							durationMs: 1_000,
						},
						{
							id: "older",
							name: "write",
							summary: "older",
							status: "done",
							startedAt: 6_000,
							durationMs: 1_000,
						},
						{
							id: "oldest",
							name: "grep",
							summary: "oldest",
							status: "done",
							startedAt: 5_000,
							durationMs: 1_000,
						},
					],
					completedCount: 5,
					failedCount: 0,
				}),
				DEFAULT_CONFIG,
				theme,
				34,
				60,
				false,
				20_000,
			),
		);
		const recentRows = rows.filter((row) => /^(bash|edit|write)\s+/.test(row));
		expect(recentRows).toHaveLength(3);
		expect(recentRows[0]).toMatch(/^bash\s+n+/);
		expect(recentRows[1]).toMatch(/^edit\s+middle\s+done 1s$/);
		expect(recentRows[2]).toMatch(/^write\s+older\s+done 1s$/);
		expect(rows).not.toEqual(expect.arrayContaining([expect.stringContaining("duplicate")]));
		expect(rows).not.toEqual(expect.arrayContaining([expect.stringContaining("oldest")]));
		expect(rows.every((row) => visibleWidth(row) <= 32)).toBe(true);
	});

	it("uses success, error, and working palette roles for activity status", () => {
		const liveFg = vi.fn((_color: string, text: string) => text);
		renderSidebarLines(
			withActivity({
				phase: "running",
				startedAt: 10_000,
				activeTools: [
					{ id: "active", name: "read", summary: "src/a.ts", status: "running", startedAt: 10_000 },
				],
				recentTools: [],
				completedCount: 0,
				failedCount: 0,
			}),
			DEFAULT_CONFIG,
			{ fg: liveFg, bold: theme.bold, italic: theme.italic },
			44,
			36,
			true,
			20_000,
		);
		expect(liveFg).toHaveBeenCalledWith("mdHeading", "10s");

		const settledFg = vi.fn((_color: string, text: string) => text);
		renderSidebarLines(
			withActivity({
				phase: "settled",
				startedAt: 10_000,
				durationMs: 10_000,
				activeTools: [],
				recentTools: [
					{ id: "ok", name: "bash", summary: "ok", status: "done", startedAt: 9_000, durationMs: 1_000 },
					{ id: "bad", name: "edit", summary: "bad", status: "failed", startedAt: 8_000, durationMs: 1_000 },
				],
				completedCount: 1,
				failedCount: 1,
			}),
			DEFAULT_CONFIG,
			{ fg: settledFg, bold: theme.bold, italic: theme.italic },
			44,
			36,
			true,
			20_000,
		);
		expect(settledFg).toHaveBeenCalledWith("thinkingLow", "done 1s");
		expect(settledFg).toHaveBeenCalledWith("error", "failed 1s");
	});

	it("drops workspace details, tools, then usage as height contracts", () => {
		const ranked = withActivity({
			phase: "running",
			turnNumber: 2,
			startedAt: 1_000,
			activeTools: [
				{ id: "active-a", name: "read", summary: "active-a", status: "running", startedAt: 2_000 },
				{ id: "active-b", name: "bash", summary: "active-b", status: "running", startedAt: 3_000 },
			],
			recentTools: [
				{
					id: "newest",
					name: "write",
					summary: "newest",
					status: "done",
					startedAt: 8_000,
					durationMs: 1_000,
				},
				{
					id: "middle",
					name: "grep",
					summary: "middle",
					status: "done",
					startedAt: 7_000,
					durationMs: 1_000,
				},
				{
					id: "oldest",
					name: "edit",
					summary: "oldest",
					status: "failed",
					startedAt: 6_000,
					durationMs: 1_000,
				},
			],
			completedCount: 3,
			failedCount: 1,
		});

		const fullRows = contentRows(renderSidebarLines(ranked, DEFAULT_CONFIG, theme, 44, 40, false, 20_000));
		expect(fullRows).toContain("TOOLS");
		expect(fullRows).toContain("USAGE");
		expect(fullRows).toContain("WORKSPACE");
		expect(fullRows.findIndex((row) => /^bash\s+active-b/.test(row))).toBeLessThan(
			fullRows.indexOf("CONTEXT"),
		);

		const withoutSession = contentRows(
			renderSidebarLines(ranked, DEFAULT_CONFIG, theme, 44, 32, false, 20_000),
		);
		expect(withoutSession).toContain("TOOLS");
		expect(withoutSession).toContain("USAGE");
		expect(withoutSession).toContain("WORKSPACE");
		expect(withoutSession).not.toContain("Sidebar implementation");
		expect(withoutSession).not.toContain("38 entries · persisted");

		const withoutTools = contentRows(
			renderSidebarLines(ranked, DEFAULT_CONFIG, theme, 44, 28, false, 20_000),
		);
		expect(withoutTools).not.toContain("TOOLS");
		expect(withoutTools).toContain("USAGE");
		expect(withoutTools).toContain("WORKSPACE");

		const coreOnly = contentRows(renderSidebarLines(ranked, DEFAULT_CONFIG, theme, 44, 22, false, 20_000));
		expect(coreOnly).not.toContain("TOOLS");
		expect(coreOnly).not.toContain("USAGE");
		expect(coreOnly).toContain("WORKSPACE");
		expect(coreOnly).toContain("5 tracked  +182  −47");
		expect(coreOnly).not.toContain("Sidebar implementation");
		expect(coreOnly).not.toContain("38 entries · persisted");
		expect(coreOnly).toContain("AGENT");
		expect(coreOnly).toContain("CONTEXT");
	});

	it("normalizes tools, collapses names by default, and expands them from configuration", () => {
		const toolsSnapshot = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: [] },
			cwd: "/tmp/project",
			branchEntryCount: 6,
			activeToolCount: 3,
			availableToolCount: 7,
			activeToolNames: ["read", "\u001b[31mbash", " edit\n", "read", "   "],
			extensionStatuses: [],
		});
		expect(toolsSnapshot.activeToolNames).toEqual(["bash", "edit", "read"]);

		const collapsed = contentRows(renderSidebarLines(toolsSnapshot, DEFAULT_CONFIG, theme, 44, 36, false));
		const collapsedIndex = collapsed.indexOf("TOOLS");
		expect(collapsed[collapsedIndex + 1]).toMatch(/^3 \/ 7 active\s+▸$/);
		expect(collapsed).not.toContain("bash  edit");

		const expandedConfig = { ...DEFAULT_CONFIG, showSidebarToolNames: true };
		const expanded = contentRows(renderSidebarLines(toolsSnapshot, expandedConfig, theme, 44, 36, false));
		const expandedIndex = expanded.indexOf("TOOLS");
		expect(expanded[expandedIndex + 1]).toMatch(/^3 \/ 7 active\s+▾$/);
		expect(expanded[expandedIndex + 2]).toBe("bash  edit");
		expect(expanded[expandedIndex + 3]).toBe("read");
		expect(expanded.join("\n")).not.toContain("[31m");

		for (const width of [44, 56, 72]) {
			const wide = contentRows(renderSidebarLines(toolsSnapshot, expandedConfig, theme, width, 36, false));
			const wideIndex = wide.indexOf("TOOLS");
			expect(wide[wideIndex + 2]).toBe("bash  edit");
			expect(wide[wideIndex + 3]).toBe("read");
		}

		for (const width of [28, 39]) {
			const narrow = contentRows(renderSidebarLines(toolsSnapshot, expandedConfig, theme, width, 36, false));
			const narrowIndex = narrow.indexOf("TOOLS");
			expect(narrow[narrowIndex + 1]).toMatch(/^3 \/ 7 active\s+▸$/);
			expect(narrow).not.toContain("bash  edit");
			expect(narrow).not.toContain("read");
		}
		expect(expandedConfig.showSidebarToolNames).toBe(true);
	});

	it("drops activated tool-name rows before the tool count", () => {
		const toolsSnapshot = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: [] },
			cwd: "/tmp/project",
			branchEntryCount: 6,
			activeToolCount: 4,
			availableToolCount: 7,
			activeToolNames: ["write", "read", "edit", "bash"],
			extensionStatuses: [],
		});
		const expandedConfig = { ...DEFAULT_CONFIG, showSidebarToolNames: true };
		const fullRows = contentRows(renderSidebarLines(toolsSnapshot, expandedConfig, theme, 44, 60, false));
		const fullHeight = fullRows.findLastIndex((row) => row !== "") + 3;
		const constrained = contentRows(
			renderSidebarLines(toolsSnapshot, expandedConfig, theme, 44, fullHeight - 1, false),
		);
		expect(constrained).toContainEqual(expect.stringMatching(/^4 \/ 7 active\s+▾$/));
		expect(constrained).toContain("bash  edit");
		expect(constrained).not.toContain("read  write");
	});

	it("renders no tool-name placeholder when none are active", () => {
		const toolsSnapshot = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: [] },
			cwd: "/tmp/project",
			branchEntryCount: 0,
			activeToolCount: 0,
			availableToolCount: 7,
			activeToolNames: [],
			extensionStatuses: [],
		});
		const rows = contentRows(renderSidebarLines(toolsSnapshot, DEFAULT_CONFIG, theme, 44, 36, false));
		const toolsIndex = rows.indexOf("TOOLS");
		expect(rows[toolsIndex + 1]).toMatch(/^0 \/ 7 active\s+▸$/);
		expect(rows[toolsIndex + 2]).toBe("");
	});

	it("renders tool count without standalone status placeholder when extension statuses are empty", () => {
		const emptyStatuses = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: [] },
			cwd: "/tmp/project",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: [],
		});
		const rows = contentRows(renderSidebarLines(emptyStatuses, DEFAULT_CONFIG, theme, 44, 36, false));
		const toolsIndex = rows.indexOf("TOOLS");
		expect(toolsIndex).toBeGreaterThan(-1);
		expect(rows[toolsIndex + 1]).toMatch(/^8 \/ 12 active\s+▸$/);
		expect(rows.slice(toolsIndex + 2)).not.toContain("—");
		expect(rows).toEqual(expect.not.arrayContaining([expect.stringMatching(/^STATUS /)]));
	});

	it("shows only sanitized warning and error extension statuses", () => {
		const statusSnapshot = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: [] },
			cwd: "/tmp/project",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: ["tests \u001b[31mpassing", "api\nready", "sync warning", "index failed", "   "],
		});
		const rows = contentRows(renderSidebarLines(statusSnapshot, DEFAULT_CONFIG, theme, 44, 36, false));
		expect(rows).toContain("ALERTS");
		expect(rows).toContain("▲ sync warning");
		expect(rows).toContain("✕ index failed");
		expect(rows).not.toContain("tests passing");
		expect(rows).not.toContain("api ready");
		expect(rows.join("\n")).not.toContain("[31m");
	});

	it("suppresses routine healthy extension statuses", () => {
		const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false));
		expect(rows).toContainEqual(expect.stringMatching(/^8 \/ 12 active\s+▸$/));
		expect(rows).not.toContain("tests passing");
		expect(rows).not.toContain("ALERTS");
	});

	it("keeps only the required hierarchy in a compact 12 row rail", () => {
		const text = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 12, false).join("\n");
		expect(text).not.toContain("▛▀▜");
		expect(text).toContain("AGENT");
		expect(text).toContain("CONTEXT");
		expect(text).not.toContain("WORKSPACE");
		expect(text).not.toContain("USAGE");
		expect(text).not.toContain("TOOLS");
		expect(text).not.toContain("tests passing");
	});

	it("renders missing metadata as unavailable and the session as ephemeral", () => {
		const {
			modelId: _model,
			provider: _provider,
			thinkingLevel: _thinking,
			branch: _branch,
			...base
		} = state;
		const missing = buildSidebarSnapshot({
			state: {
				...base,
				metrics: { ...state.metrics, contextTokens: null, contextPercent: null },
			},
			cwd: "/tmp/project",
			branchEntryCount: 0,
			activeToolCount: 0,
			availableToolCount: 0,
			extensionStatuses: [],
		});
		const lines = renderSidebarLines(missing, DEFAULT_CONFIG, theme, 32, 36, false);
		expect(lines.join("\n")).toContain("—");
		expect(lines.join("\n")).toContain("ephemeral");
		expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
	});

	it("sanitizes and truncates long values without breaking the frame", () => {
		const long = {
			...snapshot(),
			modelId: `model\u001b[31m${"界".repeat(60)}`,
			branch: `feature/${"x".repeat(100)}`,
			sessionName: `release\n${"y".repeat(100)}`,
			extensionStatuses: [`status\t${"z".repeat(100)}`],
		};
		const lines = renderSidebarLines(long, DEFAULT_CONFIG, theme, 34, 36, false);
		expect(lines.join("")).not.toContain("[31m");
		expect(lines.every((line) => visibleWidth(line) <= 34)).toBe(true);
	});

	it.each([
		[50, "text"],
		[75, "warning"],
		[95, "error"],
	] as const)("uses the configured context role at %s%%", (percent, expectedRole) => {
		const fg = vi.fn((_color: string, text: string) => text);
		renderSidebarLines(
			{ ...snapshot(), metrics: { ...state.metrics, contextPercent: percent } },
			DEFAULT_CONFIG,
			{ ...theme, fg },
			44,
			36,
			false,
		);
		expect(fg).toHaveBeenCalledWith(expectedRole, expect.stringContaining(`${percent.toFixed(1)}%`));
	});

	it("hides Agent while retaining every populated sibling panel", () => {
		const configWithoutAgent = { ...DEFAULT_CONFIG, showSidebarAgent: false };
		const populated = {
			...snapshot(),
			todos: [
				{ id: 1, text: "Visible TODO", status: "pending" as const },
				{ id: 2, text: "Completed TODO", status: "completed" as const },
			],
		};
		const rows = contentRows(renderSidebarLines(populated, configWithoutAgent, theme, 44, 64, false, 0));
		expect(rows).not.toContain("AGENT");
		for (const panel of ["ACTIVITY", "TODOS", "CONTEXT", "WORKSPACE", "USAGE", "TOOLS"]) {
			expect(rows).toContain(panel);
		}
		expect(rows.some((row) => row.includes("Visible TODO"))).toBe(true);
	});

	it("shows the Agent panel when showSidebarAgent is true", () => {
		const configWithAgent = { ...DEFAULT_CONFIG, showSidebarAgent: true };
		const rows = contentRows(renderSidebarLines(snapshot(), configWithAgent, theme, 44, 36, false, 0));
		expect(rows).toContain("AGENT");
	});
});

describe("sidebar component and overlay", () => {
	it("does not capture editor input or render modal close help", () => {
		const component = createSidebarComponent({
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			getHeight: () => 36,
			theme,
		});
		expect(component.handleInput).toBeUndefined();
		expect(component.render(44).join("\n")).not.toContain("esc/q close");
	});

	it("shows a visible Resize state and active divider styling", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const component = createSidebarComponent({
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			getHeight: () => 36,
			isResizing: () => true,
			theme: { fg, bold: theme.bold, italic: theme.italic },
		});

		expect(component.render(44).join("\n")).toContain("RESIZE");
		expect(fg).toHaveBeenCalledWith("warning", "│");
	});

	it("reads live terminal height on every render without recreation", () => {
		let height = 24;
		const component = createSidebarComponent({
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			getHeight: () => height,
			theme,
		});
		expect(component.render(44)).toHaveLength(24);
		height = 31;
		expect(component.render(44)).toHaveLength(31);
	});

	it.each(["snapshot", "config", "render"] as const)(
		"renders a bounded error state after a %s failure",
		(source) => {
			const component = createSidebarComponent({
				getSnapshot: () => {
					if (source === "snapshot") throw new Error("snapshot failed");
					return snapshot();
				},
				getConfig: () => {
					if (source === "config") throw new Error("config failed");
					return DEFAULT_CONFIG;
				},
				getHeight: () => 7,
				theme:
					source === "render"
						? {
								...theme,
								bold: () => {
									throw new Error("render failed");
								},
							}
						: theme,
			});
			const lines = component.render(24);
			expect(lines).toHaveLength(7);
			expect(lines.every((line) => stripAnsi(line).startsWith("│ "))).toBe(true);
			expect(contentRows(lines)[0]).toBe("Sidebar unavailable");
			expect(lines.join("\n")).not.toMatch(/PI ATELIER|ATELIER/);
			expect(lines.join("\n")).not.toContain("esc/q close");
			expect(lines.join("\n")).not.toMatch(/[╭╮╰╯]/);
			expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
		},
	);

	it("keeps one overlay alive and supports repeated lifecycle operations", async () => {
		const requestRender = vi.fn();
		const closeCallbacks: Array<ReturnType<typeof vi.fn>> = [];
		const handles: Array<{ hide: ReturnType<typeof vi.fn> }> = [];
		const components: unknown[] = [];
		const tui = fakeTui(requestRender);
		const custom = vi.fn((factory, customOptions) => {
			return new Promise<undefined>((resolve) => {
				let closed = false;
				const done = vi.fn((value: undefined) => {
					if (closed) return;
					closed = true;
					resolve(value);
				});
				const handle = { hide: vi.fn() };
				closeCallbacks.push(done);
				handles.push(handle);
				components.push(factory(tui as never, theme as never, {} as never, done));
				const overlayOptions =
					typeof customOptions.overlayOptions === "function"
						? customOptions.overlayOptions()
						: customOptions.overlayOptions;
				expect(overlayOptions).toMatchObject({
					anchor: "top-right",
					width: DEFAULT_SIDEBAR_WIDTH,
					nonCapturing: true,
				});
				expect(tui.render(120)).toEqual(["main:120"]);
				customOptions.onHandle?.(handle as never);
			});
		});
		const controller = createSidebarController({
			ctx: { mode: "tui", ui: { custom } } as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
		});

		expect(controller.isVisible()).toBe(false);
		controller.show();
		expect(controller.isVisible()).toBe(true);
		expect(custom).toHaveBeenCalledOnce();
		expect(custom.mock.calls[0]?.[1]).toMatchObject({
			overlay: true,
			overlayOptions: expect.any(Function),
			onHandle: expect.any(Function),
		});
		expect(components).toHaveLength(1);
		controller.show();
		expect(custom).toHaveBeenCalledOnce();

		requestRender.mockClear();
		controller.requestRender();
		expect(requestRender).toHaveBeenCalledTimes(2);
		controller.hide();
		expect(controller.isVisible()).toBe(false);
		expect(closeCallbacks[0]).toHaveBeenCalledOnce();
		expect(handles[0]?.hide).not.toHaveBeenCalled();
		controller.hide();
		expect(closeCallbacks[0]).toHaveBeenCalledOnce();

		controller.toggle();
		expect(controller.isVisible()).toBe(true);
		expect(custom).toHaveBeenCalledTimes(2);
		expect(components).toHaveLength(2);

		// Cross the overlay promise and its catch/finally chain while the replacement is active.
		await flushOverlay();
		await flushOverlay();
		expect(controller.isVisible()).toBe(true);
		requestRender.mockClear();
		controller.requestRender();
		expect(requestRender).toHaveBeenCalledTimes(2);

		controller.dispose();
		expect(controller.isVisible()).toBe(false);
		expect(closeCallbacks[1]).toHaveBeenCalledOnce();
	});

	it("animates live activity on one timer only while visible", async () => {
		vi.useFakeTimers();
		let running = true;
		const requestRender = vi.fn();
		const tui = fakeTui(requestRender);
		const custom = vi.fn((factory, customOptions) => {
			return new Promise<undefined>((resolve) => {
				const handle = { hide: vi.fn() };
				factory(tui as never, theme as never, {} as never, resolve);
				customOptions.onHandle?.(handle as never);
			});
		});
		const controller = createSidebarController({
			ctx: { mode: "tui", ui: { custom } } as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			shouldAnimate: () => running,
			animationIntervalMs: 10,
		});
		vi.advanceTimersByTime(30);
		expect(requestRender).not.toHaveBeenCalled();

		controller.show();
		await flushOverlay();
		controller.show();
		requestRender.mockClear();
		vi.advanceTimersByTime(30);
		expect(requestRender).toHaveBeenCalledTimes(3);

		controller.requestRender();
		expect(requestRender).toHaveBeenCalledTimes(5);
		vi.advanceTimersByTime(10);
		expect(requestRender).toHaveBeenCalledTimes(6);

		running = false;
		controller.requestRender();
		expect(requestRender).toHaveBeenCalledTimes(8);
		vi.advanceTimersByTime(30);
		expect(requestRender).toHaveBeenCalledTimes(8);
	});

	it("stops animation on hide, overlay closure, dispose, and stale generation", async () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = fakeTui(requestRender);
		const doneCallbacks: Array<(value: undefined) => void> = [];
		const custom = vi.fn((factory, customOptions) => {
			return new Promise<undefined>((resolve) => {
				const done = (value: undefined) => resolve(value);
				doneCallbacks.push(done);
				const handle = { hide: vi.fn() };
				factory(tui as never, theme as never, {} as never, done);
				customOptions.onHandle?.(handle as never);
			});
		});
		const controller = createSidebarController({
			ctx: { mode: "tui", ui: { custom } } as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			shouldAnimate: () => true,
			animationIntervalMs: 10,
		});

		controller.show();
		await flushOverlay();
		requestRender.mockClear();
		vi.advanceTimersByTime(10);
		expect(requestRender).toHaveBeenCalledOnce();
		controller.hide();
		requestRender.mockClear();
		vi.advanceTimersByTime(30);
		expect(requestRender).not.toHaveBeenCalled();

		controller.show();
		await flushOverlay();
		requestRender.mockClear();
		vi.advanceTimersByTime(10);
		expect(requestRender).toHaveBeenCalledOnce();
		doneCallbacks[1]?.(undefined);
		await flushOverlay();
		requestRender.mockClear();
		vi.advanceTimersByTime(30);
		expect(requestRender).not.toHaveBeenCalled();

		controller.show();
		await flushOverlay();
		controller.hide();
		controller.show();
		await flushOverlay();
		doneCallbacks[2]?.(undefined);
		await flushOverlay();
		requestRender.mockClear();
		vi.advanceTimersByTime(10);
		expect(requestRender).toHaveBeenCalledOnce();
		controller.dispose();
		requestRender.mockClear();
		vi.advanceTimersByTime(30);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("enters Resize mode through the composed sidebar controller", () => {
		let input: ((data: string) => unknown) | undefined;
		const tui = fakeTui();
		const custom = vi.fn((factory, customOptions) => {
			factory(tui as never, theme as never, {} as never, vi.fn());
			customOptions.onHandle?.({ hide: vi.fn() });
			return new Promise(() => undefined);
		});
		const controller = createSidebarController({
			ctx: {
				mode: "tui",
				ui: {
					custom,
					onTerminalInput: vi.fn((handler) => {
						input = handler;
						return vi.fn();
					}),
				},
			} as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
		});

		controller.show();
		expect(controller.beginResize()).toBe(true);
		expect(controller.isResizing()).toBe(true);
		expect(controller.getWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
		expect(input).toBeTypeOf("function");
	});

	it("cleans composed Resize state and restores full-width rendering on hide", () => {
		let input: ((data: string) => unknown) | undefined;
		const tui = fakeTui();
		const custom = vi.fn((factory, customOptions) => {
			factory(tui as never, theme as never, {} as never, vi.fn());
			customOptions.onHandle?.({ hide: vi.fn() });
			return new Promise(() => undefined);
		});
		const controller = createSidebarController({
			ctx: {
				mode: "tui",
				ui: {
					custom,
					onTerminalInput: vi.fn((handler) => {
						input = handler;
						return vi.fn();
					}),
				},
			} as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
		});

		controller.show();
		expect(controller.beginResize()).toBe(true);
		input?.("\u001b[D");
		expect(controller.getWidth()).toBe(DEFAULT_SIDEBAR_WIDTH + 1);
		expect(tui.render(120)).toEqual(["main:120"]);

		controller.hide();

		expect(controller.isResizing()).toBe(false);
		expect(tui.render(120)).toEqual(["main:120"]);
	});

	it("continues overlay cleanup when the external TUI render request throws", async () => {
		vi.useFakeTimers();
		const renderError = new Error("request render failed");
		const requestRender = vi.fn();
		const tui = fakeTui(requestRender);
		let finishOverlay: ((value: undefined) => void) | undefined;
		const custom = vi.fn(
			(factory, customOptions) =>
				new Promise<undefined>((resolve) => {
					finishOverlay = resolve;
					factory(tui as never, theme as never, {} as never, resolve);
					customOptions.onHandle?.({ hide: vi.fn() });
				}),
		);
		const onError = vi.fn();
		const controller = createSidebarController({
			ctx: { mode: "tui", ui: { custom } } as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			shouldAnimate: () => true,
			animationIntervalMs: 10,
			onError,
		});

		controller.show();
		expect(vi.getTimerCount()).toBe(1);
		requestRender.mockImplementation(() => {
			throw renderError;
		});
		finishOverlay?.(undefined);
		await flushOverlay();

		expect(controller.isVisible()).toBe(false);
		expect(controller.isResizing()).toBe(false);
		expect(tui.render(120)).toEqual(["main:120"]);
		expect(vi.getTimerCount()).toBe(0);
		expect(onError).toHaveBeenCalledWith(renderError);

		expect(() => controller.show()).not.toThrow();
		expect(controller.isVisible()).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("makes show after dispose a no-op", async () => {
		const tui = fakeTui();
		const doneCallbacks: Array<ReturnType<typeof vi.fn>> = [];
		const custom = vi.fn(
			(factory, customOptions) =>
				new Promise<undefined>((resolve) => {
					const done = vi.fn((value: undefined) => resolve(value));
					doneCallbacks.push(done);
					factory(tui as never, theme as never, {} as never, done);
					customOptions.onHandle?.({ hide: vi.fn() });
				}),
		);
		const controller = createSidebarController({
			ctx: { mode: "tui", ui: { custom } } as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
		});

		controller.show();
		expect(tui.render(120)).toEqual(["main:120"]);
		controller.dispose();
		await flushOverlay();

		controller.show();

		expect(controller.isVisible()).toBe(false);
		expect(custom).toHaveBeenCalledOnce();
		expect(doneCallbacks[0]).toHaveBeenCalledOnce();
		expect(tui.render(120)).toEqual(["main:120"]);
	});

	it("aborts overlay activation when a replacement TUI cannot attach", async () => {
		vi.useFakeTimers();
		const firstTui = fakeTui();
		const replacementTui = fakeTui();
		const tuis = [firstTui, replacementTui];
		const doneCallbacks: Array<ReturnType<typeof vi.fn>> = [];
		const handles: Array<{ hide: ReturnType<typeof vi.fn> }> = [];
		const onError = vi.fn();
		const custom = vi.fn((factory, customOptions) => {
			const tui = tuis[doneCallbacks.length];
			return new Promise<undefined>((resolve) => {
				const done = vi.fn((value: undefined) => resolve(value));
				const handle = { hide: vi.fn() };
				doneCallbacks.push(done);
				handles.push(handle);
				factory(tui as never, theme as never, {} as never, done);
				customOptions.onHandle?.(handle as never);
			});
		});
		const controller = createSidebarController({
			ctx: { mode: "tui", ui: { custom } } as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			shouldAnimate: () => true,
			animationIntervalMs: 10,
			onError,
		});

		controller.show();
		controller.hide();
		await flushOverlay();
		controller.show();
		await flushOverlay();

		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("another TUI") }),
		);
		expect(controller.isVisible()).toBe(false);
		expect(doneCallbacks[1]).toHaveBeenCalledOnce();
		expect(handles[1]?.hide).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		expect(firstTui.render(120)).toEqual(["main:120"]);
		expect(replacementTui.render(120)).toEqual(["main:120"]);
	});

	it("reports unsupported modes without enabling the sidebar", () => {
		const onError = vi.fn();
		const custom = vi.fn();
		const controller = createSidebarController({
			ctx: { mode: "rpc", ui: { custom } } as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			onError,
		});
		controller.show();
		expect(controller.isVisible()).toBe(false);
		expect(custom).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("TUI") }),
		);
	});
});

describe("todos panel", () => {
	it("omits todos panel when list is empty", () => {
		const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false));
		expect(rows).not.toContain("TODOS");
	});

	it("keeps only the in-progress todo during a live Turn", () => {
		const snapWithTodos = buildSidebarSnapshot({
			state,
			cwd: "/Users/example/projects/pi-atelier",
			sessionName: "Sidebar implementation",
			sessionFile: "/tmp/session.jsonl",
			branchEntryCount: 38,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: ["tests passing"],
			runActivity: activeActivity(),
			todos: [
				{ id: 1, text: "Review diff", status: "completed" },
				{ id: 2, text: "Write tests", status: "in_progress" },
				{ id: 3, text: "Commit changes", status: "pending" },
			],
		});
		const rows = contentRows(renderSidebarLines(snapWithTodos, DEFAULT_CONFIG, theme, 44, 48, false, 20_000));
		expect(rows).toContain("TODOS");
		expect(rows).toContain("1/3");
		expect(rows).toContain("◐ #2 Write tests");
		expect(rows).not.toContain("✓ #1 Review diff");
		expect(rows).not.toContain("○ #3 Commit changes");
	});

	it("renders todos with all 3 status states", () => {
		const snapWithTodos = buildSidebarSnapshot({
			state,
			cwd: "/Users/example/projects/pi-atelier",
			sessionName: "Sidebar implementation",
			sessionFile: "/tmp/session.jsonl",
			branchEntryCount: 38,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: ["tests passing"],
			runActivity: EMPTY_RUN_ACTIVITY,
			todos: [
				{ id: 1, text: "Review diff", status: "completed" },
				{ id: 2, text: "Write tests", status: "in_progress" },
				{ id: 3, text: "Commit changes", status: "pending" },
			],
		});
		const rows = contentRows(renderSidebarLines(snapWithTodos, DEFAULT_CONFIG, theme, 44, 36, false));
		expect(rows).toContain("TODOS");
		expect(rows).toContain("1/3");
		expect(rows).toContain("✓ #1 Review diff");
		expect(rows).toContain("◐ #2 Write tests");
		expect(rows).toContain("○ #3 Commit changes");
	});

	it("hides todos panel when config disables showSidebarTodos", () => {
		const snapWithTodos = buildSidebarSnapshot({
			state,
			cwd: "/Users/example/projects/pi-atelier",
			sessionName: "Sidebar implementation",
			sessionFile: "/tmp/session.jsonl",
			branchEntryCount: 38,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: ["tests passing"],
			runActivity: EMPTY_RUN_ACTIVITY,
			todos: [{ id: 1, text: "Task", status: "pending" }],
		});
		const config = { ...DEFAULT_CONFIG, showSidebarTodos: false };
		const rows = contentRows(renderSidebarLines(snapWithTodos, config, theme, 44, 36, false));
		expect(rows).not.toContain("TODOS");
	});

	it("sanitizes ansi codes in todo text", () => {
		const snapWithTodos = buildSidebarSnapshot({
			state,
			cwd: "/Users/example/projects/pi-atelier",
			sessionName: "Sidebar implementation",
			sessionFile: "/tmp/session.jsonl",
			branchEntryCount: 38,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: ["tests passing"],
			runActivity: EMPTY_RUN_ACTIVITY,
			todos: [{ id: 1, text: "Task\u001b[31mred", status: "pending" }],
		});
		const lines = renderSidebarLines(snapWithTodos, DEFAULT_CONFIG, theme, 44, 36, false);
		expect(lines.join("")).not.toContain("[31m");
		const rows = contentRows(lines);
		expect(rows).toContain("○ #1 Taskred");
	});
});

import { disposeAfterTest } from "./helpers/cleanup.js";
import { describe, expect, it, vi } from "vitest";
import { eventTransport } from "./helpers/events.js";
import {
	createSidebarPanelRegistry,
	isSidebarPanelContributionId,
	isSidebarPanelId,
	isSidebarPanelRequestId,
	registerSidebarPanel,
	SIDEBAR_PANEL_EVENT_CHANNEL,
	SIDEBAR_PANEL_MAX_ID_CHARS,
	SIDEBAR_PANEL_MAX_PANELS,
	SIDEBAR_PANEL_MAX_RAW_REQUEST_ID_CODE_UNITS,
	SIDEBAR_PANEL_MAX_ROW_CHARS,
	SIDEBAR_PANEL_MAX_ROWS,
	SIDEBAR_PANEL_MAX_SOURCE_CHARS,
	SIDEBAR_PANEL_MAX_TITLE_CHARS,
	SIDEBAR_PANEL_MAX_TRACKED_SOURCES,
} from "../src/sidebar-panels.js";

// Keep ownership and revision explicit; payloads may deliberately violate the protocol.
const registration = (source: string, revision: number, panel: unknown) => ({
	version: 1,
	type: "register",
	source,
	revision,
	panel,
});
const removal = (source: string, revision: number, id: string) => ({
	version: 1,
	type: "unregister",
	source,
	revision,
	id,
});

describe("sidebar contribution protocol", () => {
	it("supports load-order discovery, updates, and removal through the public event seam", () => {
		const { events, emitted } = eventTransport();
		const publisher = disposeAfterTest(
			registerSidebarPanel({ events }, { id: "vendor:queue", title: "Queue", rows: ["one"] }),
		);
		const changed = vi.fn();
		const registry = disposeAfterTest(createSidebarPanelRegistry({ events, onChange: changed }));
		expect(registry.get("vendor:queue")?.title).toBe("Queue");
		publisher.update({
			id: "vendor:queue",
			title: "Updated queue",
			rows: [{ text: "two", role: "warning" }],
		});
		expect(registry.get("vendor:queue")?.rows[0]?.text).toBe("two");
		publisher.dispose();
		expect(registry.get("vendor:queue")).toBeUndefined();
		expect(changed).toHaveBeenCalledTimes(3);
		expect(emitted.map((data) => (data as { type: string }).type)).toEqual([
			"register",
			"discover",
			"register",
			"register",
			"unregister",
		]);
		registry.dispose();
	});

	it("accepts namespaced contributors whose source matches the discovery prefix", () => {
		const { events, emitted } = eventTransport();
		const registry = disposeAfterTest(createSidebarPanelRegistry({ events, instanceId: "vendor" }));
		events.emit(
			SIDEBAR_PANEL_EVENT_CHANNEL,
			registration("vendor", 1, { id: "vendor:queue", title: "Queue", rows: ["ready"] }),
		);
		expect(registry.get("vendor:queue")?.source).toBe("vendor");
		expect(emitted[0]).toMatchObject({ type: "discover", requestId: "vendor-1" });
		registry.dispose();
	});

	it("validates contributed IDs and discovery request IDs before echoing them", () => {
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

		const { events, emitted } = eventTransport();
		const publisher = disposeAfterTest(
			registerSidebarPanel({ events }, { id: "vendor:queue", title: "Queue", rows: [] }),
		);
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

		publisher.dispose();
	});

	it("allocates revisions across same-source publishers without coupling transports", () => {
		const firstTransport = eventTransport();
		const secondTransport = eventTransport();
		const first = disposeAfterTest(
			registerSidebarPanel(
				{ events: firstTransport.events },
				{ id: "vendor:queue", title: "Queue", rows: ["one"] },
				{ source: "vendor" },
			),
		);
		const second = disposeAfterTest(
			registerSidebarPanel(
				{ events: firstTransport.events },
				{ id: "vendor:status", title: "Status", rows: ["ready"] },
				{ source: "vendor" },
			),
		);
		disposeAfterTest(
			registerSidebarPanel(
				{ events: secondTransport.events },
				{ id: "vendor:other", title: "Other", rows: ["isolated"] },
				{ source: "vendor" },
			),
		);

		const registry = disposeAfterTest(createSidebarPanelRegistry({ events: firstTransport.events }));
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
		const { events, emitted } = eventTransport();
		const panel = (id: string, title = id) => ({
			id: id as `${string}:${string}`,
			title,
			rows: [],
		});
		const malformed = disposeAfterTest(
			registerSidebarPanel({ events }, panel("vendor:malformed-source"), {
				source: "s".repeat(SIDEBAR_PANEL_MAX_SOURCE_CHARS + 1),
			}),
		);
		malformed.update(panel("vendor:malformed-source", "Should stay inert"));
		malformed.dispose();
		expect(emitted).toEqual([]);
		const publishers = Array.from({ length: SIDEBAR_PANEL_MAX_TRACKED_SOURCES }, (_, index) =>
			disposeAfterTest(
				registerSidebarPanel({ events }, panel(`vendor:allocator-${index}`), {
					source: `allocator-${index}`,
				}),
			),
		);
		const registry = disposeAfterTest(createSidebarPanelRegistry({ events }));
		expect(registry.getAvailable()).toHaveLength(SIDEBAR_PANEL_MAX_TRACKED_SOURCES);

		const beforeOverflow = emitted.length;
		const overflow = disposeAfterTest(
			registerSidebarPanel({ events }, panel("vendor:allocator-overflow"), {
				source: "allocator-overflow",
			}),
		);
		overflow.update(panel("vendor:allocator-overflow", "Updated overflow"));
		overflow.dispose();
		expect(emitted).toHaveLength(beforeOverflow);
		expect(registry.get("vendor:allocator-overflow")).toBeUndefined();

		publishers[0]?.update(panel("vendor:allocator-0", "Updated tracked"));
		expect(registry.get("vendor:allocator-0")?.title).toBe("Updated tracked");
		publishers[0]?.dispose();
		expect(registry.get("vendor:allocator-0")).toBeUndefined();

		const reused = disposeAfterTest(
			registerSidebarPanel({ events }, panel("vendor:allocator-reused", "Reused source"), {
				source: "allocator-0",
			}),
		);
		expect(registry.get("vendor:allocator-reused")?.title).toBe("Reused source");
		const reusedRevision = (emitted.at(-1) as { revision?: number })?.revision;
		expect(reusedRevision).toBeGreaterThan(1);
		events.emit(
			SIDEBAR_PANEL_EVENT_CHANNEL,
			registration("allocator-0", (reusedRevision ?? 1) - 1, panel("vendor:allocator-reused", "Stale reuse")),
		);
		expect(registry.get("vendor:allocator-reused")?.title).toBe("Reused source");
		reused.dispose();
		expect(registry.get("vendor:allocator-reused")).toBeUndefined();
		for (const publisher of publishers.slice(1)) publisher.dispose();
		registry.dispose();
	});

	it("rejects built-in public contributions before ownership, revisions, or capacity are consumed", () => {
		const registry = disposeAfterTest(createSidebarPanelRegistry());
		// @ts-expect-error Built-in IDs are intentionally rejected by this contributed-panel API.
		expect(registry.register({ id: "agent", title: "Spoofed", rows: [] })).toBe(false);
		for (const id of ["agent", "tools"] as const) {
			registry.handleEvent(registration("vendor", 1, { id, title: "Spoofed", rows: [] }));
		}
		expect(registry.get("agent")).toBeUndefined();
		expect(registry.get("tools")).toBeUndefined();
		expect(registry.getAvailable()).toEqual([]);
		// The rejected built-in events do not consume the source's first revision.
		registry.handleEvent(registration("vendor", 1, { id: "vendor:queue", title: "Queue", rows: [] }));
		expect(registry.get("vendor:queue")?.title).toBe("Queue");
		// Nor do they consume a panel slot when the registry is one slot from full.
		const capacityRegistry = disposeAfterTest(createSidebarPanelRegistry());
		for (let index = 0; index < SIDEBAR_PANEL_MAX_PANELS - 1; index += 1) {
			expect(capacityRegistry.register({ id: `vendor:panel-${index}`, title: "Panel", rows: [] })).toBe(true);
		}
		capacityRegistry.handleEvent(
			registration("capacity-source", 1, { id: "activity", title: "Spoofed", rows: [] }),
		);
		capacityRegistry.handleEvent(
			registration("capacity-source", 1, { id: "capacity-source:panel", title: "Accepted", rows: [] }),
		);
		expect(capacityRegistry.get("capacity-source:panel")?.title).toBe("Accepted");
		expect(capacityRegistry.getAvailable()).toHaveLength(SIDEBAR_PANEL_MAX_PANELS);
		registry.dispose();
		capacityRegistry.dispose();
	});

	it("rejects malformed public events and preserves panel ownership across revisions", () => {
		const registry = disposeAfterTest(createSidebarPanelRegistry());
		for (const event of [
			undefined,
			null,
			{},
			{ version: 2, type: "register" },
			{ version: 1, type: "register", source: "vendor", revision: 1 },
			registration("vendor", 1, { id: "not-namespaced", title: "Bad", rows: [] }),
			registration("vendor", 1, { id: "vendor:queue", title: "Queue", rows: [null] }),
		])
			registry.handleEvent(event);
		expect(registry.getAvailable()).toEqual([]);

		registry.handleEvent(registration("vendor", 1, { id: "vendor:queue", title: "Queue", rows: ["one"] }));
		registry.handleEvent(registration("other", 1, { id: "vendor:queue", title: "Hijack", rows: ["bad"] }));
		registry.handleEvent(registration("vendor", 1, { id: "vendor:queue", title: "Stale", rows: ["stale"] }));
		expect(registry.get("vendor:queue")?.title).toBe("Queue");
		registry.handleEvent(registration("vendor", 2, { id: "vendor:queue", title: "Updated", rows: ["two"] }));
		expect(registry.get("vendor:queue")?.title).toBe("Updated");
		registry.handleEvent(removal("other", 2, "vendor:queue"));
		expect(registry.get("vendor:queue")?.title).toBe("Updated");
		registry.handleEvent(removal("vendor", 3, "vendor:queue"));
		expect(registry.get("vendor:queue")).toBeUndefined();
		registry.dispose();
	});

	it("rejects oversized raw titles and rows while preserving valid Unicode", () => {
		const registry = disposeAfterTest(createSidebarPanelRegistry());
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
		const registry = disposeAfterTest(createSidebarPanelRegistry());
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
		const registry = disposeAfterTest(createSidebarPanelRegistry());
		const longId = `vendor:${"x".repeat(SIDEBAR_PANEL_MAX_ID_CHARS)}` as `vendor:${string}`;
		const longSource = "s".repeat(SIDEBAR_PANEL_MAX_SOURCE_CHARS + 1);
		const safePanel = { id: "vendor:safe" as const, title: "Safe", rows: [] };

		expect(isSidebarPanelId(longId)).toBe(false);
		expect(registry.register({ ...safePanel, id: longId })).toBe(false);
		expect(registry.unregister(longId, "vendor")).toBe(false);
		expect(registry.register(safePanel, longSource)).toBe(false);
		expect(registry.unregister(safePanel.id, longSource)).toBe(false);
		registry.handleEvent(registration("vendor", 1, { ...safePanel, id: longId }));
		registry.handleEvent(registration(longSource, 1, safePanel));
		expect(registry.getAvailable()).toEqual([]);

		const emitted: unknown[] = [];
		const events = {
			on: () => () => undefined,
			emit: (_channel: string, data: unknown) => emitted.push(data),
		};
		const invalidIdPublisher = disposeAfterTest(
			registerSidebarPanel({ events }, { ...safePanel, id: longId }),
		);
		const invalidSourcePublisher = disposeAfterTest(
			registerSidebarPanel({ events }, safePanel, { source: longSource }),
		);
		expect(emitted).toEqual([]);
		invalidIdPublisher.update(safePanel);
		invalidSourcePublisher.update(safePanel);
		invalidIdPublisher.dispose();
		invalidSourcePublisher.dispose();
		expect(emitted).toEqual([]);
		registry.dispose();
	});

	it("caps new panels while allowing updates and unregisters to free capacity", () => {
		const registry = disposeAfterTest(createSidebarPanelRegistry());
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
		registry.handleEvent(registration("vendor", 1, panel("vendor:panel-0", "Updated at capacity")));
		expect(registry.get("vendor:panel-0")?.title).toBe("Updated at capacity");

		// Capacity-rejected registrations do not consume a source revision, so
		// retrying the same event after capacity is freed succeeds.
		registry.handleEvent(registration("overflow", 1, panel("vendor:overflow", "Overflow")));
		expect(registry.get("vendor:overflow")).toBeUndefined();
		registry.handleEvent(removal("vendor", 2, "vendor:panel-0"));
		expect(registry.get("vendor:panel-0")).toBeUndefined();
		registry.handleEvent(registration("overflow", 1, panel("vendor:overflow", "Retried after capacity")));
		expect(registry.get("vendor:overflow")?.title).toBe("Retried after capacity");
		registry.handleEvent(registration("overflow", 2, panel("vendor:overflow", "Accepted after unregister")));
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
		const capacityRegistry = disposeAfterTest(createSidebarPanelRegistry());
		for (let index = 0; index < SIDEBAR_PANEL_MAX_PANELS; index += 1) {
			expect(capacityRegistry.register(panel(`vendor:full-${index}`), "owner")).toBe(true);
		}
		for (let index = 0; index < SIDEBAR_PANEL_MAX_TRACKED_SOURCES * 2; index += 1) {
			capacityRegistry.handleEvent(registration(`capacity-${index}`, 1, panel(`capacity-${index}:panel`)));
		}
		capacityRegistry.unregister("vendor:full-0", "owner");
		capacityRegistry.handleEvent(
			registration("capacity-0", 1, panel("capacity-0:panel", "Accepted after retry")),
		);
		expect(capacityRegistry.get("capacity-0:panel")?.title).toBe("Accepted after retry");
		capacityRegistry.dispose();

		const ownerRegistry = disposeAfterTest(createSidebarPanelRegistry());
		expect(ownerRegistry.register(panel("vendor:owned"), "owner")).toBe(true);
		for (let index = 0; index < SIDEBAR_PANEL_MAX_TRACKED_SOURCES * 2; index += 1) {
			ownerRegistry.handleEvent(registration(`hijacker-${index}`, 1, panel("vendor:owned", "Hijacked")));
			ownerRegistry.handleEvent(removal(`missing-${index}`, 1, "vendor:missing"));
		}
		ownerRegistry.handleEvent(
			registration("missing-0", 1, panel("vendor:missing", "Accepted after missing removal")),
		);
		expect(ownerRegistry.get("vendor:missing")?.title).toBe("Accepted after missing removal");
		ownerRegistry.unregister("vendor:owned", "owner");
		ownerRegistry.handleEvent(
			registration("hijacker-0", 1, panel("vendor:owned", "Accepted after owner removal")),
		);
		expect(ownerRegistry.get("vendor:owned")?.title).toBe("Accepted after owner removal");
		ownerRegistry.dispose();
	});

	it("bounds tracked sources while preserving revisions for active sources", () => {
		const registry = disposeAfterTest(createSidebarPanelRegistry());
		const panel = (id: string, title = id) => ({
			id: id as `${string}:${string}`,
			title,
			rows: [],
		});
		for (let index = 0; index < SIDEBAR_PANEL_MAX_TRACKED_SOURCES; index += 1) {
			registry.handleEvent(registration(`tracked-${index}`, 1, panel(`tracked-${index}:panel`)));
		}
		expect(registry.getAvailable()).toHaveLength(SIDEBAR_PANEL_MAX_TRACKED_SOURCES);
		registry.handleEvent(removal("tracked-0", 2, "tracked-0:panel"));
		registry.handleEvent(registration("overflow-source", 1, panel("overflow-source:panel")));
		expect(registry.get("overflow-source:panel")).toBeUndefined();

		// A tracked source remains usable for updates and removal after the cap.
		registry.handleEvent(registration("tracked-1", 2, panel("tracked-1:panel", "Updated")));
		expect(registry.get("tracked-1:panel")?.title).toBe("Updated");
		registry.handleEvent(removal("tracked-1", 3, "tracked-1:panel"));
		expect(registry.get("tracked-1:panel")).toBeUndefined();
		registry.handleEvent(registration("tracked-1", 2, panel("tracked-1:panel", "Stale")));
		expect(registry.get("tracked-1:panel")).toBeUndefined();
		registry.dispose();
	});

	it("keeps publisher IDs stable and ignores updates after teardown", () => {
		const { events, emitted } = eventTransport();
		const publisher = disposeAfterTest(
			registerSidebarPanel({ events }, { id: "vendor:queue", title: "Queue", rows: ["one"] }),
		);
		const registry = disposeAfterTest(createSidebarPanelRegistry({ events }));
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
});

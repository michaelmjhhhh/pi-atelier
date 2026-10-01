import { describe, expect, it } from "vitest";

import {
	harness,
	replacementContext,
	start,
	todoBranchEntry,
	command,
	renderOverlayText,
	withPersistedUserConfig,
} from "./helpers/extension.js";

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

		const toolResultHandler = h.handler("tool_result");
		const result = await toolResultHandler({ toolName: "todo", details }, h.ctx);

		expect(result).toEqual({ content: [{ type: "text", text: summary }] });
	});

	it("preserves cached todos for error and malformed results", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			todoBranchEntry({ todos: [{ id: 1, text: "Initial task", done: false }], nextId: 2 }),
		]);
		await start(h);
		await command(h, "sidebar on");

		const toolResultHandler = h.handler("tool_result");
		const errorResult = await toolResultHandler(
			{
				toolName: "todo",
				isError: true,
				details: { todos: [{ id: 2, text: "Failed task", done: false }], nextId: 3 },
			},
			h.ctx,
		);
		expect(errorResult).toBeUndefined();

		const malformedResult = await toolResultHandler(
			{ toolName: "todo", isError: false, details: { todos: "not an array", nextId: 1 } },
			h.ctx,
		);
		expect(malformedResult).toBeUndefined();

		await command(h, "sidebar off");
		await command(h, "sidebar on");
		const sidebarText = renderOverlayText(h, h.overlays.length - 1, 44);
		expect(sidebarText).toContain("Initial task");
		expect(sidebarText).not.toContain("Failed task");
	});

	it("ignores non-todo tool results", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");

		const toolResultHandler = h.handler("tool_result");

		const event = { toolName: "read", details: {} };
		const result = await toolResultHandler(event, h.ctx);
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

		const sidebarText = renderOverlayText(h, 0, 44);
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
		const sidebarOverlay = h.overlays[0]!;
		expect(sidebarOverlay.component.render(44).join("\n")).toContain("First branch task");

		h.ctx.sessionManager.getBranch.mockReturnValue([
			todoBranchEntry({ tasks: [{ id: 2, subject: "Second branch task", status: "pending" }], nextId: 3 }),
		]);
		const sessionTreeHandler = h.handler("session_tree");
		const previousRenderCount = sidebarOverlay.requestRender.mock.calls.length;
		await sessionTreeHandler({ type: "session_tree", newLeafId: "second", oldLeafId: "first" }, h.ctx);
		expect(sidebarOverlay.requestRender.mock.calls.length).toBeGreaterThan(previousRenderCount);
		let sidebarText = sidebarOverlay.component.render(44).join("\n");
		expect(sidebarText).toContain("Second branch task");
		expect(sidebarText).not.toContain("First branch task");

		h.ctx.sessionManager.getBranch.mockReturnValue([]);
		await sessionTreeHandler({ type: "session_tree", newLeafId: null, oldLeafId: "second" }, h.ctx);
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

		const sidebarText = renderOverlayText(h, 0, 44);
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

		let sidebarText = renderOverlayText(h, 0, 44);
		expect(sidebarText).toContain("0/1");
		expect(sidebarText).toContain("Initial task");

		// Trigger new todo result
		const toolResultHandler = h.handler("tool_result");
		await toolResultHandler(
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

		sidebarText = renderOverlayText(h, 0, 44);
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

		const toolResultHandler = h.handler("tool_result");
		const result = await toolResultHandler(
			{
				toolName: "todo",
				details: { todos: [{ id: 2, text: "Hidden update", done: false }], nextId: 3 },
			},
			h.ctx,
		);
		expect(result).toBeUndefined();

		await command(h, "sidebar on");
		const sidebarText = renderOverlayText(h, h.overlays.length - 1, 44);
		expect(sidebarText).toContain("Hidden update");
		expect(sidebarText).not.toContain("Initial task");
	});

	it.each([
		["a valid empty list arrives", { todos: [], nextId: 1 }],
		[
			"all task statuses are filtered out",
			{ tasks: [{ id: 2, subject: "Deleted task", status: "deleted" }], nextId: 3 },
		],
	])("clears cached todos when %s", async (_label, details) => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			todoBranchEntry({ todos: [{ id: 1, text: "Stale task", done: false }], nextId: 2 }),
		]);
		await start(h);
		await command(h, "sidebar on");

		const toolResultHandler = h.handler("tool_result");
		const result = await toolResultHandler({ toolName: "todo", details }, h.ctx);
		expect(result).toBeUndefined();

		await command(h, "sidebar off");
		await command(h, "sidebar on");
		const sidebarText = renderOverlayText(h, h.overlays.length - 1, 44);
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
			const initialSidebar = renderOverlayText(h, 0, 44);
			expect(initialSidebar).not.toContain("AGENT");
			expect(initialSidebar).toContain("TODOS");
			expect(initialSidebar).toContain("1/2");
			expect(initialSidebar).toContain("Visible TODO");

			await start(h, replacementContext(h.ctx, "Reloaded session"));
			expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
			const reloadedSidebar = renderOverlayText(h, 1, 44);
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

			const sidebarText = renderOverlayText(h, 0, 44);
			expect(sidebarText).not.toContain("TODOS");

			const toolResultHandler = h.handler("tool_result");
			const result = await toolResultHandler(
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

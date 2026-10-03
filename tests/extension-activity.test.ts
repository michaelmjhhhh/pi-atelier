import { plainTheme } from "./helpers/render.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deferred, settleMicrotasks } from "./helpers/async.js";
import {
	harness,
	start,
	todoBranchEntry,
	command,
	renderOverlayText,
	queueWorkspacePulseInspection,
	execResult,
} from "./helpers/extension.js";

describe("extension activity", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("waits to inspect Workspace Pulse until the project is trusted", async () => {
		vi.useFakeTimers();
		const h = harness();

		await start(h);
		await h.dispatch("turn_start", { type: "turn_start", turnIndex: 0 });
		await h.dispatch("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "untrusted-pulse-tool",
			toolName: "write",
			result: { output: "" },
		});
		await h.dispatch("turn_end", { type: "turn_end" });
		await vi.advanceTimersByTimeAsync(1_000);

		expect(h.pi.exec).not.toHaveBeenCalled();

		h.ctx.isProjectTrusted.mockReturnValue(true);
		await h.dispatch("turn_end", { type: "turn_end" });

		expect(h.pi.exec).toHaveBeenCalledOnce();
	});

	it("stops an in-flight Workspace Pulse inspection when project trust is revoked", async () => {
		const discovery = deferred<ReturnType<typeof execResult>>();
		const h = harness();
		queueWorkspacePulseInspection(h, discovery.promise);
		await start(h);
		expect(h.pi.exec).toHaveBeenCalledOnce();

		h.ctx.isProjectTrusted.mockReturnValue(false);
		discovery.resolve(execResult("true\n/tmp/project\n"));
		await settleMicrotasks();

		expect(h.pi.exec).toHaveBeenCalledOnce();
	});

	it("sends only one native notification when a turn settles", async () => {
		const h = harness("tui", "darwin");
		await start(h);
		await h.dispatch("agent_start", { type: "agent_start" });
		await h.dispatch("agent_settled", { type: "agent_settled" });
		await h.dispatch("agent_settled", { type: "agent_settled" });

		expect(h.spawnNotificationProcess).toHaveBeenCalledTimes(1);
	});

	it("rearms settlement delivery from turn_start when agent_start was missed", async () => {
		const h = harness("tui", "darwin");
		await start(h);
		await h.dispatch("agent_start", { type: "agent_start" });
		await h.dispatch("agent_settled", { type: "agent_settled" });

		await h.dispatch("turn_start", { type: "turn_start", turnIndex: 1 });
		await h.dispatch("agent_settled", { type: "agent_settled" });

		expect(h.spawnNotificationProcess).toHaveBeenCalledTimes(2);
	});

	it("does not notify settlement when another extension has already started a run", async () => {
		const h = harness("tui", "darwin");
		await start(h);
		await h.dispatch("agent_start", { type: "agent_start" });
		h.ctx.isIdle.mockReturnValue(false);
		await h.dispatch("agent_settled", { type: "agent_settled" });

		expect(h.spawnNotificationProcess).not.toHaveBeenCalled();
	});

	it("sends one native notification for each actual ask-user blocked interval", async () => {
		const h = harness("tui", "darwin");
		await start(h);
		await h.dispatch("agent_start", { type: "agent_start" });

		h.pi.events.emit("rpiv:ask-user:blocked", { active: true });
		h.pi.events.emit("rpiv:ask-user:blocked", { active: true });
		h.pi.events.emit("rpiv:ask-user:blocked", { active: false });
		h.pi.events.emit("rpiv:ask-user:blocked", { active: true });

		expect(h.spawnNotificationProcess).toHaveBeenCalledTimes(2);
	});

	it("forwards run and turn events into sidebar activity without putting tool history in the footer", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");

		await h.dispatch("agent_start", { type: "agent_start" });
		await h.dispatch("turn_start", { type: "turn_start", turnIndex: 2, timestamp: 1_000 });
		await h.dispatch("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "bash",
			args: { command: "npm test -- tests/extension.test.ts" },
		});

		const sidebarText = renderOverlayText(h, 0, 44);
		expect(sidebarText).toContain("ACTIVITY");
		expect(sidebarText).toContain("Turn 3");
		expect(sidebarText).toContain("◐ bash");
		expect(sidebarText).toContain("bash");
		expect(sidebarText).toContain("npm test");
		expect(sidebarText).toContain("Working");
		expect(h.overlays[0]?.requestRender.mock.calls.length).toBeGreaterThan(0);

		const footer = h.setFooter.mock.calls[0]?.[0]({ requestRender: vi.fn() }, plainTheme, {
			getGitBranch: () => undefined,
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		});
		const footerText = footer.render(160).join("\n");
		expect(footerText).toContain("●");
		expect(footerText).not.toContain("bash");
		expect(footerText).not.toContain("npm test");
	});

	it("forwards provider timing and streamed throughput to both footer and sidebar", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const h = harness("tui", "linux", true);
		await start(h);
		await h.dispatch("agent_start", { type: "agent_start" });
		const opening = command(h, "display");
		await h.mounted(1);
		expect(h.overlays).toHaveLength(2);
		const workspace = h.overlays.at(-1)!.component;
		// Walk to the performance segment by name; its position in the list is not part of this test.
		for (let guard = 20; guard > 0; guard -= 1) {
			if (workspace.render(120).at(-2)!.includes("performance ·")) break;
			workspace.handleInput("\u001b[B");
		}
		workspace.handleInput(" ");

		const footerRequestRender = vi.fn();
		const footer = h.setFooter.mock.calls[0]?.[0]({ requestRender: footerRequestRender }, plainTheme, {
			getGitBranch: () => undefined,
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		});
		expect(footer.render(160).join("\n")).toContain("\uf017 —  \uf0e7 —");

		vi.setSystemTime(1_100);
		await h.dispatch("before_provider_request", { type: "before_provider_request", payload: {} });
		vi.setSystemTime(1_920);
		await h.dispatch("message_update", {
			type: "message_update",
			message: { role: "assistant", content: [{ type: "thinking", thinking: "token" }] },
			assistantMessageEvent: { type: "thinking_delta", delta: "token" },
		});

		expect(footerRequestRender).toHaveBeenCalled();
		expect(footer.render(160).join("\n")).toContain("\uf017 820ms  \uf0e7 —");
		expect(renderOverlayText(h)).toMatch(/First token\s+820ms/);

		vi.setSystemTime(2_920);
		await h.dispatch("message_update", {
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "x".repeat(80) }] },
			assistantMessageEvent: { type: "text_delta", delta: "more output" },
		});
		expect(footer.render(160).join("\n")).toContain("\uf017 820ms  \uf0e7 ~20.0/s");
		expect(renderOverlayText(h)).toMatch(/Output speed\s+~20\.0 tok\/s/);

		vi.setSystemTime(4_420);
		await h.dispatch("message_end", {
			type: "message_end",
			message: { role: "assistant", usage: { output: 120 } },
		});
		expect(footer.render(160).join("\n")).toContain("\uf017 820ms  \uf0e7 48.0/s");
		expect(renderOverlayText(h)).toMatch(/Output speed\s+48\.0 tok\/s/);
		workspace.handleInput("\u001b");
		await opening;
	});

	it("coalesces a Turn-start Workspace Pulse refresh for 250ms", async () => {
		vi.useFakeTimers();
		const h = harness();
		h.ctx.isProjectTrusted.mockReturnValue(true);
		await start(h);
		const inspectionsAfterStart = h.pi.exec.mock.calls.length;

		await h.dispatch("turn_start", { type: "turn_start", turnIndex: 0 });
		await vi.advanceTimersByTimeAsync(249);
		expect(h.pi.exec).toHaveBeenCalledTimes(inspectionsAfterStart);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.pi.exec).toHaveBeenCalledTimes(inspectionsAfterStart + 1);
	});

	it("flushes a fresh Workspace Pulse at Turn end without leaving a scheduled duplicate", async () => {
		vi.useFakeTimers();
		const h = harness();
		h.ctx.isProjectTrusted.mockReturnValue(true);
		await start(h);
		const inspectionsAfterStart = h.pi.exec.mock.calls.length;

		await h.dispatch("turn_start", { type: "turn_start", turnIndex: 0 });
		await h.dispatch("turn_end", { type: "turn_end" });
		expect(h.pi.exec).toHaveBeenCalledTimes(inspectionsAfterStart + 1);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(h.pi.exec).toHaveBeenCalledTimes(inspectionsAfterStart + 1);
	});

	it("coalesces rapid tool completions into one Workspace Pulse refresh", async () => {
		vi.useFakeTimers();
		const h = harness();
		h.ctx.isProjectTrusted.mockReturnValue(true);
		await start(h);
		const inspectionsAfterStart = h.pi.exec.mock.calls.length;

		for (const toolCallId of ["one", "two", "three"]) {
			await h.dispatch("tool_execution_end", {
				type: "tool_execution_end",
				toolCallId,
				toolName: "write",
				result: { content: [] },
				isError: false,
			});
		}

		await vi.advanceTimersByTimeAsync(249);
		expect(h.pi.exec).toHaveBeenCalledTimes(inspectionsAfterStart);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.pi.exec).toHaveBeenCalledTimes(inspectionsAfterStart + 1);
	});

	it("updates recent tool results and settles the sidebar without continuing animation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const h = harness();
		await start(h);
		await command(h, "sidebar on");

		await h.dispatch("agent_start", { type: "agent_start" });
		await h.dispatch("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "/tmp/project/src/run-activity.ts" },
		});
		vi.setSystemTime(2_500);
		await h.dispatch("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "read-1",
			toolName: "read",
			result: { content: [] },
			isError: false,
		});

		const withResult = renderOverlayText(h, 0, 44);
		expect(withResult).toMatch(/Run\s+(<1s|\d+s)/);
		expect(withResult).not.toContain("src/run-activity.ts");
		expect(withResult).not.toContain("✓ read");
		expect(withResult).not.toMatch(/Tools\s+1 done/);

		const rendersBeforeTick = h.overlays[0]?.requestRender.mock.calls.length ?? 0;
		vi.advanceTimersByTime(1_000);
		expect(h.overlays[0]?.requestRender.mock.calls.length).toBeGreaterThan(rendersBeforeTick);

		vi.setSystemTime(4_000);
		await h.dispatch("agent_settled", { type: "agent_settled" });
		const settledRenderCount = h.overlays[0]?.requestRender.mock.calls.length ?? 0;
		const settledText = renderOverlayText(h, 0, 44);
		expect(settledText).toMatch(/Last run\s+3s/);
		expect(settledText).not.toContain("settled 3s");
		expect(settledText).toContain("Ready");
		expect(settledText).toContain("read");
		expect(settledText).toContain("src/run-activity.ts");
		expect(settledText).toMatch(/✓ read\s+src\/run-activity\.ts\s+1s/);

		vi.advanceTimersByTime(3_000);
		expect(h.overlays[0]?.requestRender.mock.calls.length).toBe(settledRenderCount);
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
		await h.dispatch("agent_start", { type: "agent_start" });
		await h.dispatch("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1_000 });
		await h.dispatch("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "older",
			toolName: "read",
			args: { path: "/tmp/project/older.ts" },
		});
		await h.dispatch("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "newer",
			toolName: "write",
			args: { path: "/tmp/project/newer.ts" },
		});

		const live = renderOverlayText(h);
		expect(live).toMatch(/Turn 2\s+(<1s|\d+s)/);
		expect(live).toContain("newer.ts");
		expect(live).toContain("+1");
		expect(live).not.toContain("older.ts");
		expect(live).toContain("Current live TODO");
		expect(live).not.toContain("Done live TODO");
		expect(live).not.toContain("Queued live TODO");
	});

	it("accepts fresh Pi event contexts for the active session", async () => {
		const h = harness();
		await start(h);
		await command(h, "sidebar on");
		const eventCtx = { ...h.ctx };

		await h.dispatch("agent_start", { type: "agent_start" }, eventCtx);
		await h.dispatch("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1_000 }, eventCtx);

		const text = renderOverlayText(h, 0, 44);
		expect(text).toContain("Working");
		expect(text).toContain("ACTIVITY");
		expect(text).toContain("Turn 1");
	});
});

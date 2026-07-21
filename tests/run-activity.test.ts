import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	EMPTY_RUN_ACTIVITY,
	createRunActivityTracker,
	formatDuration,
	summarizeTool,
} from "../src/run-activity.js";

describe("run activity tracker transitions", () => {
	it("tracks run, turn, and tool start with deterministic timestamps", () => {
		const onChange = vi.fn();
		const tracker = createRunActivityTracker({ cwd: "/repo", onChange });
		tracker.startRun(1_000);
		tracker.startTurn(2);
		tracker.startTool(
			{
				type: "tool_execution_start",
				toolCallId: "read-1",
				toolName: "read",
				args: { path: "/repo/src/state.ts" },
			},
			2_000,
		);

		expect(tracker.getSnapshot()).toMatchObject({
			phase: "running",
			turnNumber: 3,
			startedAt: 1_000,
			activeTools: [{ id: "read-1", name: "read", summary: "src/state.ts", startedAt: 2_000 }],
		});
		expect(onChange).toHaveBeenCalledTimes(3);
	});

	it("preserves parallel active tool insertion order", () => {
		const tracker = createRunActivityTracker({ cwd: "/repo" });
		tracker.startRun(0);
		tracker.startTool(
			{ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "npm test" } },
			100,
		);
		tracker.startTool(
			{ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "/repo/a.ts" } },
			200,
		);

		expect(tracker.getSnapshot().activeTools.map((tool) => tool.id)).toEqual(["bash-1", "read-1"]);
	});

	it("records done and failed completions with clamped durations", () => {
		const onChange = vi.fn();
		const tracker = createRunActivityTracker({ cwd: "/repo", onChange });
		tracker.startRun(0);
		tracker.startTool(
			{ type: "tool_execution_start", toolCallId: "ok", toolName: "read", args: { path: "/repo/a.ts" } },
			1_000,
		);
		tracker.startTool(
			{ type: "tool_execution_start", toolCallId: "bad", toolName: "bash", args: { command: "npm test" } },
			4_000,
		);

		tracker.finishTool(
			{ type: "tool_execution_end", toolCallId: "ok", toolName: "read", result: "ignored", isError: false },
			2_500,
		);
		tracker.finishTool(
			{ type: "tool_execution_end", toolCallId: "bad", toolName: "bash", result: "secret", isError: true },
			3_000,
		);

		const snapshot = tracker.getSnapshot();
		expect(snapshot.activeTools).toEqual([]);
		expect(snapshot.completedCount).toBe(1);
		expect(snapshot.failedCount).toBe(1);
		expect(snapshot.recentTools).toMatchObject([
			{ id: "bad", status: "failed", durationMs: 0 },
			{ id: "ok", status: "done", durationMs: 1_500 },
		]);
		expect(JSON.stringify(snapshot)).not.toContain("secret");
		expect(onChange).toHaveBeenCalledTimes(5);
	});

	it("keeps newest-first recent history capped at three entries", () => {
		const tracker = createRunActivityTracker({ cwd: "/repo" });
		tracker.startRun(0);
		for (let index = 1; index <= 4; index += 1) {
			tracker.startTool(
				{
					type: "tool_execution_start",
					toolCallId: `tool-${index}`,
					toolName: "read",
					args: { path: `/repo/${index}.ts` },
				},
				index * 1_000,
			);
			tracker.finishTool(
				{
					type: "tool_execution_end",
					toolCallId: `tool-${index}`,
					toolName: "read",
					result: {},
					isError: false,
				},
				index * 1_000 + 100,
			);
		}

		expect(tracker.getSnapshot().recentTools.map((tool) => tool.id)).toEqual(["tool-4", "tool-3", "tool-2"]);
	});

	it("ignores unknown completion IDs without notifying", () => {
		const onChange = vi.fn();
		const tracker = createRunActivityTracker({ cwd: "/repo", onChange });
		tracker.startRun(0);
		onChange.mockClear();

		tracker.finishTool(
			{
				type: "tool_execution_end",
				toolCallId: "missing",
				toolName: "read",
				result: { output: "ignored" },
				isError: false,
			},
			1_000,
		);

		expect(tracker.getSnapshot()).toMatchObject({
			activeTools: [],
			recentTools: [],
			completedCount: 0,
			failedCount: 0,
		});
		expect(onChange).not.toHaveBeenCalled();
	});

	it("normalizes non-finite and negative transition timestamps", () => {
		const tracker = createRunActivityTracker({ cwd: "/repo" });
		tracker.startRun(Number.NaN);
		tracker.startTool(
			{ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "/repo/a.ts" } },
			-1_000,
		);
		tracker.finishTool(
			{
				type: "tool_execution_end",
				toolCallId: "read-1",
				toolName: "read",
				result: {},
				isError: false,
			},
			Number.POSITIVE_INFINITY,
		);

		expect(tracker.getSnapshot()).toMatchObject({
			startedAt: 0,
			recentTools: [{ startedAt: 0, durationMs: 0 }],
		});
	});

	it("settles active tools as failed and records run duration", () => {
		const onChange = vi.fn();
		const tracker = createRunActivityTracker({ cwd: "/repo", onChange });
		tracker.startRun(1_000);
		tracker.startTool(
			{ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "/repo/a.ts" } },
			2_000,
		);
		onChange.mockClear();

		tracker.settle(5_000);

		expect(tracker.getSnapshot()).toMatchObject({
			phase: "settled",
			durationMs: 4_000,
			activeTools: [],
			failedCount: 1,
			recentTools: [{ id: "read-1", status: "failed", durationMs: 3_000 }],
		});
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("resets to an idle empty snapshot", () => {
		const tracker = createRunActivityTracker({ cwd: "/repo" });
		tracker.startRun(1_000);
		tracker.startTurn(0);
		tracker.startTool(
			{ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "/repo/a.ts" } },
			2_000,
		);
		tracker.reset();

		expect(tracker.getSnapshot()).toEqual(EMPTY_RUN_ACTIVITY);
		expect(tracker.isRunning()).toBe(false);
	});

	it("startRun resets prior run state", () => {
		const tracker = createRunActivityTracker({ cwd: "/repo" });
		tracker.startRun(1_000);
		tracker.startTool(
			{ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "/repo/a.ts" } },
			2_000,
		);
		tracker.finishTool(
			{ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: {}, isError: false },
			3_000,
		);

		tracker.startRun(10_000);

		const snapshot = tracker.getSnapshot();
		expect(snapshot).toMatchObject({
			phase: "running",
			startedAt: 10_000,
			activeTools: [],
			recentTools: [],
			completedCount: 0,
			failedCount: 0,
		});
		expect(snapshot).not.toHaveProperty("turnNumber");
	});

	it("returns frozen snapshots with isolated arrays and cloned tool records", () => {
		const tracker = createRunActivityTracker({ cwd: "/repo" });
		tracker.startRun(0);
		tracker.startTool(
			{ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "/repo/a.ts" } },
			1_000,
		);

		const first = tracker.getSnapshot();
		const second = tracker.getSnapshot();
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.activeTools)).toBe(true);
		expect(Object.isFrozen(first.activeTools[0])).toBe(true);
		expect(first.activeTools).not.toBe(second.activeTools);
		expect(first.activeTools[0]).not.toBe(second.activeTools[0]);
		expect(() => (first.activeTools as unknown as { pop(): unknown }).pop()).toThrow();
		expect(tracker.getSnapshot().activeTools).toHaveLength(1);
	});
});

describe("formatDuration", () => {
	it.each([
		[0, "<1s"],
		[999, "<1s"],
		[12_400, "12s"],
		[68_000, "1m 08s"],
		[Number.NaN, "<1s"],
		[Number.POSITIVE_INFINITY, "<1s"],
		[-5_000, "<1s"],
	] as const)("formats %s as %s", (durationMs, expected) => {
		expect(formatDuration(durationMs)).toBe(expected);
	});
});

describe("summarizeTool", () => {
	it("summarizes only approved known-tool fields", () => {
		expect(summarizeTool("bash", { command: "npm test\nrm -rf nope" }, "/repo")).toBe("npm test rm -rf nope");
		expect(summarizeTool("read", { path: "/repo/src/state.ts" }, "/repo")).toBe("src/state.ts");
		expect(summarizeTool("edit", { path: "/repo/src/state.ts", oldText: "secret" }, "/repo")).toBe(
			"src/state.ts",
		);
		expect(summarizeTool("write", { path: "/repo/src/state.ts", content: "secret" }, "/repo")).toBe(
			"src/state.ts",
		);
		expect(summarizeTool("custom", { secret: "must-not-render" }, "/repo")).toBe("");
		expect(summarizeTool("custom", "must-not-render", "/repo")).toBe("");
	});

	it("strips ANSI/control characters and collapses whitespace", () => {
		expect(summarizeTool("bash", { command: "npm \u001b[31mtest\u001b[0m\u0007\n\t-- --run" }, "/repo")).toBe(
			"npm test -- --run",
		);
	});

	it("shortens project-relative and home-relative paths", () => {
		const priorHome = process.env.HOME;
		process.env.HOME = "/Users/alice";
		try {
			expect(summarizeTool("read", { path: "/repo/src/state.ts" }, "/repo")).toBe("src/state.ts");
			expect(summarizeTool("read", { path: "/Users/alice/.pi/config.json" }, "/repo")).toBe(
				"~/.pi/config.json",
			);
		} finally {
			if (priorHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = priorHome;
			}
		}
	});

	it("summarizes grep, find, and ls from allowlisted fields", () => {
		expect(summarizeTool("grep", { pattern: "TODO", path: "/repo/src" }, "/repo")).toBe("TODO in src");
		expect(summarizeTool("find", { pattern: "*.ts", path: "/repo/src" }, "/repo")).toBe("*.ts in src");
		expect(summarizeTool("ls", { path: "/repo/src" }, "/repo")).toBe("src");
	});

	it("returns an empty summary for non-object or missing approved args", () => {
		expect(summarizeTool("read", null, "/repo")).toBe("");
		expect(summarizeTool("bash", { args: ["secret"] }, "/repo")).toBe("");
	});

	it("truncates summaries to 26 columns", () => {
		const summary = summarizeTool("bash", { command: "abcdefghijklmnopqrstuvwxyz0123456789" }, "/repo");

		expect(summary).toBe("abcdefghijklmnopqrstuvwxy…");
		expect(visibleWidth(summary)).toBe(26);
	});

	it("truncates repeated emoji, ZWJ emoji, and wide Unicode by terminal columns", () => {
		const emojiSummary = summarizeTool("bash", { command: "😀".repeat(20) }, "/repo");
		const zwjSummary = summarizeTool("bash", { command: "👩‍💻".repeat(20) }, "/repo");
		const wideSummary = summarizeTool("bash", { command: "界".repeat(20) }, "/repo");

		expect(emojiSummary).toBe(`${"😀".repeat(12)}…`);
		expect(zwjSummary).toBe(`${"👩‍💻".repeat(12)}…`);
		expect(wideSummary).toBe(`${"界".repeat(12)}…`);
		expect(visibleWidth(emojiSummary)).toBeLessThanOrEqual(26);
		expect(visibleWidth(zwjSummary)).toBeLessThanOrEqual(26);
		expect(visibleWidth(wideSummary)).toBeLessThanOrEqual(26);
	});

	it("strips ANSI-wrapped long strings before storing truncated summaries", () => {
		const summary = summarizeTool("bash", { command: `\u001b[31m${"a".repeat(40)}\u001b[0m` }, "/repo");

		expect(summary).toBe(`${"a".repeat(25)}…`);
		expect(summary).not.toContain("\u001b");
		expect(visibleWidth(summary)).toBe(26);
	});

	it("normalizes paths before deciding whether they are project relative", () => {
		expect(summarizeTool("read", { path: "/repo/../secret.txt" }, "/repo")).toBe("/secret.txt");
		expect(summarizeTool("read", { path: "/repo/src/../package.json" }, "/repo/packages/..")).toBe(
			"package.json",
		);
		expect(summarizeTool("read", { path: "/repo-other/secret.txt" }, "/repo")).toBe("/repo-other/secret.txt");
	});
});

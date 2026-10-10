import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isSubagentUsageEventForSession,
	readSubagentUsage,
	SUBAGENT_METADATA_ENTRY,
} from "../src/subagent-usage.js";
import { openSubagentUsage } from "../src/subagent-usage-view.js";
import { fakeTui, overlayHost } from "./helpers/overlay-host.js";

let cwd: string;
let dir: string;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "atelier-usage-"));
	dir = join(cwd, "subagent-artifacts");
	await mkdir(dir);
});
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});
const usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 4, cost: 0.125, turns: 1 };
const tool = (details: unknown) => ({
	type: "message",
	message: { role: "toolResult", toolName: "subagent", details },
});
async function metadata(runId: string, index = 0, extra: Record<string, unknown> = {}) {
	const path = join(dir, `${runId}_review_${index}_meta.json`);
	await writeFile(
		path,
		JSON.stringify({ runId, agent: "review", model: "provider/model", usage, timestamp: 1, ...extra }),
	);
	return path;
}
const read = (entries: unknown[]) =>
	readSubagentUsage({ cwd, sessionFile: join(cwd, "session.jsonl"), entries });
const totalCost = (snapshot: { runs: readonly { cost: number }[] }) =>
	snapshot.runs.reduce((total, run) => total + run.cost, 0);

describe("subagent metadata accounting", () => {
	it("counts separate executions of the same agent once, excluding unrelated sessions and mirrored tool usage", async () => {
		const path = await metadata("run-a");
		await metadata("run-a", 1, { usage: { ...usage, input: 200, output: 40, cost: 0.25 } });
		await metadata("run-b");
		await metadata("unrelated");
		const details = { runId: "run-a", results: [{ artifactPaths: { metadataPath: path }, usage }] };
		const result = await read([tool(details), tool(details), tool({ runId: "run-b", results: [] })]);
		expect(result.runs).toHaveLength(3);
		expect(totalCost(result)).toBe(0.5);
		expect(result.runs.every((run) => run.priced)).toBe(true);
		expect(result.unavailable).toBe(0);
	});

	it("resolves a workflow's child metadata through its session-owned status instead of the root ID", async () => {
		await metadata("child-a");
		await metadata("child-b");
		const asyncDir = join(cwd, "async", "workflow-root");
		await mkdir(asyncDir, { recursive: true });
		await writeFile(
			join(asyncDir, "status.json"),
			JSON.stringify({
				runId: "workflow-root",
				mode: "workflow",
				state: "complete",
				sessionId: join(cwd, "session.jsonl"),
				steps: [
					{ runId: "child-a", status: "completed" },
					{ runId: "child-b", status: "completed" },
				],
			}),
		);
		const result = await read([tool({ mode: "workflow", runId: "workflow-root", asyncDir, results: [] })]);
		expect(result.runs).toHaveLength(2);
		expect(totalCost(result)).toBe(0.25);
		expect(result.unavailable).toBe(0);
	});

	it("accepts the producer's file-path owner and ownerless hints only for known runs", () => {
		const session = { sessionFile: join(cwd, "session.jsonl"), sessionId: "session-uuid" };
		const entries = [tool({ runId: "workflow-root" })];
		expect(
			isSubagentUsageEventForSession(
				{ runId: "workflow-root", sessionId: session.sessionFile },
				entries,
				session,
			),
		).toBe(true);
		expect(
			isSubagentUsageEventForSession({ runId: "workflow-root", sessionId: "session-uuid" }, entries, session),
		).toBe(true);
		expect(
			isSubagentUsageEventForSession({ runId: "workflow-root", childRunId: "child-a" }, entries, session),
		).toBe(true);
		expect(isSubagentUsageEventForSession({ runId: "unrelated" }, entries, session)).toBe(false);
		expect(
			isSubagentUsageEventForSession(
				{ runId: "workflow-root", sessionId: join(cwd, "other.jsonl") },
				entries,
				session,
			),
		).toBe(false);
	});

	it("keeps unfinished workflow children pending and rejects another session's lifecycle file", async () => {
		const asyncDir = join(cwd, "async", "workflow-root");
		await mkdir(asyncDir, { recursive: true });
		const status = {
			runId: "workflow-root",
			mode: "workflow",
			state: "running",
			sessionId: join(cwd, "session.jsonl"),
			steps: [
				{ runId: "child-a", status: "completed" },
				{ runId: "child-b", status: "running" },
			],
		};
		await metadata("child-a");
		await writeFile(join(asyncDir, "status.json"), JSON.stringify(status));
		const entries = [tool({ runId: "workflow-root", asyncDir, results: [] })];
		const running = await read(entries);
		expect(running.runs).toHaveLength(1);
		expect(running.pending).toBe(2);
		expect(running.unavailable).toBe(0);
		await writeFile(
			join(asyncDir, "status.json"),
			JSON.stringify({ ...status, sessionId: join(cwd, "other-session.jsonl") }),
		);
		expect((await read(entries)).runs).toEqual([]);
	});

	it("recovers earlier workflow continuation executions from the matching receipt", async () => {
		await metadata("child-previous");
		await metadata("child-latest");
		const asyncDir = join(cwd, "async", "workflow-root");
		await mkdir(asyncDir, { recursive: true });
		await writeFile(
			join(asyncDir, "status.json"),
			JSON.stringify({
				runId: "workflow-root",
				mode: "workflow",
				state: "complete",
				sessionId: join(cwd, "session.jsonl"),
				steps: [{ runId: "child-latest", status: "completed" }],
			}),
		);
		await writeFile(
			join(asyncDir, "workflow-receipt.json"),
			JSON.stringify({
				workflowRunId: "workflow-root",
				entries: {
					review: {
						latestRunId: "child-latest",
						continuation: { runIds: ["child-previous", "child-latest"] },
					},
				},
			}),
		);
		for (const runId of ["child-previous", "child-latest"]) {
			const childDir = join(cwd, "async", runId);
			await mkdir(childDir);
			await writeFile(
				join(childDir, "status.json"),
				JSON.stringify({
					runId,
					mode: "single",
					state: "complete",
					sessionId: join(cwd, "session.jsonl"),
					startedAt: 100,
					steps: [{ agent: "review", status: "completed" }],
				}),
			);
			await writeFile(
				join(childDir, "events.jsonl"),
				JSON.stringify({
					type: "message_end",
					subagentSource: "child",
					subagentRunId: runId,
					subagentStepIndex: 0,
					subagentAgent: "review",
					observedAt: 200,
					message: { role: "assistant", timestamp: 200, usage: { cost: { total: 0.125 } } },
				}) + "\n",
			);
		}
		const result = await read([tool({ runId: "workflow-root", asyncDir, results: [] })]);
		expect(result.runs).toHaveLength(2);
		expect(result.costHistory.map((run) => run.runId).sort()).toEqual(["child-latest", "child-previous"]);
		expect(totalCost(result)).toBe(0.25);
		expect(result.unavailable).toBe(0);
	});

	it("recovers async references after reload and replaces changed metadata instead of adding snapshots", async () => {
		const path = await metadata("async-a");
		const entries = [
			{ type: "custom", customType: SUBAGENT_METADATA_ENTRY, data: { runIds: ["async-a"], paths: [path] } },
		];
		expect(totalCost(await read(entries))).toBe(0.125);
		await metadata("async-a", 0, { usage: { ...usage, output: 10, cost: 0.1 }, timestamp: 2 });
		const result = await read(entries);
		expect(result.runs).toHaveLength(1);
		expect(totalCost(result)).toBe(0.1);
	});

	it("uses project and explicit custom artifact locations, validates ownership, and deduplicates aliases", async () => {
		const path = await metadata("owned");
		const alias = join(cwd, "owned_review_0_meta.json");
		await symlink(path, alias);
		const other = await metadata("someone-else");
		const project = join(cwd, ".pi", "subagents", "artifacts");
		await mkdir(project, { recursive: true });
		await writeFile(
			join(project, "owned_review_1_meta.json"),
			JSON.stringify({ runId: "owned", agent: "review", usage }),
		);
		const result = await read([
			tool({
				runId: "owned",
				results: [path, alias, other].map((metadataPath) => ({ artifactPaths: { metadataPath } })),
			}),
		]);
		expect(result.runs).toHaveLength(2);
		expect(totalCost(result)).toBe(0.25);
	});

	it("does not count slash initial/final and repeated wait observations as additional executions", async () => {
		const path = await metadata("slash-a");
		const details = { runId: "slash-a", results: [{ artifactPaths: { metadataPath: path } }] };
		const slash = {
			type: "custom_message",
			customType: "subagent-slash-result",
			details: { requestId: "request", result: { details } },
		};
		const wait = {
			type: "message",
			message: { role: "toolResult", toolName: "bg_wait", details: { completions: [details] } },
		};
		expect(totalCost(await read([slash, slash, wait, wait]))).toBe(0.125);
	});

	it("keeps failed runs and distinguishes a missing cost from a reported zero", async () => {
		await metadata("failed", 0, {
			exitCode: 1,
			model: undefined,
			usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 4 },
		});
		await metadata("free", 0, { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } });
		const result = await read([tool({ runId: "failed" }), tool({ runId: "free" })]);
		expect(result.runs).toHaveLength(2);
		expect(result.runs.find((run) => run.runId === "failed")).toMatchObject({ cost: 0, priced: false });
		expect(result.runs.find((run) => run.runId === "free")).toMatchObject({ cost: 0, priced: true });
	});

	it("reports missing, corrupt and incomplete artifacts without guessing numbers", async () => {
		const path = await metadata("bad");
		await writeFile(path, "{incomplete");
		await metadata("negative", 0, { usage: { ...usage, input: -1 } });
		const result = await read([
			tool({ runId: "missing" }),
			tool({ runId: "bad" }),
			tool({ runId: "negative" }),
		]);
		expect(result.runs).toEqual([]);
		// Each unreadable file and each unresolved run reference is counted.
		expect(result.unavailable).toBe(5);
	});

	it("does not discover usage from arbitrary tools, notifications or unreferenced files", async () => {
		await metadata("private-run");
		const result = await read([
			{
				type: "message",
				message: { role: "toolResult", toolName: "bash", details: { runId: "private-run" } },
			},
			{ type: "custom_message", customType: "subagent-notify", content: "private-run cost $123" },
		]);
		expect(result.runs).toEqual([]);
		expect(result.unavailable).toBe(0);
	});

	it("rejects oversized metadata and honors cancellation", async () => {
		const path = await metadata("large");
		await writeFile(path, " ".repeat(2 * 1024 * 1024 + 1));
		expect((await read([tool({ runId: "large" })])).unavailable).toBeGreaterThan(0);
		const abort = new AbortController();
		abort.abort();
		expect(
			(await readSubagentUsage({ cwd, entries: [tool({ runId: "large" })], signal: abort.signal })).runs,
		).toEqual([]);
	});
});

describe("subagent usage overlay", () => {
	// Regression guard for the foreign-TUI input-starvation audit: every overlay
	// this extension exposes must own its input. The sidebar was the one component
	// without handleInput (docs/upstream-issue-overlay-input-draft.md); these
	// assertions keep the usage view from silently becoming the next one.
	it("mounts an overlay whose component owns input: Esc through its handleInput closes it", async () => {
		const requestRender = vi.fn();
		const tui = fakeTui(requestRender);
		const { custom, overlays } = overlayHost(() => tui);
		const snapshot = {
			runs: [],
			unavailable: 0,
			pending: 0,
			limited: false,
			costHistory: [],
			historyUnavailable: 0,
		};
		const lifetime = {
			isActive: () => true,
			register: () => () => undefined,
		};
		const opening = openSubagentUsage({ ui: { custom } } as never, snapshot as never, 4, lifetime as never);
		await Promise.resolve();
		expect(overlays).toHaveLength(1);
		const overlay = overlays[0]!;
		expect(typeof overlay.component.handleInput).toBe("function");
		// Escape settles the overlay promise; a component without handleInput would hang.
		overlay.component.handleInput("");
		await opening;
		expect(overlay.done).toHaveBeenCalledOnce();
	});
});

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSubagentCostHistory } from "../src/subagent-cost-history.js";
import { readSubagentUsage } from "../src/subagent-usage.js";

let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "atelier-cost-"));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});
const event = (at: number, cost: unknown, extra: object = {}) => ({
	type: "message_end",
	subagentSource: "child",
	subagentRunId: "child",
	subagentStepIndex: 0,
	subagentAgent: "scout",
	observedAt: at,
	message: {
		role: "assistant",
		timestamp: at,
		usage: { cost: { total: cost } },
		content: [{ text: "private content must not be retained" }],
	},
	...extra,
});
const source = () => ({ runId: "child", directory, startedAt: 100, steps: [{ agent: "scout" }] });
const writeEvents = async (events: unknown[], suffix = "") =>
	writeFile(
		join(directory, "events.jsonl"),
		events.map((event) => JSON.stringify(event)).join("\n") + "\n" + suffix,
	);

describe("native child cost history accounting", () => {
	it("projects only cost and time, separates same-named steps and replays without duplication", async () => {
		const first = event(200, 0.1);
		await writeEvents([
			first,
			first,
			event(300, 0.2),
			event(250, 0.4, { subagentStepIndex: 1 }),
			event(350, 99, { subagentRunId: "unrelated" }),
		]);
		const input = { ...source(), steps: [{ agent: "scout" }, { agent: "scout" }] };
		const result = await readSubagentCostHistory([input, input]);
		expect(result.series).toHaveLength(2);
		expect(result.series[0]?.points).toEqual([
			{ at: 100, cost: 0 },
			{ at: 200, cost: 0.1 },
			{ at: 300, cost: 0.1 + 0.2 },
		]);
		expect(result.series[1]?.points.at(-1)?.cost).toBe(0.4);
		expect(JSON.stringify(result)).not.toContain("private content");
		expect(await readSubagentCostHistory([input])).toEqual(result);
	});
	it("marks unknown costs partial and recovers an incomplete append on the next read", async () => {
		const tail = JSON.stringify(event(400, 0.3));
		await writeEvents([event(200, 0.1), event(300, undefined)], tail);
		const first = await readSubagentCostHistory([source()]);
		expect(first.series[0]?.partial).toBe(true);
		expect(first.series[0]?.points.at(-1)?.cost).toBe(0.1);
		await writeEvents([event(200, 0.1), event(300, undefined), event(400, 0.3)]);
		expect((await readSubagentCostHistory([source()])).series[0]?.points.at(-1)?.cost).toBe(0.4);
	});
	it("bounds reads and honors cancellation", async () => {
		await writeFile(join(directory, "events.jsonl"), "x".repeat(2 * 1024 * 1024 + 1));
		expect(await readSubagentCostHistory([source()])).toEqual({ series: [], unavailable: 1 });
		const controller = new AbortController();
		controller.abort();
		expect(await readSubagentCostHistory([source()], controller.signal)).toEqual({
			series: [],
			unavailable: 0,
		});
	});
	it("requires the owning session and reconciles completed histories against saved metadata", async () => {
		const sessionFile = join(directory, "parent.jsonl");
		const asyncDir = join(directory, "child");
		await mkdir(asyncDir);
		const artifactDir = join(directory, "subagent-artifacts");
		await mkdir(artifactDir);
		const status = {
			runId: "child",
			mode: "single",
			state: "complete",
			sessionId: sessionFile,
			startedAt: 100,
			steps: [{ agent: "scout", status: "completed" }],
		};
		await writeFile(join(asyncDir, "status.json"), JSON.stringify(status));
		await writeFile(join(asyncDir, "events.jsonl"), JSON.stringify(event(200, 0.1)) + "\n");
		const meta = join(artifactDir, "child_scout_meta.json");
		const metadata = {
			runId: "child",
			agent: "scout",
			timestamp: 200,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
		};
		await writeFile(meta, JSON.stringify(metadata));
		const options = {
			entries: [
				{
					type: "message",
					message: { role: "toolResult", toolName: "subagent", details: { runId: "child", asyncDir } },
				},
			],
			cwd: directory,
			sessionFile,
		};
		const result = await readSubagentUsage(options);
		expect(result.costHistory).toHaveLength(1);
		expect(result.totals.cost).toBe(0.1);
		await writeFile(meta, JSON.stringify({ ...metadata, usage: { ...metadata.usage, cost: 0.2 } }));
		const corrected = await readSubagentUsage(options);
		expect(corrected.costHistory).toEqual([]);
		expect(corrected.historyUnavailable).toBe(1);
		expect(corrected.totals.cost).toBe(0.2);
		await writeFile(join(asyncDir, "status.json"), JSON.stringify({ ...status, sessionId: "someone-else" }));
		expect((await readSubagentUsage(options)).costHistory).toEqual([]);
	});
});

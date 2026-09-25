import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

export interface SubagentCostPoint {
	at: number;
	cost: number;
}
export interface SubagentCostSeries {
	id: string;
	runId: string;
	stepIndex: number;
	agent: string;
	startedAt: number;
	points: SubagentCostPoint[];
	partial: boolean;
}
export interface SubagentCostSource {
	runId: string;
	directory: string;
	startedAt?: number | undefined;
	steps: { agent: string; startedAt?: number | undefined }[];
}
const object = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
const numeric = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Sources must already have passed the session-owner and referenced-run checks. */
export async function readSubagentCostHistory(
	sources: readonly SubagentCostSource[],
	signal?: AbortSignal,
): Promise<{ series: SubagentCostSeries[]; unavailable: number }> {
	const series: SubagentCostSeries[] = [];
	let unavailable = Math.max(0, sources.length - 32);
	let remainingBytes = 8 * 1024 * 1024;
	for (const source of sources.slice(-32)) {
		if (signal?.aborted) break;
		const runs = new Map<number, SubagentCostSeries>();
		let file: Awaited<ReturnType<typeof open>> | undefined;
		try {
			file = await open(join(source.directory, "events.jsonl"), constants.O_RDONLY | constants.O_NONBLOCK);
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || stat.size > remainingBytes) {
				unavailable++;
				continue;
			}
			remainingBytes -= stat.size;
			const buffer = Buffer.alloc(stat.size);
			let length = 0;
			while (length < buffer.length && !signal?.aborted) {
				const result = await file.read(buffer, length, buffer.length - length, null);
				if (!result.bytesRead) break;
				length += result.bytesRead;
			}
			if (signal?.aborted) break;
			const text = buffer.subarray(0, length).toString("utf8");
			// Ignore an append in progress. Re-reading after the next refresh recovers it.
			const lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n");
			let corrupt = false;
			// Reserve identities before their first reply so curves do not change colors as siblings report.
			for (const [index, step] of source.steps.entries()) {
				const startedAt = step.startedAt ?? source.startedAt;
				if (numeric(startedAt))
					runs.set(index, {
						id: `${source.runId}:${index}`,
						runId: source.runId,
						stepIndex: index,
						agent: step.agent,
						startedAt,
						points: [{ at: startedAt, cost: 0 }],
						partial: false,
					});
			}

			const seen = new Set<string>();
			for (const line of lines) {
				if (!line) continue;
				let event: Record<string, unknown> | undefined;
				try {
					event = object(JSON.parse(line));
				} catch {
					corrupt = true;
					continue;
				}
				if (
					event?.type !== "message_end" ||
					event.subagentSource !== "child" ||
					event.subagentRunId !== source.runId ||
					!Number.isSafeInteger(event.subagentStepIndex)
				)
					continue;
				const index = event.subagentStepIndex as number;
				const step = source.steps[index];
				const message = object(event.message);
				if (!step || event.subagentAgent !== step.agent || message?.role !== "assistant") continue;
				// Project accounting fields only. No content, prompt or tool arguments leave this reader.
				const at = event.observedAt;
				const cost = object(object(message.usage)?.cost)?.total;
				const run = runs.get(index);
				if (!run) continue;
				if (!numeric(at) || !numeric(cost) || at < run.startedAt) {
					run.partial = true;
					continue;
				}
				// The same mirrored accounting event must not add cost twice.
				const key = JSON.stringify([index, at, message.timestamp, cost]);
				if (seen.has(key)) continue;
				seen.add(key);
				const previous = run.points.at(-1);
				if (!previous || at < previous.at || run.points.length >= 2048) {
					run.partial = true;
					continue;
				}
				const total = previous.cost + cost;
				if (!Number.isFinite(total)) {
					run.partial = true;
					continue;
				}
				if (previous.at === at) previous.cost = total;
				else run.points.push({ at, cost: total });
			}
			for (const run of runs.values()) {
				run.partial ||= corrupt;
				series.push(run);
			}
		} catch {
			unavailable++;
		} finally {
			await file?.close();
		}
	}
	const unique = new Map<string, SubagentCostSeries>();
	for (const run of series) {
		const previous = unique.get(run.id);
		if (!previous || (run.points.at(-1)?.at ?? 0) > (previous.points.at(-1)?.at ?? 0))
			unique.set(run.id, run);
	}
	return {
		series: [...unique.values()].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)),
		unavailable,
	};
}

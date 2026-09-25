import { constants } from "node:fs";
import { open, opendir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	readSubagentCostHistory,
	type SubagentCostSeries,
	type SubagentCostSource,
} from "./subagent-cost-history.js";

export const SUBAGENT_METADATA_ENTRY = "pi-atelier:subagent-metadata";
const MAX_FILES = 1_000;
const MAX_DIRECTORY_ENTRIES = 20_000;
const MAX_BYTES = 2 * 1024 * 1024;
const RUN_ID = /^[A-Za-z0-9._-]{1,160}$/;

export interface MetadataReferences {
	runIds: string[];
	paths: string[];
	asyncDirs: string[];
}
export interface SubagentUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	pricedRuns: number;
}
export interface SubagentUsageRun extends SubagentUsageTotals {
	id: string;
	runId: string;
	agent: string;
	model?: string;
	exitCode?: number;
	metadataPath: string;
	recordedAt?: number;
}
export interface SubagentUsageSnapshot {
	runs: SubagentUsageRun[];
	totals: SubagentUsageTotals;
	unavailable: number;
	pending: number;
	limited: boolean;
	costHistory?: SubagentCostSeries[];
	historyUnavailable?: number;
}
export const emptySubagentUsage = (): SubagentUsageSnapshot => ({
	runs: [],
	totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, pricedRuns: 0 },
	unavailable: 0,
	pending: 0,
	limited: false,
});
const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
const number = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Project only artifact references, never prompts/output or reported usage. */
export function subagentMetadataReferences(value: unknown): MetadataReferences {
	const runIds = new Set<string>();
	const paths = new Set<string>();
	const asyncDirs = new Set<string>();
	let remaining = 10_000;
	const visit = (value: unknown, depth: number): void => {
		if (depth > 8 || --remaining < 0) return;
		if (Array.isArray(value)) {
			for (const item of value.slice(0, MAX_FILES)) visit(item, depth + 1);
			return;
		}
		const item = record(value);
		if (!item) return;
		for (const key of ["runId", "asyncId", "childRunId"]) {
			const id = item[key];
			if (typeof id === "string" && RUN_ID.test(id) && id !== "." && id !== "..") runIds.add(id);
		}
		if (typeof item.asyncDir === "string" && item.asyncDir.length <= 4096 && isAbsolute(item.asyncDir))
			asyncDirs.add(item.asyncDir);
		const artifact = record(item.artifactPaths);
		const path = artifact?.metadataPath;
		if (typeof path === "string" && path.length <= 4096 && isAbsolute(path) && path.endsWith("_meta.json"))
			paths.add(path);
		for (const key of ["results", "completions", "workflowChildren", "children", "result", "details"])
			visit(item[key], depth + 1);
	};
	visit(value, 0);
	return { runIds: [...runIds], paths: [...paths], asyncDirs: [...asyncDirs] };
}

export function sessionSubagentReferences(entries: readonly unknown[]): MetadataReferences {
	const runIds = new Set<string>();
	const paths = new Set<string>();
	const asyncDirs = new Set<string>();
	for (const raw of entries) {
		const entry = record(raw);
		const message = record(entry?.message);
		let refs: MetadataReferences | undefined;
		if (entry?.type === "custom" && entry.customType === SUBAGENT_METADATA_ENTRY) {
			const data = record(entry.data);
			refs = {
				asyncDirs: Array.isArray(data?.asyncDirs)
					? data.asyncDirs.filter(
							(dir): dir is string => typeof dir === "string" && dir.length <= 4096 && isAbsolute(dir),
						)
					: [],
				runIds: Array.isArray(data?.runIds)
					? data.runIds.filter(
							(id): id is string => typeof id === "string" && RUN_ID.test(id) && id !== "." && id !== "..",
						)
					: [],
				paths: Array.isArray(data?.paths)
					? data.paths.filter(
							(path): path is string =>
								typeof path === "string" &&
								path.length <= 4096 &&
								isAbsolute(path) &&
								path.endsWith("_meta.json"),
						)
					: [],
			};
		} else if (
			(entry?.type === "message" &&
				message?.role === "toolResult" &&
				["subagent", "bg_wait"].includes(String(message.toolName))) ||
			(entry?.type === "custom_message" && entry.customType === "subagent-slash-result")
		) {
			refs = subagentMetadataReferences(entry.type === "message" ? message?.details : entry.details);
		}
		for (const id of refs?.runIds ?? []) runIds.add(id);
		for (const path of refs?.paths ?? []) paths.add(path);
		for (const dir of refs?.asyncDirs ?? []) asyncDirs.add(dir);
	}
	return { runIds: [...runIds], paths: [...paths], asyncDirs: [...asyncDirs] };
}

export function sumSubagentUsage(runs: readonly SubagentUsageRun[]): SubagentUsageTotals {
	const total = emptySubagentUsage().totals;
	for (const run of runs) {
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "pricedRuns"] as const)
			total[key] += run[key];
	}
	return total;
}

function tempArtifactsDirectory(): string | undefined {
	const override = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	if (override) return join(resolve(override), "artifacts");
	if (process.getuid) return join(tmpdir(), `pi-subagents-uid-${process.getuid()}`, "artifacts");
	const user = process.env.USERNAME || process.env.USER || process.env.LOGNAME;
	if (!user) return undefined;
	const safe =
		user
			.trim()
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "unknown";
	return join(tmpdir(), `pi-subagents-user-${safe}`, "artifacts");
}

export function matchesSubagentSession(
	owner: unknown,
	session: { sessionFile?: string; sessionId?: string },
): boolean {
	return (
		typeof owner === "string" &&
		owner.length > 0 &&
		(owner === session.sessionFile || owner === session.sessionId)
	);
}

/** Ownerless lifecycle hints are accepted only for a run already recorded in this session. */
export function isSubagentUsageEventForSession(
	data: unknown,
	entries: readonly unknown[],
	session: { sessionFile?: string; sessionId?: string },
): boolean {
	const event = record(data);
	if (!event) return false;
	if (event.sessionId !== undefined) return matchesSubagentSession(event.sessionId, session);
	return typeof event.runId === "string" && sessionSubagentReferences(entries).runIds.includes(event.runId);
}

/** Read bounded JSON only; a FIFO or growing file must not block or grow allocations. */
async function readArtifactJson(path: string): Promise<Record<string, unknown> | undefined> {
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Invalid artifact file");
		const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1));
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		if (length > stat.size) throw new Error("Artifact changed while reading");
		return record(JSON.parse(buffer.subarray(0, length).toString("utf8")));
	} finally {
		await file.close();
	}
}

/** Read session-owned metadata and project numeric usage history from native diagnostic events. */
export async function readSubagentUsage(options: {
	entries: readonly unknown[];
	cwd: string;
	sessionFile?: string;
	sessionId?: string;
	signal?: AbortSignal;
}): Promise<SubagentUsageSnapshot> {
	const snapshot = emptySubagentUsage();
	const refs = sessionSubagentReferences(options.entries);
	if (refs.runIds.length === 0) return snapshot;
	const runIds = new Set(refs.runIds);
	const workflowRoots = new Set<string>();
	const pendingRuns = new Set<string>();
	const historySources: SubagentCostSource[] = [];
	const asyncDirs = new Set(refs.asyncDirs.slice(0, MAX_FILES));
	let statusCount = 0;
	for (const asyncDir of asyncDirs) {
		if (++statusCount > MAX_FILES) break;
		if (options.signal?.aborted) return snapshot;
		try {
			const status = await readArtifactJson(join(asyncDir, "status.json"));
			if (
				!status ||
				typeof status.runId !== "string" ||
				!runIds.has(status.runId) ||
				!matchesSubagentSession(status.sessionId, options)
			)
				continue;
			const childRefs = subagentMetadataReferences({
				results: status.steps,
				workflowChildren: status.workflowChildren,
			});
			for (const id of childRefs.runIds) runIds.add(id);
			refs.paths.push(...childRefs.paths);
			const terminal = new Set([
				"complete",
				"completed",
				"failed",
				"aborted",
				"stopped",
				"cancelled",
				"interrupted",
				"paused",
			]);
			const active = typeof status.state === "string" && !terminal.has(status.state);
			if (active) {
				pendingRuns.add(status.runId);
				for (const raw of Array.isArray(status.steps) ? status.steps : []) {
					const step = record(raw);
					if (typeof step?.runId === "string" && !terminal.has(String(step.status)))
						pendingRuns.add(step.runId);
				}
			}
			if (status.mode === "workflow") {
				workflowRoots.add(status.runId);
				for (const childId of childRefs.runIds) {
					if (childId !== status.runId && asyncDirs.size < MAX_FILES)
						asyncDirs.add(join(dirname(asyncDir), childId));
				}
				// A workflow root coordinates children and has no LLM metadata of its own.
				// Receipts retain earlier continuation run IDs after status advances to the latest one.
				try {
					const receipt = await readArtifactJson(join(asyncDir, "workflow-receipt.json"));
					if (receipt?.workflowRunId === status.runId) {
						for (const raw of Object.values(record(receipt.entries) ?? {}).slice(0, MAX_FILES)) {
							const entry = record(raw);
							const continuation = record(entry?.continuation);
							for (const id of [
								entry?.latestRunId,
								...(Array.isArray(continuation?.runIds) ? continuation.runIds : []),
							]) {
								if (typeof id === "string" && RUN_ID.test(id) && id !== "." && id !== "..") runIds.add(id);
							}
						}
					}
				} catch {
					/* Status still provides current children if an optional receipt is absent. */
				}
			} else {
				historySources.push({
					runId: status.runId,
					directory: asyncDir,
					startedAt: number(status.startedAt),
					steps: (Array.isArray(status.steps) ? status.steps : []).slice(0, MAX_FILES).map((raw) => {
						const step = record(raw);
						return {
							agent: typeof step?.agent === "string" ? step.agent : "",
							startedAt: number(step?.startedAt),
						};
					}),
				});
			}
		} catch {
			/* Missing lifecycle data leaves the original reference unavailable. */
		}
	}
	refs.runIds = [...runIds];
	snapshot.pending = pendingRuns.size;
	const candidates = new Set(refs.paths.slice(0, MAX_FILES));
	const directories = new Set(refs.paths.slice(0, MAX_FILES).map(dirname));
	if (options.sessionFile) directories.add(join(dirname(options.sessionFile), "subagent-artifacts"));
	directories.add(join(options.cwd, ".pi", "subagents", "artifacts"));
	const temp = tempArtifactsDirectory();
	if (temp) directories.add(temp);
	const referencedName = (name: string): boolean =>
		name.endsWith("_meta.json") && refs.runIds.some((id) => name.startsWith(`${id}_`));
	let inspected = 0;
	snapshot.limited = refs.paths.length > MAX_FILES;
	for (const directory of directories) {
		if (options.signal?.aborted) return snapshot;
		try {
			for await (const entry of await opendir(directory)) {
				if (options.signal?.aborted) return snapshot;
				if (++inspected > MAX_DIRECTORY_ENTRIES || candidates.size >= MAX_FILES) {
					snapshot.limited = true;
					break;
				}
				if (entry.isFile() && referencedName(entry.name)) candidates.add(join(directory, entry.name));
			}
		} catch {
			/* Missing/disabled artifact directories are normal. */
		}
		if (snapshot.limited) break;
	}
	const foundRuns = new Set<string>();
	const rows = new Map<string, { run: SubagentUsageRun; timestamp: number }>();
	const seenPaths = new Set<string>();
	for (const candidate of candidates) {
		if (options.signal?.aborted) return snapshot;
		try {
			const path = await realpath(candidate);
			if (seenPaths.has(path) || !referencedName(basename(path))) continue;
			seenPaths.add(path);
			const data = await readArtifactJson(path);
			if (typeof data?.runId !== "string" || !runIds.has(data.runId)) continue;
			if (typeof data.agent !== "string" || data.agent.length === 0 || data.agent.length > 512)
				throw new Error("Missing agent");
			const expected = `${data.runId}_${data.agent.replace(/[^\w.-]/g, "_")}`;
			const name = basename(path);
			const suffix = name.slice(expected.length);
			if (!name.startsWith(expected) || !/^(_\d+)?_meta\.json$/.test(suffix)) continue;
			const usage = record(data.usage);
			const input = number(usage?.input),
				output = number(usage?.output);
			const cacheRead = number(usage?.cacheRead),
				cacheWrite = number(usage?.cacheWrite);
			if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined)
				throw new Error("Missing usage");
			const cost = number(usage?.cost);
			const timestamp = number(data.timestamp);
			const id = `${data.runId}/${name}`;
			const run: SubagentUsageRun = {
				id,
				runId: data.runId,
				agent: data.agent,
				input,
				output,
				cacheRead,
				cacheWrite,
				cost: cost ?? 0,
				pricedRuns: cost === undefined ? 0 : 1,
				metadataPath: path,
				...(timestamp === undefined ? {} : { recordedAt: timestamp }),
				...(typeof data.model === "string" && data.model.length <= 512 ? { model: data.model } : {}),
				...(typeof data.exitCode === "number" && Number.isFinite(data.exitCode)
					? { exitCode: data.exitCode }
					: {}),
			};
			if (!rows.has(id) || (timestamp ?? 0) > (rows.get(id)?.timestamp ?? 0))
				rows.set(id, { run, timestamp: timestamp ?? 0 });
			foundRuns.add(data.runId);
		} catch {
			snapshot.unavailable++;
		}
	}
	snapshot.runs = [...rows.values()]
		.map(({ run }) => run)
		.sort((a, b) => b.output - a.output || a.id.localeCompare(b.id));
	snapshot.totals = sumSubagentUsage(snapshot.runs);
	const history = await readSubagentCostHistory(historySources, options.signal);
	snapshot.costHistory = history.series.filter((series) => {
		const matches = snapshot.runs.filter((run) => run.runId === series.runId && run.agent === series.agent);
		const saved =
			matches.length === 1
				? matches[0]
				: matches.find((run) => run.metadataPath.endsWith(`_${series.stepIndex}_meta.json`));
		if (saved?.pricedRuns && Math.abs(saved.cost - (series.points.at(-1)?.cost ?? 0)) > 1e-8) {
			history.unavailable++;
			return false;
		}
		return true;
	});
	snapshot.historyUnavailable = history.unavailable;
	// Missing run IDs are not zero-cost runs. This is a reference count, not a child count.
	snapshot.unavailable += [...runIds].filter(
		(id) => !foundRuns.has(id) && !workflowRoots.has(id) && !pendingRuns.has(id),
	).length;
	return snapshot;
}

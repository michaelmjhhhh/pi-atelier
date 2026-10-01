import { opendir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readBoundedFile } from "./bounded-file.js";
import {
	readSubagentCostHistory,
	type SubagentCostSeries,
	type SubagentCostSource,
} from "./subagent-cost-history.js";
import { isRecord } from "./text.js";

export const SUBAGENT_METADATA_ENTRY = "pi-atelier:subagent-metadata";
/** Bound on references, status files, steps, and metadata candidates per refresh. */
const MAX_FILES = 1_000;
const MAX_DIRECTORY_ENTRIES = 20_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PATH_LENGTH = 4096;
const RUN_ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,160}$/;
const SUBAGENT_TOOLS: ReadonlySet<unknown> = new Set(["subagent", "bg_wait"]);
const TERMINAL_STATES: ReadonlySet<unknown> = new Set([
	"complete",
	"completed",
	"failed",
	"aborted",
	"stopped",
	"cancelled",
	"interrupted",
	"paused",
]);

interface MetadataReferences {
	runIds: string[];
	paths: string[];
	asyncDirs: string[];
}
interface SubagentUsageRun {
	id: string;
	runId: string;
	agent: string;
	metadataPath: string;
	/** Reported cost; zero with `priced: false` when the child reported none. */
	cost: number;
	priced: boolean;
}
export interface SubagentUsageSnapshot {
	runs: SubagentUsageRun[];
	unavailable: number;
	pending: number;
	limited: boolean;
	costHistory: SubagentCostSeries[];
	historyUnavailable: number;
}
export const emptySubagentUsage = (): SubagentUsageSnapshot => ({
	runs: [],
	unavailable: 0,
	pending: 0,
	limited: false,
	costHistory: [],
	historyUnavailable: 0,
});
const record = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);
const nonNegative = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const isRunId = (value: unknown): value is string => typeof value === "string" && RUN_ID.test(value);
const isBoundedAbsolutePath = (value: unknown): value is string =>
	typeof value === "string" && value.length <= MAX_PATH_LENGTH && isAbsolute(value);
const isMetadataPath = (value: unknown): value is string =>
	isBoundedAbsolutePath(value) && value.endsWith("_meta.json");

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
			if (isRunId(id)) runIds.add(id);
		}
		if (isBoundedAbsolutePath(item.asyncDir)) asyncDirs.add(item.asyncDir);
		const path = record(item.artifactPaths)?.metadataPath;
		if (isMetadataPath(path)) paths.add(path);
		for (const key of ["results", "completions", "workflowChildren", "children", "result", "details"])
			visit(item[key], depth + 1);
	};
	visit(value, 0);
	return { runIds: [...runIds], paths: [...paths], asyncDirs: [...asyncDirs] };
}

function sessionSubagentReferences(entries: readonly unknown[]): MetadataReferences {
	const runIds = new Set<string>();
	const paths = new Set<string>();
	const asyncDirs = new Set<string>();
	for (const raw of entries) {
		const entry = record(raw);
		const message = record(entry?.message);
		let refs: MetadataReferences | undefined;
		if (entry?.type === "custom" && entry.customType === SUBAGENT_METADATA_ENTRY) {
			// Saved entries live in the session file, so re-validate them like any other input.
			const data = record(entry.data);
			const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
			refs = {
				asyncDirs: list(data?.asyncDirs).filter(isBoundedAbsolutePath),
				runIds: list(data?.runIds).filter(isRunId),
				paths: list(data?.paths).filter(isMetadataPath),
			};
		} else if (
			(entry?.type === "message" && message?.role === "toolResult" && SUBAGENT_TOOLS.has(message.toolName)) ||
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

function matchesSubagentSession(
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

async function readArtifactJson(path: string): Promise<Record<string, unknown> | undefined> {
	return record(JSON.parse((await readBoundedFile(path, MAX_BYTES)).toString("utf8")));
}

interface SessionIdentity {
	sessionFile?: string;
	sessionId?: string;
}

interface StatusExpansion {
	runIds: Set<string>;
	paths: string[];
	workflowRoots: Set<string>;
	pendingRuns: Set<string>;
	historySources: SubagentCostSource[];
}

/** Follow session-owned async status files to child runs, workflow receipts, and history sources. */
async function expandAsyncStatuses(
	refs: MetadataReferences,
	session: SessionIdentity,
	signal: AbortSignal | undefined,
): Promise<StatusExpansion | undefined> {
	const expansion: StatusExpansion = {
		runIds: new Set(refs.runIds),
		paths: [...refs.paths],
		workflowRoots: new Set(),
		pendingRuns: new Set(),
		historySources: [],
	};
	const asyncDirs = new Set(refs.asyncDirs.slice(0, MAX_FILES));
	const enqueue = (asyncDir: string, rootId: string, id: string): void => {
		if (id !== rootId && asyncDirs.size < MAX_FILES) asyncDirs.add(join(dirname(asyncDir), id));
	};
	for (const asyncDir of asyncDirs) {
		if (signal?.aborted) return undefined;
		let status: Record<string, unknown> | undefined;
		try {
			status = await readArtifactJson(join(asyncDir, "status.json"));
		} catch {
			// The reference stays unresolved and is counted as unavailable later.
			continue;
		}
		const runId = status?.runId;
		if (!status || typeof runId !== "string" || !expansion.runIds.has(runId)) continue;
		if (!matchesSubagentSession(status.sessionId, session)) continue;
		const steps = (Array.isArray(status.steps) ? status.steps : []).slice(0, MAX_FILES);
		const childRefs = subagentMetadataReferences({
			results: steps,
			workflowChildren: status.workflowChildren,
		});
		for (const id of childRefs.runIds) expansion.runIds.add(id);
		expansion.paths.push(...childRefs.paths);
		if (typeof status.state === "string" && !TERMINAL_STATES.has(status.state)) {
			expansion.pendingRuns.add(runId);
			for (const step of steps.map(record)) {
				if (typeof step?.runId === "string" && !TERMINAL_STATES.has(step.status))
					expansion.pendingRuns.add(step.runId);
			}
		}
		if (status.mode !== "workflow") {
			expansion.historySources.push({
				runId,
				directory: asyncDir,
				startedAt: nonNegative(status.startedAt),
				steps: steps.map((raw) => {
					const step = record(raw);
					return {
						agent: typeof step?.agent === "string" ? step.agent : "",
						startedAt: nonNegative(step?.startedAt),
					};
				}),
			});
			continue;
		}
		// A workflow root coordinates children and has no LLM metadata of its own.
		expansion.workflowRoots.add(runId);
		for (const childId of childRefs.runIds) enqueue(asyncDir, runId, childId);
		// Receipts retain earlier continuation run IDs after status advances to the latest one.
		try {
			const receipt = await readArtifactJson(join(asyncDir, "workflow-receipt.json"));
			if (receipt?.workflowRunId !== runId) continue;
			for (const entry of Object.values(record(receipt.entries) ?? {})
				.slice(0, MAX_FILES)
				.map(record)) {
				const continuation = record(entry?.continuation)?.runIds;
				for (const id of [entry?.latestRunId, ...(Array.isArray(continuation) ? continuation : [])]) {
					if (!isRunId(id)) continue;
					expansion.runIds.add(id);
					enqueue(asyncDir, runId, id);
				}
			}
		} catch {
			// Status still provides current children if an optional receipt is absent.
		}
	}
	return expansion;
}

/** Collect referenced metadata files from explicit paths and the known artifact directories. */
async function findMetadataCandidates(
	expansion: StatusExpansion,
	options: { cwd: string; sessionFile?: string; signal?: AbortSignal },
): Promise<{ candidates: Set<string>; limited: boolean } | undefined> {
	const paths = expansion.paths.slice(0, MAX_FILES);
	const candidates = new Set(paths);
	const directories = new Set(paths.map(dirname));
	if (options.sessionFile) directories.add(join(dirname(options.sessionFile), "subagent-artifacts"));
	directories.add(join(options.cwd, ".pi", "subagents", "artifacts"));
	const temp = tempArtifactsDirectory();
	if (temp) directories.add(temp);
	let limited = expansion.paths.length > MAX_FILES;
	let inspected = 0;
	for (const directory of directories) {
		if (options.signal?.aborted) return undefined;
		try {
			for await (const entry of await opendir(directory)) {
				if (options.signal?.aborted) return undefined;
				if (++inspected > MAX_DIRECTORY_ENTRIES || candidates.size >= MAX_FILES) {
					limited = true;
					break;
				}
				if (entry.isFile() && isReferencedMetadataName(entry.name, expansion.runIds))
					candidates.add(join(directory, entry.name));
			}
		} catch {
			// Missing or disabled artifact directories are normal.
		}
		if (limited) break;
	}
	return { candidates, limited };
}

function isReferencedMetadataName(name: string, runIds: ReadonlySet<string>): boolean {
	if (!name.endsWith("_meta.json")) return false;
	const separator = name.indexOf("_");
	// Run IDs may themselves contain underscores, so test every prefix that ends at one.
	for (let index = separator; index >= 0; index = name.indexOf("_", index + 1)) {
		if (runIds.has(name.slice(0, index))) return true;
	}
	return false;
}

/** One metadata file's projection, or undefined when it is not a referenced run's own file. */
function parseMetadataRun(
	path: string,
	data: Record<string, unknown> | undefined,
	runIds: ReadonlySet<string>,
): SubagentUsageRun | "invalid" | undefined {
	if (typeof data?.runId !== "string" || !runIds.has(data.runId)) return undefined;
	if (typeof data.agent !== "string" || data.agent.length === 0 || data.agent.length > 512) return "invalid";
	const name = basename(path);
	const expected = `${data.runId}_${data.agent.replace(/[^\w.-]/g, "_")}`;
	if (!name.startsWith(expected) || !/^(_\d+)?_meta\.json$/.test(name.slice(expected.length)))
		return undefined;
	const usage = record(data.usage);
	// Token counts are not displayed, but a record without them is not a usage record.
	if (
		[usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite].some(
			(value) => nonNegative(value) === undefined,
		)
	)
		return "invalid";
	const cost = nonNegative(usage?.cost);
	return {
		id: `${data.runId}/${name}`,
		runId: data.runId,
		agent: data.agent,
		metadataPath: path,
		cost: cost ?? 0,
		priced: cost !== undefined,
	};
}

const COST_TOLERANCE = 1e-8;

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
	const expansion = await expandAsyncStatuses(refs, options, options.signal);
	if (!expansion) return snapshot;
	snapshot.pending = expansion.pendingRuns.size;
	const found = await findMetadataCandidates(expansion, options);
	if (!found) return snapshot;
	snapshot.limited = found.limited;

	const foundRuns = new Set<string>();
	const runs = new Map<string, { run: SubagentUsageRun; timestamp: number }>();
	const seenPaths = new Set<string>();
	for (const candidate of found.candidates) {
		if (options.signal?.aborted) return snapshot;
		try {
			const path = await realpath(candidate);
			if (seenPaths.has(path) || !isReferencedMetadataName(basename(path), expansion.runIds)) continue;
			seenPaths.add(path);
			const data = await readArtifactJson(path);
			const run = parseMetadataRun(path, data, expansion.runIds);
			if (run === undefined) continue;
			if (run === "invalid") {
				snapshot.unavailable++;
				continue;
			}
			// A rewritten metadata file replaces its earlier snapshot.
			const timestamp = nonNegative(data?.timestamp) ?? 0;
			const existing = runs.get(run.id);
			if (!existing || timestamp > existing.timestamp) runs.set(run.id, { run, timestamp });
			foundRuns.add(run.runId);
		} catch {
			snapshot.unavailable++;
		}
	}
	snapshot.runs = [...runs.values()].map(({ run }) => run);

	const history = await readSubagentCostHistory(expansion.historySources, options.signal);
	let historyUnavailable = history.unavailable;
	snapshot.costHistory = history.series.filter((series) => {
		const matches = snapshot.runs.filter((run) => run.runId === series.runId && run.agent === series.agent);
		const saved =
			matches.length === 1
				? matches[0]
				: matches.find((run) => run.metadataPath.endsWith(`_${series.stepIndex}_meta.json`));
		// Drop a curve that disagrees with the child's own final accounting.
		const consistent =
			!saved?.priced || Math.abs(saved.cost - (series.points.at(-1)?.cost ?? 0)) <= COST_TOLERANCE;
		if (!consistent) historyUnavailable++;
		return consistent;
	});
	snapshot.historyUnavailable = historyUnavailable;
	// Missing run IDs are not zero-cost runs. This is a reference count, not a child count.
	snapshot.unavailable += [...expansion.runIds].filter(
		(id) => !foundRuns.has(id) && !expansion.workflowRoots.has(id) && !expansion.pendingRuns.has(id),
	).length;
	return snapshot;
}

import { existsSync } from "node:fs";
import nodePath from "node:path";
import { toDisplayPath } from "./display-path.js";

export interface WorkspacePulseSnapshot {
	trackedFiles: number;
	untrackedFiles: number;
	linesAdded: number;
	linesRemoved: number;
	binaryFiles: number;
	submodules: number;
	conflicts: number;
}

export interface WorkspacePulseData {
	root: string;
	relativeCwd: string;
	branch?: string;
	snapshot: WorkspacePulseSnapshot;
}

export type WorkspacePulseInspection =
	| ({ kind: "available" } & WorkspacePulseData)
	| { kind: "not-repo" }
	| { kind: "unavailable" };

interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

type WorkspacePulseExec = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number },
) => Promise<ExecResult>;

export interface InspectWorkspacePulseOptions {
	exec: WorkspacePulseExec;
	cwd: string;
}

export interface WorkspacePulseRefresh {
	request(): void;
	flush(): Promise<void>;
	dispose(): void;
}

export interface WorkspacePulseRefreshOptions {
	inspect(): Promise<WorkspacePulseInspection>;
	publish(inspection: WorkspacePulseInspection): void;
	delayMs?: number;
}

/** Owns coalescing, serialization, and freshness for Workspace Pulse inspections. */
export function createWorkspacePulseRefresh(options: WorkspacePulseRefreshOptions): WorkspacePulseRefresh {
	const delayMs = Math.max(0, Math.trunc(options.delayMs ?? 250));
	let disposed = false;
	let requestedVersion = 0;
	let completedVersion = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: Promise<void> | undefined;

	const clearTimer = (): void => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};

	const runInspection = (): Promise<void> => {
		const version = requestedVersion;
		const running = (async () => {
			let inspection: WorkspacePulseInspection;
			try {
				inspection = await options.inspect();
			} catch {
				inspection = { kind: "unavailable" };
			}
			if (disposed) return;
			completedVersion = Math.max(completedVersion, version);
			options.publish(inspection);
		})();
		inFlight = running;
		void running.then(
			() => {
				if (inFlight === running) inFlight = undefined;
			},
			() => {
				if (inFlight === running) inFlight = undefined;
			},
		);
		return running;
	};

	const runScheduled = async (version: number): Promise<void> => {
		if (disposed || version !== requestedVersion) return;
		if (inFlight) await inFlight;
		if (disposed || version !== requestedVersion || completedVersion >= version) return;
		await runInspection();
	};

	return {
		request() {
			if (disposed) return;
			const version = ++requestedVersion;
			clearTimer();
			timer = setTimeout(() => {
				timer = undefined;
				void runScheduled(version);
			}, delayMs);
			timer.unref?.();
		},
		async flush() {
			if (disposed) return;
			const targetVersion = ++requestedVersion;
			clearTimer();
			while (!disposed && completedVersion < targetVersion) {
				if (inFlight) await inFlight;
				else await runInspection();
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			requestedVersion += 1;
			clearTimer();
		},
	};
}

const EMPTY_SNAPSHOT: WorkspacePulseSnapshot = {
	trackedFiles: 0,
	untrackedFiles: 0,
	linesAdded: 0,
	linesRemoved: 0,
	binaryFiles: 0,
	submodules: 0,
	conflicts: 0,
};

function hasGitMarker(cwd: string): boolean {
	let current = nodePath.resolve(cwd);
	while (true) {
		if (existsSync(nodePath.join(current, ".git"))) return true;
		const parent = nodePath.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

function discoveryOutput(output: string): { inside: boolean; root?: string } {
	const separator = output.indexOf("\n");
	if (separator < 0) return { inside: false };
	const inside = output.slice(0, separator).replace(/\r$/, "") === "true";
	let root = output.slice(separator + 1);
	if (root.endsWith("\n")) root = root.slice(0, -1);
	if (root.endsWith("\r")) root = root.slice(0, -1);
	return { inside, ...(root ? { root } : {}) };
}

interface ParsedStatus {
	branch?: string;
	valid: boolean;
	unborn: boolean;
	trackedFiles: number;
	untrackedFiles: number;
	conflicts: number;
	submodulePaths: Set<string>;
}

function parseStatus(output: string): ParsedStatus {
	const parsed: ParsedStatus = {
		valid: false,
		unborn: false,
		trackedFiles: 0,
		untrackedFiles: 0,
		conflicts: 0,
		submodulePaths: new Set(),
	};
	let sawBranchOid = false;
	let sawBranchHead = false;
	const records = output.split("\0");
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index] ?? "";
		if (record.startsWith("# branch.oid ")) {
			sawBranchOid = true;
			parsed.unborn = record === "# branch.oid (initial)";
			continue;
		}
		if (record.startsWith("# branch.head ")) {
			sawBranchHead = true;
			const branch = record.slice("# branch.head ".length).trim();
			if (branch) parsed.branch = branch === "(detached)" ? "detached" : branch;
			continue;
		}
		if (record.startsWith("? ")) {
			parsed.untrackedFiles += 1;
			continue;
		}
		const kind = record[0];
		if ((kind !== "1" && kind !== "2" && kind !== "u") || record[1] !== " ") continue;
		parsed.trackedFiles += 1;
		if (kind === "u") parsed.conflicts += 1;
		const fields = record.split(" ");
		const submodule = fields[2] ?? "";
		const pathIndex = kind === "u" ? 10 : kind === "2" ? 9 : 8;
		const path = fields.slice(pathIndex).join(" ");
		if (submodule.startsWith("S") && path) parsed.submodulePaths.add(path);
		if (kind === "2") index += 1;
	}
	parsed.valid = sawBranchOid && sawBranchHead;
	return parsed;
}

function parseNumstat(
	output: string,
	submodulePaths: ReadonlySet<string>,
): Pick<WorkspacePulseSnapshot, "linesAdded" | "linesRemoved" | "binaryFiles"> {
	let linesAdded = 0;
	let linesRemoved = 0;
	let binaryFiles = 0;
	const records = output.split("\0");
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index] ?? "";
		if (!record) continue;
		const firstTab = record.indexOf("\t");
		const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
		if (firstTab < 0 || secondTab < 0) continue;
		const added = record.slice(0, firstTab);
		const removed = record.slice(firstTab + 1, secondTab);
		let path = record.slice(secondTab + 1);
		if (!path) {
			index += 2;
			path = records[index] ?? "";
		}
		if (submodulePaths.has(path)) continue;
		if (added === "-" && removed === "-") {
			binaryFiles += 1;
			continue;
		}
		const addedCount = Number(added);
		const removedCount = Number(removed);
		if (Number.isFinite(addedCount)) linesAdded += Math.max(0, Math.trunc(addedCount));
		if (Number.isFinite(removedCount)) linesRemoved += Math.max(0, Math.trunc(removedCount));
	}
	return { linesAdded, linesRemoved, binaryFiles };
}

async function inspectWorkspacePulseUnchecked(
	options: InspectWorkspacePulseOptions,
): Promise<WorkspacePulseInspection> {
	const discovery = await options.exec("git", ["rev-parse", "--is-inside-work-tree", "--show-toplevel"], {
		cwd: options.cwd,
		timeout: 2_000,
	});
	if (discovery.code !== 0 || discovery.killed) {
		const explicitNotRepo = /not a git repository/i.test(`${discovery.stderr}\n${discovery.stdout}`);
		return !discovery.killed && (explicitNotRepo || (discovery.code === 128 && !hasGitMarker(options.cwd)))
			? { kind: "not-repo" }
			: { kind: "unavailable" };
	}
	const discovered = discoveryOutput(discovery.stdout);
	const root = discovered.root;
	if (!discovered.inside || !root) return { kind: "unavailable" };

	const status = await options.exec(
		"git",
		["-C", root, "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"],
		{ timeout: 2_000 },
	);
	if (status.code !== 0 || status.killed) return { kind: "unavailable" };

	const parsedStatus = parseStatus(status.stdout);
	if (!parsedStatus.valid) return { kind: "unavailable" };
	const head = await options.exec("git", ["-C", root, "rev-parse", "--verify", "HEAD^{tree}"], {
		timeout: 2_000,
	});
	if (head.killed) return { kind: "unavailable" };
	const baseline =
		head.code === 0
			? head.stdout.trim()
			: parsedStatus.unborn
				? "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
				: "";
	if (!baseline) return { kind: "unavailable" };

	const diff = await options.exec(
		"git",
		["-C", root, "diff", "--numstat", "-z", "--find-renames", baseline, "--"],
		{ timeout: 2_000 },
	);
	if (diff.code !== 0 || diff.killed) return { kind: "unavailable" };

	const numstat = parseNumstat(diff.stdout, parsedStatus.submodulePaths);
	return {
		kind: "available",
		root,
		relativeCwd: toDisplayPath(nodePath.relative(root, options.cwd), nodePath.sep),
		...(parsedStatus.branch ? { branch: parsedStatus.branch } : {}),
		snapshot: {
			...EMPTY_SNAPSHOT,
			trackedFiles: parsedStatus.trackedFiles,
			untrackedFiles: parsedStatus.untrackedFiles,
			conflicts: parsedStatus.conflicts,
			submodules: parsedStatus.submodulePaths.size,
			...numstat,
		},
	};
}

export async function inspectWorkspacePulse(
	options: InspectWorkspacePulseOptions,
): Promise<WorkspacePulseInspection> {
	try {
		return await inspectWorkspacePulseUnchecked(options);
	} catch {
		return { kind: "unavailable" };
	}
}

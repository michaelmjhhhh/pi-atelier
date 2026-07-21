import nodePath from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type ToolActivityStatus = "running" | "done" | "failed";

export interface ToolActivity {
	id: string;
	name: string;
	summary: string;
	status: ToolActivityStatus;
	startedAt: number;
	durationMs?: number;
}

export interface RunActivitySnapshot {
	phase: "idle" | "running" | "settled";
	turnNumber?: number;
	startedAt?: number;
	durationMs?: number;
	activeTools: readonly ToolActivity[];
	recentTools: readonly ToolActivity[];
	completedCount: number;
	failedCount: number;
}

export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: unknown;
}

export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
}

export interface RunActivityTracker {
	startRun(now?: number): void;
	startTurn(turnIndex: number): void;
	startTool(event: ToolExecutionStartEvent, now?: number): void;
	finishTool(event: ToolExecutionEndEvent, now?: number): void;
	settle(now?: number): void;
	reset(): void;
	isRunning(): boolean;
	getSnapshot(): RunActivitySnapshot;
}

export interface RunActivityTrackerOptions {
	cwd: string;
	onChange?: (snapshot: RunActivitySnapshot) => void;
}

const MAX_SUMMARY_COLUMNS = 26;
const MAX_RECENT_TOOLS = 3;

export const EMPTY_RUN_ACTIVITY: RunActivitySnapshot = Object.freeze({
	phase: "idle",
	activeTools: Object.freeze([]),
	recentTools: Object.freeze([]),
	completedCount: 0,
	failedCount: 0,
});

export function createRunActivityTracker(options: RunActivityTrackerOptions): RunActivityTracker {
	return new DefaultRunActivityTracker(options);
}

export function formatDuration(durationMs: number): string {
	const normalized = normalizeTimestamp(durationMs);
	const totalSeconds = Math.floor(normalized / 1_000);
	if (totalSeconds < 1) return "<1s";
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;

	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `${hours}h ${remainingMinutes.toString().padStart(2, "0")}m`;
}

export function summarizeTool(toolName: string, args: unknown, cwd: string): string {
	if (!isRecord(args)) return "";

	switch (toolName) {
		case "bash":
			return truncateSummary(sanitizeText(getString(args, "command")), MAX_SUMMARY_COLUMNS);
		case "read":
		case "edit":
		case "write":
			return truncateSummary(shortenPath(getString(args, "path"), cwd), MAX_SUMMARY_COLUMNS);
		case "grep":
			return summarizePatternTool(args, cwd);
		case "find":
			return summarizePatternTool(args, cwd);
		case "ls":
			return truncateSummary(shortenPath(getString(args, "path"), cwd), MAX_SUMMARY_COLUMNS);
		default:
			return "";
	}
}

class DefaultRunActivityTracker implements RunActivityTracker {
	private phase: RunActivitySnapshot["phase"] = "idle";
	private turnNumber: number | undefined;
	private startedAt: number | undefined;
	private durationMs: number | undefined;
	private activeTools = new Map<string, ToolActivity>();
	private recentTools: ToolActivity[] = [];
	private completedCount = 0;
	private failedCount = 0;
	private readonly cwd: string;
	private readonly onChange: ((snapshot: RunActivitySnapshot) => void) | undefined;

	constructor(options: RunActivityTrackerOptions) {
		this.cwd = options.cwd;
		this.onChange = options.onChange;
	}

	startRun(now?: number): void {
		this.phase = "running";
		this.turnNumber = undefined;
		this.startedAt = normalizeTimestamp(now ?? Date.now());
		this.durationMs = undefined;
		this.activeTools = new Map<string, ToolActivity>();
		this.recentTools = [];
		this.completedCount = 0;
		this.failedCount = 0;
		this.notify();
	}

	startTurn(turnIndex: number): void {
		const nextTurnNumber = Math.max(0, Number.isFinite(turnIndex) ? Math.trunc(turnIndex) : 0) + 1;
		if (this.turnNumber === nextTurnNumber && this.phase === "running") return;

		this.phase = "running";
		this.turnNumber = nextTurnNumber;
		this.durationMs = undefined;
		this.notify();
	}

	startTool(event: ToolExecutionStartEvent, now?: number): void {
		const id = sanitizeText(event.toolCallId);
		if (id.length === 0) return;

		const tool: ToolActivity = freezeTool({
			id,
			name: sanitizeToolName(event.toolName),
			summary: summarizeTool(event.toolName, event.args, this.cwd),
			status: "running",
			startedAt: normalizeTimestamp(now ?? Date.now()),
		});
		this.phase = "running";
		this.durationMs = undefined;
		this.activeTools.set(id, tool);
		this.notify();
	}

	finishTool(event: ToolExecutionEndEvent, now?: number): void {
		const id = sanitizeText(event.toolCallId);
		const active = this.activeTools.get(id);
		if (!active) return;

		this.activeTools.delete(id);
		const endedAt = normalizeTimestamp(now ?? Date.now());
		const status: ToolActivityStatus = event.isError ? "failed" : "done";
		const completed = freezeTool({
			...active,
			status,
			durationMs: Math.max(0, endedAt - active.startedAt),
		});
		if (status === "failed") {
			this.failedCount += 1;
		} else {
			this.completedCount += 1;
		}
		this.recentTools = [completed, ...this.recentTools].slice(0, MAX_RECENT_TOOLS);
		this.notify();
	}

	settle(now?: number): void {
		if (this.phase === "idle" && this.activeTools.size === 0) return;
		if (this.phase === "settled" && this.activeTools.size === 0) return;

		const settledAt = normalizeTimestamp(now ?? Date.now());
		const failedActiveTools = Array.from(this.activeTools.values(), (tool) =>
			freezeTool({
				...tool,
				status: "failed",
				durationMs: Math.max(0, settledAt - tool.startedAt),
			}),
		);
		this.activeTools = new Map<string, ToolActivity>();
		for (const tool of failedActiveTools) {
			this.failedCount += 1;
			this.recentTools.unshift(tool);
		}
		this.recentTools = this.recentTools.slice(0, MAX_RECENT_TOOLS);
		this.phase = "settled";
		this.durationMs = Math.max(0, settledAt - (this.startedAt ?? settledAt));
		this.notify();
	}

	reset(): void {
		if (this.isEmpty()) return;

		this.phase = "idle";
		this.turnNumber = undefined;
		this.startedAt = undefined;
		this.durationMs = undefined;
		this.activeTools = new Map<string, ToolActivity>();
		this.recentTools = [];
		this.completedCount = 0;
		this.failedCount = 0;
		this.notify();
	}

	isRunning(): boolean {
		return this.phase === "running";
	}

	getSnapshot(): RunActivitySnapshot {
		const activeTools = freezeToolArray(Array.from(this.activeTools.values()));
		const recentTools = freezeToolArray(this.recentTools);
		const snapshot: RunActivitySnapshot = {
			phase: this.phase,
			...(this.turnNumber === undefined ? {} : { turnNumber: this.turnNumber }),
			...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
			...(this.durationMs === undefined ? {} : { durationMs: this.durationMs }),
			activeTools,
			recentTools,
			completedCount: this.completedCount,
			failedCount: this.failedCount,
		};
		return Object.freeze(snapshot);
	}

	private notify(): void {
		this.onChange?.(this.getSnapshot());
	}

	private isEmpty(): boolean {
		return (
			this.phase === "idle" &&
			this.turnNumber === undefined &&
			this.startedAt === undefined &&
			this.durationMs === undefined &&
			this.activeTools.size === 0 &&
			this.recentTools.length === 0 &&
			this.completedCount === 0 &&
			this.failedCount === 0
		);
	}
}

function normalizeTimestamp(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.trunc(value));
}

function freezeTool(tool: ToolActivity): ToolActivity {
	return Object.freeze({ ...tool });
}

function cloneTool(tool: ToolActivity): ToolActivity {
	return freezeTool(tool.durationMs === undefined ? { ...tool } : { ...tool, durationMs: tool.durationMs });
}

function freezeToolArray(tools: readonly ToolActivity[]): readonly ToolActivity[] {
	return Object.freeze(tools.map(cloneTool));
}

function sanitizeToolName(name: string): string {
	return truncateSummary(sanitizeText(name), MAX_SUMMARY_COLUMNS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	return typeof value === "string" ? value : "";
}

function sanitizeText(value: string): string {
	return value
		.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function summarizePatternTool(args: Record<string, unknown>, cwd: string): string {
	const pattern = sanitizeText(getString(args, "pattern"));
	if (pattern.length === 0) return "";

	const targetPath = shortenPath(getString(args, "path"), cwd);
	if (targetPath.length === 0) return truncateSummary(pattern, MAX_SUMMARY_COLUMNS);

	const combined = `${pattern} in ${targetPath}`;
	if (visibleWidth(combined) <= MAX_SUMMARY_COLUMNS) return combined;
	return truncateSummary(pattern, MAX_SUMMARY_COLUMNS);
}

function shortenPath(pathValue: string, cwd: string): string {
	const safePath = sanitizeText(pathValue);
	if (safePath.length === 0) return "";

	const normalizedCwd = nodePath.resolve(sanitizeText(cwd));
	const normalizedPath = nodePath.isAbsolute(safePath)
		? nodePath.normalize(safePath)
		: nodePath.resolve(normalizedCwd, safePath);

	const projectRelativePath = safeRelativePath(normalizedCwd, normalizedPath);
	if (projectRelativePath !== undefined) return projectRelativePath;

	const home = sanitizeText(process.env.HOME ?? "");
	if (home.length > 0) {
		const normalizedHome = nodePath.resolve(home);
		const homeRelativePath = safeRelativePath(normalizedHome, normalizedPath);
		if (homeRelativePath !== undefined) return homeRelativePath === "." ? "~" : `~/${homeRelativePath}`;
	}

	return normalizedPath;
}

function safeRelativePath(fromPath: string, toPath: string): string | undefined {
	const relativePath = nodePath.relative(fromPath, toPath);
	if (relativePath === "") return ".";
	if (
		nodePath.isAbsolute(relativePath) ||
		relativePath === ".." ||
		relativePath.startsWith(`..${nodePath.sep}`)
	) {
		return undefined;
	}
	return relativePath;
}

function truncateSummary(value: string, maxColumns: number): string {
	return sanitizeText(truncateToWidth(value, maxColumns, "…"));
}

import nodePath from "node:path";
import type { ToolExecutionEndEvent, ToolExecutionStartEvent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { displayHomePath, displayPathWithin } from "./display-path.js";
import { isRecord, PLACEHOLDER, sanitizeInline } from "./text.js";
import type { DisplayValue, ResponsePerformance } from "./types.js";

export interface ToolActivity {
	id: string;
	name: string;
	summary: string;
	status: "running" | "done" | "failed";
	startedAt: number;
	durationMs?: number;
}

export interface RunActivitySnapshot {
	phase: "idle" | "running" | "settled";
	turnNumber?: number;
	startedAt?: number;
	durationMs?: number;
	performance?: ResponsePerformance;
	activeTools: readonly ToolActivity[];
	recentTools: readonly ToolActivity[];
	completedCount: number;
	failedCount: number;
}

export interface RunActivityTracker {
	startRun(): void;
	startTurn(turnIndex: number): void;
	startResponse(): void;
	resetResponse(): void;
	updateResponseEstimate(estimatedOutputTokens: number): void;
	finishResponse(outputTokens: number): void;
	startTool(event: ToolExecutionStartEvent): void;
	finishTool(event: ToolExecutionEndEvent): void;
	settle(): void;
	reset(): void;
	isRunning(): boolean;
	getSnapshot(): RunActivitySnapshot;
}

export interface RunActivityTrackerOptions {
	cwd: string;
	onChange?: () => void;
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

export function responsePerformanceValues(performance?: ResponsePerformance): {
	ttft: DisplayValue;
	tps: DisplayValue;
} {
	const ttftMs = performance?.ttftMs;
	const tokensPerSecond = performance?.tokensPerSecond;
	return {
		ttft:
			ttftMs !== undefined && Number.isFinite(ttftMs)
				? { text: formatTtft(ttftMs), available: true }
				: { text: PLACEHOLDER, available: false },
		tps:
			tokensPerSecond !== undefined && Number.isFinite(tokensPerSecond)
				? {
						text: `${performance?.estimated ? "~" : ""}${Math.max(0, tokensPerSecond).toFixed(1)}`,
						available: true,
					}
				: { text: PLACEHOLDER, available: false },
	};
}

function formatTtft(ttftMs: number): string {
	const safe = Math.max(0, ttftMs);
	return safe < 1_000 ? `${Math.round(safe)}ms` : `${(safe / 1_000).toFixed(1)}s`;
}

export function formatDuration(durationMs: number): string {
	const totalSeconds = Number.isFinite(durationMs) ? Math.floor(Math.max(0, durationMs) / 1_000) : 0;
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
			return truncateSummary(sanitizeInline(getString(args, "command")));
		case "read":
		case "edit":
		case "write":
		case "ls":
			return truncateSummary(shortenPath(getString(args, "path"), cwd));
		case "grep":
		case "find":
			return summarizePatternTool(args, cwd);
		default:
			return "";
	}
}

interface TrackerState {
	phase: RunActivitySnapshot["phase"];
	turnNumber: number | undefined;
	startedAt: number | undefined;
	durationMs: number | undefined;
	/** In-flight provider request; performance exists once the first token arrives. */
	response: { requestedAt: number; firstTokenAt?: number } | undefined;
	performance: ResponsePerformance | undefined;
	activeTools: Map<string, ToolActivity>;
	recentTools: ToolActivity[];
	completedCount: number;
	failedCount: number;
}

const initialState = (): TrackerState => ({
	phase: "idle",
	turnNumber: undefined,
	startedAt: undefined,
	durationMs: undefined,
	response: undefined,
	performance: undefined,
	activeTools: new Map(),
	recentTools: [],
	completedCount: 0,
	failedCount: 0,
});

const isInitial = (state: TrackerState): boolean =>
	state.phase === "idle" &&
	state.turnNumber === undefined &&
	state.startedAt === undefined &&
	state.response === undefined &&
	state.performance === undefined &&
	state.activeTools.size === 0 &&
	state.recentTools.length === 0 &&
	state.completedCount === 0 &&
	state.failedCount === 0;

export function createRunActivityTracker(options: RunActivityTrackerOptions): RunActivityTracker {
	let state = initialState();
	const notify = (): void => options.onChange?.();

	return {
		startRun() {
			state = { ...initialState(), phase: "running", startedAt: Date.now() };
			notify();
		},
		startTurn(turnIndex) {
			const turnNumber = Math.max(0, Math.trunc(turnIndex)) + 1;
			if (state.turnNumber === turnNumber && state.phase === "running") return;
			state.phase = "running";
			state.turnNumber = turnNumber;
			state.durationMs = undefined;
			notify();
		},
		startResponse() {
			state.response = { requestedAt: Date.now() };
			state.performance = undefined;
			notify();
		},
		/** A response partly observed while disabled has no reliable TTFT or TPS. */
		resetResponse() {
			state.response = undefined;
			state.performance = undefined;
			notify();
		},
		updateResponseEstimate(estimatedOutputTokens) {
			const response = state.response;
			if (!response || !Number.isFinite(estimatedOutputTokens) || estimatedOutputTokens <= 0) return;
			const observedAt = Date.now();
			if (response.firstTokenAt === undefined) {
				response.firstTokenAt = observedAt;
				state.performance = { ttftMs: Math.max(0, observedAt - response.requestedAt) };
				notify();
				return;
			}
			const generationMs = observedAt - response.firstTokenAt;
			if (generationMs <= 0 || !state.performance) return;
			state.performance = {
				ttftMs: state.performance.ttftMs,
				tokensPerSecond: estimatedOutputTokens / (generationMs / 1_000),
				estimated: true,
			};
			notify();
		},
		finishResponse(outputTokens) {
			const firstTokenAt = state.response?.firstTokenAt;
			state.response = undefined;
			if (firstTokenAt === undefined || !state.performance) return;
			const generationMs = Date.now() - firstTokenAt;
			if (!Number.isFinite(outputTokens) || outputTokens <= 0 || generationMs <= 0) return;
			state.performance = {
				ttftMs: state.performance.ttftMs,
				tokensPerSecond: outputTokens / (generationMs / 1_000),
			};
			notify();
		},
		startTool(event) {
			const id = sanitizeInline(event.toolCallId);
			if (id.length === 0) return;
			state.phase = "running";
			state.durationMs = undefined;
			state.activeTools.set(id, {
				id,
				name: truncateSummary(sanitizeInline(event.toolName)),
				summary: summarizeTool(event.toolName, event.args, options.cwd),
				status: "running",
				startedAt: Date.now(),
			});
			notify();
		},
		finishTool(event) {
			const id = sanitizeInline(event.toolCallId);
			const active = state.activeTools.get(id);
			if (!active) return;
			state.activeTools.delete(id);
			const status = event.isError ? "failed" : "done";
			if (status === "failed") state.failedCount += 1;
			else state.completedCount += 1;
			const completed: ToolActivity = {
				...active,
				status,
				durationMs: Math.max(0, Date.now() - active.startedAt),
			};
			state.recentTools = [completed, ...state.recentTools].slice(0, MAX_RECENT_TOOLS);
			notify();
		},
		settle() {
			if (state.phase !== "running" && state.activeTools.size === 0) return;
			const settledAt = Date.now();
			const interrupted = Array.from(
				state.activeTools.values(),
				(tool): ToolActivity => ({
					...tool,
					status: "failed",
					durationMs: Math.max(0, settledAt - tool.startedAt),
				}),
			);
			state.activeTools = new Map();
			state.failedCount += interrupted.length;
			state.recentTools = [...interrupted.reverse(), ...state.recentTools].slice(0, MAX_RECENT_TOOLS);
			state.phase = "settled";
			state.durationMs = Math.max(0, settledAt - (state.startedAt ?? settledAt));
			notify();
		},
		reset() {
			if (isInitial(state)) return;
			state = initialState();
			notify();
		},
		isRunning: () => state.phase === "running",
		getSnapshot() {
			return {
				phase: state.phase,
				...(state.turnNumber === undefined ? {} : { turnNumber: state.turnNumber }),
				...(state.startedAt === undefined ? {} : { startedAt: state.startedAt }),
				...(state.durationMs === undefined ? {} : { durationMs: state.durationMs }),
				...(state.performance === undefined ? {} : { performance: state.performance }),
				activeTools: [...state.activeTools.values()],
				recentTools: [...state.recentTools],
				completedCount: state.completedCount,
				failedCount: state.failedCount,
			};
		},
	};
}

function getString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	return typeof value === "string" ? value : "";
}

function summarizePatternTool(args: Record<string, unknown>, cwd: string): string {
	const pattern = sanitizeInline(getString(args, "pattern"));
	if (pattern.length === 0) return "";
	const targetPath = shortenPath(getString(args, "path"), cwd);
	const combined = `${pattern} in ${targetPath}`;
	if (targetPath.length > 0 && visibleWidth(combined) <= MAX_SUMMARY_COLUMNS) return combined;
	return truncateSummary(pattern);
}

function shortenPath(pathValue: string, cwd: string): string {
	const safePath = sanitizeInline(pathValue);
	if (safePath.length === 0) return "";
	const normalizedCwd = nodePath.resolve(sanitizeInline(cwd));
	const normalizedPath = nodePath.resolve(normalizedCwd, safePath);
	return displayPathWithin(normalizedCwd, normalizedPath) ?? displayHomePath(normalizedPath);
}

/** `truncateToWidth` appends SGR resets when it truncates; strip them so summaries stay plain text. */
function truncateSummary(value: string): string {
	return sanitizeInline(truncateToWidth(value, MAX_SUMMARY_COLUMNS, "…"));
}

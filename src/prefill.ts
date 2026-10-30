/** Live prefill progress read from the provider's own stream chunks. */

import { formatTokens } from "./metrics.js";
import { isRecord } from "./text.js";
export interface PrefillSnapshot {
	/** Share of uncached prompt tokens processed, 0 through 1. */
	percent: number;
	processed: number;
	total: number;
	uncachedTotal: number;
	/** Uncached tokens already processed: the cached prefix is not work the user is waiting for. */
	uncachedProcessed: number;
	/** Instantaneous rate from the delta between consecutive progress chunks. */
	ratePerSec: number | null;
	/** Estimated seconds until the first generated token, when a rate is known. */
	etaSec: number | null;
}

export interface PrefillTrackerOptions {
	providers: readonly string[];
	/** Clock injection for deterministic tests. */
	now?: () => number;
}

/** A bar that flashes for 20 ms is noise: these decide when progress is worth drawing. */
export const SIGNIFICANT_TOKENS = 1_024;
export const SIGNIFICANT_MS = 300;
/** A fast local server emits chunks every few milliseconds; the dock is redrawn far less often. */
export const RENDER_THROTTLE_MS = 120;

export const OPENAI_COMPLETIONS_API = "openai-completions";

/**
 * The subset of Pi's model info prefill needs, declared locally so the pinned Pi types stay
 * untouched. `id` is compared with the model the request body names.
 */
export interface PrefillModel {
	api?: string;
	id?: string;
	provider?: string;
}

export type PrefillView = "percent" | "tokens" | "eta" | "rate";

/** Views the sidebar dock can show, in the order its rows are drawn. The rate rides the
 *  ETA row when both are asked for, and takes a `Speed` row of its own when it cannot. */
export const SIDEBAR_PREFILL_VIEWS: readonly PrefillView[] = ["percent", "tokens", "eta", "rate"];

export interface PrefillTracker {
	noteRequest(model: PrefillModel | undefined, payload: unknown): boolean;
	noteChunk(data: unknown): PrefillSnapshot | undefined;
	/** Drop the progress of the current request: a run ended by other means. */
	clear(): void;
	getSnapshot(): PrefillSnapshot | undefined;
}

/** A per-chunk rate is only worth drawing when it is a real number: a chunk whose
 *  `time_ms` did not advance yields a divide-by-zero spike rather than a speed. */
function usableRate(ratePerSec: number | null): ratePerSec is number {
	return ratePerSec !== null && Number.isFinite(ratePerSec) && ratePerSec > 0;
}

/** Tokens per second, compact: `3400` → `3.4k tok/s`, `840` → `840 tok/s`. */
function formatRate(ratePerSec: number): string {
	return `${formatTokens(Math.round(ratePerSec))} tok/s`;
}

export interface PrefillRow {
	label: string;
	value: string;
}

/**
 * Rows the PREFILL panel shows for the configured views. `percent` is not a row of its
 * own — it rides the bar. `rate` is shown where it has a number of its own to sit with:
 *  - `eta` and `rate` both requested and both usable → one `First token` row, `~4s · 3.4k tok/s`
 *  - only `eta` usable → `First token  ~4s`, with no rate text
 *  - `rate` usable while `eta` is not requested or not usable → its own `Speed` row
 * Either view order yields exactly one rate-bearing row, never two.
 */

export function formatPrefillRows(snapshot: PrefillSnapshot, views: readonly PrefillView[]): PrefillRow[] {
	const etaText =
		views.includes("eta") && snapshot.etaSec !== null
			? `~${Math.max(1, Math.round(snapshot.etaSec))}s`
			: undefined;
	const rateText =
		views.includes("rate") && usableRate(snapshot.ratePerSec) ? formatRate(snapshot.ratePerSec) : undefined;
	const rows: PrefillRow[] = [];
	const seen = new Set<PrefillView>();
	for (const view of views) {
		if (seen.has(view)) continue;
		seen.add(view);
		if (view === "tokens") {
			rows.push({
				label: "Tokens",
				value: `${formatTokens(snapshot.uncachedProcessed)} / ${formatTokens(snapshot.uncachedTotal)}`,
			});
		} else if (view === "eta" && etaText !== undefined) {
			// The rate rides the ETA row when both views were asked for, so one row carries both.
			rows.push({
				label: "First token",
				value: rateText === undefined ? etaText : `${etaText} · ${rateText}`,
			});
		} else if (view === "rate" && rateText !== undefined && etaText === undefined) {
			rows.push({ label: "Speed", value: rateText });
		}
	}
	return rows;
}

interface PromptProgress {
	total?: number;
	cache?: number;
	processed?: number;
	time_ms?: number;
}

function isGenerationStart(data: unknown): boolean {
	const choice = (data as { choices?: { delta?: unknown; finish_reason?: unknown }[] } | undefined)
		?.choices?.[0];
	if (!choice) return false;
	if (choice.finish_reason != null) return true;
	const delta = choice.delta as
		| { content?: unknown; tool_calls?: unknown; reasoning_content?: unknown; reasoning?: unknown }
		| undefined;
	if (delta == null) return false;
	return (
		(typeof delta.content === "string" && delta.content.length > 0) ||
		Array.isArray(delta.content) ||
		Array.isArray(delta.tool_calls) ||
		(typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) ||
		(typeof delta.reasoning === "string" && delta.reasoning.length > 0)
	);
}

function readProgress(data: unknown): PromptProgress | undefined {
	const progress = (data as { prompt_progress?: PromptProgress } | undefined)?.prompt_progress;
	if (!progress || typeof progress.total !== "number") return undefined;
	return progress;
}

/**
 * Which providers get `return_progress` added to their request body. OpenAI-compatible
 * servers ignore unknown body fields, so a server that cannot report progress never sends
 * `prompt_progress` chunks and the panel stays absent. No status code disables a provider:
 * llama.cpp answers 400 when a prompt exceeds its context size, which says nothing about
 * the field.
 */
export function createPrefillTracker(options: PrefillTrackerOptions): PrefillTracker {
	const now = options.now ?? Date.now;
	const providers = new Set(
		options.providers.map((provider) => provider.trim().toLowerCase()).filter(Boolean),
	);
	let snapshot: PrefillSnapshot | undefined;
	let previousProcessed = 0;
	let previousTimeMs = 0;
	let firstSeenAt = 0;
	let assessed = false;
	let tracking = false;

	const reset = (): void => {
		snapshot = undefined;
		previousProcessed = 0;
		previousTimeMs = 0;
		firstSeenAt = 0;
		assessed = false;
		tracking = false;
	};

	return {
		noteRequest(model, payload): boolean {
			reset();
			if (typeof model?.provider !== "string") return false;
			if (model.api !== OPENAI_COMPLETIONS_API) return false;
			const provider = model.provider.trim().toLowerCase();
			if (!providers.has(provider)) return false;
			if (!isRecord(payload)) return false;
			if (payload.stream === false) return false;
			// Pi reports the selected model, not the one a request ended up with: a virtual
			// selection routes to another model and an extension may redirect. Inject only into a
			// body that names the model the allow-list decision was made for.
			if (payload.model !== model.id) return false;
			return true;
		},
		noteChunk(data: unknown): PrefillSnapshot | undefined {
			if (isGenerationStart(data)) {
				snapshot = undefined;
				tracking = false;
				return undefined;
			}
			const progress = readProgress(data);
			if (!progress) return undefined;

			const total = progress.total as number;
			const cache = progress.cache ?? 0;
			const processed = progress.processed ?? 0;
			const timeMs = progress.time_ms ?? 0;
			const uncachedTotal = Math.max(0, total - cache);
			const uncachedProcessed = Math.min(uncachedTotal, Math.max(0, processed - cache));
			if (!assessed) {
				assessed = true;
				firstSeenAt = now();
				if (uncachedTotal > SIGNIFICANT_TOKENS) tracking = true;
				// The first chunk already counts the cached prefix. Seeding the delta base with the
				// cache keeps those tokens out of the first rate and the first ETA.
				previousProcessed = cache;
			} else if (!tracking && now() - firstSeenAt > SIGNIFICANT_MS) {
				tracking = true;
			}
			if (!tracking) return undefined;

			const deltaProcessed = processed - previousProcessed;
			const deltaMs = timeMs - previousTimeMs;
			const ratePerSec = deltaProcessed > 0 && deltaMs > 0 ? deltaProcessed / (deltaMs / 1000) : null;
			const remaining = Math.max(0, total - processed);

			snapshot = {
				percent: uncachedTotal > 0 ? uncachedProcessed / uncachedTotal : 1,
				processed,
				total,
				uncachedTotal,
				uncachedProcessed,
				ratePerSec,
				etaSec: ratePerSec !== null && ratePerSec > 0 && remaining > 0 ? remaining / ratePerSec : null,
			};
			previousProcessed = processed;
			previousTimeMs = timeMs;
			return snapshot;
		},
		getSnapshot: () => snapshot,
		clear: reset,
	};
}

export interface PrefillThrottleOptions {
	requestRender: () => void;
	/** Timer injection so the throttle stays testable and cancellable. */
	schedule: (delayMs: number, run: () => void) => () => void;
	now?: () => number;
	/** Shortest interval between dock renders while chunks arrive. */
	minIntervalMs?: number;
}

export interface PrefillThrottle {
	note(): void;
	cancel(): void;
}

/**
 * A fast local server streams progress far faster than the dock can be redrawn, so
 * renders are coalesced: one at once, then at most one more per interval.
 */
export function createPrefillThrottle(options: PrefillThrottleOptions): PrefillThrottle {
	const now = options.now ?? Date.now;
	const minIntervalMs = options.minIntervalMs ?? RENDER_THROTTLE_MS;
	let lastRenderAt = Number.NEGATIVE_INFINITY;
	let cancelPending: (() => void) | undefined;

	return {
		note(): void {
			if (cancelPending) return;
			const elapsed = now() - lastRenderAt;
			if (elapsed >= minIntervalMs) {
				lastRenderAt = now();
				options.requestRender();
				return;
			}
			cancelPending = options.schedule(minIntervalMs - elapsed, () => {
				cancelPending = undefined;
				lastRenderAt = now();
				options.requestRender();
			});
		},
		cancel(): void {
			cancelPending?.();
			cancelPending = undefined;
		},
	};
}

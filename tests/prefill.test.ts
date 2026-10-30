import { describe, expect, it } from "vitest";
import {
	type PrefillModel,
	type PrefillRow,
	type PrefillSnapshot,
	type PrefillView,
	createPrefillThrottle,
	createPrefillTracker,
	formatPrefillRows,
} from "../src/prefill.js";

const progress = (total: number, cache: number, processed: number, timeMs: number) => ({
	prompt_progress: { total, cache, processed, time_ms: timeMs },
});

/** Mid-prefill receipt: half the uncached prompt read, 3.4k tok/s, ~4s left. */
const snapshot = (overrides: Partial<PrefillSnapshot> = {}): PrefillSnapshot => ({
	percent: 0.52,
	processed: 14_100,
	total: 27_300,
	uncachedTotal: 14_300,
	uncachedProcessed: 7_436,
	ratePerSec: 3_400,
	etaSec: 3.8823529411764706,
	...overrides,
});

const prefilled = (): ReturnType<typeof createPrefillTracker> => {
	const tracker = createPrefillTracker({ providers: ["llama.cpp"], now: () => 1_000 });
	tracker.noteChunk(progress(2_000, 0, 1_000, 100));
	return tracker;
};

describe("prefill tracker", () => {
	it("reports progress from a chunk that carries prompt_progress", () => {
		const tracker = prefilled();

		expect(tracker.getSnapshot()).toMatchObject({ percent: 0.5, processed: 1_000, total: 2_000 });
	});

	it("ignores a chunk without usable prompt_progress", () => {
		const tracker = createPrefillTracker({ providers: ["llama.cpp"] });

		expect(tracker.noteChunk(undefined)).toBeUndefined();
		expect(tracker.noteChunk({ prompt_progress: { processed: 10 } })).toBeUndefined();
		expect(tracker.getSnapshot()).toBeUndefined();
	});

	it("derives the instantaneous rate and ETA from the delta between chunks", () => {
		const tracker = createPrefillTracker({ providers: ["llama.cpp"] });
		tracker.noteChunk(progress(27_300, 13_000, 13_000, 1_000));
		const receipt = tracker.noteChunk(progress(27_300, 13_000, 17_800, 2_000));

		// 4800 uncached tokens in the 1s between the two chunks; 9500 still queued.
		expect(receipt?.uncachedTotal).toBe(14_300);
		expect(receipt?.ratePerSec).toBe(4_800);
		expect(receipt?.etaSec).toBeCloseTo(1.9792, 4);
	});

	it("keeps the cached prefix out of the first rate", () => {
		const tracker = createPrefillTracker({ providers: ["llama.cpp"] });
		const first = tracker.noteChunk(progress(21_024, 19_000, 19_500, 100));

		// 500 uncached tokens read in 100ms. The 19000 cached ones are not read work.
		expect(first?.uncachedProcessed).toBe(500);
		expect(first?.ratePerSec).toBe(5_000);
		expect(first?.etaSec).toBeCloseTo(0.3048, 4);
	});

	it("measures progress against uncached tokens, not the whole prompt", () => {
		let now = 1_000;
		const tracker = createPrefillTracker({ providers: ["llama.cpp"], now: () => now });
		// A warm prompt: llama.cpp reports the cached prefix as already processed.
		const warm = (processed: number) => progress(10_900, 9_937, processed, processed - 9_937);

		expect(tracker.noteChunk(warm(9_937))).toBeUndefined();
		now = 1_400;
		const receipt = tracker.noteChunk(warm(9_946));

		expect(receipt?.uncachedTotal).toBe(963);
		expect(receipt?.uncachedProcessed).toBe(9);
		expect(receipt?.percent).toBeCloseTo(9 / 963, 6);
	});

	it("waits until the prefill is worth showing", () => {
		let now = 1_000;
		const tracker = createPrefillTracker({ providers: ["llama.cpp"], now: () => now });
		const small = (processed: number) => progress(512, 0, processed, processed);

		expect(tracker.noteChunk(small(200))).toBeUndefined();
		now = 1_350;
		expect(tracker.noteChunk(small(300))?.processed).toBe(300);

		// A large uncached prompt needs no waiting.
		expect(
			createPrefillTracker({ providers: ["llama.cpp"], now: () => 1_000 }).noteChunk(
				progress(1_025, 0, 1, 1),
			),
		).toBeDefined();
	});

	it("stops tracking at the first generated token", () => {
		const generationChunks = [
			{ choices: [{ finish_reason: "stop" }] },
			{ choices: [{ delta: { content: "hello" } }] },
			{ choices: [{ delta: { content: [{ text: "hello" }] } }] },
			{ choices: [{ delta: { tool_calls: [{ id: "1" }] } }] },
			{ choices: [{ delta: { reasoning_content: "thinking" } }] },
		];

		for (const chunk of generationChunks) {
			const tracker = prefilled();
			expect(tracker.noteChunk(chunk)).toBeUndefined();
			expect(tracker.getSnapshot()).toBeUndefined();
		}
	});

	it("starts every provider request from a clean slate", () => {
		const tracker = prefilled();
		tracker.noteRequest(
			{ api: "openai-completions", id: "qwen3.6-27b-q6", provider: "llama.cpp" },
			{ model: "qwen3.6-27b-q6", stream: true },
		);

		expect(tracker.getSnapshot()).toBeUndefined();
		expect(tracker.noteChunk(progress(2_000, 0, 100, 10))?.percent).toBe(0.05);
	});

	it("clears progress when a run settles without a generation chunk", () => {
		const tracker = prefilled();
		tracker.clear();

		expect(tracker.getSnapshot()).toBeUndefined();
	});

	it("asks only allow-listed openai-completions providers for progress", () => {
		const model = { api: "openai-completions", id: "qwen3.6-27b-q6", provider: "llama.cpp" };
		const stream = { model: "qwen3.6-27b-q6", stream: true, messages: [] };
		const asks = (providers: readonly string[], model: PrefillModel | undefined, payload: unknown) =>
			createPrefillTracker({ providers }).noteRequest(model, payload);

		expect(asks(["llama.cpp"], model, stream)).toBe(true);
		// The allow-list matches a provider name case- and whitespace-insensitively.
		expect(asks([" LLAMA.CPP "], model, stream)).toBe(true);
		expect(asks(["llama.cpp"], { ...model, api: "anthropic-messages" }, stream)).toBe(false);
		expect(asks(["llama.cpp"], { ...model, provider: "vllm" }, stream)).toBe(false);
		expect(asks([], model, stream)).toBe(false);
		expect(asks(["llama.cpp"], model, { stream: false })).toBe(false);
		expect(asks(["llama.cpp"], model, undefined)).toBe(false);
		expect(asks(["llama.cpp"], undefined, stream)).toBe(false);
		// Pi reports the selected model. A body naming another model, or naming none, gets nothing.
		expect(asks(["llama.cpp"], model, { ...stream, model: "qwen3.6-27b-q8" })).toBe(false);
		expect(asks(["llama.cpp"], model, { stream: true })).toBe(false);
	});
});

describe("prefill rows", () => {
	const ROWS: [PrefillView[], PrefillRow[]][] = [
		// percent rides the bar, so it is never a row of its own.
		[["percent"], []],
		[["tokens"], [{ label: "Tokens", value: "7.4k / 14k" }]],
		[["eta"], [{ label: "First token", value: "~4s" }]],
		[["rate"], [{ label: "Speed", value: "3.4k tok/s" }]],
		// The rate rides the ETA row whenever both are asked for, so one row carries both.
		[
			["percent", "tokens", "eta", "rate"],
			[
				{ label: "Tokens", value: "7.4k / 14k" },
				{ label: "First token", value: "~4s · 3.4k tok/s" },
			],
		],
		[
			["percent", "tokens", "eta"],
			[
				{ label: "Tokens", value: "7.4k / 14k" },
				{ label: "First token", value: "~4s" },
			],
		],
		// Either view order renders exactly one rate-bearing row, and a repeated entry draws once.
		[["eta", "rate"], [{ label: "First token", value: "~4s · 3.4k tok/s" }]],
		[["rate", "eta"], [{ label: "First token", value: "~4s · 3.4k tok/s" }]],
		[["eta", "eta", "rate"], [{ label: "First token", value: "~4s · 3.4k tok/s" }]],
	];

	it("draws one row per view in the configured order", () => {
		for (const [views, rows] of ROWS) expect(formatPrefillRows(snapshot(), views)).toEqual(rows);
	});

	it("omits a row whose number is missing", () => {
		const idle = snapshot({ processed: 0, uncachedProcessed: 0, percent: 0, ratePerSec: null, etaSec: null });

		expect(formatPrefillRows(idle, ["percent", "tokens", "eta", "rate"])).toEqual([
			{ label: "Tokens", value: "0 / 14k" },
		]);
	});

	it("withholds a rate that is not a usable number", () => {
		// A chunk whose time_ms did not advance yields 0 or a divide-by-zero spike; neither is drawn.
		for (const ratePerSec of [null, 0, Number.NaN, Number.POSITIVE_INFINITY])
			expect(formatPrefillRows(snapshot({ ratePerSec }), ["eta", "rate"])).toEqual([
				{ label: "First token", value: "~4s" },
			]);
		expect(formatPrefillRows(snapshot({ ratePerSec: Number.NaN, etaSec: null }), ["eta", "rate"])).toEqual(
			[],
		);
		// A usable rate with no ETA to sit with takes its own row instead of vanishing.
		expect(formatPrefillRows(snapshot({ ratePerSec: 840, etaSec: null }), ["eta", "rate"])).toEqual([
			{ label: "Speed", value: "840 tok/s" },
		]);
	});
});

describe("prefill render throttle", () => {
	it("renders the first progress chunk at once and coalesces the rest", () => {
		const renders: number[] = [];
		const timers: Array<{ at: number; run: () => void }> = [];
		const throttle = createPrefillThrottle({
			requestRender: () => renders.push(1),
			schedule: (delayMs, run) => {
				timers.push({ at: delayMs, run });
				return () => timers.shift();
			},
			now: () => 1_000,
		});

		throttle.note();
		throttle.note();

		expect(renders).toHaveLength(1);
		expect(timers).toHaveLength(1);
		timers[0]?.run();
		expect(renders).toHaveLength(2);
	});

	it("drops a pending render when the panel goes away", () => {
		const renders: number[] = [];
		let cancel: (() => void) | undefined;
		const throttle = createPrefillThrottle({
			requestRender: () => renders.push(1),
			schedule: (_delayMs, run) => {
				cancel = () => run();
				return () => {
					cancel = undefined;
				};
			},
			now: () => 1_000,
		});

		throttle.note();
		throttle.note();
		throttle.cancel();

		expect(cancel).toBeUndefined();
		expect(renders).toHaveLength(1);
	});
});

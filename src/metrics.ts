import type { AtelierMetrics } from "./types.js";

export interface UsageMessage {
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
	};
}

export interface AggregateOptions {
	subscription: boolean;
	context?: { tokens: number | null; contextWindow: number; percent: number | null };
	autoCompact: boolean | null;
}

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);
const finite = (value: number | undefined): number => (isFiniteNumber(value) ? value : 0);
const finiteOrNull = (value: number | null | undefined): number | null =>
	isFiniteNumber(value) ? value : null;

export function aggregateMetrics(
	messages: readonly UsageMessage[],
	options: AggregateOptions,
): AtelierMetrics {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let cacheHitPercent: number | undefined;
	let usageAvailable = false;
	let costAvailable = false;

	for (const { usage } of messages) {
		const messageInput = usage?.input;
		const messageOutput = usage?.output;
		const messageCacheRead = usage?.cacheRead;
		const messageCacheWrite = usage?.cacheWrite;
		if (
			!isFiniteNumber(messageInput) ||
			!isFiniteNumber(messageOutput) ||
			!isFiniteNumber(messageCacheRead) ||
			!isFiniteNumber(messageCacheWrite)
		)
			continue;
		usageAvailable = true;
		const messageCost = usage?.cost?.total;
		if (isFiniteNumber(messageCost)) {
			costAvailable = true;
			cost += messageCost;
		}
		input += messageInput;
		output += messageOutput;
		cacheRead += messageCacheRead;
		cacheWrite += messageCacheWrite;
		const prompt = messageInput + messageCacheRead + messageCacheWrite;
		// Cache hit describes the latest request, not the session aggregate.
		cacheHitPercent = prompt > 0 ? (messageCacheRead / prompt) * 100 : undefined;
	}

	const context = options.context;
	return {
		usageAvailable,
		costAvailable,
		input,
		output,
		cacheRead,
		cacheWrite,
		...(cacheHitPercent === undefined ? {} : { cacheHitPercent }),
		cost,
		subscription: options.subscription,
		contextTokens: finiteOrNull(context?.tokens),
		contextWindow: finite(context?.contextWindow),
		contextPercent: finiteOrNull(context?.percent),
		autoCompact: options.autoCompact,
	};
}

/** Compact count: `999`, `1.2k`, `12k`, `1.2M`, `12M`. */
export function formatTokens(count: number): string {
	const safe = Math.max(0, finite(count));
	if (safe < 1_000) return safe.toString();
	if (safe < 10_000) return `${(safe / 1_000).toFixed(1)}k`;
	if (safe < 1_000_000) return `${Math.round(safe / 1_000)}k`;
	if (safe < 10_000_000) return `${(safe / 1_000_000).toFixed(1)}M`;
	return `${Math.round(safe / 1_000_000)}M`;
}

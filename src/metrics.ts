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

const finite = (value: number | undefined): number => (Number.isFinite(value) ? (value ?? 0) : 0);

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

	for (const message of messages) {
		const usage = message.usage;
		if (
			!usage ||
			typeof usage !== "object" ||
			![usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(
				(value) => typeof value === "number" && Number.isFinite(value),
			)
		) {
			continue;
		}
		usageAvailable = true;
		costAvailable ||= typeof usage.cost?.total === "number" && Number.isFinite(usage.cost.total);
		input += finite(usage.input);
		output += finite(usage.output);
		cacheRead += finite(usage.cacheRead);
		cacheWrite += finite(usage.cacheWrite);
		cost += finite(usage.cost?.total);
		const prompt = finite(usage.input) + finite(usage.cacheRead) + finite(usage.cacheWrite);
		cacheHitPercent = prompt > 0 ? (finite(usage.cacheRead) / prompt) * 100 : undefined;
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
		contextTokens: context?.tokens ?? null,
		contextWindow: finite(context?.contextWindow),
		contextPercent: context?.percent ?? null,
		autoCompact: options.autoCompact,
	};
}

export function formatTokens(count: number): string {
	const safe = Math.max(0, finite(count));
	if (safe < 1_000) return safe.toString();
	if (safe < 10_000) return `${(safe / 1_000).toFixed(1)}k`;
	if (safe < 1_000_000) return `${Math.round(safe / 1_000)}k`;
	if (safe < 10_000_000) return `${(safe / 1_000_000).toFixed(1)}M`;
	return `${Math.round(safe / 1_000_000)}M`;
}

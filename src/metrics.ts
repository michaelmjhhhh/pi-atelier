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

const decimals = (value: number): number => Math.min(6, Math.max(0, Math.trunc(finite(value))));
const usageValue = (metrics: AtelierMetrics, amount: number): string =>
	metrics.usageAvailable ? formatTokens(amount) : "—";

export function formatMetrics(metrics: AtelierMetrics, currencyDecimals: number): string {
	const parts = [
		`↑${usageValue(metrics, metrics.input)}`,
		`↓${usageValue(metrics, metrics.output)}`,
		`R${usageValue(metrics, metrics.cacheRead)}`,
	];
	if (metrics.cacheWrite > 0) parts.push(`W${usageValue(metrics, metrics.cacheWrite)}`);
	if (metrics.cacheHitPercent !== undefined && Number.isFinite(metrics.cacheHitPercent)) {
		parts.push(`CH${metrics.cacheHitPercent.toFixed(1)}%`);
	}
	const cost = metrics.costAvailable ? finite(metrics.cost).toFixed(decimals(currencyDecimals)) : "—";
	parts.push(`$${cost}${metrics.subscription ? " (sub)" : ""}`);
	return parts.join(" ");
}

export function formatContext(metrics: AtelierMetrics): string {
	const usage = metrics.contextPercent === null ? "?" : `${finite(metrics.contextPercent).toFixed(1)}%`;
	const compaction = metrics.autoCompact === true ? " (auto)" : metrics.autoCompact === null ? " (—)" : "";
	return `${usage}/${formatTokens(metrics.contextWindow)}${compaction}`;
}

export function formatCompactMetrics(metrics: AtelierMetrics, currencyDecimals: number): string {
	const parts = [
		`↑${usageValue(metrics, metrics.input)}↓${usageValue(metrics, metrics.output)}`,
		`R${usageValue(metrics, metrics.cacheRead)}${metrics.cacheWrite > 0 ? `W${usageValue(metrics, metrics.cacheWrite)}` : ""}`,
	];
	if (metrics.cacheHitPercent !== undefined && Number.isFinite(metrics.cacheHitPercent)) {
		parts.push(`CH${Math.round(metrics.cacheHitPercent)}%`);
	}
	const numericCost = finite(metrics.cost);
	const cost = !metrics.costAvailable
		? "—"
		: numericCost >= 1_000
			? formatTokens(numericCost)
			: numericCost.toFixed(Math.min(2, decimals(currencyDecimals)));
	parts.push(`$${cost}${metrics.subscription ? "(sub)" : ""}`);
	return `${parts[0]} ${parts[1]} ${parts.slice(2).join("")}`;
}

export function formatCompactContext(metrics: AtelierMetrics): string {
	const usage = metrics.contextPercent === null ? "?" : `${finite(metrics.contextPercent).toFixed(1)}%`;
	const compaction = metrics.autoCompact === true ? "(auto)" : metrics.autoCompact === null ? "(—)" : "";
	return `${usage}/${formatTokens(metrics.contextWindow)}${compaction}`;
}

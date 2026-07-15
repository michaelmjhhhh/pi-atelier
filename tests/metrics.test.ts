import { describe, expect, it } from "vitest";
import {
	aggregateMetrics,
	formatCompactContext,
	formatCompactMetrics,
	formatContext,
	formatMetrics,
	formatTokens,
} from "../src/metrics.js";

const messages = [
	{ usage: { input: 1_200, output: 500, cacheRead: 8_000, cacheWrite: 300, cost: { total: 0.125 } } },
	{ usage: { input: 2_000, output: 700, cacheRead: 18_000, cacheWrite: 0, cost: { total: 0.375 } } },
];

describe("metrics", () => {
	it("matches Pi cumulative totals and latest cache-hit semantics", () => {
		const result = aggregateMetrics(messages, {
			subscription: true,
			context: { tokens: 100_000, contextWindow: 372_000, percent: 26.8817 },
			autoCompact: true,
		});
		expect(result).toMatchObject({
			input: 3_200,
			output: 1_200,
			cacheRead: 26_000,
			cacheWrite: 300,
			cost: 0.5,
		});
		expect(result.cacheHitPercent).toBeCloseTo(90, 5);
		expect(formatMetrics(result, 3)).toBe("↑3.2k ↓1.2k R26k W300 CH90.0% $0.500 (sub)");
		expect(formatContext(result)).toBe("26.9%/372k (auto)");
	});

	it("handles missing and zero prompt usage without NaN", () => {
		const result = aggregateMetrics(
			[{ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }],
			{
				subscription: false,
				context: { tokens: null, contextWindow: 128_000, percent: null },
				autoCompact: false,
			},
		);
		expect(result.cacheHitPercent).toBeUndefined();
		expect(formatMetrics(result, 3)).toBe("↑0 ↓0 R0 $0.000");
		expect(formatContext(result)).toBe("?/128k");
	});

	it("marks absent or malformed usage as unavailable instead of throwing", () => {
		const result = aggregateMetrics([{} as never, { usage: { input: "invalid" } } as never], {
			subscription: false,
			autoCompact: null,
		});
		expect(result.usageAvailable).toBe(false);
		expect(result.costAvailable).toBe(false);
		expect(formatMetrics(result, 3)).toBe("↑— ↓— R— $—");
		expect(formatContext(result)).toBe("?/0 (—)");
	});

	it("uses compact attribution without dropping categories", () => {
		const result = aggregateMetrics(messages, {
			subscription: true,
			context: { tokens: 100_000, contextWindow: 372_000, percent: 26.8817 },
			autoCompact: true,
		});
		expect(formatCompactMetrics(result, 3)).toBe("↑3.2k↓1.2k R26kW300 CH90%$0.50(sub)");
		expect(formatCompactContext(result)).toBe("26.9%/372k(auto)");
	});

	it.each([
		[999, "999"],
		[1_200, "1.2k"],
		[12_400, "12k"],
		[1_500_000, "1.5M"],
	])("formats %d as %s", (value, expected) => {
		expect(formatTokens(value)).toBe(expected);
	});
});

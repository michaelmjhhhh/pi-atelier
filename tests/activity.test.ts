import { describe, expect, it } from "vitest";
import { selectWorkingPhrase } from "../src/activity.js";

describe("working phrases", () => {
	it.each([
		[0, "KNEADING"],
		[0.5, "PONDERING"],
		[0.999_999, "COMBOBULATING"],
		[1, "COMBOBULATING"],
		[-1, "KNEADING"],
		[Number.NaN, "KNEADING"],
	] as const)("selects a bounded phrase for random value %s", (randomValue, expected) => {
		expect(selectWorkingPhrase(randomValue)).toBe(expected);
	});
});

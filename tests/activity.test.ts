import { describe, expect, it } from "vitest";
import { selectWorkingPhrase, WORKING_PHRASES } from "../src/activity.js";

const expectedPhrases = [
	"KNEADING",
	"PERCOLATING",
	"MARINATING",
	"CARAMELIZING",
	"JULIENNING",
	"FLAMBÉING",
	"CHOREOGRAPHING",
	"MOONWALKING",
	"JITTERBUGGING",
	"SOCK-HOPPING",
	"BOOGIEING",
	"SHIMMYING",
	"EBBING",
	"UNDULATING",
	"PROPAGATING",
	"PHOTOSYNTHESIZING",
	"GERMINATING",
	"POLLINATING",
	"PONDERING",
	"RUMINATING",
	"COGITATING",
	"CEREBRATING",
	"DELIBERATING",
	"MUSING",
	"FROLICKING",
	"LOLLYGAGGING",
	"DILLY-DALLYING",
	"BOONDOGGLING",
	"SHENANIGANING",
	"RAZZLE-DAZZLING",
	"CLAUDING",
	"GITIFYING",
	"RETICULATING",
	"HYPERSPACING",
	"QUANTUMIZING",
	"COMBOBULATING",
] as const;

describe("working phrases", () => {
	it("contains exactly the approved reference-image phrases", () => {
		expect(WORKING_PHRASES).toEqual(expectedPhrases);
		expect(new Set(WORKING_PHRASES).size).toBe(36);
	});

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

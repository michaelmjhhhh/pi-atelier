import { describe, expect, it, vi } from "vitest";
import { createPalette } from "../src/palette.js";

const rgb = (red: number, green: number, blue: number, text = "X") =>
	`\u001b[38;2;${red};${green};${blue}m${text}\u001b[39m`;

const themed = (name?: string) => ({
	...(name === undefined ? {} : { name }),
	fg: vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`),
});

describe("Adaptive Midnight Spectrum", () => {
	it.each([
		["ready", rgb(110, 168, 254)],
		["input", rgb(110, 168, 254)],
		["context", rgb(110, 168, 254)],
		["output", rgb(177, 140, 255)],
		["menu", rgb(177, 140, 255)],
		["cache", rgb(125, 211, 252)],
		["working", rgb(255, 159, 67)],
		["cost", rgb(255, 159, 67)],
		["warning", rgb(255, 159, 67)],
		["error", rgb(255, 93, 115)],
	] as const)("paints dark %s with its exact RGB", (role, expected) => {
		expect(createPalette(themed("dark"), true).paint(role, "X")).toBe(expected);
	});

	it.each([
		["ready", rgb(36, 95, 191)],
		["input", rgb(36, 95, 191)],
		["context", rgb(36, 95, 191)],
		["output", rgb(112, 66, 193)],
		["menu", rgb(112, 66, 193)],
		["cache", rgb(8, 124, 158)],
		["working", rgb(180, 83, 9)],
		["cost", rgb(180, 83, 9)],
		["warning", rgb(180, 83, 9)],
		["error", rgb(198, 40, 69)],
	] as const)("paints light %s with its exact RGB", (role, expected) => {
		expect(createPalette(themed("light"), true).paint(role, "X")).toBe(expected);
	});

	it.each([
		["ready", "thinkingLow"],
		["input", "thinkingLow"],
		["context", "thinkingLow"],
		["output", "thinkingHigh"],
		["menu", "thinkingHigh"],
		["cache", "syntaxType"],
		["working", "mdHeading"],
		["cost", "mdHeading"],
		["warning", "warning"],
		["error", "error"],
	] as const)("maps custom-theme %s to %s", (role, token) => {
		expect(createPalette(themed("nord"), true).paint(role, "X")).toBe(`<${token}>X</${token}>`);
	});

	it.each([
		["accent", "accent"],
		["primary", "text"],
		["muted", "muted"],
	] as const)("retains the %s compatibility role", (role, token) => {
		expect(createPalette(themed("dark"), true).paint(role, "X")).toBe(`<${token}>X</${token}>`);
	});

	it("uses custom mappings for unnamed themes", () => {
		expect(createPalette(themed(), true).paint("ready", "X")).toBe("<thinkingLow>X</thinkingLow>");
	});

	it("uses neutral and semantic roles without RGB when color is disabled", () => {
		const palette = createPalette(themed("dark"), false);
		for (const role of ["ready", "working", "input", "output", "cache", "cost", "context", "menu"] as const) {
			expect(palette.paint(role, "X")).toBe("<text>X</text>");
		}
		expect(palette.paint("warning", "X")).toBe("<warning>X</warning>");
		expect(palette.paint("error", "X")).toBe("<error>X</error>");
	});
});

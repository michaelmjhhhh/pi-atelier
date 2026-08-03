import { describe, expect, it, vi } from "vitest";
import { createPalette } from "../src/palette.js";
import type { AtelierColorScheme } from "../src/types.js";

const rgb = (red: number, green: number, blue: number, text = "X") =>
	`\u001b[38;2;${red};${green};${blue}m${text}\u001b[39m`;
const indexed = (index: number, text = "X") => `\u001b[38;5;${index}m${text}\u001b[39m`;

const themed = (name?: string) => ({
	...(name === undefined ? {} : { name }),
	fg: vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`),
});

const fixedDarkRoles = [
	["accent", rgb(177, 140, 255)],
	["primary", rgb(212, 212, 212)],
	["muted", rgb(128, 128, 128)],
	["dim", rgb(102, 102, 102)],
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
] as const;

describe("Fixed Dark Midnight Spectrum", () => {
	it.each(["dark", "light", "nord", "solarized"])(
		"uses the same dark palette for the selected %s theme",
		(themeName) => {
			const theme = themed(themeName);
			const palette = createPalette(theme, true);
			for (const [role, expected] of fixedDarkRoles) {
				expect(palette.paint(role, "X")).toBe(expected);
			}
			expect(theme.fg).not.toHaveBeenCalled();
		},
	);

	it("uses safe theme-token fallbacks only when the host theme is unnamed", () => {
		const theme = themed();
		const palette = createPalette(theme, true);
		expect(palette.paint("primary", "X")).toBe("<text>X</text>");
		expect(palette.paint("muted", "X")).toBe("<muted>X</muted>");
		expect(palette.paint("dim", "X")).toBe("<dim>X</dim>");
		expect(palette.paint("input", "X")).toBe("<thinkingLow>X</thinkingLow>");
		expect(palette.paint("working", "X")).toBe("<mdHeading>X</mdHeading>");
		expect(palette.paint("menu", "X")).toBe("<thinkingHigh>X</thinkingHigh>");
	});

	it("uses neutral and semantic roles without RGB when color is disabled", () => {
		const palette = createPalette(themed("light"), false);
		for (const role of ["ready", "working", "input", "output", "cache", "cost", "context", "menu"] as const) {
			expect(palette.paint(role, "X")).toBe("<text>X</text>");
		}
		expect(palette.paint("accent", "X")).toBe("<accent>X</accent>");
		expect(palette.paint("primary", "X")).toBe("<text>X</text>");
		expect(palette.paint("muted", "X")).toBe("<muted>X</muted>");
		expect(palette.paint("dim", "X")).toBe("<dim>X</dim>");
		expect(palette.paint("warning", "X")).toBe("<warning>X</warning>");
		expect(palette.paint("error", "X")).toBe("<error>X</error>");
	});

	it("can inherit the selected Pi theme tokens", () => {
		const theme = themed("catppuccin");
		const palette = createPalette(theme, true, "inherit");
		expect(palette.paint("primary", "X")).toBe("<text>X</text>");
		expect(palette.paint("input", "X")).toBe("<thinkingLow>X</thinkingLow>");
		expect(palette.paint("output", "X")).toBe("<thinkingHigh>X</thinkingHigh>");
		expect(palette.paint("warning", "X")).toBe("<warning>X</warning>");
		expect(theme.fg).toHaveBeenCalled();
	});

	it("accepts custom role colors with an inherited base", () => {
		const palette = createPalette(themed("dark"), true, {
			base: "inherit",
			accent: 0,
			primary: 255,
			output: "#cba6f7",
			cache: 45,
			working: "warning",
		});
		expect(palette.paint("accent", "X")).toBe(indexed(0));
		expect(palette.paint("primary", "X")).toBe(indexed(255));
		expect(palette.paint("output", "X")).toBe(rgb(203, 166, 247));
		expect(palette.paint("cache", "X")).toBe(indexed(45));
		expect(palette.paint("working", "X")).toBe("<warning>X</warning>");
		expect(palette.paint("input", "X")).toBe("<thinkingLow>X</thinkingLow>");
	});

	it("defaults malformed and invalid direct-call role specs", () => {
		const theme = themed("dark");
		const palette = createPalette(theme, true, {
			primary: "",
			muted: undefined,
			output: "#bad",
			cache: 256,
			cost: 1.5,
			context: -1,
			menu: Symbol("unsafe color"),
		} as unknown as AtelierColorScheme);
		for (const role of ["primary", "muted", "output", "cache", "cost", "context", "menu"] as const) {
			expect(palette.paint(role, "X")).toBe("\u001b[39mX\u001b[39m");
		}
		expect(theme.fg).not.toHaveBeenCalled();
	});

	it.each([null, true, 7, Symbol("unsafe scheme")])(
		"treats invalid direct-call color scheme %s as atelier with no overrides",
		(colorScheme) => {
			const theme = themed("dark");
			const palette = createPalette(theme, true, colorScheme as AtelierColorScheme);
			expect(palette.paint("output", "X")).toBe(rgb(177, 140, 255));
			expect(theme.fg).not.toHaveBeenCalled();
		},
	);

	it("ignores inherited direct-call role and base properties", () => {
		const theme = themed("dark");
		const palette = createPalette(theme, true, Object.create({ output: "#ff0000", base: "inherit" }));
		expect(palette.paint("output", "X")).toBe(rgb(177, 140, 255));
		expect(palette.paint("input", "X")).toBe(rgb(110, 168, 254));
		expect(theme.fg).not.toHaveBeenCalled();
	});
});

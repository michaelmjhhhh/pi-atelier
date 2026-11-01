import { describe, expect, it, vi } from "vitest";
import { createPalette, PALETTE_RGB, type PaletteRole } from "../src/palette.js";

const rgb = ([red, green, blue]: readonly number[], text = "X") =>
	`\u001b[38;2;${red};${green};${blue}m${text}\u001b[39m`;

const themed = (name?: string) => ({
	...(name === undefined ? {} : { name }),
	fg: vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`),
});

const linearize = (channel: number) => {
	const value = channel / 255;
	return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const luminance = ([red, green, blue]: readonly [number, number, number]) =>
	0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);

const contrast = (
	foreground: readonly [number, number, number],
	background: readonly [number, number, number],
) => {
	const foregroundLuminance = luminance(foreground);
	const backgroundLuminance = luminance(background);
	return (
		(Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
		(Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
	);
};

describe("Fixed Dark Midnight Spectrum", () => {
	it("keeps every text role at WCAG AA contrast on black and Midnight", () => {
		for (const [role, color] of Object.entries(PALETTE_RGB) as [
			PaletteRole,
			readonly [number, number, number],
		][]) {
			for (const background of [
				[0, 0, 0],
				[30, 30, 46],
			] as const) {
				expect(contrast(color, background), `${role} on ${background.join(",")}`).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	it.each(["dark", "light"])("paints the fixed truecolor palette for the named %s theme", (themeName) => {
		const theme = themed(themeName);
		const palette = createPalette(theme, true);
		for (const role of Object.keys(PALETTE_RGB) as PaletteRole[]) {
			expect(palette.paint(role, "X")).toBe(rgb(PALETTE_RGB[role]));
		}
		expect(theme.fg).not.toHaveBeenCalled();
	});

	it("uses safe theme-token fallbacks only when the host theme is unnamed", () => {
		const theme = themed();
		const palette = createPalette(theme, true);
		expect(palette.paint("primary", "X")).toBe("<text>X</text>");
		expect(palette.paint("muted", "X")).toBe("<muted>X</muted>");
		expect(palette.paint("dim", "X")).toBe("<dim>X</dim>");
		expect(palette.paint("input", "X")).toBe("<thinkingLow>X</thinkingLow>");
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
});

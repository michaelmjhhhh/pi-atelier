import { describe, expect, it, vi } from "vitest";
import { createPalette } from "../src/palette.js";

const theme = {
	fg: vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`),
};

describe("Midnight Amethyst palette", () => {
	it.each([
		["brand", "\u001b[38;2;177;140;255mX\u001b[39m"],
		["ready", "\u001b[38;2;110;168;254mX\u001b[39m"],
		["working", "\u001b[38;2;255;159;67mX\u001b[39m"],
		["cache", "\u001b[38;2;125;211;252mX\u001b[39m"],
		["cost", "\u001b[38;2;255;159;67mX\u001b[39m"],
		["error", "\u001b[38;2;255;93;115mX\u001b[39m"],
	] as const)("renders %s with exact true color", (role, expected) => {
		expect(createPalette(theme, true).paint(role, "X")).toBe(expected);
	});

	it("uses neutral theme colors without green or yellow fallback", () => {
		const fg = vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`);
		const palette = createPalette({ fg }, false);
		palette.paint("brand", "brand");
		palette.paint("input", "input");
		palette.paint("cache", "cache");
		palette.paint("cost", "cost");
		palette.paint("error", "error");
		expect(fg.mock.calls.map(([color]) => color)).toEqual(["accent", "text", "muted", "accent", "error"]);
		expect(fg).not.toHaveBeenCalledWith("success", expect.anything());
		expect(fg).not.toHaveBeenCalledWith("warning", expect.anything());
	});
});

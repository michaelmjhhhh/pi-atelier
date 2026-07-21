import { describe, expect, it, vi } from "vitest";
import { createPalette } from "../src/palette.js";

const theme = {
	fg: vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`),
};

describe("Status Rail palette", () => {
	it.each([
		["accent", "accent"],
		["primary", "text"],
		["muted", "muted"],
		["warning", "warning"],
		["error", "error"],
	] as const)("maps %s to the Pi %s theme role", (role, themeRole) => {
		expect(createPalette(theme, true).paint(role, "X")).toBe(`<${themeRole}>X</${themeRole}>`);
	});

	it("uses the same semantic hierarchy when color is disabled", () => {
		const fg = vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`);
		const palette = createPalette({ fg }, false);
		for (const role of ["accent", "primary", "muted", "warning", "error"] as const) {
			palette.paint(role, role);
		}
		expect(fg.mock.calls.map(([color]) => color)).toEqual([
			"accent",
			"text",
			"muted",
			"warning",
			"error",
		]);
	});
});

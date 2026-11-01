import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { isReservedShortcut } from "../src/shortcuts.js";

describe("shortcut reservations", () => {
	it("detects collisions with default and configured Atelier shortcuts", () => {
		const reserved = [DEFAULT_CONFIG.shortcut, "ctrl+o"];
		expect(isReservedShortcut("f6", reserved)).toBe(true);
		expect(isReservedShortcut("ctrl+o", reserved)).toBe(true);
		expect(isReservedShortcut("alt+r", reserved)).toBe(false);
	});

	it("treats modifier order as equivalent", () => {
		expect(isReservedShortcut("shift+ctrl+r", ["ctrl+shift+r"])).toBe(true);
	});
});

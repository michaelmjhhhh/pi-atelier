import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { isReservedShortcut, planShortcuts } from "../src/shortcuts.js";

const plan = (overrides: Partial<Parameters<typeof planShortcuts>[0]>) =>
	planShortcuts({
		shortcut: DEFAULT_CONFIG.shortcut,
		resizeShortcut: DEFAULT_CONFIG.resizeShortcut,
		toggleShortcut: DEFAULT_CONFIG.toggleShortcut,
		...overrides,
	});

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

describe("shortcut plan", () => {
	it("binds the default resize key and nothing else by default", () => {
		expect(plan({})).toEqual({ open: undefined, resize: "ctrl+shift+r", toggle: undefined, warnings: [] });
	});

	it("replaces the default resize key instead of adding to it", () => {
		expect(plan({ resizeShortcut: "alt+r" })).toMatchObject({ resize: "alt+r", warnings: [] });
	});

	it.each(["f6", "F6", "alt+o"])(
		"falls back to the default when resizeShortcut reuses an open key: %s",
		(key) => {
			expect(plan({ shortcut: "alt+o", resizeShortcut: key })).toMatchObject({
				resize: "ctrl+shift+r",
				warnings: [`resizeShortcut "${key}" is already an Atelier shortcut; using ctrl+shift+r`],
			});
		},
	);

	it("leaves resize unbound when the open shortcut already uses the default resize key", () => {
		expect(plan({ shortcut: "shift+ctrl+r" })).toMatchObject({
			open: "shift+ctrl+r",
			resize: undefined,
			warnings: ['resizeShortcut "ctrl+shift+r" is already an Atelier shortcut; Sidebar resize has no key'],
		});
	});

	it("rejects a toggle key that reuses the resolved resize key", () => {
		expect(plan({ resizeShortcut: "alt+r", toggleShortcut: "alt+r" })).toMatchObject({
			resize: "alt+r",
			toggle: undefined,
			warnings: ['toggleShortcut "alt+r" is already an Atelier shortcut'],
		});
		expect(plan({ resizeShortcut: "alt+r", toggleShortcut: "ctrl+shift+r" })).toMatchObject({
			toggle: "ctrl+shift+r",
			warnings: [],
		});
	});
});

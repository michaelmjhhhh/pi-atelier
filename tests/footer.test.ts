import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createFooterComponent, renderFooterLine, selectResponsiveMode } from "../src/footer.js";
import { DEFAULT_CONFIG, type AtelierState } from "../src/types.js";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
};
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

const state: AtelierState = {
	activity: "ready",
	modelId: "gpt-5.6-sol",
	provider: "openai-codex",
	thinkingLevel: "medium",
	branch: "main",
	dirty: true,
	metrics: {
		usageAvailable: true,
		costAvailable: true,
		input: 324_000,
		output: 15_000,
		cacheRead: 5_900_000,
		cacheWrite: 0,
		cacheHitPercent: 98.8,
		cost: 5.041,
		subscription: true,
		contextTokens: 100_000,
		contextWindow: 372_000,
		contextPercent: 27,
		autoCompact: true,
	},
	extensionStatuses: [],
};

describe("footer", () => {
	it("selects exact responsive modes", () => {
		expect([132, 131, 96, 95, 72, 71, 56, 55].map(selectResponsiveMode)).toEqual([
			"gallery",
			"balanced",
			"balanced",
			"focus",
			"focus",
			"telemetry",
			"telemetry",
			"safe",
		]);
	});

	it("uses the Midnight Amethyst palette without green or yellow theme roles", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const line = renderFooterLine(
			state,
			DEFAULT_CONFIG,
			{ fg, bold: (text) => text, italic: (text) => text },
			180,
		);
		expect(line).toContain("\u001b[38;2;110;168;254m↑324k\u001b[39m");
		expect(line).toContain("\u001b[38;2;177;140;255m↓15k\u001b[39m");
		expect(line).toContain("\u001b[38;2;125;211;252mR5.9M\u001b[39m");
		expect(line).toContain("\u001b[38;2;255;159;67m$5.041\u001b[39m");
		expect(line).toContain("\u001b[38;2;110;168;254m◔27.0%/372k\u001b[39m");
		expect(fg).not.toHaveBeenCalledWith("success", expect.anything());
		expect(fg).not.toHaveBeenCalledWith("warning", expect.anything());
	});

	it("uses neutral theme colors when true color is disabled", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		renderFooterLine(state, DEFAULT_CONFIG, { fg, bold: (text) => text, italic: (text) => text }, 180, false);
		const colors = fg.mock.calls.map(([color]) => color);
		expect(colors).not.toContain("success");
		expect(colors).not.toContain("warning");
		expect(colors).toEqual(expect.arrayContaining(["accent", "text", "muted"]));
		expect(colors.every((color) => ["accent", "text", "muted", "borderMuted", "error"].includes(color))).toBe(
			true,
		);
	});
	it.each([
		[132, true, true, true, true],
		[131, false, true, true, true],
		[95, false, true, false, true],
		[71, false, false, false, false],
		[55, false, false, false, false],
	] as const)("organizes width %d intentionally", (width, brand, model, git, menu) => {
		const line = renderFooterLine(state, DEFAULT_CONFIG, plainTheme, width);
		expect(line.includes("ATELIER")).toBe(brand);
		expect(line.includes("gpt-5.6-sol")).toBe(model);
		expect(line.includes("main")).toBe(git);
		expect(line.includes("⌥A")).toBe(menu);
		expect(line).not.toMatch(/^\s*[│·]/);
		expect(line).not.toMatch(/[│·]\s*$/);
		expect(line).not.toContain("│ │");
	});

	it("right-aligns telemetry in gallery mode", () => {
		const line = renderFooterLine(state, DEFAULT_CONFIG, plainTheme, 180);
		expect(visibleWidth(line)).toBe(180);
		expect(stripAnsi(line).endsWith("⌥A MENU")).toBe(true);
	});

	it("renders the full editorial layout at wide widths", () => {
		const line = renderFooterLine(state, DEFAULT_CONFIG, plainTheme, 160);
		expect(line).toContain("◆ ATELIER");
		const plainLine = stripAnsi(line);
		for (const group of ["↑324k ↓15k", "R5.9M CH98.8%", "$5.041 (sub)", "◔27.0%/372k (auto)"]) {
			expect(plainLine).toContain(group);
		}
		expect(plainLine).toContain("gpt-5.6-sol · medium");
		expect(plainLine).toContain("main ✦");
		expect(visibleWidth(line)).toBeLessThanOrEqual(160);
	});

	it("keeps ANSI-heavy themed output within every responsive width", () => {
		const ansiTheme = {
			fg: (_color: string, text: string) => `\u001b[38;5;45m${text}\u001b[0m`,
			bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
			italic: (text: string) => `\u001b[3m${text}\u001b[23m`,
		};
		for (const width of [132, 131, 96, 95, 72, 71, 56, 55, 20]) {
			expect(visibleWidth(renderFooterLine(state, DEFAULT_CONFIG, ansiTheme, width))).toBeLessThanOrEqual(
				width,
			);
		}
	});

	it.each([160, 100, 80, 56, 40, 12])("never exceeds width %d", (width) => {
		expect(visibleWidth(renderFooterLine(state, DEFAULT_CONFIG, plainTheme, width))).toBeLessThanOrEqual(
			width,
		);
	});

	it("preserves metrics and context at the supported narrow boundary", () => {
		const line = renderFooterLine(state, DEFAULT_CONFIG, plainTheme, 56);
		expect(line).toContain("↑324k");
		expect(line).toContain("CH99%");
		expect(line).toContain("27.0%/372k");
		expect(line).not.toContain("ATELIER");
	});

	it("honors ornament, density, and configured telemetry order", () => {
		const noOrnament = renderFooterLine(state, { ...DEFAULT_CONFIG, ornament: "none" }, plainTheme, 160);
		expect(noOrnament).not.toContain("ATELIER");
		const compact = renderFooterLine(state, { ...DEFAULT_CONFIG, density: "compact" }, plainTheme, 160);
		expect(compact).toContain("CH99%");
		const reordered = renderFooterLine(
			state,
			{ ...DEFAULT_CONFIG, ornament: "none", segments: ["context", "metrics"] },
			plainTheme,
			160,
		);
		expect(reordered.indexOf("◔27.0%")).toBeLessThan(reordered.indexOf("↑324k"));
		const contextOnly = renderFooterLine(
			state,
			{ ...DEFAULT_CONFIG, ornament: "none", segments: ["context"] },
			plainTheme,
			160,
		);
		expect(contextOnly).not.toContain("↑324k");
	});

	it("renders unavailable and non-finite telemetry safely", () => {
		const { cacheHitPercent: _cacheHitPercent, ...metricsWithoutHit } = state.metrics;
		const unavailableState: AtelierState = {
			...state,
			metrics: {
				...metricsWithoutHit,
				usageAvailable: false,
				costAvailable: false,
				contextPercent: null,
				autoCompact: null,
			},
		};
		const unavailableLine = renderFooterLine(unavailableState, DEFAULT_CONFIG, plainTheme, 160);
		for (const marker of ["↑—", "↓—", "R—", "CH—", "$—", "◔—/372k", "(—)"]) {
			expect(unavailableLine).toContain(marker);
		}
		const invalidLine = renderFooterLine(
			{
				...state,
				metrics: {
					...state.metrics,
					cacheHitPercent: Number.NaN,
					contextPercent: Number.POSITIVE_INFINITY,
					cost: Number.NaN,
				},
			},
			DEFAULT_CONFIG,
			plainTheme,
			160,
		);
		expect(invalidLine).not.toMatch(/NaN|Infinity/);
	});

	it("uses orange and red context colors at exact thresholds", () => {
		for (const [percent, rgb] of [
			[70, "255;159;67"],
			[90, "255;93;115"],
		] as const) {
			const line = renderFooterLine(
				{ ...state, metrics: { ...state.metrics, contextPercent: percent } },
				DEFAULT_CONFIG,
				plainTheme,
				160,
			);
			expect(line).toContain(`\u001b[38;2;${rgb}m◔${percent.toFixed(1)}%/372k\u001b[39m`);
		}
	});

	it("omits oversized optional statuses without downgrading Gallery", () => {
		const line = renderFooterLine(
			{ ...state, extensionStatuses: ["x".repeat(200)] },
			DEFAULT_CONFIG,
			plainTheme,
			160,
		);
		expect(line).toContain("ATELIER");
		expect(stripAnsi(line).endsWith("⌥A MENU")).toBe(true);
		expect(line).not.toContain("xxxxxxxxxx");
	});

	it("sanitizes extension status and honors optional visibility", () => {
		const line = renderFooterLine(
			{ ...state, extensionStatuses: ["workflow:\nrunning\t now"] },
			{ ...DEFAULT_CONFIG, segments: ["metrics", "context", "statuses"] },
			plainTheme,
			160,
		);
		expect(line).toContain("workflow: running now");
		expect(line).not.toContain("\n");
	});

	it.each([
		["menu", "metrics", "context"],
		["context", "menu", "metrics"],
	] as const)("preserves required telemetry at 56 columns for order %j", (...order) => {
		const line = renderFooterLine(state, { ...DEFAULT_CONFIG, segments: [...order] }, plainTheme, 56);
		for (const marker of ["↑", "↓", "R", "CH", "$", "/", "(auto)"]) expect(line).toContain(marker);
	});

	it("renders malformed context capacity as unavailable", () => {
		const line = renderFooterLine(
			{ ...state, metrics: { ...state.metrics, contextWindow: Number.POSITIVE_INFINITY } },
			DEFAULT_CONFIG,
			plainTheme,
			160,
		);
		expect(line).toContain("◔27.0%/—");
		expect(line).not.toContain("Infinity");
	});

	it("preserves every required category for worst-case values at 56 columns", () => {
		const extreme = {
			...state,
			metrics: {
				...state.metrics,
				input: 999_000_000,
				output: 999_000_000,
				cacheRead: 999_000_000,
				cacheWrite: 999_000_000,
				cacheHitPercent: 100,
				cost: 999_000_000,
				contextPercent: 100,
				contextWindow: 999_000_000,
			},
		};
		const line = renderFooterLine(extreme, DEFAULT_CONFIG, plainTheme, 56);
		for (const marker of ["↑", "↓", "R", "W", "CH", "$", "(sub)", "/", "(auto)"]) {
			expect(line).toContain(marker);
		}
		expect(visibleWidth(line)).toBeLessThanOrEqual(56);
	});

	it("renders the selected working phrase without changing it across redraws", () => {
		let current = state;
		const component = createFooterComponent({
			getState: () => current,
			getConfig: () => DEFAULT_CONFIG,
			requestRender: vi.fn(),
			onBranchChange: () => vi.fn(),
			theme: plainTheme,
		});

		expect(component.render(160)[0]).toContain("READY");
		current = { ...state, activity: "working", workingLabel: "PHOTOSYNTHESIZING" };
		expect(component.render(160)[0]).toContain("PHOTOSYNTHESIZING");
		expect(component.render(160)[0]).toContain("PHOTOSYNTHESIZING");
		expect(component.render(160)[0]).not.toContain("WORKING");
	});

	it("renders the full working phrase and dots in orange italics without italicizing the bullet", () => {
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			italic: (text: string) => `<i>${text}</i>`,
		};
		const working = { ...state, activity: "working" as const, workingLabel: "PONDERING" };
		const line = renderFooterLine(working, DEFAULT_CONFIG, theme, 160, true, "..");

		expect(line).toContain("\u001b[38;2;255;159;67m● <i>PONDERING..</i>\u001b[39m");
		expect(line).not.toContain("<i>●");
	});

	it.each([
		["ready", "READY"],
		["warning", "WARNING"],
		["error", "ERROR"],
		["working", "WORKING"],
	] as const)("renders %s with the expected fallback label", (activity, expected) => {
		const line = renderFooterLine({ ...state, activity }, DEFAULT_CONFIG, plainTheme, 160);
		expect(line).toContain(activity === "working" ? `${expected}...` : expected);
	});

	it("keeps the longest working phrase within responsive width limits", () => {
		const working = { ...state, activity: "working" as const, workingLabel: "PHOTOSYNTHESIZING" };
		for (const width of [132, 131, 96, 95, 72, 71, 56, 55, 20]) {
			expect(visibleWidth(renderFooterLine(working, DEFAULT_CONFIG, plainTheme, width))).toBeLessThanOrEqual(
				width,
			);
		}
	});

	it("disposes its branch subscription exactly once", () => {
		const unsubscribe = vi.fn();
		let callback: (() => void) | undefined;
		const requestRender = vi.fn();
		const component = createFooterComponent({
			getState: () => state,
			getConfig: () => DEFAULT_CONFIG,
			requestRender,
			onBranchChange: (listener) => {
				callback = listener;
				return unsubscribe;
			},
			theme: plainTheme,
		});
		callback?.();
		expect(requestRender).toHaveBeenCalledOnce();
		component.dispose();
		component.dispose();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});
});

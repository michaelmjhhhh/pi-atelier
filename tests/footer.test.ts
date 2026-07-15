import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createFooterComponent, renderFooterLine, selectResponsiveMode } from "../src/footer.js";
import { DEFAULT_CONFIG, type AtelierState } from "../src/types.js";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

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

	it("uses semantic jewel-tone theme groups", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const theme = { fg, bold: (text: string) => text };
		renderFooterLine(state, DEFAULT_CONFIG, theme, 180);
		expect(fg).toHaveBeenCalledWith("syntaxVariable", "↑324k");
		expect(fg).toHaveBeenCalledWith("success", "↓15k");
		expect(fg).toHaveBeenCalledWith("syntaxType", "R5.9M");
		expect(fg).toHaveBeenCalledWith("warning", "$5.041");
		expect(fg).toHaveBeenCalledWith("success", "◔27.0%/372k");
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
		expect(line.endsWith("⌥A MENU")).toBe(true);
	});

	it("renders the full editorial layout at wide widths", () => {
		const line = renderFooterLine(state, DEFAULT_CONFIG, plainTheme, 160);
		expect(line).toContain("◆ ATELIER");
		for (const group of ["↑324k ↓15k", "R5.9M CH98.8%", "$5.041 (sub)", "◔27.0%/372k (auto)"]) {
			expect(line).toContain(group);
		}
		expect(line).toContain("gpt-5.6-sol · medium");
		expect(line).toContain("main ✦");
		expect(visibleWidth(line)).toBeLessThanOrEqual(160);
	});

	it("keeps ANSI-heavy themed output within every responsive width", () => {
		const ansiTheme = {
			fg: (_color: string, text: string) => `\u001b[38;5;45m${text}\u001b[0m`,
			bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
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

	it("uses warning and error context colors at exact thresholds", () => {
		for (const [percent, color] of [
			[70, "warning"],
			[90, "error"],
		] as const) {
			const fg = vi.fn((_color: string, text: string) => text);
			renderFooterLine(
				{ ...state, metrics: { ...state.metrics, contextPercent: percent } },
				DEFAULT_CONFIG,
				{ fg, bold: (text) => text },
				160,
			);
			expect(fg).toHaveBeenCalledWith(color, `◔${percent.toFixed(1)}%/372k`);
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
		expect(line.endsWith("⌥A MENU")).toBe(true);
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

	it("rerenders changed state at the same width", () => {
		let current = state;
		const component = createFooterComponent({
			getState: () => current,
			getConfig: () => DEFAULT_CONFIG,
			requestRender: vi.fn(),
			onBranchChange: () => vi.fn(),
			theme: plainTheme,
		});
		expect(component.render(160)[0]).toContain("READY");
		current = { ...state, activity: "working" };
		expect(component.render(160)[0]).toContain("WORKING");
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

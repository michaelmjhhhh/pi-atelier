import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createFooterComponent, renderFooterLine, selectResponsiveMode } from "../src/footer.js";
import { type AtelierState, DEFAULT_CONFIG } from "../src/types.js";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
};
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

function plainAt(width: number, config = DEFAULT_CONFIG): string {
	return stripAnsi(renderFooterLine(state, config, plainTheme, width));
}

function firstWidthWithout(text: string): number {
	for (let width = 180; width >= 20; width -= 1) {
		if (!plainAt(width).includes(text)) return width;
	}
	throw new Error(`Expected ${text} to be removed`);
}

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

	it("renders a quiet two-zone Status Rail at wide widths", () => {
		const line = stripAnsi(renderFooterLine(state, DEFAULT_CONFIG, plainTheme, 160));
		expect(line).toContain("● READY · gpt-5.6-sol · medium · main*");
		for (const text of ["in 324k", "out 15k", "cache 99%", "$5.041 (sub)", "ctx 27.0%", "⌥A"]) {
			expect(line).toContain(text);
		}
		expect(line).not.toMatch(/ATELIER|R5\.9M|CH98\.8|◔|✦|MENU/);
		expect(visibleWidth(line)).toBe(160);
	});

	it("right-aligns readable telemetry", () => {
		const line = stripAnsi(renderFooterLine(state, DEFAULT_CONFIG, plainTheme, 180));
		expect(line.endsWith("⌥A")).toBe(true);
		expect(line.indexOf("● READY")).toBe(0);
		expect(line.indexOf("in 324k")).toBeGreaterThan(line.indexOf("main*"));
	});

	it("removes optional information in the approved order", () => {
		const gitAndThinkingGone = Math.min(firstWidthWithout("main*"), firstWidthWithout("medium"));
		const costGone = firstWidthWithout("$5.041");
		const modelGone = firstWidthWithout("gpt-5.6-sol");
		const inputAndOutputGone = Math.min(firstWidthWithout("in 324k"), firstWidthWithout("out 15k"));
		const cacheGone = firstWidthWithout("cache 99%");
		const menuGone = firstWidthWithout("⌥A");
		expect(gitAndThinkingGone).toBeGreaterThan(costGone);
		expect(costGone).toBeGreaterThan(modelGone);
		expect(modelGone).toBeGreaterThan(inputAndOutputGone);
		expect(inputAndOutputGone).toBeGreaterThan(cacheGone);
		expect(cacheGone).toBeGreaterThan(menuGone);
	});

	it("keeps activity and context after optional information is removed", () => {
		const line = plainAt(24);
		expect(line).toContain("● READY");
		expect(line).toContain("ctx");
		expect(visibleWidth(line)).toBeLessThanOrEqual(24);
	});

	it("never introduces old cryptic compact labels", () => {
		for (const width of [180, 132, 96, 72, 56, 40, 24]) {
			expect(plainAt(width)).not.toMatch(/(?:^|\s)(?:R|W|CH)\d|◔/);
		}
	});

	it("uses cache hit for editorial and detailed cache values for classic", () => {
		expect(plainAt(180, DEFAULT_CONFIG)).toContain("cache 99%");
		const classic = plainAt(180, { ...DEFAULT_CONFIG, preset: "classic", ornament: "none" });
		expect(classic).toContain("read 5.9M");
		expect(classic).toContain("hit 98.8%");
	});

	it("styles labels as muted and values as primary", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		renderFooterLine(state, DEFAULT_CONFIG, { fg, bold: (text) => text, italic: (text) => text }, 180);
		expect(fg).toHaveBeenCalledWith("muted", "in");
		expect(fg).toHaveBeenCalledWith("text", "324k");
		expect(fg).toHaveBeenCalledWith("muted", "cache");
		expect(fg).toHaveBeenCalledWith("text", "99%");
	});

	it("does not request warning or error roles for a clean ready state", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		renderFooterLine(
			{ ...state, dirty: false },
			DEFAULT_CONFIG,
			{ fg, bold: (text) => text, italic: (text) => text },
			180,
		);
		const colors = fg.mock.calls.map(([color]) => color);
		expect(colors).not.toContain("warning");
		expect(colors).not.toContain("error");
	});

	it("uses warning and error only for actionable states", () => {
		for (const [percent, color] of [
			[70, "warning"],
			[90, "error"],
		] as const) {
			const fg = vi.fn((_color: string, text: string) => text);
			renderFooterLine(
				{ ...state, metrics: { ...state.metrics, contextPercent: percent } },
				DEFAULT_CONFIG,
				{ fg, bold: (text) => text, italic: (text) => text },
				160,
			);
			expect(fg).toHaveBeenCalledWith(color, `${percent.toFixed(1)}%`);
		}
	});

	it("uses the same semantic theme hierarchy when color is disabled", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const disabled = renderFooterLine(
			state,
			DEFAULT_CONFIG,
			{ fg, bold: (text) => text, italic: (text) => text },
			180,
			false,
		);
		expect(disabled).toBe(renderFooterLine(state, DEFAULT_CONFIG, plainTheme, 180, true));
		expect(fg.mock.calls.map(([color]) => color)).toEqual(
			expect.arrayContaining(["accent", "text", "muted", "warning"]),
		);
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

	it("keeps required activity and context at the supported narrow boundary", () => {
		const line = renderFooterLine(state, DEFAULT_CONFIG, plainTheme, 56);
		expect(line).toContain("● READY");
		expect(line).toContain("ctx 27.0%");
		expect(line).not.toContain("ATELIER");
	});

	it("honors ornament, preset, density, and configured item order", () => {
		const defaultLine = renderFooterLine(state, DEFAULT_CONFIG, plainTheme, 180);
		expect(defaultLine).not.toContain("ATELIER");
		const ornament = renderFooterLine(
			state,
			{ ...DEFAULT_CONFIG, preset: "classic", ornament: "restrained" },
			plainTheme,
			180,
		);
		expect(ornament).toContain("ATELIER");
		expect(ornament).toContain("read 5.9M");
		expect(ornament).toContain("hit 98.8%");

		const compact = renderFooterLine(
			{ ...state, activity: "working", workingLabel: "PONDERING" },
			{ ...DEFAULT_CONFIG, density: "compact" },
			plainTheme,
			160,
		);
		expect(compact).toContain("● WORKING");
		expect(compact).not.toContain("PONDERING");

		const reordered = renderFooterLine(
			state,
			{ ...DEFAULT_CONFIG, segments: ["context", "metrics"] },
			plainTheme,
			160,
		);
		expect(reordered.indexOf("ctx 27.0%")).toBeLessThan(reordered.indexOf("in 324k"));
		const contextOnly = renderFooterLine(
			state,
			{ ...DEFAULT_CONFIG, segments: ["context"] },
			plainTheme,
			160,
		);
		expect(contextOnly).toContain("ctx 27.0%");
		expect(contextOnly).not.toContain("in 324k");
		expect(contextOnly).not.toContain("● READY");
	});

	it("keeps extreme numeric telemetry within the requested width", () => {
		const extreme = {
			...state,
			metrics: {
				...state.metrics,
				input: Number.MAX_VALUE,
				output: Number.MAX_SAFE_INTEGER,
				cacheRead: Number.MAX_VALUE,
				cacheWrite: Number.MAX_VALUE,
				cost: Number.MAX_VALUE,
				contextPercent: Number.MAX_VALUE,
			},
		};
		for (const width of [180, 96, 56, 24, 12]) {
			expect(visibleWidth(renderFooterLine(extreme, DEFAULT_CONFIG, plainTheme, width))).toBeLessThanOrEqual(
				width,
			);
		}
		const narrow = renderFooterLine(extreme, DEFAULT_CONFIG, plainTheme, 40);
		expect(narrow).toContain("● READY");
		expect(narrow).toContain("ctx");
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
		for (const marker of ["in —", "out —", "cache —", "$—", "ctx —"]) {
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

	it("sanitizes optional text and drops oversized statuses before state or telemetry", () => {
		const sanitized = renderFooterLine(
			{
				...state,
				modelId: "gpt\n5",
				thinkingLevel: "high\tnow",
				branch: "feature\nrail",
				extensionStatuses: ["workflow:\nrunning\t now"],
			},
			DEFAULT_CONFIG,
			plainTheme,
			180,
		);
		for (const text of ["gpt 5", "high now", "feature rail*", "workflow: running now"]) {
			expect(sanitized).toContain(text);
		}
		expect(sanitized).not.toMatch(/[\n\t]/);

		const oversized = renderFooterLine(
			{ ...state, extensionStatuses: ["x".repeat(200)] },
			DEFAULT_CONFIG,
			plainTheme,
			160,
		);
		expect(oversized).toContain("● READY");
		expect(oversized).toContain("ctx 27.0%");
		expect(oversized).not.toContain("xxxxxxxxxx");
	});

	it("generates each item at most once for duplicate configured categories", () => {
		const line = renderFooterLine(
			state,
			{ ...DEFAULT_CONFIG, segments: ["activity", "metrics", "metrics", "context", "context"] },
			plainTheme,
			180,
		);
		expect(line.match(/in 324k/g)).toHaveLength(1);
		expect(line.match(/ctx 27\.0%/g)).toHaveLength(1);
	});

	it("animates shrinking dots every 400 ms while retaining the selected phrase", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const working = { ...state, activity: "working" as const, workingLabel: "PHOTOSYNTHESIZING" };
		const component = createFooterComponent({
			getState: () => working,
			getConfig: () => DEFAULT_CONFIG,
			requestRender,
			onBranchChange: () => vi.fn(),
			theme: plainTheme,
		});

		try {
			expect(component.render(160)[0]).toContain("PHOTOSYNTHESIZING...");
			expect(vi.getTimerCount()).toBe(1);
			vi.advanceTimersByTime(400);
			expect(requestRender).toHaveBeenCalledTimes(1);
			expect(component.render(160)[0]).toContain("PHOTOSYNTHESIZING..");
			vi.advanceTimersByTime(400);
			expect(component.render(160)[0]).toContain("PHOTOSYNTHESIZING.");
			vi.advanceTimersByTime(400);
			expect(component.render(160)[0]).toContain("PHOTOSYNTHESIZING...");
			expect(component.render(160)[0]).not.toContain("WORKING");
		} finally {
			component.dispose();
			vi.useRealTimers();
		}
	});

	it("animates only when the full working status is visible and resets after stopping", () => {
		vi.useFakeTimers();
		let current: AtelierState = {
			...state,
			activity: "working",
			workingLabel: "PONDERING",
		};
		let config = DEFAULT_CONFIG;
		const requestRender = vi.fn();
		const component = createFooterComponent({
			getState: () => current,
			getConfig: () => config,
			requestRender,
			onBranchChange: () => vi.fn(),
			theme: plainTheme,
		});

		try {
			expect(component.render(20)[0]).not.toContain("PONDERING");
			expect(vi.getTimerCount()).toBe(0);
			config = { ...DEFAULT_CONFIG, segments: DEFAULT_CONFIG.segments.filter((id) => id !== "activity") };
			expect(component.render(100)[0]).not.toContain("PONDERING");
			expect(vi.getTimerCount()).toBe(0);
			config = DEFAULT_CONFIG;
			expect(component.render(100)[0]).toContain("PONDERING...");
			expect(vi.getTimerCount()).toBe(1);
			vi.advanceTimersByTime(400);
			expect(component.render(100)[0]).toContain("PONDERING..");

			current = { ...state, activity: "ready" };
			expect(component.render(100)[0]).toContain("READY");
			expect(vi.getTimerCount()).toBe(0);
			current = { ...state, activity: "working", workingLabel: "PONDERING" };
			expect(component.render(100)[0]).toContain("PONDERING...");
		} finally {
			component.dispose();
			vi.useRealTimers();
		}
	});

	it("does not animate when an omitted activity label appears in another segment", () => {
		vi.useFakeTimers();
		const component = createFooterComponent({
			getState: () => ({
				...state,
				activity: "working",
				workingLabel: "PONDERING",
				modelId: "PONDERING",
			}),
			getConfig: () => ({
				...DEFAULT_CONFIG,
				segments: DEFAULT_CONFIG.segments.filter((id) => id !== "activity"),
			}),
			requestRender: vi.fn(),
			onBranchChange: () => vi.fn(),
			theme: plainTheme,
		});

		try {
			expect(component.render(100)[0]).toContain("PONDERING");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			component.dispose();
			vi.useRealTimers();
		}
	});

	it("renders the full working phrase and dots in bold theme accent", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const bold = vi.fn((text: string) => `<b>${text}</b>`);
		const italic = vi.fn((text: string) => `<i>${text}</i>`);
		const working = { ...state, activity: "working" as const, workingLabel: "PONDERING" };
		const line = renderFooterLine(working, DEFAULT_CONFIG, { fg, bold, italic }, 160, true, "..");

		expect(line).toContain("<b>● PONDERING..</b>");
		expect(fg).toHaveBeenCalledWith("accent", "<b>● PONDERING..</b>");
		expect(italic).not.toHaveBeenCalled();
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

	it("does not restart animation when rendered after disposal", () => {
		vi.useFakeTimers();
		const component = createFooterComponent({
			getState: () => ({ ...state, activity: "working", workingLabel: "PONDERING" }),
			getConfig: () => DEFAULT_CONFIG,
			requestRender: vi.fn(),
			onBranchChange: () => vi.fn(),
			theme: plainTheme,
		});

		try {
			component.dispose();
			expect(component.render(160)[0]).toContain("PONDERING...");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			component.dispose();
			vi.useRealTimers();
		}
	});

	it("clears the animation timer and prevents redraws after disposal", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const component = createFooterComponent({
			getState: () => ({ ...state, activity: "working", workingLabel: "PONDERING" }),
			getConfig: () => DEFAULT_CONFIG,
			requestRender,
			onBranchChange: () => vi.fn(),
			theme: plainTheme,
		});

		try {
			component.render(160);
			expect(vi.getTimerCount()).toBe(1);
			component.dispose();
			expect(vi.getTimerCount()).toBe(0);
			vi.advanceTimersByTime(800);
			expect(requestRender).not.toHaveBeenCalled();
			component.dispose();
		} finally {
			component.dispose();
			vi.useRealTimers();
		}
	});
});

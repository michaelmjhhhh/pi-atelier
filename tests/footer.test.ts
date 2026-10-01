import { plainTheme } from "./helpers/render.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { disposeAfterTest } from "./helpers/cleanup.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyDisplayTemplate, legacySegmentsToLayout } from "../src/display.js";
import { createFooterComponent, renderFooterLine } from "../src/footer.js";
import { type AtelierConfig, type AtelierState, type FooterState } from "../src/types.js";

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

// Expected shell-prompt glyphs are part of the rendered footer contract.
const icons = {
	model: "\ueb08",
	thinking: "\uf0eb",
	workspace: "\uf07b",
	git: "\uf418",
	input: "\uf019",
	output: "\uf093",
	cache: "\uf1c0",
	latency: "\uf017",
	speed: "\uf0e7",
	context: "\uf2db",
	autoCompact: "\uf021",
	menu: "\uf013",
	separator: "\ue0b1",
};

const namedTheme = (name: string) => ({
	name,
	fg: (color: string, text: string) => `<${name}:${color}>${text}</${name}:${color}>`,
	bold: (text: string) => text,
});

const darkRgb = {
	text: "\u001b[38;2;212;212;212m",
	muted: "\u001b[38;2;128;128;128m",
	dim: "\u001b[38;2;102;102;102m",
	blue: "\u001b[38;2;110;168;254m",
	purple: "\u001b[38;2;177;140;255m",
	cyan: "\u001b[38;2;125;211;252m",
	amber: "\u001b[38;2;255;159;67m",
	red: "\u001b[38;2;255;93;115m",
};

function plainAt(width: number, config = DEFAULT_CONFIG, renderState = state): string {
	return stripAnsi(renderFooterLine(renderState, config, plainTheme, width));
}

function disappearanceWidths(markers: string[], config = DEFAULT_CONFIG, renderState = state): number[] {
	const wide = plainAt(180, config, renderState);
	for (const marker of markers) expect(wide).toContain(marker);
	const missing = new Map<string, number>();
	for (let width = 179; width >= 20 && missing.size < markers.length; width -= 1) {
		const line = plainAt(width, config, renderState);
		for (const marker of markers) {
			if (!missing.has(marker) && !line.includes(marker)) missing.set(marker, width);
		}
	}
	return markers.map((marker) => {
		const width = missing.get(marker);
		if (width === undefined) throw new Error(`Expected ${marker} to be removed`);
		return width;
	});
}

const withVisible = (ids: Parameters<typeof legacySegmentsToLayout>[0], overrides = {}) => ({
	...DEFAULT_CONFIG,
	...overrides,
	segmentLayout: legacySegmentsToLayout(ids),
});

const actualClassicPresetConfig: AtelierConfig = { ...DEFAULT_CONFIG, ...applyDisplayTemplate("classic") };

const state: AtelierState = {
	activity: "ready",
	modelId: "gpt-5.6-sol",
	provider: "openai-codex",
	thinkingLevel: "medium",
	branch: "main",
	dirty: true,
	workspacePulse: {
		status: "changed",
		data: {
			root: "/repo",
			relativeCwd: "",
			branch: "main",
			snapshot: {
				trackedFiles: 1,
				untrackedFiles: 0,
				linesAdded: 1,
				linesRemoved: 0,
				binaryFiles: 0,
				submodules: 0,
				conflicts: 0,
			},
		},
	},
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

afterEach(() => {
	vi.useRealTimers();
});

function createFooter(options: Partial<Parameters<typeof createFooterComponent>[0]> = {}) {
	return disposeAfterTest(
		createFooterComponent({
			getState: () => state,
			getConfig: () => DEFAULT_CONFIG,
			requestRender: vi.fn(),
			onBranchChange: () => vi.fn(),
			theme: plainTheme,
			...options,
		}),
	);
}

describe("footer performance", () => {
	it("renders configured response performance in the Status Rail", () => {
		const config = withVisible(["activity", "metrics", "performance", "context", "model", "menu"]);
		const line = stripAnsi(renderFooterLine(state, config, plainTheme, 160));

		expect(line).toContain(`${icons.latency} —  ${icons.speed} —`);
		expect(stripAnsi(renderFooterLine(state, DEFAULT_CONFIG, plainTheme, 160))).not.toContain(icons.latency);
	});

	it("renders response performance after a response starts", () => {
		const config = withVisible(["activity", "metrics", "performance", "context", "model", "menu"]);
		const line = stripAnsi(
			renderFooterLine(
				{ ...state, performance: { ttftMs: 820, tokensPerSecond: 42.34, estimated: true } },
				config,
				plainTheme,
				160,
			),
		);

		expect(line).toContain(`${icons.latency} 820ms  ${icons.speed} ~42.3/s`);
	});

	it("keeps performance icons muted and dims each value until it is measured", () => {
		const config = withVisible(["activity", "metrics", "performance", "context", "model", "menu"]);
		const theme = namedTheme("dark");

		const idle = renderFooterLine(state, config, theme, 400);
		expect(idle).toContain(`${darkRgb.muted}${icons.latency}\u001b[39m ${darkRgb.dim}—\u001b[39m`);
		expect(idle).toContain(`${darkRgb.muted}${icons.speed}\u001b[39m ${darkRgb.dim}—\u001b[39m`);

		const ttftOnly = renderFooterLine({ ...state, performance: { ttftMs: 820 } }, config, theme, 400);
		expect(ttftOnly).toContain(`${darkRgb.muted}${icons.latency}\u001b[39m ${darkRgb.purple}820ms\u001b[39m`);
		expect(ttftOnly).toContain(`${darkRgb.muted}${icons.speed}\u001b[39m ${darkRgb.dim}—\u001b[39m`);

		const measured = renderFooterLine(
			{ ...state, performance: { ttftMs: 820, tokensPerSecond: 42.34 } },
			config,
			theme,
			400,
		);
		expect(measured).toContain(`${darkRgb.muted}${icons.speed}\u001b[39m ${darkRgb.purple}42.3\u001b[39m`);
	});

	describe("responsive performance", () => {
		it("drops performance as one item when the footer is narrow", () => {
			const config = withVisible(["activity", "metrics", "performance", "context", "model", "menu"]);
			const measured = { ...state, performance: { ttftMs: 820, tokensPerSecond: 42.34 } };
			expect(plainAt(160, config, measured)).toContain(`${icons.latency} 820ms  ${icons.speed} 42.3/s`);
			const line = plainAt(56, config, measured);

			expect(line).not.toContain(icons.latency);
			expect(line).not.toContain(icons.speed);
			expect(line).toContain("● READY");
			expect(line).toContain(`${icons.context} 27.0%`);
		});
	});
});

describe("composer header and telemetry", () => {
	const config = withVisible(["activity", "model", "git", "context", "metrics", "performance", "menu"]);
	const session: FooterState = {
		...state,
		workspaceLabel: "pi-atelier",
		performance: { ttftMs: 820, tokensPerSecond: 42.34 },
	};
	const { cacheHitPercent: _cacheHitPercent, ...metricsWithoutHit } = state.metrics;
	const unmeasured: FooterState = {
		...state,
		metrics: { ...metricsWithoutHit, usageAvailable: false, costAvailable: false },
	};

	it("places session identity in a flowing header and usage in a separate telemetry row", () => {
		const header = stripAnsi(renderFooterLine(session, config, plainTheme, 160, { surface: "header" }));
		const telemetry = stripAnsi(renderFooterLine(session, config, plainTheme, 160, { surface: "telemetry" }));
		expect(header).toBe(
			`● READY ${icons.separator} ${icons.model} gpt-5.6-sol · ${icons.thinking} medium ${icons.separator} ${icons.workspace} pi-atelier · ${icons.git} main* ${icons.separator} ${icons.context} 27.0% / 372k ${icons.autoCompact}`,
		);
		for (const marker of ["● READY", "gpt-5.6-sol", "pi-atelier", "main*", `${icons.context} 27.0%`]) {
			expect(telemetry).not.toContain(marker);
		}
		for (const marker of [
			`${icons.input} 324k`,
			`${icons.output} 15k`,
			`${icons.cache} 99%`,
			"$5.041 (sub)",
			`${icons.latency} 820ms  ${icons.speed} 42.3/s`,
			`${icons.menu} F6`,
		]) {
			expect(telemetry).toContain(marker);
			expect(header).not.toContain(marker);
		}
		expect(telemetry.startsWith(`${icons.input} 324k  ${icons.output} 15k`)).toBe(true);
		expect(telemetry.endsWith(`${icons.menu} F6`)).toBe(true);
		expect(visibleWidth(telemetry)).toBe(160);
	});

	it("hides unmeasured telemetry and omits the row when the menu is hidden", () => {
		const component = createFooter({
			getState: () => unmeasured,
			getConfig: () => ({
				...config,
				segmentLayout: config.segmentLayout.map((entry) =>
					entry.id === "menu" ? { ...entry, visible: false } : entry,
				),
			}),
		});
		expect(component.renderTelemetry(160)).toEqual([]);
		expect(component.renderHeader(160)).toContain("● READY");
		const fallback = stripAnsi(component.render(160)[0] ?? "");
		for (const marker of [
			`${icons.input} —`,
			`${icons.output} —`,
			`${icons.cache} —`,
			"$—",
			`${icons.latency} —`,
		]) {
			expect(fallback).toContain(marker);
		}
	});

	it("right-aligns the menu when there are no measured values", () => {
		const telemetry = stripAnsi(
			renderFooterLine(unmeasured, config, plainTheme, 80, { surface: "telemetry" }),
		);
		expect(telemetry.trim()).toBe(`${icons.menu} F6`);
		expect(telemetry.endsWith(`${icons.menu} F6`)).toBe(true);
		expect(visibleWidth(telemetry)).toBe(80);
	});

	it("retains measured zero values instead of treating them as unavailable", () => {
		const zero: FooterState = {
			...state,
			metrics: { ...state.metrics, input: 0, output: 0, cacheHitPercent: 0, cost: 0 },
			performance: { ttftMs: 0, tokensPerSecond: 0 },
		};
		const telemetry = stripAnsi(renderFooterLine(zero, config, plainTheme, 160, { surface: "telemetry" }));
		for (const marker of [
			`${icons.input} 0`,
			`${icons.output} 0`,
			`${icons.cache} 0%`,
			"$0.000",
			`${icons.latency} 0ms  ${icons.speed} 0.0/s`,
		]) {
			expect(telemetry).toContain(marker);
		}
		expect(telemetry).not.toContain("—");
	});

	it("returns an empty header rather than clipping essential activity or context", () => {
		const atBoundary = stripAnsi(
			renderFooterLine(state, DEFAULT_CONFIG, plainTheme, 17, { surface: "header" }),
		);
		expect(atBoundary).toBe(`● READY ${icons.separator} ${icons.context} 27.0%`);
		for (const width of [16, 12, 1, 0]) {
			expect(renderFooterLine(state, DEFAULT_CONFIG, plainTheme, width, { surface: "header" })).toBe("");
		}
		expect(plainAt(16)).toBe(`● READY  ${icons.context} 27.0%`);
	});

	it("keeps header animation running when telemetry is rendered afterwards", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const component = createFooter({
			getState: () => ({ ...session, activity: "working", workingLabel: "PONDERING" }),
			getConfig: () => config,
			requestRender,
		});
		expect(component.renderHeader(160)).toContain("PONDERING...");
		expect(component.renderTelemetry(160)[0]).not.toContain("PONDERING");
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(400);
		expect(requestRender).toHaveBeenCalledOnce();
		component.renderTelemetry(160);
		expect(component.renderHeader(160)).toContain("PONDERING.. ");
		expect(component.renderHeader(16)).toBe("");
		component.renderTelemetry(160);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("footer", () => {
	it("renders icon groups in the complete footer at wide widths", () => {
		const line = stripAnsi(renderFooterLine(state, DEFAULT_CONFIG, plainTheme, 160));
		expect(line).toContain(
			`● READY ${icons.separator} ${icons.model} gpt-5.6-sol · ${icons.thinking} medium ${icons.separator} ${icons.git} main*`,
		);
		for (const text of [
			`${icons.input} 324k`,
			`${icons.output} 15k`,
			`${icons.cache} 99%`,
			"$5.041 (sub)",
			`${icons.context} 27.0%`,
			"F6",
		]) {
			expect(line).toContain(text);
		}
		expect(visibleWidth(line)).toBe(160);
	});

	it("right-aligns telemetry in the complete footer", () => {
		const line = stripAnsi(renderFooterLine(state, DEFAULT_CONFIG, plainTheme, 180));
		expect(line.endsWith("F6")).toBe(true);
		expect(line.indexOf("● READY")).toBe(0);
		expect(line).toContain("main*");
		expect(line).toContain(`${icons.input} 324k`);
		expect(line.indexOf(`${icons.input} 324k`)).toBeGreaterThan(line.indexOf("main*"));
	});

	it("dims group dividers and keeps related identity items together", () => {
		const line = renderFooterLine(state, DEFAULT_CONFIG, namedTheme("dark"), 400);
		expect(line).toContain(`${darkRgb.dim} ${icons.separator} \u001b[39m`);
		expect(line).toContain(`${darkRgb.dim} · \u001b[39m`);
		expect(stripAnsi(line)).toContain(`${icons.model} gpt-5.6-sol · ${icons.thinking} medium`);
	});

	it("drops secondary detail before workspace identity and required context", () => {
		const [menuGone, thinkingGone, costGone, inputGone, outputGone, cacheGone, gitGone, modelGone] =
			disappearanceWidths([
				"F6",
				"medium",
				"$5.041",
				`${icons.input} 324k`,
				`${icons.output} 15k`,
				`${icons.cache} 99%`,
				"main*",
				"gpt-5.6-sol",
			]) as [number, number, number, number, number, number, number, number];
		expect(menuGone).toBeGreaterThan(thinkingGone);
		expect(thinkingGone).toBeGreaterThan(costGone);
		expect(costGone).toBeGreaterThan(inputGone);
		expect(inputGone).toBeGreaterThanOrEqual(outputGone);
		expect(outputGone).toBeGreaterThan(cacheGone);
		expect(cacheGone).toBeGreaterThan(gitGone);
		expect(gitGone).toBeGreaterThan(modelGone);
	});

	it("removes configured brand and extension statuses before Git and thinking", () => {
		const config: AtelierConfig = {
			...DEFAULT_CONFIG,
			preset: "classic",
			segmentLayout: DEFAULT_CONFIG.segmentLayout.map((entry) =>
				entry.id === "brand" ? { ...entry, visible: true } : { ...entry },
			),
		};
		const configuredState = { ...state, extensionStatuses: ["INDEXING"] };
		expect(plainAt(180, config, configuredState)).toEqual(expect.stringContaining("ATELIER"));
		expect(plainAt(180, config, configuredState)).toEqual(expect.stringContaining("INDEXING"));

		const [brandGone, statusGone, gitGone, thinkingGone] = disappearanceWidths(
			["ATELIER", "INDEXING", "main*", "medium"],
			config,
			configuredState,
		) as [number, number, number, number];
		expect(Math.min(brandGone, statusGone)).toBeGreaterThan(Math.max(gitGone, thinkingGone));
	});

	it("keeps activity and context after optional information is removed", () => {
		const line = plainAt(24);
		expect(line).toContain("● READY");
		expect(line).toContain(`${icons.context} 27.0%`);
		expect(visibleWidth(line)).toBeLessThanOrEqual(24);
	});

	it("uses cache hit for editorial and detailed cache values for classic", () => {
		expect(plainAt(180, DEFAULT_CONFIG)).toContain(`${icons.cache} 99%`);
		const classic = plainAt(180, actualClassicPresetConfig);
		expect(classic).toContain("read 5.9M");
		expect(classic).toContain("hit 98.8%");
	});

	it("renders the actual classic preset segment set", () => {
		const classic = plainAt(180, actualClassicPresetConfig, {
			...state,
			extensionStatuses: ["INDEXING"],
		});
		for (const text of [
			`${icons.input} 324k`,
			`${icons.context} 27.0%`,
			"gpt-5.6-sol",
			"medium",
			"main*",
			"INDEXING",
		]) {
			expect(classic).toContain(text);
		}
		expect(classic).not.toContain("● READY");
		expect(classic).not.toContain("F6");
	});

	it("uses fixed dark colors for named custom themes", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const line = renderFooterLine(state, DEFAULT_CONFIG, { name: "nord", fg, bold: (text) => text }, 180);
		expect(line).toContain(`${darkRgb.blue}${icons.input}\u001b[39m ${darkRgb.blue}324k\u001b[39m`);
		expect(line).toContain(`${darkRgb.cyan}${icons.cache}\u001b[39m ${darkRgb.cyan}99%\u001b[39m`);
		expect(fg).not.toHaveBeenCalled();
	});

	it("colors dark-theme metric icons and values by category", () => {
		const line = renderFooterLine(state, DEFAULT_CONFIG, namedTheme("dark"), 400);
		expect(line).toContain(`${darkRgb.blue}${icons.input}\u001b[39m ${darkRgb.blue}324k\u001b[39m`);
		expect(line).toContain(`${darkRgb.purple}${icons.output}\u001b[39m ${darkRgb.purple}15k\u001b[39m`);
		expect(line).toContain(`${darkRgb.cyan}${icons.cache}\u001b[39m ${darkRgb.cyan}99%\u001b[39m`);
		expect(line).toContain(`${darkRgb.amber}$5.041\u001b[39m${darkRgb.muted} (sub)\u001b[39m`);
		expect(line).toContain(`${darkRgb.blue}${icons.context}\u001b[39m ${darkRgb.blue}27.0%\u001b[39m`);
		expect(line).toContain(`${darkRgb.purple}F6\u001b[39m`);
	});

	it("colors every classic cache value cyan while keeping labels muted", () => {
		const line = renderFooterLine(
			{ ...state, metrics: { ...state.metrics, cacheWrite: 42_000 } },
			actualClassicPresetConfig,
			namedTheme("dark"),
			400,
		);
		expect(line).toContain(`${darkRgb.muted}read\u001b[39m ${darkRgb.cyan}5.9M\u001b[39m`);
		expect(line).toContain(`${darkRgb.muted}write\u001b[39m ${darkRgb.cyan}42k\u001b[39m`);
		expect(line).toContain(`${darkRgb.muted}hit\u001b[39m ${darkRgb.cyan}98.8%\u001b[39m`);
	});

	it("keeps unavailable classic cache values dim without cache RGB", () => {
		const { cacheHitPercent: _cacheHitPercent, ...metricsWithoutHit } = state.metrics;
		const line = renderFooterLine(
			{
				...state,
				metrics: { ...metricsWithoutHit, usageAvailable: false },
			},
			actualClassicPresetConfig,
			namedTheme("dark"),
			400,
		);
		expect(line).toContain(`${darkRgb.muted}read\u001b[39m ${darkRgb.dim}—\u001b[39m`);
		expect(line).toContain(`${darkRgb.muted}hit\u001b[39m ${darkRgb.dim}—\u001b[39m`);
		expect(line).not.toMatch(/\u001b\[38;2;125;211;252m—/);
	});

	it("uses state-specific activity colors", () => {
		const ready = renderFooterLine(state, DEFAULT_CONFIG, namedTheme("dark"), 180);
		const working = renderFooterLine(
			{ ...state, activity: "working", workingLabel: "PONDERING" },
			DEFAULT_CONFIG,
			namedTheme("dark"),
			180,
		);
		expect(ready).toContain(`${darkRgb.blue}● READY\u001b[39m`);
		expect(working).toContain(`${darkRgb.amber}● PONDERING...\u001b[39m`);
	});

	it("overrides context blue at warning and danger thresholds", () => {
		const warning = renderFooterLine(
			{ ...state, metrics: { ...state.metrics, contextPercent: 70 } },
			DEFAULT_CONFIG,
			namedTheme("dark"),
			180,
		);
		const danger = renderFooterLine(
			{ ...state, metrics: { ...state.metrics, contextPercent: 90 } },
			DEFAULT_CONFIG,
			namedTheme("dark"),
			180,
		);
		expect(warning).toContain(`${darkRgb.amber}70.0%\u001b[39m`);
		expect(danger).toContain(`${darkRgb.red}90.0%\u001b[39m`);
		const lightDanger = renderFooterLine(
			{ ...state, metrics: { ...state.metrics, contextPercent: 90 } },
			DEFAULT_CONFIG,
			namedTheme("light"),
			180,
		);
		expect(lightDanger).toContain(`${darkRgb.red}90.0%\u001b[39m`);
	});

	it("keeps unavailable values dim instead of category-colored", () => {
		const line = renderFooterLine(
			{
				...state,
				metrics: {
					...state.metrics,
					usageAvailable: false,
					costAvailable: false,
					contextPercent: null,
				},
			},
			DEFAULT_CONFIG,
			namedTheme("dark"),
			400,
		);
		expect(line).toContain(`${darkRgb.dim}—\u001b[39m`);
		expect(line).toContain(`${darkRgb.dim}$—\u001b[39m`);
		for (const category of [darkRgb.blue, darkRgb.purple, darkRgb.cyan, darkRgb.amber, darkRgb.red]) {
			expect(line).not.toContain(`${category}—`);
			expect(line).not.toContain(`${category}$—`);
		}
	});

	it("does not request warning or error roles for a clean ready state", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		renderFooterLine({ ...state, dirty: false }, DEFAULT_CONFIG, { fg, bold: (text) => text }, 180);
		const colors = fg.mock.calls.map(([color]) => color);
		expect(colors).not.toContain("warning");
		expect(colors).not.toContain("error");
	});

	it("uses the same semantic hierarchy without custom RGB when color is disabled", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const disabled = renderFooterLine(
			state,
			DEFAULT_CONFIG,
			{ name: "light", fg, bold: (text) => text },
			180,
			{ colorEnabled: false },
		);
		const colored = renderFooterLine(state, DEFAULT_CONFIG, namedTheme("light"), 180);
		expect(stripAnsi(disabled)).toBe(stripAnsi(colored));
		expect(disabled).not.toContain("\u001b[38;2;");
		expect(fg.mock.calls.map(([color]) => color)).toEqual(
			expect.arrayContaining(["text", "muted", "warning"]),
		);
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

	it("renders identically across selected themes at representative widths", () => {
		for (const width of [160, 100, 56, 20]) {
			const dark = renderFooterLine(state, DEFAULT_CONFIG, namedTheme("dark"), width);
			for (const selectedTheme of ["light", "nord", "solarized"]) {
				expect(renderFooterLine(state, DEFAULT_CONFIG, namedTheme(selectedTheme), width)).toBe(dark);
			}
			expect(visibleWidth(dark)).toBeLessThanOrEqual(width);
			expect(stripAnsi(dark)).toContain(width >= 56 ? icons.context : "● READY");
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
		expect(line).toContain(`${icons.context} 27.0%`);
	});

	it("uses normalized layout as the sole Brand and Statuses visibility source", () => {
		const visible = withVisible(["brand", "activity", "metrics", "context", "statuses"], {
			preset: "editorial",
			showExtensionStatuses: false,
		}) as AtelierConfig;
		const line = renderFooterLine({ ...state, extensionStatuses: ["INDEXING"] }, visible, plainTheme, 180);
		expect(line).toContain("ATELIER");
		expect(line).toContain("INDEXING");

		const hidden = withVisible(["activity", "metrics", "context"], {
			preset: "classic",
			showExtensionStatuses: true,
		}) as AtelierConfig;
		const hiddenLine = renderFooterLine(
			{ ...state, extensionStatuses: ["INDEXING"] },
			hidden,
			plainTheme,
			180,
		);
		expect(hiddenLine).not.toContain("ATELIER");
		expect(hiddenLine).not.toContain("INDEXING");
	});

	it("honors preset, density, and configured item order", () => {
		const defaultLine = renderFooterLine(state, DEFAULT_CONFIG, plainTheme, 180);
		expect(defaultLine).not.toContain("ATELIER");
		const ornament = renderFooterLine(
			state,
			withVisible(["brand", "activity", "metrics", "context", "model", "git", "statuses", "menu"], {
				preset: "classic",
			}),
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

		const reordered = renderFooterLine(state, withVisible(["context", "metrics"]), plainTheme, 160);
		expect(reordered).toContain(`${icons.context} 27.0%`);
		expect(reordered).toContain(`${icons.input} 324k`);
		expect(reordered.indexOf(`${icons.context} 27.0%`)).toBeLessThan(
			reordered.indexOf(`${icons.input} 324k`),
		);
		const contextOnly = renderFooterLine(state, withVisible(["context"]), plainTheme, 160);
		expect(contextOnly).toContain(`${icons.context} 27.0%`);
		// Required metrics remains visible even when omitted by a legacy-style fixture.
		expect(contextOnly).toContain(`${icons.input} 324k`);
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
		expect(narrow).toContain(icons.context);
	});

	it("renders unavailable telemetry as dim placeholders", () => {
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
		for (const marker of [
			`${icons.input} —`,
			`${icons.output} —`,
			`${icons.cache} —`,
			"$—",
			`${icons.context} —`,
		]) {
			expect(unavailableLine).toContain(marker);
		}
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
		expect(oversized).toContain(`${icons.context} 27.0%`);
		expect(oversized).not.toContain("xxxxxxxxxx");
	});

	it("reserves ellipsis width so animated frames never move the model", () => {
		const working = { ...state, activity: "working" as const, workingLabel: "CLAUDING" };
		const lines = ["...", "..", "."].map((dots) =>
			stripAnsi(
				renderFooterLine(working, DEFAULT_CONFIG, plainTheme, 160, { colorEnabled: true, workingDots: dots }),
			),
		);
		const modelColumns = lines.map((line) => line.indexOf("gpt-5.6-sol"));
		expect(modelColumns[0]).toBeGreaterThan(0);
		expect(new Set(modelColumns).size).toBe(1);
		expect(lines[0]).toContain(`CLAUDING... ${icons.separator} ${icons.model} gpt-5.6-sol`);
		expect(lines[1]).toContain(`CLAUDING..  ${icons.separator} ${icons.model} gpt-5.6-sol`);
		expect(lines[2]).toContain(`CLAUDING.   ${icons.separator} ${icons.model} gpt-5.6-sol`);
	});

	it("animates shrinking dots every 400 ms while retaining the selected phrase", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const working = { ...state, activity: "working" as const, workingLabel: "PHOTOSYNTHESIZING" };
		const component = createFooter({ getState: () => working, requestRender });

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
		const component = createFooter({ getState: () => current, getConfig: () => config, requestRender });

		expect(component.render(20)[0]).not.toContain("PONDERING");
		expect(vi.getTimerCount()).toBe(0);
		config = {
			...DEFAULT_CONFIG,
			segmentLayout: DEFAULT_CONFIG.segmentLayout.map((entry) =>
				entry.id === "activity" ? { ...entry, visible: false } : { ...entry },
			),
		};
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
	});

	it("does not animate when an omitted activity label appears in another segment", () => {
		vi.useFakeTimers();
		const component = createFooter({
			getState: () => ({
				...state,
				activity: "working",
				workingLabel: "PONDERING",
				modelId: "PONDERING",
			}),
			getConfig: () => ({
				...DEFAULT_CONFIG,
				segmentLayout: DEFAULT_CONFIG.segmentLayout.map((entry) =>
					entry.id === "activity" ? { ...entry, visible: false } : { ...entry },
				),
			}),
		});

		expect(component.render(100)[0]).toContain("PONDERING");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("renders the full working phrase and dots in fixed amber for custom themes", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const bold = vi.fn((text: string) => `<b>${text}</b>`);
		const working = { ...state, activity: "working" as const, workingLabel: "PONDERING" };
		const line = renderFooterLine(working, DEFAULT_CONFIG, { name: "nord", fg, bold }, 160, {
			colorEnabled: true,
			workingDots: "..",
		});

		expect(line).toContain(`${darkRgb.amber}<b>● PONDERING.. </b>\u001b[39m`);
		expect(fg).not.toHaveBeenCalled();
	});

	it.each([
		["ready", "READY"],
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
		const component = createFooter({
			requestRender,
			onBranchChange: (listener) => {
				callback = listener;
				return unsubscribe;
			},
		});
		callback?.();
		expect(requestRender).toHaveBeenCalledOnce();
		component.dispose();
		component.dispose();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("stops animating and requesting redraws once disposed", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const component = createFooter({
			getState: () => ({ ...state, activity: "working", workingLabel: "PONDERING" }),
			requestRender,
		});
		component.render(160);
		expect(vi.getTimerCount()).toBe(1);
		component.dispose();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(800);
		expect(requestRender).not.toHaveBeenCalled();
		expect(component.render(160)[0]).toContain("PONDERING...");
		expect(vi.getTimerCount()).toBe(0);
	});
});

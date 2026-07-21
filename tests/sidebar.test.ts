import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	buildSidebarSnapshot,
	createSidebarComponent,
	createSidebarController,
	renderSidebarLines,
	sidebarOverlayOptions,
} from "../src/sidebar.js";
import { type AtelierState, DEFAULT_CONFIG } from "../src/types.js";

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

const theme = {
	name: "dark",
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
};

const state: AtelierState = {
	activity: "working",
	workingLabel: "GITIFYING",
	modelId: "gpt-5.6-sol",
	provider: "openai-codex",
	thinkingLevel: "medium",
	branch: "feature/sidebar",
	dirty: true,
	metrics: {
		usageAvailable: true,
		costAvailable: true,
		input: 50_000,
		output: 1_900,
		cacheRead: 100_000,
		cacheWrite: 0,
		cacheHitPercent: 96,
		cost: 0.479,
		subscription: true,
		contextTokens: 32_400,
		contextWindow: 400_000,
		contextPercent: 8.1,
		autoCompact: true,
	},
	extensionStatuses: [],
};

function snapshot() {
	return buildSidebarSnapshot({
		state,
		cwd: "/Users/example/projects/pi-atelier",
		sessionName: "Sidebar implementation",
		sessionFile: "/tmp/session.jsonl",
		branchEntryCount: 38,
		activeToolCount: 8,
		availableToolCount: 12,
		extensionStatuses: ["tests passing"],
	});
}

function contentRows(lines: string[]) {
	return lines.map((line) => stripAnsi(line).slice(2).trimEnd());
}

describe("sidebar snapshot and layout", () => {
	it("builds the approved core overview", () => {
		expect(snapshot()).toMatchObject({
			projectName: "pi-atelier",
			branch: "feature/sidebar",
			dirty: true,
			sessionName: "Sidebar implementation",
			persisted: true,
			branchEntryCount: 38,
			activeToolCount: 8,
			availableToolCount: 12,
		});
	});

	it("renders a full-height dock without rounded corners or a brand block", () => {
		const lines = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false);
		const text = lines.join("\n");
		expect(lines).toHaveLength(36);
		expect(lines.every((line) => visibleWidth(line) <= 44)).toBe(true);
		expect(lines.every((line) => stripAnsi(line).startsWith("│ "))).toBe(true);
		expect(text).not.toMatch(/[╭╮╰╯]/);
		expect(text).not.toContain("ATELIER");
		expect(text).not.toMatch(/PI ATELIER|ATELIER|▛▀▜|◆|●|✓/);
		expect(contentRows(lines)[0]).toBe("PROJECT");
		expect(contentRows(lines).some((row) => /^PROJECT ─/.test(row))).toBe(false);
		expect(contentRows(lines)).toContain("feature/sidebar · modified");
		expect(contentRows(lines)).toContain("Working · gitifying");
	});

	it("matches the representative 44x36 no-color docked rail", () => {
		const noSession = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: [] },
			cwd: "/Users/example/projects/pi-atelier",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: [],
		});
		expect(
			contentRows(renderSidebarLines(noSession, DEFAULT_CONFIG, theme, 44, 36, false)),
		).toMatchInlineSnapshot(`
			[
			  "PROJECT",
			  "pi-atelier",
			  "/Users/example/projects/pi-atelier",
			  "feature/sidebar · modified",
			  "",
			  "AGENT",
			  "gpt-5.6-sol",
			  "openai-codex · medium",
			  "Working · gitifying",
			  "",
			  "CONTEXT",
			  "32k / 400k                            8.1%",
			  "███░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░",
			  "auto compact",
			  "",
			  "SESSION",
			  "6 entries · ephemeral",
			  "",
			  "USAGE",
			  "INPUT                OUTPUT",
			  "50.0k                1.9k",
			  "CACHE                HIT",
			  "100.0k               96.0%",
			  "COST                 ACCESS",
			  "$0.479               subscription",
			  "",
			  "TOOLS",
			  "8 / 12 active",
			  "",
			  "",
			  "",
			  "",
			  "",
			  "",
			  "",
			  "",
			]
		`);
	});

	it("renders organized sections without exceeding width", () => {
		for (const width of [32, 40, 44]) {
			const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, width, 36, false));
			expect(rows.join("\n")).not.toContain("ATELIER");
			expect(rows.join("\n")).toContain("PROJECT");
			expect(rows.join("\n")).toContain("CONTEXT");
			expect(rows).toContain("TOOLS");
			expect(rows.every((row) => !row.startsWith("STATUS "))).toBe(true);
			expect(
				renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, width, 36, false).every(
					(line) => visibleWidth(line) <= width,
				),
			).toBe(true);
		}
	});

	it("right-aligns context percentage and fills the available bar width", () => {
		const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false));
		const contextIndex = rows.indexOf("CONTEXT");
		expect(rows[contextIndex + 1]).toMatch(/^32k \/ 400k\s+8\.1%$/);
		expect(visibleWidth(rows[contextIndex + 2] ?? "")).toBe(42);
	});

	it("uses an attached non-capturing overlay with responsive visibility", () => {
		const options = sidebarOverlayOptions();
		expect(options).toMatchObject({
			anchor: "top-right",
			width: 44,
			margin: 0,
			nonCapturing: true,
		});
		expect(options.visible?.(87, 40)).toBe(false);
		expect(options.visible?.(88, 40)).toBe(true);
		expect(options.visible?.(160, 40)).toBe(true);
	});

	it("omits a standalone unavailable marker when session name is missing", () => {
		const missingSession = buildSidebarSnapshot({
			state,
			cwd: "/tmp/project",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: [],
		});
		const rows = contentRows(renderSidebarLines(missingSession, DEFAULT_CONFIG, theme, 44, 36, false));
		const sessionIndex = rows.findIndex((row) => row.startsWith("SESSION "));
		const usageIndex = rows.findIndex((row) => row.startsWith("USAGE "));
		expect(rows.slice(sessionIndex + 1, usageIndex)).not.toContain("—");
		expect(rows.slice(sessionIndex + 1, usageIndex)).toContain("6 entries · ephemeral");
	});

	it("does not render the session file path", () => {
		const text = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false).join("\n");
		expect(text).not.toContain("/tmp/session.jsonl");
		expect(text).not.toContain("session.jsonl");
	});

	it("renders session entry count and persistence on one row", () => {
		const persisted = buildSidebarSnapshot({
			state,
			cwd: "/tmp/project",
			sessionName: "Task session",
			sessionFile: "/tmp/session.jsonl",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: [],
		});
		expect(contentRows(renderSidebarLines(persisted, DEFAULT_CONFIG, theme, 44, 36, false))).toContain(
			"6 entries · persisted",
		);
	});

	it("renders usage as aligned muted labels followed by value rows", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const unnamedTheme = { fg, bold: theme.bold, italic: theme.italic };
		const lines = renderSidebarLines(snapshot(), DEFAULT_CONFIG, unnamedTheme, 44, 36, true);
		const rows = contentRows(lines);
		const inputLabel = rows.indexOf("INPUT                OUTPUT");
		expect(inputLabel).toBeGreaterThan(-1);
		expect(rows[inputLabel + 1]).toBe("50.0k                1.9k");
		expect(rows[inputLabel + 2]).toBe("CACHE                HIT");
		expect(rows[inputLabel + 3]).toBe("100.0k               96.0%");
		expect(rows[inputLabel + 4]).toBe("COST                 ACCESS");
		expect(rows[inputLabel + 5]).toBe("$0.479               subscription");
		for (const label of ["INPUT", "OUTPUT", "CACHE", "HIT", "COST", "ACCESS"]) {
			expect(fg).toHaveBeenCalledWith("muted", label);
		}
	});

	it("renders quiet section labels without ornamental rules", () => {
		const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 36, false));
		for (const heading of ["PROJECT", "AGENT", "CONTEXT", "SESSION", "USAGE", "TOOLS"]) {
			expect(rows).toContain(heading);
		}
		expect(rows).toEqual(expect.not.arrayContaining([expect.stringMatching(/^[A-Z &]+ ─/)]));
	});

	it("renders tool count without standalone status placeholder when extension statuses are empty", () => {
		const emptyStatuses = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: [] },
			cwd: "/tmp/project",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: [],
		});
		const rows = contentRows(renderSidebarLines(emptyStatuses, DEFAULT_CONFIG, theme, 44, 36, false));
		const toolsIndex = rows.indexOf("TOOLS");
		expect(toolsIndex).toBeGreaterThan(-1);
		expect(rows[toolsIndex + 1]).toBe("8 / 12 active");
		expect(rows.slice(toolsIndex + 2)).not.toContain("—");
		expect(rows).toEqual(expect.not.arrayContaining([expect.stringMatching(/^STATUS /)]));
	});

	it("appends sanitized extension status details when present", () => {
		const statusSnapshot = buildSidebarSnapshot({
			state: { ...state, extensionStatuses: [] },
			cwd: "/tmp/project",
			branchEntryCount: 6,
			activeToolCount: 8,
			availableToolCount: 12,
			extensionStatuses: ["tests \u001b[31mpassing", "api\nready", "   "],
		});
		const rows = contentRows(renderSidebarLines(statusSnapshot, DEFAULT_CONFIG, theme, 44, 36, false));
		const toolsIndex = rows.indexOf("TOOLS");
		expect(rows[toolsIndex + 1]).toBe("8 / 12 active");
		expect(rows).toContain("tests passing");
		expect(rows).toContain("api ready");
		expect(rows.join("\n")).not.toContain("[31m");
		expect(rows).toEqual(expect.not.arrayContaining([expect.stringMatching(/^STATUS /)]));
	});

	it("drops extension status detail rows before the tool count in shorter rails", () => {
		const rows = contentRows(renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 29, false));
		expect(rows).toContain("8 / 12 active");
		expect(rows).not.toContain("tests passing");
	});

	it("keeps only the required hierarchy in a compact 15 row rail", () => {
		const text = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, 44, 15, false).join("\n");
		expect(text).not.toContain("▛▀▜");
		expect(text).toContain("PROJECT");
		expect(text).toContain("AGENT");
		expect(text).toContain("CONTEXT");
		expect(text).not.toContain("SESSION");
		expect(text).not.toContain("USAGE");
		expect(text).not.toContain("TOOLS");
		expect(text).not.toContain("tests passing");
		expect(text).not.toContain("active");
	});

	it("renders missing metadata as unavailable and the session as ephemeral", () => {
		const {
			modelId: _model,
			provider: _provider,
			thinkingLevel: _thinking,
			branch: _branch,
			...base
		} = state;
		const missing = buildSidebarSnapshot({
			state: {
				...base,
				metrics: { ...state.metrics, contextTokens: null, contextPercent: null },
			},
			cwd: "/tmp/project",
			branchEntryCount: 0,
			activeToolCount: 0,
			availableToolCount: 0,
			extensionStatuses: [],
		});
		const lines = renderSidebarLines(missing, DEFAULT_CONFIG, theme, 32, 36, false);
		expect(lines.join("\n")).toContain("—");
		expect(lines.join("\n")).toContain("ephemeral");
		expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
	});

	it("sanitizes and truncates long values without breaking the frame", () => {
		const long = {
			...snapshot(),
			modelId: `model\u001b[31m${"界".repeat(60)}`,
			branch: `feature/${"x".repeat(100)}`,
			sessionName: `release\n${"y".repeat(100)}`,
			extensionStatuses: [`status\t${"z".repeat(100)}`],
		};
		const lines = renderSidebarLines(long, DEFAULT_CONFIG, theme, 34, 36, false);
		expect(lines.join("")).not.toContain("[31m");
		expect(lines.every((line) => visibleWidth(line) <= 34)).toBe(true);
	});

	it.each([
		[50, "text"],
		[75, "warning"],
		[95, "error"],
	] as const)("uses the configured context role at %s%%", (percent, expectedRole) => {
		const fg = vi.fn((_color: string, text: string) => text);
		renderSidebarLines(
			{ ...snapshot(), metrics: { ...state.metrics, contextPercent: percent } },
			DEFAULT_CONFIG,
			{ ...theme, fg },
			44,
			36,
			false,
		);
		expect(fg).toHaveBeenCalledWith(expectedRole, expect.stringContaining(`${percent.toFixed(1)}%`));
	});
});

describe("sidebar component and overlay", () => {
	it("does not capture editor input or render modal close help", () => {
		const component = createSidebarComponent({
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			getHeight: () => 36,
			theme,
		});
		expect(component.handleInput).toBeUndefined();
		expect(component.render(44).join("\n")).not.toContain("esc/q close");
	});

	it("reads live terminal height on every render without recreation", () => {
		let height = 24;
		const component = createSidebarComponent({
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			getHeight: () => height,
			theme,
		});
		expect(component.render(44)).toHaveLength(24);
		height = 31;
		expect(component.render(44)).toHaveLength(31);
	});

	it.each(["snapshot", "config", "render"] as const)(
		"renders a bounded error state after a %s failure",
		(source) => {
			const component = createSidebarComponent({
				getSnapshot: () => {
					if (source === "snapshot") throw new Error("snapshot failed");
					return snapshot();
				},
				getConfig: () => {
					if (source === "config") throw new Error("config failed");
					return DEFAULT_CONFIG;
				},
				getHeight: () => 7,
				theme:
					source === "render"
						? {
								...theme,
								bold: () => {
									throw new Error("render failed");
								},
							}
						: theme,
			});
			const lines = component.render(24);
			expect(lines).toHaveLength(7);
			expect(lines.every((line) => stripAnsi(line).startsWith("│ "))).toBe(true);
			expect(contentRows(lines)[0]).toBe("Sidebar unavailable");
			expect(lines.join("\n")).not.toMatch(/PI ATELIER|ATELIER/);
			expect(lines.join("\n")).not.toContain("esc/q close");
			expect(lines.join("\n")).not.toMatch(/[╭╮╰╯]/);
			expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
		},
	);

	it("keeps one overlay alive and supports repeated lifecycle operations", async () => {
		const requestRender = vi.fn();
		const closeCallbacks: Array<ReturnType<typeof vi.fn>> = [];
		const handles: Array<{ hide: ReturnType<typeof vi.fn> }> = [];
		const components: unknown[] = [];
		const custom = vi.fn((factory, customOptions) => {
			return new Promise<undefined>((resolve) => {
				let closed = false;
				const done = vi.fn((value: undefined) => {
					if (closed) return;
					closed = true;
					resolve(value);
				});
				const handle = { hide: vi.fn() };
				closeCallbacks.push(done);
				handles.push(handle);
				components.push(
					factory({ requestRender, terminal: { rows: 36 } } as never, theme as never, {} as never, done),
				);
				customOptions.onHandle?.(handle as never);
			});
		});
		const controller = createSidebarController({
			ctx: { mode: "tui", ui: { custom } } as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
		});

		expect(controller.isVisible()).toBe(false);
		controller.show();
		expect(controller.isVisible()).toBe(true);
		expect(custom).toHaveBeenCalledOnce();
		expect(custom.mock.calls[0]?.[1]).toMatchObject({
			overlay: true,
			overlayOptions: expect.objectContaining({
				anchor: "top-right",
				width: 44,
				nonCapturing: true,
			}),
			onHandle: expect.any(Function),
		});
		expect(components).toHaveLength(1);
		controller.show();
		expect(custom).toHaveBeenCalledOnce();

		controller.requestRender();
		expect(requestRender).toHaveBeenCalledOnce();
		controller.hide();
		expect(controller.isVisible()).toBe(false);
		expect(closeCallbacks[0]).toHaveBeenCalledOnce();
		expect(handles[0]?.hide).not.toHaveBeenCalled();
		controller.hide();
		expect(closeCallbacks[0]).toHaveBeenCalledOnce();

		controller.toggle();
		expect(controller.isVisible()).toBe(true);
		expect(custom).toHaveBeenCalledTimes(2);
		expect(components).toHaveLength(2);

		// Cross both the overlay promise and its chained finally() while the replacement is active.
		await Promise.resolve();
		await Promise.resolve();
		expect(controller.isVisible()).toBe(true);
		controller.requestRender();
		expect(requestRender).toHaveBeenCalledTimes(2);

		controller.dispose();
		expect(controller.isVisible()).toBe(false);
		expect(closeCallbacks[1]).toHaveBeenCalledOnce();
	});

	it("reports unsupported modes without enabling the sidebar", () => {
		const onError = vi.fn();
		const custom = vi.fn();
		const controller = createSidebarController({
			ctx: { mode: "rpc", ui: { custom } } as never,
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			onError,
		});
		controller.show();
		expect(controller.isVisible()).toBe(false);
		expect(custom).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("TUI") }),
		);
	});
});

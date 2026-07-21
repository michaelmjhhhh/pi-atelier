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

	it("renders organized sections without exceeding width", () => {
		for (const width of [32, 40, 44]) {
			const lines = renderSidebarLines(snapshot(), DEFAULT_CONFIG, theme, width, false);
			expect(lines.join("\n")).toContain("PI ATELIER");
			expect(lines.join("\n")).toContain("PROJECT");
			expect(lines.join("\n")).toContain("CONTEXT");
			expect(lines.join("\n")).toContain("TOOLS & STATUS");
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});

	it("uses an attached non-capturing overlay with responsive visibility", () => {
		const options = sidebarOverlayOptions();
		expect(options).toMatchObject({
			anchor: "right-center",
			width: 44,
			margin: 0,
			nonCapturing: true,
		});
		expect(options.visible?.(87, 40)).toBe(false);
		expect(options.visible?.(88, 40)).toBe(true);
		expect(options.visible?.(160, 40)).toBe(true);
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
		const lines = renderSidebarLines(missing, DEFAULT_CONFIG, theme, 32, false);
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
		const lines = renderSidebarLines(long, DEFAULT_CONFIG, theme, 34, false);
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
			theme,
		});
		expect(component.handleInput).toBeUndefined();
		expect(component.render(44).join("\n")).not.toContain("esc/q close");
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
			expect(lines.join("\n")).toContain("Sidebar unavailable");
			expect(lines.join("\n")).not.toContain("esc/q close");
			expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
		},
	);

	it("keeps one overlay alive and supports repeated lifecycle operations", () => {
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
				components.push(factory({ requestRender } as never, theme as never, {} as never, done));
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
				anchor: "right-center",
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

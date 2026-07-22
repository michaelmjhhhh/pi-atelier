import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_SIDEBAR_WIDTH,
	MAX_SIDEBAR_WIDTH,
	MIN_MAIN_WIDTH,
	MIN_SIDEBAR_WIDTH,
	createSplitPaneController,
} from "../src/split-pane.js";

function harness(columns = 120) {
	const baseRender = vi.fn((width: number) => [`base:${width}`]);
	const requestRender = vi.fn();
	const write = vi.fn();
	const tui = {
		render: baseRender,
		requestRender,
		terminal: { columns, rows: 36, write },
	} as unknown as TUI;
	return { tui, baseRender, requestRender, write };
}

describe("split pane width reservation", () => {
	it("reserves the default sidebar width without changing overlay coordinates", () => {
		const h = harness(120);
		const split = createSplitPaneController();
		split.attach(h.tui);
		split.show();

		expect(h.tui.render(120)).toEqual(["base:76"]);
		expect(h.baseRender).toHaveBeenLastCalledWith(120 - DEFAULT_SIDEBAR_WIDTH);
		expect(split.overlayOptions()).toMatchObject({
			anchor: "top-right",
			width: 44,
			maxHeight: "100%",
			margin: 0,
			nonCapturing: true,
		});
	});

	it("uses full width when hidden or too narrow and restores on widen", () => {
		const h = harness(120);
		const split = createSplitPaneController();
		split.attach(h.tui);
		split.show();

		expect(h.tui.render(MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH - 1)).toEqual(["base:91"]);
		expect(split.isVisibleAtWidth(91)).toBe(false);
		expect(h.tui.render(120)).toEqual(["base:76"]);

		split.hide();
		expect(h.tui.render(120)).toEqual(["base:120"]);
	});

	it("shows the pane at the exact minimum terminal width", () => {
		const h = harness();
		const split = createSplitPaneController();
		split.attach(h.tui);
		split.show();

		expect(split.isVisibleAtWidth(MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH)).toBe(true);
		expect(h.tui.render(MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH)).toEqual(["base:64"]);
	});

	it("passes zero and negative widths through unchanged", () => {
		const h = harness();
		const split = createSplitPaneController();
		split.attach(h.tui);

		expect(h.tui.render(0)).toEqual(["base:0"]);
		expect(h.tui.render(-5)).toEqual(["base:-5"]);
	});

	it("clamps configured and runtime widths while preserving the main pane", () => {
		const h = harness(100);
		const split = createSplitPaneController();
		split.attach(h.tui);
		split.show();

		split.setSidebarWidth(999);
		expect(split.getSidebarWidth()).toBe(MAX_SIDEBAR_WIDTH);
		expect(h.tui.render(100)).toEqual([`base:${MIN_MAIN_WIDTH}`]);
		expect(split.overlayOptions()).toMatchObject({ width: 36 });

		split.setSidebarWidth(Number.NaN);
		expect(split.getSidebarWidth()).toBe(MAX_SIDEBAR_WIDTH);

		split.setSidebarWidth(-10);
		expect(split.getSidebarWidth()).toBe(MIN_SIDEBAR_WIDTH);
		expect(h.tui.render(100)).toEqual(["base:72"]);
	});
});

describe("split pane render lifecycle", () => {
	it("attaches once and restores the exact original method on dispose", () => {
		const h = harness();
		const original = h.tui.render;
		const split = createSplitPaneController();

		split.attach(h.tui);
		const wrapped = h.tui.render;
		split.attach(h.tui);
		expect(h.tui.render).toBe(wrapped);

		split.dispose();
		expect(h.tui.render).toBe(original);
		split.dispose();
		expect(h.tui.render).toBe(original);
	});

	it("does not overwrite a renderer installed later by another extension", () => {
		const h = harness();
		const split = createSplitPaneController();
		split.attach(h.tui);
		const atelierWrapper = h.tui.render;
		const laterWrapper = vi.fn((width: number) => atelierWrapper.call(h.tui, width));
		h.tui.render = laterWrapper;

		split.dispose();

		expect(h.tui.render).toBe(laterWrapper);
		expect(h.tui.render(120)).toEqual(["base:120"]);
	});

	it("calls onError, disables the split, and retries the prior renderer full-width", () => {
		const error = new Error("render failed");
		const onError = vi.fn();
		const baseRender = vi
			.fn()
			.mockImplementationOnce(() => {
				throw error;
			})
			.mockImplementation((width: number) => [`base:${width}`]);
		const requestRender = vi.fn();
		const tui = {
			render: baseRender,
			requestRender,
			terminal: { columns: 120, rows: 36, write: vi.fn() },
		} as unknown as TUI;
		const split = createSplitPaneController({ onError });
		split.attach(tui);
		split.show();

		expect(tui.render(120)).toEqual(["base:120"]);
		expect(onError).toHaveBeenCalledWith(error);
		expect(split.isEnabled()).toBe(false);
		expect(baseRender.mock.calls).toEqual([[76], [120]]);
	});

	it("keeps show, hide, width updates, and requests idempotent", () => {
		const h = harness();
		const split = createSplitPaneController();
		split.attach(h.tui);
		split.show();
		split.show();
		split.setSidebarWidth(44);
		split.requestRender();
		split.hide();
		split.hide();

		expect(split.isEnabled()).toBe(false);
		expect(h.tui.render(120)).toEqual(["base:120"]);
		expect(h.requestRender.mock.calls.length).toBeGreaterThan(0);
	});
});

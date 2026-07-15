import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createFooterComponent, renderFooterLine } from "../src/footer.js";
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
	it("renders the full editorial layout at wide widths", () => {
		const line = renderFooterLine(state, DEFAULT_CONFIG, plainTheme, 160);
		expect(line).toContain("◆ ATELIER");
		expect(line).toContain("↑324k ↓15k R5.9M CH98.8% $5.041 (sub)");
		expect(line).toContain("27.0%/372k (auto)");
		expect(line).toContain("gpt-5.6-sol · medium");
		expect(line).toContain("main ✦");
		expect(visibleWidth(line)).toBeLessThanOrEqual(160);
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

import type { TUI } from "@earendil-works/pi-tui";
import { getCapabilities, setCapabilities, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createSplitPaneController } from "../src/split-pane.js";

const KITTY_IMAGE = "\u001b_Ga=T,f=100,q=2,C=1,c=20,r=6,i=51;AAAA\u001b\\";

function stableTuiReference(getRenderer: () => TUI): TUI {
	return new Proxy({} as TUI, {
		get: (_target, property) => {
			const renderer = getRenderer();
			const value = Reflect.get(renderer, property, renderer);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				const currentRenderer = getRenderer();
				const method = Reflect.get(currentRenderer, property, currentRenderer);
				if (typeof method !== "function") throw new TypeError(`${String(property)} is not callable`);
				return Reflect.apply(method, currentRenderer, args);
			};
		},
		set: (_target, property, value) => {
			const renderer = getRenderer();
			return Reflect.set(renderer, property, value, renderer);
		},
		getPrototypeOf: () => Reflect.getPrototypeOf(getRenderer()),
	}) as TUI;
}

function harness() {
	const terminal = {
		columns: 120,
		rows: 10,
		write: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
		hideCursor: vi.fn(),
		showCursor: vi.fn(),
	};
	const renderer = new TuiMainScreen(terminal as never);
	const tui = stableTuiReference(() => renderer);
	const split = createSplitPaneController();
	return { renderer, split, tui };
}

function renderedLines(renderer: TuiMainScreen): string[] {
	return renderer.captureRenderState().previousLines;
}

function isInlineImageLine(line: string): boolean {
	return line.includes("\u001b_G") || line.includes("\u001b]1337;File=");
}

describe("inline image composition", () => {
	it("keeps the Sidebar row visible when it shares a row with an inline image", () => {
		const { renderer, split, tui } = harness();
		renderer.addChild({
			render: () => [KITTY_IMAGE, "", "", "", "", ""],
			invalidate() {},
		});
		split.attach(tui);
		split.show();
		tui.showOverlay(
			{
				render: () => ["SIDEBAR", "activity"],
				invalidate() {},
			},
			split.overlayOptions(),
		);

		renderer.renderNow();

		expect(renderedLines(renderer)[0]).toContain("SIDEBAR");
		split.dispose();
	});

	it("uses the image fallback while the fullscreen Sidebar is visible", () => {
		const originalCapabilities = getCapabilities();
		setCapabilities({ ...originalCapabilities, images: "kitty" });
		const writes: string[] = [];
		const terminal = {
			columns: 120,
			rows: 10,
			write: vi.fn((value: string) => writes.push(value)),
			start: vi.fn(),
			stop: vi.fn(),
			hideCursor: vi.fn(),
			showCursor: vi.fn(),
		};
		const renderer = new TuiAltScreen(terminal as never);
		const split = createSplitPaneController();
		try {
			renderer.setLayoutRoot({
				render: () => (getCapabilities().images ? [KITTY_IMAGE, "", "", "", "", ""] : ["IMAGE FALLBACK"]),
				invalidate() {},
			});
			renderer.start();
			split.attach(stableTuiReference(() => renderer));
			split.show();
			renderer.renderNow();

			expect(writes.at(-1)).toContain("IMAGE FALLBACK");
			expect(writes.at(-1)).not.toContain(KITTY_IMAGE);

			split.hide();
			renderer.renderNow();
			expect(writes.at(-1)).toContain(KITTY_IMAGE);
		} finally {
			split.dispose();
			renderer.stop();
			setCapabilities(originalCapabilities);
		}
	});

	it("temporarily suppresses a multi-row image while another overlay intersects its rows", () => {
		const { renderer, split, tui } = harness();
		renderer.addChild({
			render: () => [KITTY_IMAGE, "", "", "", "", "", "transcript"],
			invalidate() {},
		});
		split.attach(tui);
		split.show();
		tui.showOverlay(
			{
				render: () => ["SIDEBAR", "activity"],
				invalidate() {},
			},
			split.overlayOptions(),
		);
		renderer.renderNow();
		const modal = tui.showOverlay(
			{
				render: () => ["CONTROL CENTER", "enter select"],
				invalidate() {},
			},
			{ row: 3, col: 10, width: 40 },
		);

		renderer.renderNow();

		expect(renderedLines(renderer).some(isInlineImageLine)).toBe(false);
		expect(renderedLines(renderer).join("\n")).toContain("CONTROL CENTER");

		modal.hide();
		renderer.renderNow();
		expect(renderedLines(renderer).some(isInlineImageLine)).toBe(true);
		split.dispose();
	});
});

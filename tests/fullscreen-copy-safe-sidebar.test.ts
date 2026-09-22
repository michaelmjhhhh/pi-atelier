import { ScrollView, TuiAltScreen } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createSidebarController } from "../src/sidebar.js";
import { createSplitPaneController } from "../src/split-pane.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import { stableTuiReference } from "./helpers/stable-tui-reference.js";

const press = (x: number, y: number) => `\u001b[<0;${x};${y}M`;
const motion = (x: number, y: number) => `\u001b[<32;${x};${y}M`;
const release = (x: number, y: number) => `\u001b[<0;${x};${y}m`;

describe("fullscreen Sidebar selection", () => {
	it("removes the split child immediately when ctx.ui.custom closes its lifecycle overlay", async () => {
		const terminal = {
			columns: 120,
			rows: 8,
			write: vi.fn(),
			start: vi.fn(),
			stop: vi.fn(),
			hideCursor: vi.fn(),
			showCursor: vi.fn(),
		};
		const renderer = new TuiAltScreen(terminal as never);
		const tui = stableTuiReference(() => renderer);
		const mainWidths: number[] = [];
		renderer.setLayoutRoot({
			render: (width) => {
				mainWidths.push(width);
				return [`main:${width}`];
			},
			invalidate() {},
		});
		let closeCustom: (() => void) | undefined;
		const custom = vi.fn(
			(factory, options) =>
				new Promise<void>((resolve) => {
					const done = () => {
						tui.hideOverlay();
						resolve();
					};
					closeCustom = done;
					const component = factory(
						tui,
						{
							name: "dark",
							fg: (_color: string, text: string) => text,
							bold: (text: string) => text,
							italic: (text: string) => text,
						},
						{},
						done,
					);
					const overlayOptions =
						typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
					const handle = tui.showOverlay(component, overlayOptions);
					options.onHandle?.(handle);
				}),
		);
		const controller = createSidebarController({
			ctx: { mode: "tui", ui: { custom } } as never,
			getSnapshot: () => {
				throw new Error("render lifecycle marker");
			},
			getConfig: () => DEFAULT_CONFIG,
		});

		controller.show();
		tui.render(120);
		expect(mainWidths.at(-1)).toBe(76);

		closeCustom?.();
		tui.render(120);
		expect(mainWidths.at(-1)).toBe(120);
		await Promise.resolve();
		await Promise.resolve();
		expect(controller.isVisible()).toBe(false);

		controller.dispose();
	});

	it("copies transcript content without Sidebar text through Pi's stable TUI reference", () => {
		let deliverInput: ((data: string) => void) | undefined;
		const write = vi.fn();
		const terminal = {
			columns: 120,
			rows: 8,
			write,
			start: vi.fn((onInput: (data: string) => void) => {
				deliverInput = onInput;
			}),
			stop: vi.fn(),
			hideCursor: vi.fn(),
			showCursor: vi.fn(),
		};
		const renderer = new TuiAltScreen(terminal as never);
		const tui = stableTuiReference(() => renderer);
		const transcript = new ScrollView(
			{
				render: () => ["alpha", "beta", "gamma"],
				invalidate() {},
			},
			{ primary: true },
		);
		renderer.setLayoutRoot(transcript);
		renderer.start();

		const split = createSplitPaneController();
		split.attach(tui);
		split.show();
		const overlayHandle = tui.showOverlay(
			{
				render: () => ["SIDEBAR", "TOKEN BURDEN"],
				invalidate() {},
			},
			split.overlayOptions(),
		);
		renderer.renderNow();

		// The Sidebar is visibly part of the HStack, but its lifecycle overlay is
		// non-visible so Pi can bind text selection to the transcript ScrollView.
		expect(tui.render(120).join("\n")).toContain("SIDEBAR");
		expect(tui.hasOverlay()).toBe(false);

		deliverInput?.(press(1, 1));
		deliverInput?.(motion(4, 2));
		deliverInput?.(release(4, 2));

		const copyWrite = write.mock.calls
			.map(([value]) => String(value))
			.findLast((value) => value.includes("\u001b]52;c;"));
		expect(copyWrite).toBeDefined();
		const encoded = copyWrite?.match(/\u001b\]52;c;([A-Za-z0-9+/=]+)\u0007/)?.[1];
		expect(encoded).toBeDefined();
		const copied = Buffer.from(encoded ?? "", "base64").toString("utf8");
		expect(copied).toBe("alpha\nbeta");
		expect(copied).not.toContain("SIDEBAR");
		expect(copied).not.toContain("TOKEN BURDEN");

		overlayHandle.setHidden(true);
		expect(overlayHandle.isHidden()).toBe(true);
		expect(tui.render(120).join("\n")).not.toContain("SIDEBAR");
		overlayHandle.setHidden(false);
		expect(tui.render(120).join("\n")).toContain("SIDEBAR");

		tui.hideOverlay();
		expect(tui.render(120).join("\n")).not.toContain("SIDEBAR");

		overlayHandle.hide();
		expect(tui.render(120).join("\n")).not.toContain("SIDEBAR");
		expect(tui.render(120).join("\n")).not.toContain("TOKEN BURDEN");
		split.dispose();
		renderer.stop();
	});
});

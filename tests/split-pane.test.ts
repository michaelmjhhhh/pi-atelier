import type { TUI } from "@earendil-works/pi-tui";
import { TuiMainScreen as PiTuiMainScreen, TuiAltScreen } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	createSplitPaneController,
	DEFAULT_SIDEBAR_WIDTH,
	MAX_SIDEBAR_WIDTH,
	MIN_MAIN_WIDTH,
	MIN_SIDEBAR_WIDTH,
	parseSgrMouseEvent,
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

class TuiMainScreen {
	readonly mode: "regular" | "fullscreen" = "regular";
	readonly requestRender = vi.fn();
	readonly terminal = { columns: 120, rows: 36, write: vi.fn() };
	readonly widths: number[] = [];

	render(width: number): string[] {
		this.widths.push(width);
		return [`base:${width}`];
	}
}

class FullscreenRenderer extends TuiMainScreen {
	override readonly mode = "fullscreen" as const;
}

const press = (x: number, y = 4) => `\u001b[<0;${x};${y}M`;
const motion = (x: number, y = 4) => `\u001b[<32;${x};${y}M`;
const release = (x: number, y = 4) => `\u001b[<0;${x};${y}m`;
const mousePress = (button: number, x: number, y = 4) => `\u001b[<${button};${x};${y}M`;

function resizeHarness(columns = 120) {
	const h = harness(columns);
	let input: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
	const unsubscribe = vi.fn();
	const onResizeChange = vi.fn();
	const split = createSplitPaneController({
		subscribeInput(handler) {
			input = handler;
			return unsubscribe;
		},
		onResizeChange,
	});
	split.attach(h.tui);
	split.show();
	return { ...h, split, unsubscribe, onResizeChange, send: (data: string) => input?.(data) };
}

describe("SGR mouse parsing", () => {
	it("parses press, held motion, and release coordinates", () => {
		expect(parseSgrMouseEvent(press(77))).toEqual({ button: 0, x: 77, y: 4, release: false, motion: false });
		expect(parseSgrMouseEvent(motion(70))).toMatchObject({ x: 70, motion: true, release: false });
		expect(parseSgrMouseEvent(release(70))).toMatchObject({ x: 70, motion: false, release: true });
	});
	it.each(["", "left", "\u001b[<x;1;1M", "\u001b[<0;0;1M"])("rejects malformed input: %j", (data) =>
		expect(parseSgrMouseEvent(data)).toBeUndefined(),
	);
});

describe("temporary Resize mode", () => {
	it("enables mouse reporting only during Resize mode", () => {
		const h = resizeHarness();
		expect(h.write).not.toHaveBeenCalled();
		expect(h.split.beginResize()).toBe(true);
		expect(h.write).toHaveBeenCalledWith("\u001b[?1002h\u001b[?1006h");
		expect(h.split.isResizing()).toBe(true);
		h.split.finishResize();
		expect(h.write).toHaveBeenLastCalledWith("\u001b[?1006l\u001b[?1002l");
		expect(h.unsubscribe).toHaveBeenCalledOnce();
		expect(h.split.isResizing()).toBe(false);
	});
	it("drags only from the divider and accepts on release", () => {
		const h = resizeHarness();
		h.split.beginResize();
		const dividerX = 120 - DEFAULT_SIDEBAR_WIDTH + 1;
		expect(h.send(press(dividerX))).toEqual({ consume: true });
		expect(h.send(motion(70))).toEqual({ consume: true });
		expect(h.split.getSidebarWidth()).toBe(51);
		expect(h.send(release(70))).toEqual({ consume: true });
		expect(h.split.isResizing()).toBe(false);
		expect(h.split.getSidebarWidth()).toBe(51);
	});
	it("receives fullscreen drags before viewport text selection", () => {
		const renderer = new TuiAltScreen({ columns: 120, rows: 36, write: vi.fn() } as never);
		renderer.requestRender = vi.fn();
		const split = createSplitPaneController({
			subscribeInput: (handler) => renderer.addInputListener(handler),
		});
		const listeners = (renderer as unknown as { inputListeners: Set<unknown> }).inputListeners;
		expect(listeners.size).toBe(1);
		split.attach(stableTuiReference(() => renderer));
		split.show();
		expect(split.beginResize()).toBe(true);
		expect(listeners.size).toBe(2);

		const send = (data: string) =>
			(renderer as unknown as { handleTerminalInput(data: string): void }).handleTerminalInput(data);
		const dividerX = 120 - DEFAULT_SIDEBAR_WIDTH + 1;
		send(press(dividerX));
		send(motion(70));
		send(release(70));

		expect(split.getSidebarWidth()).toBe(51);
		expect(split.isResizing()).toBe(false);
		expect(listeners.size).toBe(1);
	});
	it("keeps fullscreen transcript wheel scrolling after Resize and sidebar visibility changes", () => {
		let deliverInput: ((data: string) => void) | undefined;
		let mouseReporting = false;
		const terminal = {
			columns: 120,
			rows: 8,
			write: vi.fn((data: string) => {
				if (data.includes("\u001b[?1006h")) mouseReporting = true;
				if (data.includes("\u001b[?1006l")) mouseReporting = false;
			}),
			start: vi.fn((onInput: (data: string) => void) => {
				deliverInput = onInput;
			}),
			stop: vi.fn(),
			hideCursor: vi.fn(),
			showCursor: vi.fn(),
			sendWheelUp() {
				if (mouseReporting) deliverInput?.("\u001b[<64;1;1M");
			},
		};
		const renderer = new TuiAltScreen(terminal as never);
		renderer.addChild({
			render: () => Array.from({ length: 30 }, (_, index) => `line ${index}`),
			invalidate() {},
		});
		renderer.start();
		renderer.renderNow();
		const split = createSplitPaneController({
			subscribeInput: (handler) => renderer.addInputListener(handler),
		});
		split.attach(stableTuiReference(() => renderer));
		split.show();

		expect(split.beginResize()).toBe(true);
		split.finishResize();
		split.hide();
		split.show();
		renderer.renderNow();
		const viewportBeforeWheel = renderer.viewportTop;
		terminal.sendWheelUp();

		expect(renderer.viewportTop).toBe(viewportBeforeWheel - 1);
		renderer.stop();
	});

	it("temporarily manages mouse reporting for unsupported fullscreen renderers", () => {
		const renderer = new FullscreenRenderer();
		const split = createSplitPaneController({ subscribeInput: () => vi.fn() });
		split.attach(stableTuiReference(() => renderer as unknown as TUI));
		split.show();

		expect(split.beginResize()).toBe(true);
		split.finishResize();

		expect(renderer.terminal.write.mock.calls).toEqual([
			["\u001b[?1002h\u001b[?1006h"],
			["\u001b[?1006l\u001b[?1002l"],
		]);
	});

	it("cleans mouse reporting on the renderer that entered Resize mode", () => {
		let renderer: TUI = new TuiMainScreen() as unknown as TUI;
		const split = createSplitPaneController({ subscribeInput: () => vi.fn() });
		split.attach(stableTuiReference(() => renderer));
		split.show();

		expect(split.beginResize()).toBe(true);
		const resizeRenderer = renderer as unknown as TuiMainScreen;
		expect(resizeRenderer.terminal.write).toHaveBeenCalledWith("\u001b[?1002h\u001b[?1006h");
		renderer = new FullscreenRenderer() as unknown as TUI;
		const fullscreenRenderer = renderer as unknown as FullscreenRenderer;

		split.finishResize();

		expect(resizeRenderer.terminal.write).toHaveBeenLastCalledWith("\u001b[?1006l\u001b[?1002l");
		expect(fullscreenRenderer.terminal.write).not.toHaveBeenCalled();
	});

	it("does not start dragging for wheel or non-primary mouse events", () => {
		const h = resizeHarness();
		h.split.beginResize();
		const dividerX = 120 - DEFAULT_SIDEBAR_WIDTH + 1;

		expect(h.send(mousePress(64, dividerX))).toEqual({ consume: true });
		expect(h.send(motion(70))).toEqual({ consume: true });
		expect(h.split.getSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);

		expect(h.send(mousePress(1, dividerX))).toEqual({ consume: true });
		expect(h.send(motion(70))).toEqual({ consume: true });
		expect(h.split.getSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
	});
	it("leaves unrelated keyboard input unconsumed", () => {
		const h = resizeHarness();
		h.split.beginResize();
		expect(h.send("a")).toBeUndefined();
	});
	it("keeps Resize mode active on misses and starts dragging within one column of the divider", () => {
		const h = resizeHarness();
		h.split.beginResize();
		h.send("\u001b[C");
		expect(h.split.getSidebarWidth()).toBe(43);

		h.send(press(10));
		expect(h.split.getSidebarWidth()).toBe(43);
		expect(h.split.isResizing()).toBe(true);

		const dividerX = 120 - 43 + 1;
		h.send(press(dividerX - 1));
		h.send(motion(70));
		expect(h.split.getSidebarWidth()).toBe(51);
		h.send(release(70));
		expect(h.split.isResizing()).toBe(false);
	});
	it("supports arrows, shifted arrows, Enter, and Escape rollback", () => {
		const h = resizeHarness();
		h.split.beginResize();
		h.send("\u001b[D");
		expect(h.split.getSidebarWidth()).toBe(45);
		h.send("\u001b[1;2D");
		expect(h.split.getSidebarWidth()).toBe(49);
		h.send("\u001b");
		expect(h.split.getSidebarWidth()).toBe(44);
		h.split.beginResize();
		h.send("\u001b[C");
		h.send("\r");
		expect(h.split.getSidebarWidth()).toBe(43);
		expect(h.split.isResizing()).toBe(false);
	});
	it("refuses Resize mode when the split is hidden or not attached", () => {
		const warnings: string[] = [];
		const split = createSplitPaneController({ onWarning: (message) => warnings.push(message) });
		expect(split.beginResize()).toBe(false);
		expect(warnings.at(-1)).toContain("not ready");
		const h = harness(91);
		split.attach(h.tui);
		split.show();
		expect(split.beginResize()).toBe(false);
		expect(h.write).not.toHaveBeenCalled();
	});
	it.each(["hide", "dispose"] as const)("cleans mouse state on %s", (action) => {
		const h = resizeHarness();
		h.split.beginResize();
		h.split[action]();
		expect(h.write).toHaveBeenLastCalledWith("\u001b[?1006l\u001b[?1002l");
		expect(h.unsubscribe).toHaveBeenCalledOnce();
	});
	it("attempts remaining cleanup when disabling mouse reporting throws", () => {
		const h = resizeHarness();
		h.write.mockImplementation((sequence: string) => {
			if (sequence === "\u001b[?1006l\u001b[?1002l") throw new Error("disable failed");
		});
		h.split.beginResize();

		expect(() => h.split.finishResize()).not.toThrow();
		expect(h.unsubscribe).toHaveBeenCalledOnce();
		expect(h.onResizeChange).toHaveBeenLastCalledWith(false);
		expect(h.split.isResizing()).toBe(false);
	});
	it("attempts remaining cleanup when unsubscribe throws", () => {
		const h = resizeHarness();
		h.unsubscribe.mockImplementation(() => {
			throw new Error("unsubscribe failed");
		});
		h.split.beginResize();

		expect(() => h.split.finishResize()).not.toThrow();
		expect(h.write).toHaveBeenLastCalledWith("\u001b[?1006l\u001b[?1002l");
		expect(h.onResizeChange).toHaveBeenLastCalledWith(false);
		expect(h.split.isResizing()).toBe(false);
	});
	it("cleans up before safely reporting begin errors", () => {
		const h = resizeHarness();
		const error = new Error("enable failed");
		h.write.mockImplementationOnce(() => {
			throw error;
		});
		const onError = vi.fn(() => {
			throw new Error("report failed");
		});
		const split = createSplitPaneController({
			subscribeInput: () => h.unsubscribe,
			onResizeChange: h.onResizeChange,
			onError,
		});
		split.attach(h.tui);
		split.show();

		expect(() => split.beginResize()).not.toThrow();
		expect(h.write).toHaveBeenLastCalledWith("\u001b[?1006l\u001b[?1002l");
		expect(h.unsubscribe).toHaveBeenCalledOnce();
		expect(h.onResizeChange).toHaveBeenLastCalledWith(false);
		expect(onError).toHaveBeenCalledWith(error);
		expect(split.isResizing()).toBe(false);
	});
	it("continues cleanup when onResizeChange throws", () => {
		const h = resizeHarness();
		h.onResizeChange.mockImplementation(() => {
			throw new Error("resize callback failed");
		});
		h.split.beginResize();

		expect(() => h.split.finishResize()).not.toThrow();
		expect(h.write).toHaveBeenLastCalledWith("\u001b[?1006l\u001b[?1002l");
		expect(h.unsubscribe).toHaveBeenCalledOnce();
		expect(h.split.isResizing()).toBe(false);
	});
	it("reclamps while resizing and exits safely when terminal becomes too narrow", () => {
		const h = resizeHarness();
		h.split.setSidebarWidth(72);
		h.split.beginResize();
		expect(h.split.getSidebarWidth()).toBe(56);
		(h.tui.terminal as { columns: number }).columns = 100;
		h.split.overlayOptions().visible?.(100, 36);
		expect(h.split.getSidebarWidth()).toBe(36);
		(h.tui.terminal as { columns: number }).columns = 91;
		h.split.overlayOptions().visible?.(91, 36);
		expect(h.split.isResizing()).toBe(false);
		expect(h.write).toHaveBeenLastCalledWith("\u001b[?1006l\u001b[?1002l");
	});
});

describe("Pi 0.84 split layout", () => {
	it("reserves width on Pi TUI's concrete regular renderer", () => {
		const renderer = new PiTuiMainScreen({ columns: 120, rows: 36, write: vi.fn() } as never);
		const widths: number[] = [];
		renderer.requestRender = vi.fn();
		renderer.addChild({
			render(width) {
				widths.push(width);
				return [`main:${width}`];
			},
			invalidate() {},
		});
		const tui = stableTuiReference(() => renderer);
		const split = createSplitPaneController();

		split.attach(tui);
		split.show();

		expect(tui.render(120)).toEqual(["main:76"]);
		expect(widths).toEqual([76]);
		split.dispose();
		expect(renderer.render(120)).toEqual(["main:120"]);
	});

	it("reserves sidebar width through the stable TUI proxy without recursion", () => {
		const renderer = new TuiMainScreen();
		const tui = stableTuiReference(() => renderer as unknown as TUI);
		const split = createSplitPaneController();

		split.attach(tui);
		split.show();

		expect(tui.render(120)).toEqual(["base:76"]);
		expect(renderer.widths).toEqual([76]);
	});

	it("keeps the main pane bounded while resizing and restores full width when hidden", () => {
		const renderer = new TuiMainScreen();
		const tui = stableTuiReference(() => renderer as unknown as TUI);
		const split = createSplitPaneController();
		split.attach(tui);
		split.show();

		split.setSidebarWidth(72);
		split.overlayOptions().visible?.(100, 36);
		expect(tui.render(100)).toEqual(["base:64"]);
		expect(split.overlayOptions()).toMatchObject({ width: 36 });

		split.hide();
		expect(tui.render(100)).toEqual(["base:100"]);
	});

	it("reserves fullscreen columns in the real layout-frame render path", () => {
		const terminal = {
			columns: 120,
			rows: 36,
			write: vi.fn(),
			start: vi.fn(),
			stop: vi.fn(),
			hideCursor: vi.fn(),
			showCursor: vi.fn(),
		};
		const renderer = new TuiAltScreen(terminal as never); // intentionally exercises renderLayoutFrame
		const widths: number[] = [];
		renderer.setLayoutRoot({
			render(width: number) {
				widths.push(width);
				return [`main:${width}`];
			},
			invalidate() {},
		});
		renderer.start();
		const split = createSplitPaneController();
		split.attach(stableTuiReference(() => renderer));
		split.show();

		renderer.renderNow();
		expect(widths.at(-1)).toBe(76);
		split.setSidebarWidth(72);
		terminal.columns = 100;
		renderer.renderNow();
		expect(widths.at(-1)).toBe(64);
		terminal.columns = 91;
		renderer.renderNow();
		expect(widths.at(-1)).toBe(91);
		renderer.stop();
	});

	it("reserves fullscreen layout columns without wrapping render", () => {
		const renderer = new TuiAltScreen({ columns: 120, rows: 36, write: vi.fn() } as never);
		const widths: number[] = [];
		const originalRoot = {
			render(width: number) {
				widths.push(width);
				return [`main:${width}`];
			},
			invalidate() {},
		};
		const originalRender = renderer.render;
		renderer.requestRender = vi.fn();
		renderer.setLayoutRoot(originalRoot);
		const split = createSplitPaneController();
		split.attach(stableTuiReference(() => renderer));
		split.show();

		renderer.render(120);
		expect(widths.at(-1)).toBe(76);
		expect(renderer.render).toBe(originalRender);

		split.setSidebarWidth(72);
		renderer.render(100);
		expect(widths.at(-1)).toBe(64);

		renderer.render(91);
		expect(widths.at(-1)).toBe(91);

		split.hide();
		renderer.render(120);
		expect(widths.at(-1)).toBe(120);
	});

	it("restores the original fullscreen layout root on disposal", () => {
		const renderer = new TuiAltScreen({ columns: 120, rows: 36, write: vi.fn() } as never);
		const originalRoot = { render: (width: number) => [`main:${width}`], invalidate() {} };
		renderer.requestRender = vi.fn();
		renderer.setLayoutRoot(originalRoot);
		const split = createSplitPaneController();
		split.attach(stableTuiReference(() => renderer));
		split.show();
		expect((renderer as unknown as { layoutRoot: unknown }).layoutRoot).not.toBe(originalRoot);

		split.dispose();

		expect((renderer as unknown as { layoutRoot: unknown }).layoutRoot).toBe(originalRoot);
	});

	it("reconciles replaced fullscreen renderers after hide and show", () => {
		const createRenderer = () => {
			const renderer = new TuiAltScreen({ columns: 120, rows: 36, write: vi.fn() } as never);
			const widths: number[] = [];
			renderer.requestRender = vi.fn();
			renderer.setLayoutRoot({
				render(width: number) {
					widths.push(width);
					return [`main:${width}`];
				},
				invalidate() {},
			});
			return { renderer, widths };
		};
		let current = createRenderer();
		const tui = stableTuiReference(() => current.renderer);
		const split = createSplitPaneController();
		split.attach(tui);
		split.show();
		current.renderer.render(120);
		expect(current.widths.at(-1)).toBe(76);

		split.hide();
		current = createRenderer();
		split.show();
		current.renderer.render(120);
		expect(current.widths.at(-1)).toBe(76);
	});

	it("does not overwrite a fullscreen layout installed later", () => {
		const renderer = new TuiAltScreen({ columns: 120, rows: 36, write: vi.fn() } as never);
		const originalRoot = { render: (width: number) => [`main:${width}`], invalidate() {} };
		const laterRoot = { render: (width: number) => [`later:${width}`], invalidate() {} };
		renderer.requestRender = vi.fn();
		renderer.setLayoutRoot(originalRoot);
		const split = createSplitPaneController();
		split.attach(stableTuiReference(() => renderer));
		split.show();
		renderer.setLayoutRoot(laterRoot);

		split.dispose();

		expect((renderer as unknown as { layoutRoot: unknown }).layoutRoot).toBe(laterRoot);
	});

	it("uses the overlay fallback for unsupported fullscreen renderers", () => {
		const renderer = new FullscreenRenderer();
		const originalRender = renderer.render;
		const tui = stableTuiReference(() => renderer as unknown as TUI);
		const split = createSplitPaneController();

		split.attach(tui);
		split.show();

		expect(tui.render(120)).toEqual(["base:120"]);
		expect(renderer.render).toBe(originalRender);
	});

	it("reconciles regular and fullscreen renderer replacements", () => {
		let renderer: TuiMainScreen = new TuiMainScreen();
		const tui = stableTuiReference(() => renderer as unknown as TUI);
		const split = createSplitPaneController();
		split.attach(tui);
		split.show();
		expect(tui.render(120)).toEqual(["base:76"]);

		split.hide();
		renderer = new FullscreenRenderer();
		split.show();
		expect(tui.render(120)).toEqual(["base:120"]);

		split.hide();
		renderer = new TuiMainScreen();
		split.show();
		expect(tui.render(120)).toEqual(["base:76"]);
	});

	it("restores the prototype renderer on disposal", () => {
		const renderer = new TuiMainScreen();
		const prototypeRender = TuiMainScreen.prototype.render;
		const split = createSplitPaneController();
		split.attach(stableTuiReference(() => renderer as unknown as TUI));
		split.show();
		expect(renderer.render).not.toBe(prototypeRender);

		split.dispose();

		expect(renderer.render).toBe(prototypeRender);
		expect(renderer.render(120)).toEqual(["base:120"]);
	});
});

describe("sidebar overlay sizing", () => {
	it("keeps main rendering unchanged and positions the overlay", () => {
		const h = harness(120);
		const split = createSplitPaneController();
		split.attach(h.tui);
		split.show();

		expect(h.tui.render(120)).toEqual(["base:120"]);
		expect(h.baseRender).toHaveBeenLastCalledWith(120);
		expect(split.overlayOptions()).toMatchObject({
			anchor: "top-right",
			width: 44,
			maxHeight: "100%",
			margin: 0,
			nonCapturing: true,
		});
	});

	it("keeps one overlay options object and updates its width", () => {
		const h = harness(120);
		const split = createSplitPaneController();
		split.attach(h.tui);
		split.show();
		const retainedOptions = split.overlayOptions();

		split.setSidebarWidth(36);

		expect(split.overlayOptions()).toBe(retainedOptions);
		expect(retainedOptions.width).toBe(36);
		expect(h.tui.render(120)).toEqual(["base:120"]);
	});

	it("keeps main rendering at full width when hidden or too narrow", () => {
		const h = harness(120);
		const split = createSplitPaneController();
		split.attach(h.tui);
		split.show();

		expect(h.tui.render(MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH - 1)).toEqual(["base:91"]);
		expect(split.isVisibleAtWidth(91)).toBe(false);
		expect(h.tui.render(120)).toEqual(["base:120"]);

		split.hide();
		expect(h.tui.render(120)).toEqual(["base:120"]);
	});

	it("shows the pane at the exact minimum terminal width", () => {
		const h = harness();
		const split = createSplitPaneController();
		split.attach(h.tui);
		split.show();

		expect(split.isVisibleAtWidth(MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH)).toBe(true);
		expect(h.tui.render(MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH)).toEqual(["base:92"]);
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
		expect(h.tui.render(100)).toEqual(["base:100"]);
		expect(split.overlayOptions()).toMatchObject({ width: 36 });

		split.setSidebarWidth(Number.NaN);
		expect(split.getSidebarWidth()).toBe(MAX_SIDEBAR_WIDTH);

		split.setSidebarWidth(-10);
		expect(split.getSidebarWidth()).toBe(MIN_SIDEBAR_WIDTH);
		expect(h.tui.render(100)).toEqual(["base:100"]);
	});
});

describe("split pane render lifecycle", () => {
	it("does not replace render through Pi 0.84's stable TUI reference", () => {
		const h = harness();
		const originalRender = h.tui.render;
		const split = createSplitPaneController();

		split.attach(stableTuiReference(() => h.tui));
		split.show();

		expect(h.tui.render).toBe(originalRender);
		expect(h.tui.render(120)).toEqual(["base:120"]);
	});

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

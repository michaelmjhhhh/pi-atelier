import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { HStack, matchesKey } from "@earendil-works/pi-tui";

const ENABLE_MOUSE = "\u001b[?1002h\u001b[?1006h";
const DISABLE_MOUSE = "\u001b[?1006l\u001b[?1002l";
const SGR_MOUSE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;
const PI_084_REGULAR_RENDER_ADAPTER = Symbol("pi-atelier.regular-render-adapter");
const PI_084_FULLSCREEN_LAYOUT_ADAPTER = Symbol("pi-atelier.fullscreen-layout-adapter");

interface RegularRenderAdapterState {
	owner: object;
	baseRender: TUI["render"];
}

interface FullscreenLayoutAdapterState {
	owner: object;
	originalRoot: Component;
	splitRoot: Component;
	sidebarWidth: number;
}

type AdaptedTui = TUI & {
	[PI_084_REGULAR_RENDER_ADAPTER]: RegularRenderAdapterState | undefined;
	[PI_084_FULLSCREEN_LAYOUT_ADAPTER]: FullscreenLayoutAdapterState | undefined;
	layoutRoot?: Component;
	setLayoutRoot(component: Component | undefined): void;
};

export interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
	motion: boolean;
}

export function parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
	const match = data.match(SGR_MOUSE);
	if (!match) return undefined;
	const button = Number(match[1]);
	const x = Number(match[2]);
	const y = Number(match[3]);
	if (![button, x, y].every(Number.isFinite) || x < 1 || y < 1) return undefined;
	return { button, x, y, release: match[4] === "m", motion: (button & 32) !== 0 };
}

export const DEFAULT_SIDEBAR_WIDTH = 44;
export const MIN_SIDEBAR_WIDTH = 28;
export const MAX_SIDEBAR_WIDTH = 72;
export const MIN_MAIN_WIDTH = 64;

export interface SplitPaneControllerOptions {
	defaultSidebarWidth?: number;
	minSidebarWidth?: number;
	maxSidebarWidth?: number;
	minMainWidth?: number;
	onError?(error: unknown): void;
	subscribeInput?(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	onResizeChange?(resizing: boolean): void;
	onWarning?(message: string): void;
}

export interface SplitPaneController {
	attach(tui: TUI): void;
	show(): void;
	hide(): void;
	setSidebarWidth(width: number): void;
	getSidebarWidth(): number;
	isEnabled(): boolean;
	isVisibleAtWidth(terminalWidth: number): boolean;
	beginResize(): boolean;
	finishResize(): void;
	cancelResize(): void;
	isResizing(): boolean;
	overlayOptions(): OverlayOptions;
	requestRender(): void;
	dispose(): void;
}

const finiteInteger = (value: number, fallback: number): number =>
	Number.isFinite(value) ? Math.trunc(value) : fallback;

const clamp = (value: number, minimum: number, maximum: number): number =>
	Math.min(maximum, Math.max(minimum, value));

export function createSplitPaneController(options: SplitPaneControllerOptions = {}): SplitPaneController {
	const minimumSidebar = Math.max(
		1,
		finiteInteger(options.minSidebarWidth ?? MIN_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH),
	);
	const maximumSidebar = Math.max(
		minimumSidebar,
		finiteInteger(options.maxSidebarWidth ?? MAX_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
	);
	const minimumMain = Math.max(1, finiteInteger(options.minMainWidth ?? MIN_MAIN_WIDTH, MIN_MAIN_WIDTH));
	let sidebarWidth = clamp(
		finiteInteger(options.defaultSidebarWidth ?? DEFAULT_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH),
		minimumSidebar,
		maximumSidebar,
	);
	let tui: TUI | undefined;
	let enabled = false;
	let disposed = false;
	let resizing = false;
	let resizeStartWidth = sidebarWidth;
	let dragging = false;
	let unsubscribeInput: (() => void) | undefined;
	let resizeMouseTerminal: TUI["terminal"] | undefined;
	let controller: SplitPaneController;
	const adapterOwner = {};

	const findPrototypeRender = (nextTui: TUI): TUI["render"] | undefined => {
		let prototype = Object.getPrototypeOf(nextTui) as object | null;
		if ((prototype as { constructor?: { name?: string } } | null)?.constructor?.name !== "TuiMainScreen") {
			return undefined;
		}
		while (prototype) {
			const descriptor = Object.getOwnPropertyDescriptor(prototype, "render");
			if (typeof descriptor?.value === "function") return descriptor.value as TUI["render"];
			prototype = Object.getPrototypeOf(prototype) as object | null;
		}
		return undefined;
	};

	const syncRegularRenderAdapter = () => {
		if (!tui || tui.mode !== "regular") return;
		const adaptedTui = tui as AdaptedTui;
		const currentState = adaptedTui[PI_084_REGULAR_RENDER_ADAPTER];
		if (currentState?.owner === adapterOwner) return;
		// Another Atelier instance owns this renderer; do not stack private adapters.
		if (currentState) return;
		const baseRender = findPrototypeRender(tui);
		if (!baseRender) return;
		adaptedTui[PI_084_REGULAR_RENDER_ADAPTER] = { owner: adapterOwner, baseRender };
		adaptedTui.render = (width: number) => {
			const sidebar = effectiveSidebarWidth(width);
			return Reflect.apply(baseRender, tui, [sidebar > 0 ? width - sidebar : width]);
		};
	};

	const restoreRegularRenderAdapter = () => {
		if (!tui) return;
		const adaptedTui = tui as AdaptedTui;
		const currentState = adaptedTui[PI_084_REGULAR_RENDER_ADAPTER];
		if (currentState?.owner !== adapterOwner) return;
		adaptedTui.render = currentState.baseRender;
		adaptedTui[PI_084_REGULAR_RENDER_ADAPTER] = undefined;
	};

	const createFullscreenSplitRoot = (originalRoot: Component): Component =>
		new HStack([
			{ component: originalRoot, basis: 0, grow: 1, shrink: 1, minSize: minimumMain },
			{
				component: { render: () => [], invalidate() {} },
				basis: sidebarWidth,
				grow: 0,
				shrink: 1,
				minSize: minimumSidebar,
				maxSize: maximumSidebar,
				visible: ({ width }) => visibleAt(width),
			},
		]);

	const syncFullscreenLayoutAdapter = () => {
		if (!tui || tui.mode !== "fullscreen") return;
		const adaptedTui = tui as AdaptedTui;
		const prototype = Object.getPrototypeOf(tui) as { constructor?: { name?: string } } | null;
		if (prototype?.constructor?.name !== "TuiAltScreen") return;
		const currentState = adaptedTui[PI_084_FULLSCREEN_LAYOUT_ADAPTER];
		if (currentState && currentState.owner !== adapterOwner) return;
		const currentRoot = adaptedTui.layoutRoot;
		if (currentState?.owner === adapterOwner && currentRoot === currentState.splitRoot) {
			if (currentState.sidebarWidth === sidebarWidth) return;
			const splitRoot = createFullscreenSplitRoot(currentState.originalRoot);
			adaptedTui.setLayoutRoot(splitRoot);
			currentState.splitRoot = splitRoot;
			currentState.sidebarWidth = sidebarWidth;
			return;
		}
		if (!currentRoot) return;
		const splitRoot = createFullscreenSplitRoot(currentRoot);
		adaptedTui.setLayoutRoot(splitRoot);
		adaptedTui[PI_084_FULLSCREEN_LAYOUT_ADAPTER] = {
			owner: adapterOwner,
			originalRoot: currentRoot,
			splitRoot,
			sidebarWidth,
		};
	};

	const restoreFullscreenLayoutAdapter = () => {
		if (!tui) return;
		const adaptedTui = tui as AdaptedTui;
		const currentState = adaptedTui[PI_084_FULLSCREEN_LAYOUT_ADAPTER];
		if (currentState?.owner !== adapterOwner) return;
		if (adaptedTui.layoutRoot === currentState.splitRoot) {
			adaptedTui.setLayoutRoot(currentState.originalRoot);
		}
		adaptedTui[PI_084_FULLSCREEN_LAYOUT_ADAPTER] = undefined;
	};

	const isPiFullscreenRenderer = (): boolean => {
		if (!tui || tui.mode !== "fullscreen") return false;
		const prototype = Object.getPrototypeOf(tui) as { constructor?: { name?: string } } | null;
		return prototype?.constructor?.name === "TuiAltScreen";
	};

	const prioritizeFullscreenResizeInput = (
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	) => {
		if (!isPiFullscreenRenderer()) return;
		const listeners = (tui as unknown as { inputListeners?: Set<typeof handler> }).inputListeners;
		if (!(listeners instanceof Set) || !listeners.delete(handler)) return;
		// Pi 0.84's viewport listener consumes every mouse event for text selection.
		// Put Resize first temporarily; unsubscribe removes it without disturbing
		// the relative order of Pi's listener or other extension listeners.
		const existingListeners = [...listeners];
		listeners.clear();
		listeners.add(handler);
		for (const listener of existingListeners) listeners.add(listener);
	};

	const safely = (action: () => unknown) => {
		try {
			const result = action();
			if (result && typeof (result as PromiseLike<unknown>).then === "function") {
				void Promise.resolve(result).catch(() => undefined);
			}
		} catch {
			// Cleanup and error reporting are best effort; continue with remaining actions.
		}
	};

	const visibleAt = (terminalWidth: number): boolean =>
		enabled && Number.isFinite(terminalWidth) && terminalWidth >= minimumMain + minimumSidebar;

	const effectiveSidebarWidth = (terminalWidth: number): number => {
		if (!visibleAt(terminalWidth)) return 0;
		return clamp(sidebarWidth, minimumSidebar, Math.min(maximumSidebar, terminalWidth - minimumMain));
	};

	const overlayLayout: OverlayOptions = {
		anchor: "top-right",
		width: sidebarWidth,
		maxHeight: "100%",
		margin: 0,
		nonCapturing: true,
		visible: (terminalWidth) => {
			reconcileResizeWidth(terminalWidth);
			syncOverlayWidth(terminalWidth);
			return visibleAt(terminalWidth);
		},
	};

	const syncOverlayWidth = (terminalWidth = tui?.terminal.columns) => {
		const effectiveWidth = terminalWidth === undefined ? 0 : effectiveSidebarWidth(terminalWidth);
		overlayLayout.width = effectiveWidth > 0 ? effectiveWidth : sidebarWidth;
	};

	const requestRender = () => tui?.requestRender();

	const stopResize = (restore: boolean) => {
		if (!resizing && !resizeMouseTerminal && !unsubscribeInput) return;
		if (restore) sidebarWidth = resizeStartWidth;
		syncOverlayWidth();
		syncFullscreenLayoutAdapter();
		const mouseTerminal = resizeMouseTerminal;
		const unsubscribe = unsubscribeInput;
		dragging = false;
		resizing = false;
		resizeMouseTerminal = undefined;
		unsubscribeInput = undefined;
		if (mouseTerminal) safely(() => mouseTerminal.write(DISABLE_MOUSE));
		if (unsubscribe) safely(unsubscribe);
		safely(() => options.onResizeChange?.(false));
		safely(requestRender);
	};

	const reconcileResizeWidth = (terminalWidth: number) => {
		if (!resizing) return;
		if (!visibleAt(terminalWidth)) {
			stopResize(true);
			return;
		}
		const effectiveMax = Math.min(maximumSidebar, terminalWidth - minimumMain);
		sidebarWidth = clamp(sidebarWidth, minimumSidebar, Math.max(minimumSidebar, effectiveMax));
	};

	const attach = (nextTui: TUI) => {
		if (disposed) throw new Error("Cannot attach a disposed split pane");
		if (tui === nextTui) return;
		if (tui) throw new Error("Split pane is already attached to another TUI");
		tui = nextTui;
		reconcileResizeWidth(nextTui.terminal.columns);
		syncOverlayWidth(nextTui.terminal.columns);
		syncRegularRenderAdapter();
		syncFullscreenLayoutAdapter();
		requestRender();
	};

	const handleResizeInput = (data: string): { consume?: boolean; data?: string } | undefined => {
		const mouse = parseSgrMouseEvent(data);
		if (mouse) {
			if (mouse.release) {
				if (dragging) stopResize(false);
				return { consume: true };
			}
			if (!mouse.motion && (mouse.button & 3) === 0 && (mouse.button & 64) === 0) {
				const dividerX = (tui?.terminal.columns ?? 0) - sidebarWidth + 1;
				if (Math.abs(mouse.x - dividerX) <= 1) dragging = true;
				return { consume: true };
			}
			if (mouse.motion && dragging && tui) {
				const proposed = tui.terminal.columns - mouse.x + 1;
				const effectiveMax = Math.min(maximumSidebar, tui.terminal.columns - minimumMain);
				sidebarWidth = clamp(proposed, minimumSidebar, Math.max(minimumSidebar, effectiveMax));
				syncOverlayWidth();
				syncFullscreenLayoutAdapter();
				requestRender();
			}
			return { consume: true };
		}
		if (matchesKey(data, "shift+left")) {
			controller.setSidebarWidth(sidebarWidth + 4);
			return { consume: true };
		}
		if (matchesKey(data, "shift+right")) {
			controller.setSidebarWidth(sidebarWidth - 4);
			return { consume: true };
		}
		if (matchesKey(data, "left")) {
			controller.setSidebarWidth(sidebarWidth + 1);
			return { consume: true };
		}
		if (matchesKey(data, "right")) {
			controller.setSidebarWidth(sidebarWidth - 1);
			return { consume: true };
		}
		if (matchesKey(data, "enter")) {
			stopResize(false);
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			stopResize(true);
			return { consume: true };
		}
		return undefined;
	};

	controller = {
		attach,
		show() {
			if (disposed || enabled) return;
			enabled = true;
			syncOverlayWidth();
			syncRegularRenderAdapter();
			syncFullscreenLayoutAdapter();
			requestRender();
		},
		hide() {
			stopResize(true);
			if (!enabled) return;
			enabled = false;
			requestRender();
		},
		setSidebarWidth(width) {
			const next = clamp(finiteInteger(width, sidebarWidth), minimumSidebar, maximumSidebar);
			if (next === sidebarWidth) return;
			sidebarWidth = next;
			syncOverlayWidth();
			syncFullscreenLayoutAdapter();
			requestRender();
		},
		getSidebarWidth: () => sidebarWidth,
		beginResize() {
			if (resizing) return true;
			if (!tui || !enabled) {
				options.onWarning?.("Atelier sidebar is not ready to resize");
				return false;
			}
			if (!visibleAt(tui.terminal.columns)) {
				options.onWarning?.("Terminal is too narrow to resize the Atelier sidebar");
				return false;
			}
			if (!options.subscribeInput) {
				options.onWarning?.("Terminal input is unavailable for sidebar resizing");
				return false;
			}
			sidebarWidth = effectiveSidebarWidth(tui.terminal.columns);
			syncOverlayWidth();
			syncFullscreenLayoutAdapter();
			resizeStartWidth = sidebarWidth;
			dragging = false;
			resizing = true;
			try {
				unsubscribeInput = options.subscribeInput(handleResizeInput);
				prioritizeFullscreenResizeInput(handleResizeInput);
				resizeMouseTerminal = isPiFullscreenRenderer() ? undefined : tui.terminal;
				resizeMouseTerminal?.write(ENABLE_MOUSE);
				options.onResizeChange?.(true);
				requestRender();
				return true;
			} catch (error) {
				stopResize(true);
				safely(() => options.onError?.(error));
				return false;
			}
		},
		finishResize: () => stopResize(false),
		cancelResize: () => stopResize(true),
		isResizing: () => resizing,
		isEnabled: () => enabled,
		isVisibleAtWidth: visibleAt,
		overlayOptions: () => overlayLayout,
		requestRender,
		dispose() {
			if (disposed) return;
			stopResize(true);
			disposed = true;
			enabled = false;
			restoreRegularRenderAdapter();
			restoreFullscreenLayoutAdapter();
			tui?.requestRender();
			tui = undefined;
		},
	};
	return controller;
}

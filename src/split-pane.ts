import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { compositeTuiLine, HStack, isViewportTUI, matchesKey, sliceByColumn } from "@earendil-works/pi-tui";
import {
	createImageCompositorBinding,
	findOwnMethod,
	type ImageCompositorBinding,
} from "./image-compositor.js";
import { clamp } from "./text.js";

const ENABLE_MOUSE = "\u001b[?1002h\u001b[?1006h";
const DISABLE_MOUSE = "\u001b[?1006l\u001b[?1002l";
const SGR_MOUSE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;
// SGR button-code bits: low two bits select the button, 32 marks motion, 64 marks the wheel.
const MOUSE_BUTTON_MASK = 3;
const MOUSE_MOTION_BIT = 32;
const MOUSE_WHEEL_BIT = 64;
const PI_084_REGULAR_RENDER_ADAPTER = Symbol("pi-atelier.regular-render-adapter");
const PI_084_FULLSCREEN_LAYOUT_ADAPTER = Symbol("pi-atelier.fullscreen-layout-adapter");
const PI_084_FULLSCREEN_OVERLAY_ADAPTER = Symbol("pi-atelier.fullscreen-overlay-adapter");
const PI_084_FULLSCREEN_SELECTION_ADAPTER = Symbol("pi-atelier.fullscreen-selection-adapter");

type SelectionColumns = (
	line: string,
	row: number,
	selection: { start: { scrollView?: unknown } },
	minColumn?: number,
	maxColumn?: number,
) => { start: number; end: number };
type ApplySelection = (screen: string[], layout?: unknown) => string[];

interface FullscreenSelectionAdapterState {
	owner: object;
	baseSelectionColumns: SelectionColumns;
	baseApplySelection?: ApplySelection;
}

interface RegularRenderAdapterState {
	owner: object;
	baseRender: TUI["render"];
}

interface FullscreenLayoutAdapterState {
	owner: object;
	originalRoot: Component;
	splitRoot: Component;
	sidebarWidth: number;
	sidebarComponent: Component | undefined;
}

interface FullscreenOverlayAdapterState {
	owner: object;
	baseShowOverlay: TUI["showOverlay"];
	baseHideOverlay: TUI["hideOverlay"];
}

type AdaptedTui = TUI & {
	[PI_084_REGULAR_RENDER_ADAPTER]: RegularRenderAdapterState | undefined;
	[PI_084_FULLSCREEN_LAYOUT_ADAPTER]: FullscreenLayoutAdapterState | undefined;
	[PI_084_FULLSCREEN_OVERLAY_ADAPTER]: FullscreenOverlayAdapterState | undefined;
	[PI_084_FULLSCREEN_SELECTION_ADAPTER]: FullscreenSelectionAdapterState | undefined;
	getSelectionColumns?: SelectionColumns;
	applySelection?: ApplySelection;
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
	const match = SGR_MOUSE.exec(data);
	if (!match) return undefined;
	const button = Number(match[1]);
	const x = Number(match[2]);
	const y = Number(match[3]);
	// Absurdly long digit runs overflow to Infinity.
	if (![button, x, y].every(Number.isFinite) || x < 1 || y < 1) return undefined;
	return { button, x, y, release: match[4] === "m", motion: (button & MOUSE_MOTION_BIT) !== 0 };
}

export const DEFAULT_SIDEBAR_WIDTH = 44;
export const MIN_SIDEBAR_WIDTH = 28;
export const MAX_SIDEBAR_WIDTH = 72;
export const MIN_MAIN_WIDTH = 64;

export interface SplitPaneControllerOptions {
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
	beginResize(): boolean;
	cancelResize(): void;
	isResizing(): boolean;
	overlayOptions(): OverlayOptions;
	requestRender(): void;
	dispose(): void;
}

const EMPTY_SIDEBAR_COMPONENT: Component = {
	render: () => [],
	invalidate() {},
};

/** Largest sidebar that leaves the main pane its minimum width. */
const sidebarLimit = (terminalWidth: number): number =>
	Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, terminalWidth - MIN_MAIN_WIDTH));

export function createSplitPaneController(options: SplitPaneControllerOptions = {}): SplitPaneController {
	let sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
	let tui: TUI | undefined;
	let enabled = false;
	let disposed = false;
	let resizing = false;
	let resizeStartWidth = sidebarWidth;
	let dragging = false;
	let unsubscribeInput: (() => void) | undefined;
	let resizeMouseTerminal: TUI["terminal"] | undefined;
	let fullscreenSidebarComponent: Component | undefined;
	let fullscreenSidebarHidden = false;
	let imageCompositor: ImageCompositorBinding | undefined;
	const adapterOwner = {};

	/** Only Pi's regular main screen renders the transcript through a replaceable `render`. */
	const findPrototypeRender = (nextTui: TUI): TUI["render"] | undefined => {
		const prototype = Object.getPrototypeOf(nextTui) as { constructor?: { name?: string } } | null;
		if (prototype?.constructor?.name !== "TuiMainScreen") return undefined;
		return findOwnMethod<TUI["render"]>(prototype, "render");
	};

	const findPrototypeOverlayMethods = (
		nextTui: TUI,
	): { showOverlay: TUI["showOverlay"]; hideOverlay: TUI["hideOverlay"] } | undefined => {
		const prototype = Object.getPrototypeOf(nextTui) as object | null;
		const showOverlay = findOwnMethod<TUI["showOverlay"]>(prototype, "showOverlay");
		const hideOverlay = findOwnMethod<TUI["hideOverlay"]>(prototype, "hideOverlay");
		return showOverlay && hideOverlay ? { showOverlay, hideOverlay } : undefined;
	};

	const clearFullscreenSidebar = (): void => {
		fullscreenSidebarComponent = undefined;
		fullscreenSidebarHidden = false;
	};

	/** Fullscreen sidebar width at `terminalWidth`, or 0 while it is absent, hidden, or covered. */
	const fullscreenSidebarWidth = (terminalWidth: number): number =>
		fullscreenSidebarComponent && !fullscreenSidebarHidden ? effectiveSidebarWidth(terminalWidth) : 0;

	const isPiFullscreenRenderer = (): boolean => tui?.mode === "fullscreen" && isViewportTUI(tui);

	const syncRegularRenderAdapter = () => {
		if (!tui || tui.mode !== "regular") return;
		const adaptedTui = tui as AdaptedTui;
		// Installed already, or another Atelier instance owns this renderer; do not stack adapters.
		if (adaptedTui[PI_084_REGULAR_RENDER_ADAPTER]) return;
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
			{ component: originalRoot, basis: 0, grow: 1, shrink: 1, minSize: MIN_MAIN_WIDTH },
			{
				component: fullscreenSidebarComponent ?? EMPTY_SIDEBAR_COMPONENT,
				basis: sidebarWidth,
				grow: 0,
				shrink: 1,
				minSize: MIN_SIDEBAR_WIDTH,
				maxSize: MAX_SIDEBAR_WIDTH,
				visible: ({ width }) => observeWidth(width) && !fullscreenSidebarHidden,
			},
		]);

	const syncFullscreenLayoutAdapter = () => {
		if (!isPiFullscreenRenderer() || !tui) return;
		const adaptedTui = tui as AdaptedTui;
		const currentState = adaptedTui[PI_084_FULLSCREEN_LAYOUT_ADAPTER];
		if (currentState && currentState.owner !== adapterOwner) return;
		const currentRoot = adaptedTui.layoutRoot;
		if (currentState?.owner === adapterOwner && currentRoot === currentState.splitRoot) {
			if (
				currentState.sidebarWidth === sidebarWidth &&
				currentState.sidebarComponent === fullscreenSidebarComponent
			) {
				return;
			}
			const splitRoot = createFullscreenSplitRoot(currentState.originalRoot);
			adaptedTui.setLayoutRoot(splitRoot);
			currentState.splitRoot = splitRoot;
			currentState.sidebarWidth = sidebarWidth;
			currentState.sidebarComponent = fullscreenSidebarComponent;
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
			sidebarComponent: fullscreenSidebarComponent,
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

	const syncFullscreenSelectionAdapter = () => {
		if (!isPiFullscreenRenderer() || !tui) return;
		const adaptedTui = tui as AdaptedTui;
		if (adaptedTui[PI_084_FULLSCREEN_SELECTION_ADAPTER]) return;
		// Read the concrete methods, not forwarding functions from Pi's stable proxy.
		const prototype = Object.getPrototypeOf(tui) as object | null;
		const baseSelectionColumns = findOwnMethod<SelectionColumns>(prototype, "getSelectionColumns");
		if (!baseSelectionColumns) return;
		const baseApplySelection = findOwnMethod<ApplySelection>(prototype, "applySelection");
		adaptedTui[PI_084_FULLSCREEN_SELECTION_ADAPTER] = {
			owner: adapterOwner,
			baseSelectionColumns,
			...(baseApplySelection ? { baseApplySelection } : {}),
		};
		adaptedTui.getSelectionColumns = function (line, row, selection, minColumn, maxColumn) {
			const columns = baseSelectionColumns.call(this, line, row, selection, minColumn, maxColumn);
			// Pi falls back to screen selection when a drag starts outside a ScrollView
			// (e.g. the editor). This method serves both highlighting and OSC 52 copying.
			if (selection.start.scrollView || this.hasOverlay()) return columns;
			const width = this.terminal.columns;
			const sidebar = fullscreenSidebarWidth(width);
			if (sidebar <= 0) return columns;
			const mainWidth = width - sidebar;
			return { start: Math.min(columns.start, mainWidth), end: Math.min(columns.end, mainWidth) };
		};
		if (!baseApplySelection) return;
		adaptedTui.applySelection = function (screen, layout) {
			const selected = baseApplySelection.call(this, screen, layout);
			const width = this.terminal.columns;
			const sidebar = fullscreenSidebarWidth(width);
			if (sidebar <= 0 || this.hasOverlay()) return selected;
			const mainWidth = width - sidebar;
			return selected.map((line, row) => {
				const original = screen[row];
				if (original === undefined || line === original) return line;
				// Pi's selection slicing can replay the transcript background AFTER the
				// pane reset. Keep its highlighted main pane, but restore the original
				// sidebar through the compositor's state-aware suffix extraction.
				return compositeTuiLine(original, sliceByColumn(line, 0, mainWidth, true), 0, mainWidth, width);
			});
		};
	};

	const restoreFullscreenSelectionAdapter = () => {
		if (!tui) return;
		const adaptedTui = tui as AdaptedTui;
		const state = adaptedTui[PI_084_FULLSCREEN_SELECTION_ADAPTER];
		if (state?.owner !== adapterOwner) return;
		adaptedTui.getSelectionColumns = state.baseSelectionColumns;
		if (state.baseApplySelection) adaptedTui.applySelection = state.baseApplySelection;
		adaptedTui[PI_084_FULLSCREEN_SELECTION_ADAPTER] = undefined;
	};

	const syncFullscreenOverlayAdapter = () => {
		if (!isPiFullscreenRenderer() || !tui) return;
		const adaptedTui = tui as AdaptedTui;
		// Installed already, or owned by another Atelier instance.
		if (adaptedTui[PI_084_FULLSCREEN_OVERLAY_ADAPTER]) return;
		const baseMethods = findPrototypeOverlayMethods(tui);
		if (!baseMethods) return;
		const { showOverlay: baseShowOverlay, hideOverlay: baseHideOverlay } = baseMethods;
		adaptedTui[PI_084_FULLSCREEN_OVERLAY_ADAPTER] = {
			owner: adapterOwner,
			baseShowOverlay,
			baseHideOverlay,
		};
		adaptedTui.showOverlay = (component, overlayOptions) => {
			const state = adaptedTui[PI_084_FULLSCREEN_OVERLAY_ADAPTER];
			const base = state?.owner === adapterOwner ? state.baseShowOverlay : baseShowOverlay;
			if (enabled && overlayOptions === overlayLayout && isPiFullscreenRenderer()) {
				fullscreenSidebarComponent = component;
				fullscreenSidebarHidden = false;
				syncFullscreenLayoutAdapter();
				// ctx.ui.custom() only exposes persistent UI as an overlay. Keep a
				// non-visible overlay entry for its lifecycle promise, while the
				// actual Sidebar is rendered by the fullscreen HStack. Pi therefore
				// sees no visible overlay and can scope selection to the transcript
				// ScrollView instead of the composed terminal screen.
				const handle = Reflect.apply(base, tui, [
					component,
					{ ...overlayOptions, visible: () => false },
				]) as OverlayHandle;
				return {
					hide() {
						try {
							handle.hide();
						} finally {
							if (fullscreenSidebarComponent === component) {
								enabled = false;
								fullscreenSidebarComponent = undefined;
								syncFullscreenLayoutAdapter();
								tui?.requestRender();
							}
						}
					},
					setHidden(hidden) {
						handle.setHidden(hidden);
						if (fullscreenSidebarComponent === component) {
							fullscreenSidebarHidden = hidden;
							tui?.requestRender();
						}
					},
					isHidden: () => handle.isHidden(),
					focus: () => handle.focus(),
					unfocus: (options) => handle.unfocus(options),
					isFocused: () => handle.isFocused(),
				};
			}
			return Reflect.apply(base, tui, [component, overlayOptions]);
		};
		adaptedTui.hideOverlay = () => {
			const state = adaptedTui[PI_084_FULLSCREEN_OVERLAY_ADAPTER];
			const base = state?.owner === adapterOwner ? state.baseHideOverlay : baseHideOverlay;
			const hadVisibleOverlay = tui?.hasOverlay() ?? false;
			Reflect.apply(base, tui, []);
			if (!hadVisibleOverlay && fullscreenSidebarComponent) {
				enabled = false;
				clearFullscreenSidebar();
				syncFullscreenLayoutAdapter();
				tui?.requestRender();
			}
		};
	};

	const restoreFullscreenOverlayAdapter = () => {
		if (!tui) return;
		const adaptedTui = tui as AdaptedTui;
		const currentState = adaptedTui[PI_084_FULLSCREEN_OVERLAY_ADAPTER];
		if (currentState?.owner !== adapterOwner) return;
		adaptedTui.showOverlay = currentState.baseShowOverlay;
		adaptedTui.hideOverlay = currentState.baseHideOverlay;
		adaptedTui[PI_084_FULLSCREEN_OVERLAY_ADAPTER] = undefined;
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

	const safely = (action: () => void): void => {
		try {
			action();
		} catch {
			// Cleanup and error reporting are best effort; continue with remaining actions.
		}
	};

	const visibleAt = (terminalWidth: number): boolean =>
		enabled && terminalWidth >= MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH;

	const effectiveSidebarWidth = (terminalWidth: number): number =>
		visibleAt(terminalWidth) ? clamp(sidebarWidth, MIN_SIDEBAR_WIDTH, terminalWidth - MIN_MAIN_WIDTH) : 0;

	/**
	 * Pi asks both layouts whether the sidebar is visible on every frame; use that
	 * to follow terminal resizes before answering.
	 */
	const observeWidth = (terminalWidth: number): boolean => {
		reconcileResizeWidth(terminalWidth);
		syncOverlayWidth(terminalWidth);
		return visibleAt(terminalWidth);
	};

	const overlayLayout: OverlayOptions = {
		anchor: "top-right",
		width: sidebarWidth,
		maxHeight: "100%",
		margin: 0,
		nonCapturing: true,
		visible: observeWidth,
	};

	const syncOverlayWidth = (terminalWidth = tui?.terminal.columns) => {
		const effectiveWidth = terminalWidth === undefined ? 0 : effectiveSidebarWidth(terminalWidth);
		overlayLayout.width = effectiveWidth > 0 ? effectiveWidth : sidebarWidth;
	};

	const requestRender = () => {
		imageCompositor?.sync();
		syncRegularRenderAdapter();
		syncFullscreenLayoutAdapter();
		syncFullscreenOverlayAdapter();
		syncFullscreenSelectionAdapter();
		tui?.requestRender();
	};

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
		sidebarWidth = clamp(sidebarWidth, MIN_SIDEBAR_WIDTH, sidebarLimit(terminalWidth));
	};

	const attach = (nextTui: TUI) => {
		if (disposed) throw new Error("Cannot attach a disposed split pane");
		if (tui === nextTui) return;
		if (tui) throw new Error("Split pane is already attached to another TUI");
		tui = nextTui;
		imageCompositor = createImageCompositorBinding(nextTui, (width) => {
			const sidebar = isPiFullscreenRenderer() ? fullscreenSidebarWidth(width) : 0;
			if (sidebar === 0 || !fullscreenSidebarComponent) return undefined;
			return { column: width - sidebar, width: sidebar, lines: fullscreenSidebarComponent.render(sidebar) };
		});
		reconcileResizeWidth(nextTui.terminal.columns);
		syncOverlayWidth(nextTui.terminal.columns);
		requestRender();
	};

	const setSidebarWidth = (width: number): void => {
		const next = clamp(
			Number.isFinite(width) ? Math.trunc(width) : sidebarWidth,
			MIN_SIDEBAR_WIDTH,
			MAX_SIDEBAR_WIDTH,
		);
		if (next === sidebarWidth) return;
		sidebarWidth = next;
		syncOverlayWidth();
		requestRender();
	};

	/** Keyboard steps: the sidebar grows to the left. */
	const RESIZE_KEYS = [
		["shift+left", 4],
		["shift+right", -4],
		["left", 1],
		["right", -1],
	] as const;

	const handleResizeInput = (data: string): { consume?: boolean; data?: string } | undefined => {
		const mouse = parseSgrMouseEvent(data);
		if (mouse) {
			if (mouse.release) {
				if (dragging) stopResize(false);
			} else if (
				!mouse.motion &&
				(mouse.button & MOUSE_BUTTON_MASK) === 0 &&
				(mouse.button & MOUSE_WHEEL_BIT) === 0
			) {
				const dividerX = (tui?.terminal.columns ?? 0) - sidebarWidth + 1;
				if (Math.abs(mouse.x - dividerX) <= 1) dragging = true;
			} else if (mouse.motion && dragging && tui) {
				const proposed = tui.terminal.columns - mouse.x + 1;
				sidebarWidth = clamp(proposed, MIN_SIDEBAR_WIDTH, sidebarLimit(tui.terminal.columns));
				syncOverlayWidth();
				requestRender();
			}
			return { consume: true };
		}
		const step = RESIZE_KEYS.find(([key]) => matchesKey(data, key))?.[1];
		if (step !== undefined) {
			setSidebarWidth(sidebarWidth + step);
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

	return {
		attach,
		show() {
			if (disposed || enabled) return;
			enabled = true;
			syncOverlayWidth();
			requestRender();
		},
		hide() {
			stopResize(true);
			if (!enabled) return;
			enabled = false;
			clearFullscreenSidebar();
			// Remove the sidebar even if subsequent compositor reconciliation fails.
			syncFullscreenLayoutAdapter();
			requestRender();
		},
		setSidebarWidth,
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
		cancelResize: () => stopResize(true),
		isResizing: () => resizing,
		isEnabled: () => enabled,
		overlayOptions: () => overlayLayout,
		requestRender,
		dispose() {
			if (disposed) return;
			stopResize(true);
			disposed = true;
			enabled = false;
			clearFullscreenSidebar();
			restoreRegularRenderAdapter();
			restoreFullscreenOverlayAdapter();
			restoreFullscreenSelectionAdapter();
			restoreFullscreenLayoutAdapter();
			imageCompositor?.dispose();
			imageCompositor = undefined;
			tui?.requestRender();
			tui = undefined;
		},
	};
}

import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { HStack, isViewportTUI, matchesKey } from "@earendil-works/pi-tui";
import { createImageCompositorBinding } from "./image-compositor.js";

const ENABLE_MOUSE = "\u001b[?1002h\u001b[?1006h";
const DISABLE_MOUSE = "\u001b[?1006l\u001b[?1002l";
const SGR_MOUSE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;
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

interface FullscreenSelectionAdapterState {
	owner: object;
	baseSelectionColumns: SelectionColumns;
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
const AUTO_MAIN_WIDTH = 80;
const AUTO_REOPEN_MARGIN = 8;

export type SidebarMode = "auto" | "on" | "off";
export type SidebarPresentation = "shown" | "auto-collapsed" | "too-narrow" | "off";

export interface SidebarStatus {
	mode: SidebarMode;
	presentation: SidebarPresentation;
}

export interface SplitPaneControllerOptions {
	defaultSidebarWidth?: number;
	minSidebarWidth?: number;
	maxSidebarWidth?: number;
	minMainWidth?: number;
	onError?(error: unknown): void;
	subscribeInput?(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	onResizeChange?(resizing: boolean): void;
	onVisibilityChange?(): void;
	onWarning?(message: string): void;
}

export interface SplitPaneController {
	attach(tui: TUI): void;
	show(mode?: Exclude<SidebarMode, "off">): void;
	hide(): void;
	getStatus(): SidebarStatus;
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

const EMPTY_SIDEBAR_COMPONENT: Component = {
	render: () => [],
	invalidate() {},
};

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
	let mode: Exclude<SidebarMode, "off"> = "on";
	let autoExpanded: boolean | undefined;
	let lastPresentation: SidebarPresentation = "off";
	let visibilityNotificationPending = false;
	let disposed = false;
	let resizing = false;
	let resizeStartWidth = sidebarWidth;
	let resizeStartAutoExpanded: boolean | undefined;
	let dragging = false;
	let unsubscribeInput: (() => void) | undefined;
	let resizeMouseTerminal: TUI["terminal"] | undefined;
	let fullscreenSidebarComponent: Component | undefined;
	let fullscreenSidebarHidden = false;
	let imageCompositor: ReturnType<typeof createImageCompositorBinding> | undefined;
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

	const findPrototypeOverlayMethods = (
		nextTui: TUI,
	): { showOverlay: TUI["showOverlay"]; hideOverlay: TUI["hideOverlay"] } | undefined => {
		let prototype = Object.getPrototypeOf(nextTui) as object | null;
		let showOverlay: TUI["showOverlay"] | undefined;
		let hideOverlay: TUI["hideOverlay"] | undefined;
		while (prototype && (!showOverlay || !hideOverlay)) {
			const showDescriptor = Object.getOwnPropertyDescriptor(prototype, "showOverlay");
			if (typeof showDescriptor?.value === "function")
				showOverlay = showDescriptor.value as TUI["showOverlay"];
			const hideDescriptor = Object.getOwnPropertyDescriptor(prototype, "hideOverlay");
			if (typeof hideDescriptor?.value === "function")
				hideOverlay = hideDescriptor.value as TUI["hideOverlay"];
			prototype = Object.getPrototypeOf(prototype) as object | null;
		}
		return showOverlay && hideOverlay ? { showOverlay, hideOverlay } : undefined;
	};

	const isPiFullscreenRenderer = (): boolean => tui?.mode === "fullscreen" && isViewportTUI(tui);

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
			reconcileResizeWidth(width);
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
				component: fullscreenSidebarComponent ?? EMPTY_SIDEBAR_COMPONENT,
				basis: sidebarWidth,
				grow: 0,
				shrink: 1,
				minSize: minimumSidebar,
				maxSize: maximumSidebar,
				visible: ({ width }) => {
					reconcileResizeWidth(width);
					syncOverlayWidth(width);
					return !fullscreenSidebarHidden && visibleAt(width);
				},
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
		// Read the concrete method, not a forwarding function from Pi's stable proxy.
		let prototype = Object.getPrototypeOf(tui);
		while (prototype) {
			const base = Object.getOwnPropertyDescriptor(prototype, "getSelectionColumns")?.value;
			if (typeof base === "function") {
				const baseSelectionColumns = base as SelectionColumns;
				adaptedTui[PI_084_FULLSCREEN_SELECTION_ADAPTER] = { owner: adapterOwner, baseSelectionColumns };
				adaptedTui.getSelectionColumns = function (line, row, selection, minColumn, maxColumn) {
					const columns = baseSelectionColumns.call(this, line, row, selection, minColumn, maxColumn);
					// Pi falls back to screen selection when a drag starts outside a ScrollView
					// (e.g. the editor). This method serves both highlighting and OSC 52 copying.
					if (
						!selection.start.scrollView &&
						fullscreenSidebarComponent &&
						!fullscreenSidebarHidden &&
						!this.hasOverlay()
					) {
						const width = this.terminal.columns;
						const sidebar = effectiveSidebarWidth(width);
						if (sidebar > 0) {
							const mainWidth = width - sidebar;
							return { start: Math.min(columns.start, mainWidth), end: Math.min(columns.end, mainWidth) };
						}
					}
					return columns;
				};
				return;
			}
			prototype = Object.getPrototypeOf(prototype);
		}
	};

	const restoreFullscreenSelectionAdapter = () => {
		if (!tui) return;
		const adaptedTui = tui as AdaptedTui;
		const state = adaptedTui[PI_084_FULLSCREEN_SELECTION_ADAPTER];
		if (state?.owner !== adapterOwner) return;
		adaptedTui.getSelectionColumns = state.baseSelectionColumns;
		adaptedTui[PI_084_FULLSCREEN_SELECTION_ADAPTER] = undefined;
	};

	const syncFullscreenOverlayAdapter = () => {
		if (!isPiFullscreenRenderer() || !tui) return;
		const adaptedTui = tui as AdaptedTui;
		const currentState = adaptedTui[PI_084_FULLSCREEN_OVERLAY_ADAPTER];
		if (currentState?.owner === adapterOwner) return;
		if (currentState) return;
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
				fullscreenSidebarComponent = undefined;
				fullscreenSidebarHidden = false;
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

	// All renderers and presentation consumers resolve the outer terminal width here.
	// Invalid resize dimensions must not change the automatic expansion history.
	const resolveLayout = (terminalWidth: number) => {
		const validWidth = Number.isFinite(terminalWidth) && terminalWidth > 0;
		if (enabled && mode === "auto" && !resizing && validWidth) {
			const threshold = Math.max(AUTO_MAIN_WIDTH, minimumMain) + sidebarWidth;
			autoExpanded = terminalWidth >= threshold + (autoExpanded === false ? AUTO_REOPEN_MARGIN : 0);
		}
		const presentation: SidebarPresentation = !enabled
			? "off"
			: !validWidth || terminalWidth < minimumMain + minimumSidebar
				? "too-narrow"
				: mode === "auto" && !resizing && !autoExpanded
					? "auto-collapsed"
					: "shown";
		const effectiveWidth =
			presentation === "shown"
				? clamp(sidebarWidth, minimumSidebar, Math.min(maximumSidebar, terminalWidth - minimumMain))
				: 0;
		if (presentation !== lastPresentation) {
			lastPresentation = presentation;
			// Rendering may discover a resize. Notify after the render stack unwinds.
			if (!visibilityNotificationPending) {
				visibilityNotificationPending = true;
				queueMicrotask(() => {
					visibilityNotificationPending = false;
					if (!disposed) safely(() => options.onVisibilityChange?.());
				});
			}
		}
		return { presentation, sidebarWidth: effectiveWidth, mainWidth: terminalWidth - effectiveWidth };
	};

	const visibleAt = (terminalWidth: number): boolean => resolveLayout(terminalWidth).presentation === "shown";
	const effectiveSidebarWidth = (terminalWidth: number): number => resolveLayout(terminalWidth).sidebarWidth;

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
		if (restore) {
			sidebarWidth = resizeStartWidth;
			autoExpanded = resizeStartAutoExpanded;
		}
		// Clear first: geometry reconciliation can run during layout updates.
		resizing = false;
		syncOverlayWidth();
		syncFullscreenLayoutAdapter();
		const mouseTerminal = resizeMouseTerminal;
		const unsubscribe = unsubscribeInput;
		dragging = false;
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
		// A terminal resize clamps presentation only, never the preferred width.
	};

	const attach = (nextTui: TUI) => {
		if (disposed) throw new Error("Cannot attach a disposed split pane");
		if (tui === nextTui) return;
		if (tui) throw new Error("Split pane is already attached to another TUI");
		tui = nextTui;
		imageCompositor = createImageCompositorBinding(nextTui, (width) => {
			if (!isPiFullscreenRenderer() || fullscreenSidebarHidden || !fullscreenSidebarComponent) {
				return undefined;
			}
			const sidebar = effectiveSidebarWidth(width);
			if (sidebar === 0) return undefined;
			return {
				column: width - sidebar,
				width: sidebar,
				lines: fullscreenSidebarComponent.render(sidebar),
			};
		});
		reconcileResizeWidth(nextTui.terminal.columns);
		syncOverlayWidth(nextTui.terminal.columns);
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
				const width = tui?.terminal.columns ?? 0;
				const dividerX = resolveLayout(width).mainWidth + 1;
				if (Math.abs(mouse.x - dividerX) <= 1) dragging = true;
				return { consume: true };
			}
			if (mouse.motion && dragging && tui) {
				const proposed = tui.terminal.columns - mouse.x + 1;
				controller.setSidebarWidth(proposed);
			}
			return { consume: true };
		}
		if (matchesKey(data, "shift+left")) {
			controller.setSidebarWidth(effectiveSidebarWidth(tui?.terminal.columns ?? 0) + 4);
			return { consume: true };
		}
		if (matchesKey(data, "shift+right")) {
			controller.setSidebarWidth(effectiveSidebarWidth(tui?.terminal.columns ?? 0) - 4);
			return { consume: true };
		}
		if (matchesKey(data, "left")) {
			controller.setSidebarWidth(effectiveSidebarWidth(tui?.terminal.columns ?? 0) + 1);
			return { consume: true };
		}
		if (matchesKey(data, "right")) {
			controller.setSidebarWidth(effectiveSidebarWidth(tui?.terminal.columns ?? 0) - 1);
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
		show(nextMode = "on") {
			if (disposed) return;
			stopResize(true);
			if (enabled && mode === nextMode && nextMode !== "auto") return;
			mode = nextMode;
			autoExpanded = undefined;
			enabled = true;
			syncOverlayWidth();
			requestRender();
		},
		hide() {
			stopResize(true);
			if (!enabled) return;
			enabled = false;
			fullscreenSidebarComponent = undefined;
			fullscreenSidebarHidden = false;
			// Remove the sidebar even if subsequent compositor reconciliation fails.
			syncFullscreenLayoutAdapter();
			requestRender();
		},
		getStatus: () => ({
			mode: enabled ? mode : "off",
			presentation: resolveLayout(tui?.terminal.columns ?? 0).presentation,
		}),
		setSidebarWidth(width) {
			const max =
				resizing && tui ? Math.min(maximumSidebar, tui.terminal.columns - minimumMain) : maximumSidebar;
			const next = clamp(finiteInteger(width, sidebarWidth), minimumSidebar, Math.max(minimumSidebar, max));
			if (next === sidebarWidth) return;
			sidebarWidth = next;
			syncOverlayWidth();
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
			resizeStartWidth = sidebarWidth;
			resizeStartAutoExpanded = autoExpanded;
			// Keep the mode; suspend automatic collapse only during the gesture.
			resizing = true;
			syncOverlayWidth();
			syncFullscreenLayoutAdapter();
			dragging = false;
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
			fullscreenSidebarComponent = undefined;
			fullscreenSidebarHidden = false;
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
	return controller;
}

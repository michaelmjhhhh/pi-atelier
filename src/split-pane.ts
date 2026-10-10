import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { matchesKey, sliceByColumn } from "@earendil-works/pi-tui";
import { compositeTuiLine, HStack, isViewportTUI } from "./pi-tui-host.js";
import {
	createImageCompositorBinding,
	findOwnMethod,
	type ImageCompositorBinding,
} from "./image-compositor.js";
import { hasCapturingOverlay } from "./image-compositor.js";
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
const PI_084_SELECTION_ADAPTER = Symbol("pi-atelier.selection-adapter");

type SelectionColumns = (
	line: string,
	row: number,
	selection: { start: { scrollView?: unknown } },
	minColumn?: number,
	maxColumn?: number,
) => { start: number; end: number };
type ApplySelection = (screen: string[], layout?: unknown) => string[];

interface SelectionAdapterState {
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
	[PI_084_SELECTION_ADAPTER]: SelectionAdapterState | undefined;
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
const AUTO_MAIN_WIDTH = 80;
const AUTO_REOPEN_MARGIN = 8;

export type SidebarMode = "auto" | "manual";
export type SidebarPresentation = "shown" | "auto-collapsed" | "too-narrow" | "off";

export interface SidebarStatus {
	mode: SidebarMode;
	enabled: boolean;
	presentation: SidebarPresentation;
}

/**
 * Whether the attached TUI belongs to a host built from Pi's TUI package,
 * which publishes `TuiMode` (`"regular" | "fullscreen"`) on every renderer.
 * A host built from another TUI reports no `mode`; such a host also routes
 * focused-overlay input without a fall-through, so a persistent sidebar
 * overlay without `handleInput` would swallow every keystroke (see
 * docs/upstream-pi-atelier-overlay-input.md). The gate is on the surface,
 * not on fullscreen: Pi's regular renderer legally mounts the same
 * nonCapturing overlay.
 */
export const isPiTuiSurface = (tui: TUI | undefined): boolean =>
	(tui as { mode?: unknown } | undefined)?.mode === "regular" ||
	(tui as { mode?: unknown } | undefined)?.mode === "fullscreen";

export interface SplitPaneControllerOptions {
	onError?(error: unknown): void;
	subscribeInput?(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	onResizeChange?(resizing: boolean): void;
	onVisibilityChange?(): void;
	onWarning?(message: string): void;
}

export interface SplitPaneController {
	attach(tui: TUI): void;
	show(): void;
	setMode(mode: SidebarMode): void;
	hide(): void;
	getStatus(): SidebarStatus;
	setSidebarWidth(width: number): void;
	getSidebarWidth(): number;
	isEnabled(): boolean;
	/** Whether the attached host serves Pi's TUI surface and tolerates a persistent nonCapturing overlay. */
	isPiTuiSurface(): boolean;
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
	let mode: SidebarMode = "manual";
	let autoExpanded: boolean | undefined;
	let lastPresentation: SidebarPresentation = "off";
	let visibilityNotificationPending = false;
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

	/**
	 * The host's regular transcript renderer, detected structurally rather
	 * than by class name: the surface reports `mode: "regular"` (Pi's class
	 * field, instance- or prototype-side) and provides a `render` plus a
	 * terminal accessor. A renderer class prototype owns its `constructor`;
	 * an ad-hoc `Object.create(base)` surface does not, and re-binding such a
	 * bag's inherited render could hijack unrelated children sharing the base.
	 */
	const resolveRendererShape = (nextTui: TUI): { prototype: object; render: TUI["render"] } | undefined => {
		const instance = nextTui as { mode?: unknown; terminal?: unknown };
		const prototype = Object.getPrototypeOf(nextTui) as {
			constructor?: unknown;
			mode?: unknown;
		} | null;
		if (!prototype) return undefined;
		if (
			instance.mode !== "regular" &&
			prototype.mode !== "regular" &&
			(prototype as { constructor?: { name?: string } }).constructor?.name !== "TuiMainScreen"
		) {
			return undefined;
		}
		// A real renderer class owns its constructor on the prototype; an
		// `Object.create(base)` bag only inherits Object's.
		if (!Object.prototype.hasOwnProperty.call(prototype, "constructor")) return undefined;
		const render = findOwnMethod<TUI["render"]>(prototype, "render");
		if (!render) return undefined;
		// Without a terminal the adapter loses its resize-reconciliation signal.
		if (typeof instance.terminal !== "object") return undefined;
		return { prototype, render };
	};

	const findPrototypeRender = (nextTui: TUI): TUI["render"] | undefined =>
		resolveRendererShape(nextTui)?.render;

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

	/**
	 * Clip screen selection to the reserved main pane whenever the host
	 * exposes the selection machinery, branded Pi or not: a non-branded
	 * regular host still runs selection and OSC-52 copies across the full
	 * terminal, including the sidebar's columns.
	 */
	const syncSelectionAdapter = () => {
		if (!tui) return;
		const adaptedTui = tui as AdaptedTui;
		if (adaptedTui[PI_084_SELECTION_ADAPTER]) return;
		if (tui.mode !== "regular" && !isPiFullscreenRenderer()) return;
		// Read the concrete methods, not forwarding functions from Pi's stable proxy.
		const prototype = Object.getPrototypeOf(tui) as object | null;
		const baseSelectionColumns = findOwnMethod<SelectionColumns>(prototype, "getSelectionColumns");
		if (!baseSelectionColumns) return;
		const baseApplySelection = findOwnMethod<ApplySelection>(prototype, "applySelection");
		adaptedTui[PI_084_SELECTION_ADAPTER] = {
			owner: adapterOwner,
			baseSelectionColumns,
			...(baseApplySelection ? { baseApplySelection } : {}),
		};
		// How many columns this host currently reserves for the sidebar:
		// the fullscreen HStack absconds it behind the overlay component,
		// while a regular host reserves it purely through the layout.
		const reservedColumns = (width: number): number =>
			isPiFullscreenRenderer()
				? fullscreenSidebarWidth(width)
				: visibleAt(width)
					? effectiveSidebarWidth(width)
					: 0;
		adaptedTui.getSelectionColumns = function (line, row, selection, minColumn, maxColumn) {
			const columns = baseSelectionColumns.call(this, line, row, selection, minColumn, maxColumn);
			// Pi falls back to screen selection when a drag starts outside a ScrollView
			// (e.g. the editor). This method serves both highlighting and OSC 52 copying.
			if (selection.start.scrollView || this.hasOverlay()) return columns;
			const width = this.terminal.columns;
			const sidebar = reservedColumns(width);
			if (sidebar <= 0) return columns;
			const mainWidth = width - sidebar;
			return { start: Math.min(columns.start, mainWidth), end: Math.min(columns.end, mainWidth) };
		};
		if (!baseApplySelection) return;
		adaptedTui.applySelection = function (screen, layout) {
			const selected = baseApplySelection.call(this, screen, layout);
			const width = this.terminal.columns;
			const sidebar = reservedColumns(width);
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

	const restoreSelectionAdapter = () => {
		if (!tui) return;
		const adaptedTui = tui as AdaptedTui;
		const state = adaptedTui[PI_084_SELECTION_ADAPTER];
		if (state?.owner !== adapterOwner) return;
		adaptedTui.getSelectionColumns = state.baseSelectionColumns;
		if (state.baseApplySelection) adaptedTui.applySelection = state.baseApplySelection;
		adaptedTui[PI_084_SELECTION_ADAPTER] = undefined;
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

	// All renderers and presentation consumers resolve the outer terminal width here.
	// Invalid resize dimensions must not change the automatic expansion history.
	const resolveLayout = (terminalWidth: number) => {
		// Fullscreen layout normalizes invalid widths to 1; retain the raw terminal validity.
		const reportedWidth = tui?.terminal.columns ?? terminalWidth;
		const validWidth =
			Number.isFinite(terminalWidth) &&
			terminalWidth > 0 &&
			Number.isFinite(reportedWidth) &&
			reportedWidth > 0;
		if (enabled && mode === "auto" && validWidth) {
			const threshold = AUTO_MAIN_WIDTH + sidebarWidth;
			autoExpanded = terminalWidth >= threshold + (autoExpanded === false ? AUTO_REOPEN_MARGIN : 0);
		}
		const presentation: SidebarPresentation = !enabled
			? "off"
			: !validWidth || terminalWidth < MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH
				? "too-narrow"
				: mode === "auto" && !autoExpanded
					? "auto-collapsed"
					: "shown";
		const effectiveWidth =
			presentation === "shown"
				? clamp(sidebarWidth, MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, terminalWidth - MIN_MAIN_WIDTH))
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

	/**
	 * Pi asks both layouts whether the sidebar is visible on every frame; use that
	 * to follow terminal resizes before answering.
	 */
	const observeWidth = (terminalWidth: number): boolean => {
		reconcileResizeWidth(terminalWidth);
		syncOverlayWidth(terminalWidth);
		const shown = visibleAt(terminalWidth);
		if (!shown) return false;
		// A capturing host dialog opens over these columns: the sidebar steps
		// aside for the frame instead of painting over the host's modal, and
		// returns once the dialog closes. Rechecked per frame, so no extra
		// state survives a missed transition.
		return tui ? !hasCapturingOverlay(tui) : true;
	};

	const visibleAt = (terminalWidth: number): boolean => resolveLayout(terminalWidth).presentation === "shown";
	const effectiveSidebarWidth = (terminalWidth: number): number => resolveLayout(terminalWidth).sidebarWidth;

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
		syncSelectionAdapter();
		tui?.requestRender();
	};

	const stopResize = (restore: boolean) => {
		if (!resizing && !resizeMouseTerminal && !unsubscribeInput) return;
		if (restore) {
			sidebarWidth = resizeStartWidth;
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
			resizing && tui ? sidebarLimit(tui.terminal.columns) : MAX_SIDEBAR_WIDTH,
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
				const dividerX = resolveLayout(tui?.terminal.columns ?? 0).mainWidth + 1;
				if (Math.abs(mouse.x - dividerX) <= 1) dragging = true;
			} else if (mouse.motion && dragging && tui) {
				const proposed = tui.terminal.columns - mouse.x + 1;
				setSidebarWidth(proposed);
			}
			return { consume: true };
		}
		const step = RESIZE_KEYS.find(([key]) => matchesKey(data, key))?.[1];
		if (step !== undefined) {
			setSidebarWidth(effectiveSidebarWidth(tui?.terminal.columns ?? 0) + step);
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
			autoExpanded = undefined;
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
		setMode(nextMode) {
			if (disposed) return;
			stopResize(true);
			mode = nextMode;
			autoExpanded = undefined;
			syncOverlayWidth();
			requestRender();
		},
		getStatus: () => ({
			mode,
			enabled,
			presentation: resolveLayout(tui?.terminal.columns ?? 0).presentation,
		}),
		setSidebarWidth,
		getSidebarWidth: () => sidebarWidth,
		beginResize() {
			if (mode === "auto") {
				options.onWarning?.("Switch to Manual mode with /atelier sidebar manual before resizing");
				return false;
			}
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
		cancelResize: () => stopResize(true),
		isResizing: () => resizing,
		isEnabled: () => enabled,
		isPiTuiSurface: () => isPiTuiSurface(tui),
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
			restoreSelectionAdapter();
			restoreFullscreenLayoutAdapter();
			imageCompositor?.dispose();
			imageCompositor = undefined;
			tui?.requestRender();
			tui = undefined;
		},
	};
}

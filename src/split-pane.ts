import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import {
	getCapabilities,
	HStack,
	isViewportTUI,
	matchesKey,
	setCapabilities,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const ENABLE_MOUSE = "\u001b[?1002h\u001b[?1006h";
const DISABLE_MOUSE = "\u001b[?1006l\u001b[?1002l";
const END_SYNCHRONIZED_OUTPUT = "\u001b[?2026l";
const SGR_MOUSE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;
const PI_084_REGULAR_RENDER_ADAPTER = Symbol("pi-atelier.regular-render-adapter");
const PI_084_FULLSCREEN_LAYOUT_ADAPTER = Symbol("pi-atelier.fullscreen-layout-adapter");
const PI_084_FULLSCREEN_PAINT_ADAPTER = Symbol("pi-atelier.fullscreen-paint-adapter");
const PI_TUI_LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const PI_084_OVERLAY_ADAPTER = Symbol("pi-atelier.overlay-adapter");

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

interface FullscreenPaintAdapterState {
	owner: object;
	baseDoRender: () => void;
}

interface OverlayAdapterState {
	owner: object;
	baseShowOverlay: TUI["showOverlay"];
	baseHideOverlay: TUI["hideOverlay"];
}

interface TrackedOverlay {
	component: Component;
	sidebar: boolean;
	blocking: boolean;
	hidden: boolean;
	removed: boolean;
}

type AdaptedTui = TUI & {
	[PI_084_REGULAR_RENDER_ADAPTER]: RegularRenderAdapterState | undefined;
	[PI_084_FULLSCREEN_LAYOUT_ADAPTER]: FullscreenLayoutAdapterState | undefined;
	[PI_084_FULLSCREEN_PAINT_ADAPTER]: FullscreenPaintAdapterState | undefined;
	[PI_084_OVERLAY_ADAPTER]: OverlayAdapterState | undefined;
	doRender(): void;
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
	attach(tui: TUI, requestInitialRender?: boolean): void;
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

const EMPTY_SIDEBAR_COMPONENT: Component = {
	render: () => [],
	invalidate() {},
};

function isInlineImageLine(line: string): boolean {
	return line.includes("\u001b_G") || line.includes("\u001b]1337;File=");
}

function padLine(line: string, width: number): string {
	const truncated = truncateToWidth(line, width, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function composeRegularSidebar(
	mainLines: readonly string[],
	sidebar: Component,
	mainWidth: number,
	sidebarWidth: number,
	terminalHeight: number,
): string[] {
	const result = [...mainLines];
	const workingHeight = Math.max(result.length, terminalHeight);
	while (result.length < workingHeight) result.push("");
	const viewportStart = Math.max(0, workingHeight - terminalHeight);
	const sidebarLines = sidebar.render(sidebarWidth).slice(0, terminalHeight);
	for (let row = 0; row < terminalHeight; row++) {
		const index = viewportStart + row;
		const mainLine = result[index] ?? "";
		const left = isInlineImageLine(mainLine)
			? `${mainLine}${" ".repeat(mainWidth)}`
			: padLine(mainLine, mainWidth);
		result[index] = `${left}${padLine(sidebarLines[row] ?? "", sidebarWidth)}`;
	}
	return result;
}

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
	let sidebarComponent: Component | undefined;
	let sidebarHidden = false;
	let savedImageProtocol: ReturnType<typeof getCapabilities>["images"] | undefined;
	const blockingOverlays = new Set<TrackedOverlay>();
	const trackedOverlays: TrackedOverlay[] = [];
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

	const findPrototypeDoRender = (nextTui: TUI): (() => void) | undefined => {
		let prototype = Object.getPrototypeOf(nextTui) as object | null;
		while (prototype) {
			const descriptor = Object.getOwnPropertyDescriptor(prototype, "doRender");
			if (typeof descriptor?.value === "function") return descriptor.value as () => void;
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

	// Pi treats terminal-image escape rows as indivisible, so modal overlays
	// cannot safely paint over them. Use image fallbacks only while a modal is
	// active; Sidebar rows have dedicated regular/fullscreen composition paths.
	const syncImageSuppression = () => {
		if (!tui) return;
		const shouldSuppress = blockingOverlays.size > 0;
		if (shouldSuppress && savedImageProtocol === undefined) {
			const capabilities = getCapabilities();
			savedImageProtocol = capabilities.images;
			if (capabilities.images !== null) {
				setCapabilities({ ...capabilities, images: null });
				tui.invalidate();
			}
			return;
		}
		if (!shouldSuppress && savedImageProtocol !== undefined) {
			const capabilities = getCapabilities();
			const imageProtocol = savedImageProtocol;
			savedImageProtocol = undefined;
			if (capabilities.images !== imageProtocol) {
				setCapabilities({ ...capabilities, images: imageProtocol });
				tui.invalidate();
			}
		}
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
			const mainWidth = sidebar > 0 ? width - sidebar : width;
			let mainLines = Reflect.apply(baseRender, tui, [mainWidth]);
			if (blockingOverlays.size > 0) {
				mainLines = mainLines.map((line) => (isInlineImageLine(line) ? "" : line));
			}
			if (sidebar === 0 || !sidebarComponent || sidebarHidden) return mainLines;
			return composeRegularSidebar(mainLines, sidebarComponent, mainWidth, sidebar, tui?.terminal.rows ?? 0);
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

	const createFullscreenSplitRoot = (originalRoot: Component): Component => {
		const sidebarEntry = (component: Component) => ({
			component,
			basis: sidebarWidth,
			grow: 0,
			shrink: 1,
			minSize: minimumSidebar,
			maxSize: maximumSidebar,
			visible: ({ width }: { width: number }) => {
				reconcileResizeWidth(width);
				syncOverlayWidth(width);
				return !sidebarHidden && visibleAt(width);
			},
		});
		const mainEntry = { component: originalRoot, basis: 0, grow: 1, shrink: 1, minSize: minimumMain };
		const splitRoot = new HStack([mainEntry, sidebarEntry(sidebarComponent ?? EMPTY_SIDEBAR_COMPONENT)]);
		const layoutRoot = new HStack([mainEntry, sidebarEntry(EMPTY_SIDEBAR_COMPONENT)]);
		const layoutNode = (layoutRoot as unknown as Record<symbol, () => unknown>)[PI_TUI_LAYOUT_NODE];
		if (layoutNode) {
			Object.defineProperty(splitRoot, PI_TUI_LAYOUT_NODE, {
				value: () => Reflect.apply(layoutNode, layoutRoot, []),
			});
		}
		return splitRoot;
	};

	const syncFullscreenLayoutAdapter = () => {
		if (!isPiFullscreenRenderer() || !tui) return;
		const adaptedTui = tui as AdaptedTui;
		const currentState = adaptedTui[PI_084_FULLSCREEN_LAYOUT_ADAPTER];
		if (currentState && currentState.owner !== adapterOwner) return;
		const currentRoot = adaptedTui.layoutRoot;
		if (currentState?.owner === adapterOwner && currentRoot === currentState.splitRoot) {
			if (currentState.sidebarWidth === sidebarWidth && currentState.sidebarComponent === sidebarComponent) {
				return;
			}
			const splitRoot = createFullscreenSplitRoot(currentState.originalRoot);
			adaptedTui.setLayoutRoot(splitRoot);
			currentState.splitRoot = splitRoot;
			currentState.sidebarWidth = sidebarWidth;
			currentState.sidebarComponent = sidebarComponent;
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
			sidebarComponent,
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

	const renderFullscreenSidebar = (): string => {
		if (!tui || !isPiFullscreenRenderer() || !enabled || !sidebarComponent || sidebarHidden) return "";
		if (blockingOverlays.size > 0) return "";
		const width = effectiveSidebarWidth(tui.terminal.columns);
		if (width === 0) return "";
		const height = Math.max(0, tui.terminal.rows);
		const column = tui.terminal.columns - width + 1;
		const lines = sidebarComponent.render(width).slice(0, height);
		let output = "\u001b7";
		for (let row = 0; row < height; row++) {
			output += `\u001b[${row + 1};${column}H${padLine(lines[row] ?? "", width)}\u001b[0m\u001b]8;;\u0007`;
		}
		return `${output}\u001b8`;
	};

	const syncFullscreenPaintAdapter = () => {
		if (!tui || !isPiFullscreenRenderer()) return;
		const adaptedTui = tui as AdaptedTui;
		const currentState = adaptedTui[PI_084_FULLSCREEN_PAINT_ADAPTER];
		if (currentState?.owner === adapterOwner || currentState) return;
		const baseDoRender = findPrototypeDoRender(tui);
		if (!baseDoRender) return;
		adaptedTui[PI_084_FULLSCREEN_PAINT_ADAPTER] = { owner: adapterOwner, baseDoRender };
		adaptedTui.doRender = () => {
			if (!tui) return;
			const terminal = tui.terminal;
			const baseWrite = terminal.write;
			let painted = false;
			terminal.write = (data: string) => {
				if (!painted) {
					const sidebar = renderFullscreenSidebar();
					const boundary = sidebar ? data.lastIndexOf(END_SYNCHRONIZED_OUTPUT) : -1;
					if (boundary >= 0) {
						data = `${data.slice(0, boundary)}${sidebar}${data.slice(boundary)}`;
						painted = true;
					}
				}
				Reflect.apply(baseWrite, terminal, [data]);
			};
			try {
				Reflect.apply(baseDoRender, tui, []);
			} finally {
				terminal.write = baseWrite;
			}
			if (!painted) {
				const sidebar = renderFullscreenSidebar();
				if (sidebar) Reflect.apply(baseWrite, terminal, [sidebar]);
			}
		};
	};

	const restoreFullscreenPaintAdapter = () => {
		if (!tui) return;
		const adaptedTui = tui as AdaptedTui;
		const currentState = adaptedTui[PI_084_FULLSCREEN_PAINT_ADAPTER];
		if (currentState?.owner !== adapterOwner) return;
		adaptedTui.doRender = currentState.baseDoRender;
		adaptedTui[PI_084_FULLSCREEN_PAINT_ADAPTER] = undefined;
	};

	const removeTrackedOverlay = (entry: TrackedOverlay) => {
		if (entry.removed) return;
		entry.removed = true;
		blockingOverlays.delete(entry);
		if (entry.sidebar && sidebarComponent === entry.component) {
			enabled = false;
			sidebarComponent = undefined;
			sidebarHidden = false;
		}
		syncImageSuppression();
		syncFullscreenLayoutAdapter();
	};

	const syncOverlayAdapter = () => {
		if (!tui) return;
		const adaptedTui = tui as AdaptedTui;
		const currentState = adaptedTui[PI_084_OVERLAY_ADAPTER];
		if (currentState?.owner === adapterOwner) return;
		if (currentState) return;
		const baseMethods = findPrototypeOverlayMethods(tui);
		if (!baseMethods) return;
		const { showOverlay: baseShowOverlay, hideOverlay: baseHideOverlay } = baseMethods;
		adaptedTui[PI_084_OVERLAY_ADAPTER] = {
			owner: adapterOwner,
			baseShowOverlay,
			baseHideOverlay,
		};
		adaptedTui.showOverlay = (component, overlayOptions) => {
			const state = adaptedTui[PI_084_OVERLAY_ADAPTER];
			const base = state?.owner === adapterOwner ? state.baseShowOverlay : baseShowOverlay;
			const sidebar = enabled && overlayOptions === overlayLayout;
			const entry: TrackedOverlay = {
				component,
				sidebar,
				blocking: !sidebar,
				hidden: false,
				removed: false,
			};
			trackedOverlays.push(entry);
			if (sidebar) {
				sidebarComponent = component;
				sidebarHidden = false;
				syncFullscreenLayoutAdapter();
			} else {
				blockingOverlays.add(entry);
			}
			syncImageSuppression();
			let handle: OverlayHandle;
			try {
				handle = Reflect.apply(base, tui, [
					component,
					sidebar ? { ...overlayOptions, visible: () => false } : overlayOptions,
				]) as OverlayHandle;
			} catch (error) {
				removeTrackedOverlay(entry);
				throw error;
			}
			return {
				hide() {
					try {
						handle.hide();
					} finally {
						removeTrackedOverlay(entry);
						tui?.requestRender();
					}
				},
				setHidden(hidden) {
					handle.setHidden(hidden);
					entry.hidden = hidden;
					if (entry.sidebar && sidebarComponent === component) {
						sidebarHidden = hidden;
					} else if (entry.blocking) {
						if (hidden) blockingOverlays.delete(entry);
						else blockingOverlays.add(entry);
					}
					syncImageSuppression();
					tui?.requestRender();
				},
				isHidden: () => handle.isHidden(),
				focus: () => handle.focus(),
				unfocus: (options) => handle.unfocus(options),
				isFocused: () => handle.isFocused(),
			};
		};
		adaptedTui.hideOverlay = () => {
			const state = adaptedTui[PI_084_OVERLAY_ADAPTER];
			const base = state?.owner === adapterOwner ? state.baseHideOverlay : baseHideOverlay;
			const entry = trackedOverlays.findLast((candidate) => !candidate.removed);
			try {
				Reflect.apply(base, tui, []);
			} finally {
				if (entry) removeTrackedOverlay(entry);
				tui?.requestRender();
			}
		};
	};

	const restoreOverlayAdapter = () => {
		if (!tui) return;
		const adaptedTui = tui as AdaptedTui;
		const currentState = adaptedTui[PI_084_OVERLAY_ADAPTER];
		if (currentState?.owner !== adapterOwner) return;
		adaptedTui.showOverlay = currentState.baseShowOverlay;
		adaptedTui.hideOverlay = currentState.baseHideOverlay;
		adaptedTui[PI_084_OVERLAY_ADAPTER] = undefined;
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

	const requestRender = () => {
		syncRegularRenderAdapter();
		syncFullscreenLayoutAdapter();
		syncFullscreenPaintAdapter();
		syncOverlayAdapter();
		syncImageSuppression();
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
		const effectiveMax = Math.min(maximumSidebar, terminalWidth - minimumMain);
		sidebarWidth = clamp(sidebarWidth, minimumSidebar, Math.max(minimumSidebar, effectiveMax));
	};

	const attach = (nextTui: TUI, requestInitialRender = true) => {
		if (disposed) throw new Error("Cannot attach a disposed split pane");
		if (tui === nextTui) return;
		if (tui) throw new Error("Split pane is already attached to another TUI");
		tui = nextTui;
		reconcileResizeWidth(nextTui.terminal.columns);
		syncOverlayWidth(nextTui.terminal.columns);
		syncRegularRenderAdapter();
		syncFullscreenLayoutAdapter();
		syncOverlayAdapter();
		if (requestInitialRender) requestRender();
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
			syncOverlayAdapter();
			requestRender();
		},
		hide() {
			stopResize(true);
			if (!enabled) return;
			enabled = false;
			sidebarComponent = undefined;
			sidebarHidden = false;
			syncImageSuppression();
			syncFullscreenLayoutAdapter();
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
			sidebarComponent = undefined;
			sidebarHidden = false;
			blockingOverlays.clear();
			syncImageSuppression();
			restoreRegularRenderAdapter();
			restoreOverlayAdapter();
			restoreFullscreenPaintAdapter();
			restoreFullscreenLayoutAdapter();
			tui?.requestRender();
			tui = undefined;
		},
	};
	return controller;
}

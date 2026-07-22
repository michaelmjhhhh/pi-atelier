import { matchesKey } from "@earendil-works/pi-tui";
import type { OverlayOptions, TUI } from "@earendil-works/pi-tui";

const ENABLE_MOUSE = "\u001b[?1002h\u001b[?1006h";
const DISABLE_MOUSE = "\u001b[?1006l\u001b[?1002l";
const SGR_MOUSE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;

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

type RenderFunction = TUI["render"];

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
	let originalRender: RenderFunction | undefined;
	let wrappedRender: RenderFunction | undefined;
	let enabled = false;
	let disposed = false;
	let resizing = false;
	let resizeStartWidth = sidebarWidth;
	let dragging = false;
	let unsubscribeInput: (() => void) | undefined;
	let mouseReportingEnabled = false;
	let controller: SplitPaneController;

	const stopResize = (restore: boolean) => {
		if (!resizing && !mouseReportingEnabled && !unsubscribeInput) return;
		if (restore) sidebarWidth = resizeStartWidth;
		dragging = false;
		resizing = false;
		if (mouseReportingEnabled) {
			tui?.terminal.write(DISABLE_MOUSE);
			mouseReportingEnabled = false;
		}
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		options.onResizeChange?.(false);
		requestRender();
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

	const visibleAt = (terminalWidth: number): boolean =>
		enabled && Number.isFinite(terminalWidth) && terminalWidth >= minimumMain + minimumSidebar;

	const effectiveSidebarWidth = (terminalWidth: number): number => {
		if (!visibleAt(terminalWidth)) return 0;
		return clamp(sidebarWidth, minimumSidebar, Math.min(maximumSidebar, terminalWidth - minimumMain));
	};

	const requestRender = () => tui?.requestRender();

	const attach = (nextTui: TUI) => {
		if (disposed) throw new Error("Cannot attach a disposed split pane");
		if (tui === nextTui) return;
		if (tui) throw new Error("Split pane is already attached to another TUI");
		tui = nextTui;
		originalRender = nextTui.render;
		const previousRender = nextTui.render;
		wrappedRender = function (this: TUI, terminalWidth: number): string[] {
			reconcileResizeWidth(terminalWidth);
			const reserved = effectiveSidebarWidth(terminalWidth);
			try {
				return previousRender.call(nextTui, terminalWidth - reserved);
			} catch (error) {
				enabled = false;
				options.onError?.(error);
				return previousRender.call(nextTui, terminalWidth);
			}
		};
		nextTui.render = wrappedRender;
		requestRender();
	};

	const handleResizeInput = (data: string): { consume?: boolean; data?: string } | undefined => {
		const mouse = parseSgrMouseEvent(data);
		if (mouse) {
			if (mouse.release) {
				if (dragging) stopResize(false);
				return { consume: true };
			}
			if (!mouse.motion && (mouse.button & 3) === 0) {
				const dividerX = (tui?.terminal.columns ?? 0) - sidebarWidth + 1;
				if (mouse.x !== dividerX) stopResize(true);
				else dragging = true;
				return { consume: true };
			}
			if (mouse.motion && dragging && tui) {
				const proposed = tui.terminal.columns - mouse.x + 1;
				const effectiveMax = Math.min(maximumSidebar, tui.terminal.columns - minimumMain);
				sidebarWidth = clamp(proposed, minimumSidebar, Math.max(minimumSidebar, effectiveMax));
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
			resizeStartWidth = sidebarWidth;
			dragging = false;
			resizing = true;
			try {
				unsubscribeInput = options.subscribeInput(handleResizeInput);
				mouseReportingEnabled = true;
				tui.terminal.write(ENABLE_MOUSE);
				options.onResizeChange?.(true);
				requestRender();
				return true;
			} catch (error) {
				options.onError?.(error);
				stopResize(true);
				return false;
			}
		},
		finishResize: () => stopResize(false),
		cancelResize: () => stopResize(true),
		isResizing: () => resizing,
		isEnabled: () => enabled,
		isVisibleAtWidth: visibleAt,
		overlayOptions: () => ({
			anchor: "top-right",
			width: tui ? effectiveSidebarWidth(tui.terminal.columns) : sidebarWidth,
			maxHeight: "100%",
			margin: 0,
			nonCapturing: true,
			visible: (terminalWidth) => visibleAt(terminalWidth),
		}),
		requestRender,
		dispose() {
			if (disposed) return;
			stopResize(true);
			disposed = true;
			enabled = false;
			if (tui && originalRender && tui.render === wrappedRender) tui.render = originalRender;
			tui?.requestRender();
			tui = undefined;
			originalRender = undefined;
			wrappedRender = undefined;
		},
	};
	return controller;
}

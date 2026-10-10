/**
 * The Pi TUI names a host may not serve.
 *
 * The host owns the `@earendil-works/pi-tui` specifier: Pi serves its own
 * package, omp serves a bundled compatibility surface built from its own TUI,
 * and that surface is a subset. A named import of a name the host omits fails
 * while the module graph is linked — before a single line of extension code
 * runs — so the failure cannot be caught, retried, or worked around at the call
 * site; it takes the whole extension down with it. Each name below is therefore
 * read off the host namespace and only replaced when the host does not serve
 * one, which keeps Pi's own implementation as the one that runs under Pi.
 *
 * Three of the four are Pi-only in practice: `HStack` and `isViewportTUI` carry
 * Pi's replaceable viewport root, and `allocateImageId` serves Pi's Kitty image
 * placement. A host that omits them keeps the regular-screen Sidebar and simply
 * stays off the viewport path.
 */
import * as hostTui from "@earendil-works/pi-tui";
import type { ViewportTUI } from "@earendil-works/pi-tui";

/** Pi's viewport brand. Shared through the symbol registry, so both hosts agree on it. */
const VIEWPORT_TUI = Symbol.for("@earendil-works/pi-tui/viewport");

/**
 * Reset between the segments of a composited row: SGR reset plus an OSC 8
 * terminator, because a spliced row must end the previous segment's colour and
 * hyperlink before the next one starts. Pi's own sequence, and the one this
 * extension's compositor already splices with.
 */
const SEGMENT_RESET = "\u001b[0m\u001b]8;;\u0007";

/**
 * Kitty and iTerm2 image rows. Their placement sequences cannot be split at an
 * arbitrary column, so `compositeTuiLine` leaves them alone.
 */
const KITTY_IMAGE = "\u001b_G";
const ITERM_IMAGE = "\u001b]1337;File=";
const isImageLine = (line: string): boolean => line.includes(KITTY_IMAGE) || line.includes(ITERM_IMAGE);

/**
 * A finite column or length inside `[0, max]`.
 *
 * Pi reads these out of a JS string and branches on `afterLen <= 0`, so no
 * argument can hurt it. A host may hand the same argument to a native binding
 * that reads it as an unsigned integer, where a negative value wraps into a
 * multi-gigabyte allocation and aborts the process, and a value past the row
 * asks for the same. Clamping to the row each argument indexes leaves every cell
 * the binding could have read unchanged.
 */
const clampExtent = (value: number, max: number): number =>
	Number.isFinite(value) ? Math.min(Math.max(0, value), max) : 0;

/**
 * `compositeTuiLine` for a host that does not serve one: Pi's own algorithm, so
 * an extension composites the way it would under Pi. The two segments of the
 * base row are sliced with the host's strict column slicer, which re-emits the
 * styling active at the slice start — the reason each segment is self-contained
 * and the resets between them cannot leak colour or a hyperlink across the seam.
 */
function localCompositeTuiLine(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	if (isImageLine(baseLine)) return baseLine;

	const total = clampExtent(totalWidth, Number.MAX_SAFE_INTEGER);
	const column = clampExtent(startCol, total);
	const width = clampExtent(overlayWidth, total);
	const baseWidth = hostTui.visibleWidth(baseLine);
	const beforeEnd = Math.min(column, baseWidth);
	const afterStart = Math.min(column + width, baseWidth);
	const before = hostTui.sliceByColumn(baseLine, 0, beforeEnd, true);
	const after = hostTui.sliceByColumn(
		baseLine,
		afterStart,
		Math.max(0, Math.min(total, baseWidth) - afterStart),
		true,
	);
	const overlay = hostTui.sliceByColumn(overlayLine, 0, width, true);

	const beforeWidth = hostTui.visibleWidth(before);
	const overlayWidthActual = hostTui.visibleWidth(overlay);
	const afterTarget = Math.max(
		0,
		total - Math.max(column, beforeWidth) - Math.max(width, overlayWidthActual),
	);
	const result =
		before +
		" ".repeat(Math.max(0, column - beforeWidth)) +
		SEGMENT_RESET +
		overlay +
		" ".repeat(Math.max(0, width - overlayWidthActual)) +
		SEGMENT_RESET +
		after +
		" ".repeat(Math.max(0, afterTarget - hostTui.visibleWidth(after)));

	// Width tracking can drift from the rendered width on an exotic sequence or a
	// wide character at a boundary, and an over-wide row breaks the terminal.
	return hostTui.visibleWidth(result) <= total
		? result
		: hostTui.sliceByColumn(result, 0, Math.min(total, result.length), true);
}

/**
 * Whether `tui` owns the viewport the way Pi's `TuiAltScreen` does, for a host
 * that does not serve `isViewportTUI`.
 *
 * The brand is the one Pi publishes, so a host whose TUI paints its child list
 * through its own frame provider — branding nothing — answers false. That keeps
 * the extension on its regular-screen Sidebar instead of letting it believe a
 * viewport root was handed over.
 */
function localIsViewportTUI(tui: unknown): tui is ViewportTUI {
	if (typeof tui !== "object" || tui === null) return false;
	return Reflect.get(tui, VIEWPORT_TUI) === true;
}

/**
 * A Kitty graphics id in `[1, 0xfffffffe]`, for a host that does not serve one.
 *
 * Random rather than sequential: two copies of a plugin in one process would
 * otherwise hand the terminal the same id for two different images and the
 * second placement would replace the first.
 */
const localAllocateImageId = (): number => Math.floor(Math.random() * 0xfffffffe) + 1;

/**
 * Stands in for Pi's `HStack`, which lays children out side by side in a
 * viewport root.
 *
 * The viewport path is the only way to reach it, and that path needs
 * `isViewportTUI` to be true — a host that omits `HStack` is a host whose TUI
 * carries no viewport brand, so this is never constructed. It exists so the
 * module graph links, and it reports the missing capability instead of
 * rendering a layout the host cannot place.
 */
class UnavailableHStack {
	constructor() {
		throw new Error(
			"HStack is unavailable: this host serves no HStack and renders no replaceable viewport root",
		);
	}
}

/** Pi's `compositeTuiLine`, or the local one when the host serves none. */
export const compositeTuiLine: typeof hostTui.compositeTuiLine =
	hostTui.compositeTuiLine ?? localCompositeTuiLine;

/** Pi's `isViewportTUI`, or the local one when the host serves none. */
export const isViewportTUI: typeof hostTui.isViewportTUI = hostTui.isViewportTUI ?? localIsViewportTUI;

/** Pi's `allocateImageId`, or the local one when the host serves none. */
export const allocateImageId: typeof hostTui.allocateImageId =
	hostTui.allocateImageId ?? localAllocateImageId;

/** Pi's `HStack`, or a stand-in that reports the host cannot render one. */
export const HStack: typeof hostTui.HStack =
	hostTui.HStack ?? (UnavailableHStack as unknown as typeof hostTui.HStack);

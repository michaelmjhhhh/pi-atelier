import { compositeTuiLine, type OverlayOptions, type TUI, visibleWidth } from "@earendil-works/pi-tui";

const RESET = "\u001b[0m\u001b]8;;\u0007";
// Keep multipart Kitty transmissions together. iTerm2's cursor-up belongs to
// the image, not the text row: leaving it behind would move the settings panel.
const IMAGE_COMMAND =
	/(?:\u001b_G[\s\S]*?\u001b\\)+|(?:\u001b\[\d+A)?\u001b\]1337;File=[^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

interface OverlayEntry {
	options?: OverlayOptions;
}

/** Pi 0.84 renderer seam. Never patch prototypes or terminal.write(). */
interface ImageRenderer {
	[IMAGE_COMPOSITOR]: Adapter | undefined;
	compositeOverlays(lines: string[], width: number, height: number): string[];
	overlayStack: OverlayEntry[];
	isOverlayVisible(entry: OverlayEntry): boolean;
}

export interface ImageSidebarFrame {
	column: number;
	width: number;
	lines: string[];
}

type SidebarFrameReader = (width: number) => ImageSidebarFrame | undefined;

interface Client {
	getSidebar?: SidebarFrameReader;
}

interface ImagePlane {
	row: number;
	column: number;
	top: number;
	bottom: number;
	sequence: string;
	iterm: boolean;
}

interface Adapter {
	clients: Set<Client>;
	restore(): void;
}

const IMAGE_COMPOSITOR = Symbol("pi-atelier.image-compositor");

function findBaseCompositor(renderer: ImageRenderer): ImageRenderer["compositeOverlays"] | undefined {
	// Pi exposes a stable Proxy whose method getters forward to the CURRENT
	// renderer. Capturing such a getter would recurse after installing our hook.
	let target: object | null = renderer;
	while (target) {
		const descriptor = Object.getOwnPropertyDescriptor(target, "compositeOverlays");
		if (typeof descriptor?.value === "function") return descriptor.value;
		target = Object.getPrototypeOf(target) as object | null;
	}
	return undefined;
}
const isImageLine = (line: string): boolean =>
	line.includes("\u001b_G") || line.includes("\u001b]1337;File=");

function separateImages(lines: string[]): { text: string[]; images: ImagePlane[] } {
	const images: ImagePlane[] = [];
	const text = lines.map((line, row) => {
		if (!isImageLine(line)) return line;
		let result = "";
		let offset = 0;
		for (const match of line.matchAll(IMAGE_COMMAND)) {
			result += line.slice(offset, match.index);
			const sequence = match[0];
			const iterm = sequence.includes("\u001b]1337;File=");
			const up = iterm ? Number(/^\u001b\[(\d+)A/.exec(sequence)?.[1] ?? 0) : 0;
			const rows = iterm ? up + 1 : Number(/(?:^|,)r=(\d+)(?:,|;)/.exec(sequence)?.[1] ?? 1);
			images.push({
				row,
				column: visibleWidth(result),
				top: row - up,
				bottom: row - up + rows,
				sequence,
				iterm,
			});
			offset = match.index + sequence.length;
		}
		return result + line.slice(offset);
	});
	return { text, images };
}

/**
 * Share one instance-local adapter between the footer and split pane. Pi's text
 * compositor deliberately skips image-bearing rows; composite text first, then
 * emit the untouched graphics commands at their original columns. In fullscreen
 * mode the HStack has already lost the sidebar on those rows, so repair just
 * those cells before Pi paints its overlays.
 *
 * Capturing overlays temporarily suppress visible transcript images. Neither
 * iTerm2 nor Pi's Kitty placements provide portable text-dialog occlusion. Keep
 * every reserved row, and let Pi's existing diff/deletion path restore images
 * when the last visible dialog closes. Model input and session data never change.
 */
function acquireImageCompositor(tui: TUI, getSidebar?: SidebarFrameReader): () => void {
	const renderer = tui as unknown as ImageRenderer;
	if (
		typeof renderer.compositeOverlays !== "function" ||
		typeof renderer.isOverlayVisible !== "function" ||
		!Array.isArray(renderer.overlayStack)
	) {
		return () => undefined;
	}

	let adapter = renderer[IMAGE_COMPOSITOR];
	if (!adapter) {
		const base = findBaseCompositor(renderer);
		if (!base) return () => undefined;
		const clients = new Set<Client>();
		let concreteRenderer = renderer;
		let rendered = false;
		const composite: ImageRenderer["compositeOverlays"] = function (
			this: ImageRenderer,
			lines,
			width,
			height,
		) {
			concreteRenderer = this;
			rendered = true;
			if (clients.size === 0 || !lines.some(isImageLine)) return base.call(this, lines, width, height);
			const { text, images } = separateImages(lines);
			if (images.length === 0) return base.call(this, lines, width, height);

			for (const client of clients) {
				const sidebar = client.getSidebar?.(width);
				if (!sidebar) continue;
				for (const { row } of images) {
					text[row] = compositeTuiLine(
						text[row] ?? "",
						sidebar.lines[row] ?? "",
						sidebar.column,
						sidebar.width,
						width,
					);
				}
			}

			const result = base.call(this, text, width, height);
			const modalVisible = this.overlayStack.some(
				(entry) => !entry.options?.nonCapturing && this.isOverlayVisible(entry),
			);
			const viewportTop = Math.max(0, result.length - height);
			for (const image of images) {
				if (modalVisible && image.bottom > viewportTop && image.top < result.length) {
					if (image.iterm) {
						// iTerm2 has no placement deletion. Dirty ALL occupied rows so
						// Pi erases their cells, not just the final command-bearing row.
						for (let row = Math.max(0, image.top); row < Math.min(result.length, image.bottom); row++) {
							result[row] += RESET;
						}
					}
					continue;
				}
				const line = result[image.row] ?? "";
				// Draw graphics after text (spaces can erase iTerm2 image cells).
				// Pi images return to their command row; explicitly restore the
				// column, which differs between Kitty C=1 and iTerm2 placements.
				const endColumn = Math.min(width, visibleWidth(line) + 1);
				result[image.row] = `${line}${RESET}\u001b[${image.column + 1}G${image.sequence}\u001b[${endColumn}G`;
			}
			return result;
		};
		renderer.compositeOverlays = composite;
		adapter = {
			clients,
			restore() {
				// Prefer the concrete renderer captured by the hook, even if Pi's
				// stable reference has since switched regular/fullscreen modes.
				if (concreteRenderer[IMAGE_COMPOSITOR] !== adapter) return;
				if (!rendered || concreteRenderer.compositeOverlays === composite) {
					concreteRenderer.compositeOverlays = base;
				}
				concreteRenderer[IMAGE_COMPOSITOR] = undefined;
			},
		};
		renderer[IMAGE_COMPOSITOR] = adapter;
	}

	const client: Client = getSidebar ? { getSidebar } : {};
	adapter.clients.add(client);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		adapter.clients.delete(client);
		if (adapter.clients.size > 0) return;
		adapter.restore();
	};
}

/** Rebind when Pi switches the renderer behind its stable TUI reference. */
export function createImageCompositorBinding(
	tui: TUI,
	getSidebar?: SidebarFrameReader,
): { sync(): void; dispose(): void } {
	let current: Adapter | undefined;
	let release: (() => void) | undefined;
	let disposed = false;
	const sync = (): void => {
		if (disposed) return;
		const renderer = tui as unknown as ImageRenderer;
		if (current && renderer[IMAGE_COMPOSITOR] === current) return;
		release?.();
		release = acquireImageCompositor(tui, getSidebar);
		current = renderer[IMAGE_COMPOSITOR];
	};
	sync();
	return {
		sync,
		dispose() {
			if (disposed) return;
			disposed = true;
			release?.();
			release = undefined;
			current = undefined;
		},
	};
}

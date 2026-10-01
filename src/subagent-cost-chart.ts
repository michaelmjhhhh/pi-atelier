import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type AtelierPalette, PALETTE_RGB, type PaletteRole, paintRgb, type Rgb } from "./palette.js";
import { interpolateCostCurve, renderCostImage } from "./subagent-cost-image.js";
import type { SubagentUsageSnapshot } from "./subagent-usage.js";
import { clamp, sanitizeInline } from "./text.js";

const COLORS: readonly PaletteRole[] = ["input", "chartPink", "cache", "chartGreen", "cost", "output"];
// Golden-angle hues extend the palette without recycling six colors. The index,
// rather than the current run count, keeps each color stable as children arrive.
function additionalColor(index: number): Rgb {
	const hue = ((index - COLORS.length) * 137.508 + 52) % 360;
	const saturation = 0.72;
	const lightness = index % 2 ? 0.76 : 0.6;
	const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
	const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
	const channels: Rgb =
		hue < 60
			? [chroma, x, 0]
			: hue < 120
				? [x, chroma, 0]
				: hue < 180
					? [0, chroma, x]
					: hue < 240
						? [0, x, chroma]
						: hue < 300
							? [x, 0, chroma]
							: [chroma, 0, x];
	const byte = (channel: number): number => Math.round((channel + lightness - chroma / 2) * 255);
	return [byte(channels[0]), byte(channels[1]), byte(channels[2])];
}
/** RGB for a series, shared by the text plot and the raster image. */
function seriesRgb(index: number): Rgb {
	const role = COLORS[index];
	return role ? PALETTE_RGB[role] : additionalColor(index);
}

export const costLegendColumns = (width: number): number => (width >= 72 ? 3 : width >= 36 ? 2 : 1);

export interface SubagentCostChartGraphics {
	/** Stable owner for a cached terminal image; omit to draw characters only. */
	imageOwner?: object | undefined;
	/** A capturing dialog is open: keep the reserved rows but draw no plot. */
	suspendPlot?: boolean;
}

export interface SubagentCostChartOptions extends SubagentCostChartGraphics {
	height?: number;
	focusedSeries?: string | undefined;
	focusedPoint?: number | undefined;
	legendRows?: number;
	legendPage?: number;
}

// Each bit is a connection through a cell edge: up, right, down, left.
// Rounded box-drawing glyphs join across character boundaries without dot gaps.
const UP = 1;
const RIGHT = 2;
const DOWN = 4;
const LEFT = 8;
const ROUNDED_GLYPHS = [" ", "│", "─", "╰", "│", "│", "╭", "├", "─", "╯", "─", "┴", "╮", "┤", "┬", "┼"];
const BIT_COUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

function glyph(mask: number, unicode: boolean): string {
	if (unicode) return ROUNDED_GLYPHS[mask] ?? "─";
	if (mask === (LEFT | RIGHT) || mask === LEFT || mask === RIGHT) return "-";
	return mask === UP || mask === DOWN || mask === (UP | DOWN) ? "|" : "+";
}

/** Each curve is one child's observed cumulative cost, on a shared elapsed-time axis. */
export function subagentCostChart(
	usage: SubagentUsageSnapshot,
	width: number,
	decimals: number,
	unicode: boolean,
	palette: AtelierPalette,
	options: SubagentCostChartOptions = {},
): string[] {
	if (width < 24) return [];
	const all = usage.costHistory;
	const selected = all
		.map((series, index) => ({ series, index }))
		.filter(({ series }) => series.points.length > 1);
	const incomplete = Boolean(usage.unavailable || usage.limited || usage.historyUnavailable);
	if (!selected.length) {
		if (incomplete) return [palette.paint("warning", "Cost history unavailable · partial")];
		return usage.pending || usage.runs.length
			? [palette.paint("dim", usage.pending ? "Cost curves · awaiting usage" : "Cost history unavailable")]
			: [];
	}
	const maximum = Math.max(...selected.flatMap(({ series }) => series.points.map((point) => point.cost)));
	const duration = Math.max(
		...selected.map(({ series }) => (series.points.at(-1)?.at ?? series.startedAt) - series.startedAt),
		1,
	);
	const label = `$${maximum.toFixed(decimals)}`;
	const columns = Math.floor(width) - label.length - 2;
	if (columns < 10) return [];
	const height = clamp(options.height ?? (width >= 60 ? 10 : 5), 3, 24);
	// Unit coordinates: elapsed share of the longest run, and share of the highest cost.
	const curves = selected.map(({ series, index }) => ({
		series,
		index,
		points: series.points.map((point) => ({
			u: (point.at - series.startedAt) / duration,
			v: maximum > 0 ? point.cost / maximum : 0,
		})),
	}));
	const paintSeries = (index: number, text: string): string =>
		index < COLORS.length || !palette.colorEnabled
			? palette.paint(COLORS[index % COLORS.length] ?? "output", text)
			: paintRgb(additionalColor(index), text);
	const isDimmed = (id: string): boolean =>
		options.focusedSeries !== undefined && options.focusedSeries !== id;
	const paintFocused = (index: number, id: string, text: string): string =>
		isDimmed(id) ? palette.paint("dim", text) : paintSeries(index, text);
	const axisLabel = (y: number): string =>
		(y === 0 ? label : y === height - 1 ? "$0" : "").padStart(label.length);

	const partial = selected.some(({ series }) => series.partial) || incomplete;
	const rows = [
		palette.paint("muted", `Cost per agent · ${selected.length} curves${partial ? " · partial" : ""}`),
	];
	if (options.suspendPlot) {
		// Occlusion is temporary, not a terminal capability failure. Keep the
		// reserved rows without switching the background to character strokes.
		for (let y = 0; y < height; y++) {
			rows.push(
				y === Math.floor(height / 2)
					? palette.paint("dim", truncateToWidth("Close dialog to view graph", width, "…"))
					: "",
			);
		}
		rows.push("");
	} else {
		const image = options.imageOwner
			? renderCostImage(
					options.imageOwner,
					curves.map(({ series, index, points }) => ({
						id: series.id,
						points,
						selectedPoint: series.id === options.focusedSeries ? options.focusedPoint : undefined,
						color: seriesRgb(index),
						opacity: isDimmed(series.id) ? 0.18 : 0.95,
					})),
					columns,
					height,
				)
			: undefined;
		if (image) {
			for (let y = 0; y < height; y++)
				rows.push(palette.paint("dim", `${axisLabel(y)}  `) + (image[y] ?? ""));
		} else {
			rows.push(
				...textPlot(curves, columns, height, options).map((line, y) => {
					const painted = line
						.map((cell) => {
							if (!cell) return " ";
							if (cell.marker) return paintSeries(cell.index, unicode ? "●" : "o");
							const curve = curves[cell.owner];
							return curve ? paintFocused(curve.index, curve.series.id, glyph(cell.bits, unicode)) : " ";
						})
						.join("");
					return palette.paint("dim", `${axisLabel(y)} ${unicode ? "│" : "|"}`) + painted;
				}),
			);
		}
		const end = `${(duration / 1000).toFixed(duration < 10000 ? 1 : 0)}s`;
		rows.push(
			palette.paint(
				"dim",
				`${" ".repeat(label.length + 2)}0s${" ".repeat(Math.max(1, columns - end.length - 2))}${end}`,
			),
		);
	}

	const legendColumns = costLegendColumns(width);
	const pageSize = legendColumns * Math.max(1, Math.floor(options.legendRows ?? 5));
	const page = clamp(Math.floor(options.legendPage ?? 0), 0, Math.ceil(selected.length / pageSize) - 1);
	const start = page * pageSize;
	const cellWidth = Math.floor((width - (legendColumns - 1) * 2) / legendColumns);
	const legend = selected.slice(start, start + pageSize).map(({ series, index }) => {
		const name = truncateToWidth(
			sanitizeInline(`#${index + 1} ${series.agent}`),
			Math.max(1, cellWidth - 2),
			"…",
		);
		const text = `${unicode ? "━" : "-"} ${name}`;
		return paintFocused(index, series.id, text) + " ".repeat(Math.max(0, cellWidth - visibleWidth(text)));
	});
	for (let index = 0; index < legend.length; index += legendColumns)
		rows.push(legend.slice(index, index + legendColumns).join("  "));

	if (selected.length > pageSize)
		rows.push(
			palette.paint(
				"dim",
				`Legend ${start + 1}–${Math.min(start + pageSize, selected.length)}/${selected.length}`,
			),
		);
	if (all.length > selected.length)
		rows.push(palette.paint("dim", `${all.length - selected.length} awaiting cost history`));
	return rows;
}

type PlotCell = { marker: true; index: number } | { marker: false; owner: number; bits: number } | undefined;

/** Rasterize curves into box-drawing cells; the focused curve wins shared cells. */
function textPlot(
	curves: readonly { series: { id: string }; index: number; points: readonly { u: number; v: number }[] }[],
	columns: number,
	height: number,
	options: SubagentCostChartOptions,
): PlotCell[][] {
	const toCell = ({ u, v }: { u: number; v: number }) => ({
		x: u * (columns - 1),
		y: height - 1 - v * (height - 1),
	});
	const layers = curves.map(({ points }) => {
		const layer = Array.from({ length: height }, () => Array<number>(columns).fill(0));
		const mark = (x: number, y: number, direction: number): void => {
			const row = layer[y];
			if (row) row[x] = (row[x] ?? 0) | direction;
		};
		let previous: { x: number; y: number } | undefined;
		for (const point of interpolateCostCurve(points.map(toCell))) {
			const x = Math.round(point.x);
			const y = Math.round(point.y);
			if (!previous) {
				previous = { x, y };
				continue;
			}
			while (previous.x < x) {
				mark(previous.x, previous.y, RIGHT);
				previous.x++;
				mark(previous.x, previous.y, LEFT);
			}
			while (previous.y !== y) {
				const upward = y < previous.y;
				mark(previous.x, previous.y, upward ? UP : DOWN);
				previous.y += upward ? -1 : 1;
				mark(previous.x, previous.y, upward ? DOWN : UP);
			}
		}
		return layer;
	});
	const focused = curves.find(({ series }) => series.id === options.focusedSeries);
	const focusedPoint = options.focusedPoint === undefined ? undefined : focused?.points[options.focusedPoint];
	const marker = focusedPoint && focused ? toCell(focusedPoint) : undefined;
	return Array.from({ length: height }, (_, y) =>
		Array.from({ length: columns }, (_, x): PlotCell => {
			if (marker && focused && Math.round(marker.x) === x && Math.round(marker.y) === y)
				return { marker: true, index: focused.index };
			let cell: PlotCell;
			let weight = 0;
			for (const [owner, layer] of layers.entries()) {
				const bits = layer[y]?.[x] ?? 0;
				const count = BIT_COUNT[bits] ?? 0;
				// Draw one complete stroke per cell instead of fusing unrelated curves into ladder rungs.
				const priority = count + (count && curves[owner]?.series.id === options.focusedSeries ? 10 : 0);
				if (count && priority >= weight) {
					cell = { marker: false, owner, bits };
					weight = priority;
				}
			}
			return cell;
		}),
	);
}

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { interpolateCostCurve, renderCostImage, type ChartRgb } from "./subagent-cost-image.js";
import type { AtelierPalette, PaletteRole } from "./palette.js";
import type { SubagentUsageSnapshot } from "./subagent-usage.js";

const COLORS: PaletteRole[] = ["input", "chartPink", "cache", "chartGreen", "cost", "output"];
// Golden-angle hues extend the palette without recycling six colors. The index,
// rather than the current run count, keeps each color stable as children arrive.
function additionalColor(index: number): ChartRgb {
	const hue = ((index - COLORS.length) * 137.508 + 52) % 360;
	const saturation = 0.72;
	const lightness = index % 2 ? 0.76 : 0.6;
	const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
	const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
	const channels: ChartRgb =
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
export const costLegendColumns = (width: number): number => (width >= 72 ? 3 : width >= 36 ? 2 : 1);

const clean = (text: string): string =>
	text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f]/g, "");

/** Each curve is one child's observed cumulative cost, on a shared elapsed-time axis. */
export function subagentCostChart(
	usage: SubagentUsageSnapshot,
	width: number,
	decimals: number,
	unicode: boolean,
	palette: AtelierPalette,
	options: {
		height?: number;
		focusedSeries?: string | undefined;
		focusedPoint?: number | undefined;
		imageOwner?: object | undefined;
		legendRows?: number;
		legendPage?: number;
	} = {},
): string[] {
	if (width < 24) return [];
	const all = usage.costHistory ?? [];
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
	const height = Math.max(3, Math.min(24, options.height ?? (width >= 60 ? 10 : 5)));
	const paintSeries = (index: number, text: string): string => {
		if (index < COLORS.length || !palette.colorEnabled)
			return palette.paint(COLORS[index % COLORS.length] ?? "output", text);
		return `\u001b[38;2;${additionalColor(index).join(";")}m${text}\u001b[39m`;
	};
	const paintFocused = (index: number, id: string, text: string): string =>
		options.focusedSeries && options.focusedSeries !== id
			? palette.paint("dim", text)
			: paintSeries(index, text);
	const layers = selected.map(() => Array.from({ length: height }, () => Array<number>(columns).fill(0)));
	// Each bit is a connection through a cell edge: up, right, down, left.
	// Rounded box-drawing glyphs join across character boundaries without dot gaps.
	const UP = 1,
		RIGHT = 2,
		DOWN = 4,
		LEFT = 8;
	for (const [layerIndex, { series }] of selected.entries()) {
		let previous: { x: number; y: number } | undefined;
		const mark = (x: number, y: number, direction: number): void => {
			const row = layers[layerIndex]?.[y];
			if (row) row[x] = (row[x] ?? 0) | direction;
		};
		const plot = (x: number, y: number): void => {
			if (!previous) {
				previous = { x, y };
				return;
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
		};
		const points = series.points.map((point) => ({
			x: ((point.at - series.startedAt) / duration) * (columns - 1),
			y: height - 1 - (maximum > 0 ? point.cost / maximum : 0) * (height - 1),
		}));
		for (const point of interpolateCostCurve(points)) plot(Math.round(point.x), Math.round(point.y));
	}
	const glyph = (mask: number): string => {
		if (!unicode)
			return mask === (LEFT | RIGHT) || mask === LEFT || mask === RIGHT
				? "-"
				: mask === UP || mask === DOWN || mask === (UP | DOWN)
					? "|"
					: "+";
		return [" ", "│", "─", "╰", "│", "│", "╭", "├", "─", "╯", "─", "┴", "╮", "┤", "┬", "┼"][mask] ?? "─";
	};
	const partial = selected.some(({ series }) => series.partial) || incomplete;
	const rows = [
		palette.paint("muted", `Cost per agent · ${selected.length} curves${partial ? " · partial" : ""}`),
	];
	const image = options.imageOwner
		? renderCostImage(
				options.imageOwner,
				selected.map(({ series, index }) => {
					const color = /\u001b\[38;2;(\d+);(\d+);(\d+)m/.exec(paintSeries(index, "x"));
					return {
						series,
						selectedPoint: series.id === options.focusedSeries ? options.focusedPoint : undefined,
						color: (color
							? [Number(color[1]), Number(color[2]), Number(color[3])]
							: [210, 210, 210]) as ChartRgb,
						opacity: options.focusedSeries && options.focusedSeries !== series.id ? 0.18 : 0.95,
					};
				}),
				columns,
				height,
			)
		: undefined;
	const focused = selected.find(({ series }) => series.id === options.focusedSeries);
	const focusedPoint =
		options.focusedPoint === undefined ? undefined : focused?.series.points[options.focusedPoint];
	const marker =
		focusedPoint && focused
			? {
					x: Math.round(((focusedPoint.at - focused.series.startedAt) / duration) * (columns - 1)),
					y: Math.round(height - 1 - (maximum > 0 ? focusedPoint.cost / maximum : 0) * (height - 1)),
					index: focused.index,
				}
			: undefined;
	for (let y = 0; y < height; y++) {
		if (image) {
			const axis = y === 0 ? label : y === height - 1 ? "$0" : "";
			rows.push(palette.paint("dim", `${axis.padStart(label.length)}  `) + (image[y] ?? ""));
			continue;
		}
		let line = "";
		for (let x = 0; x < columns; x++) {
			if (marker?.x === x && marker.y === y) {
				line += paintSeries(marker.index, unicode ? "●" : "o");
				continue;
			}
			let bits = 0,
				owner = -1,
				weight = 0;
			for (const [index, layer] of layers.entries()) {
				const dot = layer[y]?.[x] ?? 0;
				const count = dot.toString(2).replace(/0/g, "").length;
				// Draw one complete stroke per cell instead of fusing unrelated curves into ladder rungs.
				const focused = selected[index]?.series.id === options.focusedSeries;
				const priority = count + (focused && count ? 10 : 0);
				if (count && priority >= weight) {
					owner = index;
					weight = priority;
					bits = dot;
				}
			}
			const chosen = selected[owner];
			line += chosen && bits ? paintFocused(chosen.index, chosen.series.id, glyph(bits)) : " ";
		}
		const axis = y === 0 ? label : y === height - 1 ? "$0" : "";
		rows.push(palette.paint("dim", `${axis.padStart(label.length)} ${unicode ? "│" : "|"}`) + line);
	}
	const end = `${(duration / 1000).toFixed(duration < 10000 ? 1 : 0)}s`;
	rows.push(
		palette.paint(
			"dim",
			`${" ".repeat(label.length + 2)}0s${" ".repeat(Math.max(1, columns - end.length - 2))}${end}`,
		),
	);
	const legendColumns = costLegendColumns(width);
	const pageSize = legendColumns * Math.max(1, Math.floor(options.legendRows ?? 5));
	const page = Math.max(
		0,
		Math.min(Math.ceil(selected.length / pageSize) - 1, Math.floor(options.legendPage ?? 0)),
	);
	const start = page * pageSize;
	const cellWidth = Math.floor((width - (legendColumns - 1) * 2) / legendColumns);
	const legend = selected.slice(start, start + pageSize).map(({ series, index }) => {
		const name = truncateToWidth(clean(`#${index + 1} ${series.agent}`), Math.max(1, cellWidth - 2), "…");
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

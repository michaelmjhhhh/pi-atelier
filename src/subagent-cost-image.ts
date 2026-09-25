import { deflateSync } from "node:zlib";
import { allocateImageId, getCapabilities, getCellDimensions, Image } from "@earendil-works/pi-tui";
import type { SubagentCostSeries } from "./subagent-cost-history.js";

export type ChartRgb = readonly [number, number, number];
export interface CostImageSeries {
	series: SubagentCostSeries;
	color: ChartRgb;
	opacity: number;
	selectedPoint?: number | undefined;
}
export interface CurvePoint {
	x: number;
	y: number;
}

/** Shared monotone interpolation for the raster plot and terminal fallback. */
export function interpolateCostCurve(points: readonly CurvePoint[]): CurvePoint[] {
	const slopes = points.slice(1).map((point, index) => {
		const before = points[index];
		return before && point.x > before.x ? (point.y - before.y) / (point.x - before.x) : 0;
	});
	const tangents = points.map((_, index) => {
		if (index === 0) return slopes[0] ?? 0;
		if (index === points.length - 1) return slopes.at(-1) ?? 0;
		const left = slopes[index - 1] ?? 0,
			right = slopes[index] ?? 0;
		return left * right > 0 ? (2 * left * right) / (left + right) : 0;
	});
	const result: CurvePoint[] = [];
	for (let index = 1; index < points.length; index++) {
		const before = points[index - 1],
			after = points[index];
		if (!before || !after) continue;
		const span = after.x - before.x;
		const steps = Math.max(1, Math.ceil(Math.max(span, Math.abs(after.y - before.y)) * 2));
		for (let step = 0; step <= steps; step++) {
			const t = step / steps,
				t2 = t * t,
				t3 = t2 * t;
			const y =
				(2 * t3 - 3 * t2 + 1) * before.y +
				(t3 - 2 * t2 + t) * span * (tangents[index - 1] ?? 0) +
				(-2 * t3 + 3 * t2) * after.y +
				(t3 - t2) * span * (tangents[index] ?? 0);
			result.push({
				x: before.x + t * span,
				y: Math.max(Math.min(before.y, after.y), Math.min(Math.max(before.y, after.y), y)),
			});
		}
	}
	return result;
}
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
	let crc = index;
	for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	return crc >>> 0;
});
function chunk(name: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(name), data]);
	let crc = 0xffffffff;
	for (const byte of body) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 255] ?? 0);
	const output = Buffer.alloc(body.length + 8);
	output.writeUInt32BE(data.length, 0);
	body.copy(output, 4);
	output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
	return output;
}

/** Transparent, anti-aliased PNG; no shell, external renderer, files or additional packages. */
export function drawCostPlot(
	series: readonly CostImageSeries[],
	width: number,
	height: number,
	scale = 1,
): Buffer {
	width = Math.max(40, Math.min(1400, Math.round(width)));
	height = Math.max(40, Math.min(800, Math.round(height)));
	const pixels = Buffer.alloc(width * height * 4);
	const blend = (x: number, y: number, color: ChartRgb, alpha: number): void => {
		if (x < 0 || y < 0 || x >= width || y >= height || alpha <= 0) return;
		const offset = (y * width + x) * 4,
			oldAlpha = (pixels[offset + 3] ?? 0) / 255;
		const nextAlpha = alpha + oldAlpha * (1 - alpha);
		for (let channel = 0; channel < 3; channel++)
			pixels[offset + channel] = Math.round(
				((color[channel] ?? 0) * alpha + (pixels[offset + channel] ?? 0) * oldAlpha * (1 - alpha)) /
					nextAlpha,
			);
		pixels[offset + 3] = Math.round(nextAlpha * 255);
	};
	let coverage: Float32Array | undefined;
	let touched: number[] = [];
	const line = (a: CurvePoint, b: CurvePoint, color: ChartRgb, radius: number, opacity: number): void => {
		const dx = b.x - a.x,
			dy = b.y - a.y,
			length = dx * dx + dy * dy;
		for (
			let y = Math.max(0, Math.floor(Math.min(a.y, b.y) - radius - 1));
			y < Math.min(height, Math.ceil(Math.max(a.y, b.y) + radius + 1));
			y++
		) {
			for (
				let x = Math.max(0, Math.floor(Math.min(a.x, b.x) - radius - 1));
				x < Math.min(width, Math.ceil(Math.max(a.x, b.x) + radius + 1));
				x++
			) {
				const t = length
					? Math.max(0, Math.min(1, ((x + 0.5 - a.x) * dx + (y + 0.5 - a.y) * dy) / length))
					: 0;
				const distance = Math.hypot(x + 0.5 - a.x - t * dx, y + 0.5 - a.y - t * dy);
				const alpha = Math.min(1, Math.max(0, radius + 0.5 - distance)) * opacity;
				if (coverage) {
					const offset = y * width + x;
					if (alpha > 0 && !coverage[offset]) touched.push(offset);
					coverage[offset] = Math.max(coverage[offset] ?? 0, alpha);
				} else blend(x, y, color, alpha);
			}
		}
	};
	const pad = 10 * scale,
		left = pad,
		right = width - pad,
		top = pad,
		bottom = height - pad;
	const axis: ChartRgb = [126, 135, 145];
	line({ x: left, y: bottom }, { x: right, y: bottom }, axis, 0.55 * scale, 0.5);
	line({ x: left, y: bottom }, { x: left, y: top }, axis, 0.55 * scale, 0.5);
	const maxCost = Math.max(0, ...series.flatMap(({ series }) => series.points.map((point) => point.cost)));
	const duration = Math.max(
		1,
		...series.map(({ series }) => (series.points.at(-1)?.at ?? series.startedAt) - series.startedAt),
	);
	// Draw de-emphasized series first so the selected curve stays fully visible at crossings.
	const curveCoverage = new Float32Array(width * height);
	for (const item of [...series].sort((a, b) => a.opacity - b.opacity)) {
		coverage = curveCoverage;
		touched = [];
		const observations = item.series.points.map((point) => ({
			x: left + ((point.at - item.series.startedAt) / duration) * (right - left),
			y: bottom - (maxCost > 0 ? point.cost / maxCost : 0) * (bottom - top),
		}));
		const smooth = interpolateCostCurve(observations);
		for (let index = 1; index < smooth.length; index++) {
			const before = smooth[index - 1],
				after = smooth[index];
			if (before && after) line(before, after, item.color, 1.05 * scale, item.opacity);
		}
		// Mark only actual observations, with a bounded number of markers on long histories.
		const stride = Math.max(1, Math.ceil((observations.length - 1) / 7));
		for (let index = 1; index < observations.length; index++) {
			if (index % stride !== 0 && index !== observations.length - 1) continue;
			const point = observations[index];
			if (point) line(point, point, item.color, 3.0 * scale, item.opacity);
		}
		for (const offset of touched) {
			blend(offset % width, Math.floor(offset / width), item.color, coverage[offset] ?? 0);
			coverage[offset] = 0;
		}
		coverage = undefined;
		const activePoint = item.selectedPoint === undefined ? undefined : observations[item.selectedPoint];
		if (activePoint) {
			line(activePoint, activePoint, [245, 245, 245], 4.5 * scale, 1);
			line(activePoint, activePoint, item.color, 2.5 * scale, 1);
		}
	}
	const scanlines = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++)
		pixels.copy(scanlines, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(scanlines, { level: 3 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const cache = new WeakMap<object, { imageId: number; signature: string; lines: string[] }>();
export function renderCostImage(
	owner: object,
	series: readonly CostImageSeries[],
	columns: number,
	rows: number,
): string[] | undefined {
	// Kitty supports reliable placement replacement/deletion during overlay changes.
	if (getCapabilities().images !== "kitty") return undefined;
	const cell = getCellDimensions();
	const scale = Math.min(2, 1400 / (columns * cell.widthPx), 800 / (rows * cell.heightPx));
	const width = Math.max(40, Math.round(columns * cell.widthPx * scale));
	const height = Math.max(40, Math.round(rows * cell.heightPx * scale));
	const signature = JSON.stringify([
		columns,
		rows,
		width,
		height,
		series.map((item) => [item.series.id, item.series.points, item.color, item.opacity, item.selectedPoint]),
	]);
	const previous = cache.get(owner);
	if (previous?.signature === signature) return previous.lines;
	const imageId = previous?.imageId ?? allocateImageId();
	const png = drawCostPlot(series, width, height, scale);
	const image = new Image(
		png.toString("base64"),
		"image/png",
		{ fallbackColor: (text) => text },
		{ maxWidthCells: columns, maxHeightCells: rows, imageId },
		{ widthPx: width, heightPx: height },
	);
	const lines = image.render(columns + 2);
	cache.set(owner, { imageId, signature, lines });
	return lines;
}

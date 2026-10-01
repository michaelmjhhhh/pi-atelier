import type {
	Density,
	DisplaySettings,
	PresetName,
	SegmentId,
	SegmentLayout,
	SegmentLayoutEntry,
	TemplateName,
} from "./types.js";

export const PRODUCT_SEGMENT_ORDER = [
	"brand",
	"activity",
	"metrics",
	"performance",
	"context",
	"model",
	"git",
	"statuses",
	"menu",
] as const;
export const TEMPLATE_NAMES = ["editorial", "minimal", "classic"] as const;
export const DENSITIES = ["comfortable", "compact"] as const;

const REQUIRED_SEGMENT_IDS: ReadonlySet<SegmentId> = new Set(["metrics", "context"]);
const SEGMENT_IDS: ReadonlySet<string> = new Set(PRODUCT_SEGMENT_ORDER);
const PRESET_NAMES: ReadonlySet<string> = new Set([...TEMPLATE_NAMES, "custom"]);
const DENSITY_NAMES: ReadonlySet<string> = new Set(DENSITIES);

export const isRequiredSegment = (id: SegmentId): boolean => REQUIRED_SEGMENT_IDS.has(id);

export const isSegmentId = (value: unknown): value is SegmentId =>
	typeof value === "string" && SEGMENT_IDS.has(value);

export const isPresetName = (value: unknown): value is PresetName =>
	typeof value === "string" && PRESET_NAMES.has(value);

export const isDensity = (value: unknown): value is Density =>
	typeof value === "string" && DENSITY_NAMES.has(value);

const layout = (visible: readonly SegmentId[]): SegmentLayout => {
	const shown = new Set(visible);
	return PRODUCT_SEGMENT_ORDER.map((id) => ({ id, visible: shown.has(id) }));
};

export const DISPLAY_TEMPLATES: Record<TemplateName, Omit<DisplaySettings, "preset">> = {
	editorial: {
		density: "comfortable",
		segmentLayout: layout(["activity", "metrics", "context", "model", "git", "statuses", "menu"]),
	},
	minimal: {
		density: "compact",
		segmentLayout: layout(["activity", "metrics", "context", "model", "menu"]),
	},
	classic: {
		density: "comfortable",
		segmentLayout: layout(["metrics", "context", "model", "git", "statuses"]),
	},
};

/** Copies any `{ id, visible }` layout so callers can mutate it freely. */
export const cloneLayout = <T extends { visible: boolean }>(value: readonly T[]): T[] =>
	value.map((entry) => ({ ...entry }));

export const legacySegmentsToLayout = (segments: readonly SegmentId[]): SegmentLayout =>
	normalizeSegmentLayout(segments.map((id) => ({ id, visible: true })));

/** Completes already-validated entries without changing their relative order. */
export const normalizeSegmentLayout = (entries: readonly SegmentLayoutEntry[]): SegmentLayout => {
	const seen = new Set<SegmentId>();
	const result: SegmentLayout = [];
	for (const entry of entries) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		result.push({ id: entry.id, visible: entry.visible });
	}
	for (const id of PRODUCT_SEGMENT_ORDER) {
		if (!seen.has(id)) result.push({ id, visible: false });
	}
	for (const entry of result) {
		if (isRequiredSegment(entry.id)) entry.visible = true;
	}
	return result;
};

export const toggleSegmentVisibility = (value: readonly SegmentLayoutEntry[], id: SegmentId): SegmentLayout =>
	value.map((entry) => ({
		...entry,
		visible: entry.id === id && !isRequiredSegment(id) ? !entry.visible : entry.visible,
	}));

export const reorderSegment = (
	value: readonly SegmentLayoutEntry[],
	id: SegmentId,
	direction: "earlier" | "later",
): SegmentLayout => {
	const result = cloneLayout(value);
	const index = result.findIndex((entry) => entry.id === id);
	const target = direction === "earlier" ? index - 1 : index + 1;
	const current = result[index];
	const neighbor = result[target];
	if (index < 0 || !current || !neighbor) return result;
	result[index] = neighbor;
	result[target] = current;
	return result;
};

const layoutsEqual = (left: readonly SegmentLayoutEntry[], right: readonly SegmentLayoutEntry[]): boolean =>
	left.length === right.length &&
	left.every((entry, index) => entry.id === right[index]?.id && entry.visible === right[index]?.visible);

export const derivePresetIdentity = (
	display: Pick<DisplaySettings, "density" | "segmentLayout">,
): PresetName =>
	TEMPLATE_NAMES.find((name) => {
		const template = DISPLAY_TEMPLATES[name];
		return (
			display.density === template.density && layoutsEqual(display.segmentLayout, template.segmentLayout)
		);
	}) ?? "custom";

export const applyDisplayTemplate = (name: TemplateName): DisplaySettings => {
	const template = DISPLAY_TEMPLATES[name];
	return {
		preset: name,
		density: template.density,
		segmentLayout: cloneLayout(template.segmentLayout),
	};
};

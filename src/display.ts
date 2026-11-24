import type {
	Density,
	DisplaySettings,
	FooterFieldId,
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

/** Readings inside a segment that can be hidden on their own, in rail order. */
export const SEGMENT_FIELDS = {
	metrics: ["input", "output", "cache", "cost"],
	performance: ["ttft", "tps"],
	context: ["contextWindow", "autoCompact"],
	model: ["model", "thinking"],
	git: ["workspace", "branch"],
} as const satisfies Partial<Record<SegmentId, readonly string[]>>;
export const FOOTER_FIELD_IDS = Object.values(SEGMENT_FIELDS).flat();

const FIELD_IDS: ReadonlySet<string> = new Set(FOOTER_FIELD_IDS);
const SEGMENT_IDS: ReadonlySet<string> = new Set(PRODUCT_SEGMENT_ORDER);
const PRESET_NAMES: ReadonlySet<string> = new Set([...TEMPLATE_NAMES, "custom"]);
const DENSITY_NAMES: ReadonlySet<string> = new Set(DENSITIES);

export const segmentFields = (id: SegmentId): readonly FooterFieldId[] =>
	(SEGMENT_FIELDS as Partial<Record<SegmentId, readonly FooterFieldId[]>>)[id] ?? [];

export const isFooterFieldId = (value: unknown): value is FooterFieldId =>
	typeof value === "string" && FIELD_IDS.has(value);

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

/** Templates pick segments only; hidden fields carry across a preset change. */
export const DISPLAY_TEMPLATES: Record<TemplateName, Pick<DisplaySettings, "density" | "segmentLayout">> = {
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
	return result;
};

export const toggleSegmentVisibility = (value: readonly SegmentLayoutEntry[], id: SegmentId): SegmentLayout =>
	value.map((entry) => ({
		...entry,
		visible: entry.id === id ? !entry.visible : entry.visible,
	}));

/** Hidden fields in a stable order, so equal choices compare and persist identically. */
export const toggleFooterField = (hidden: readonly FooterFieldId[], id: FooterFieldId): FooterFieldId[] => {
	const next = new Set(hidden);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	return FOOTER_FIELD_IDS.filter((field) => next.has(field));
};

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

export const applyDisplayTemplate = (
	name: TemplateName,
	hiddenFooterFields: readonly FooterFieldId[] = [],
): DisplaySettings => {
	const template = DISPLAY_TEMPLATES[name];
	return {
		preset: name,
		density: template.density,
		segmentLayout: cloneLayout(template.segmentLayout),
		hiddenFooterFields: [...hiddenFooterFields],
	};
};

import type {
	Density,
	DisplaySettings,
	PresetName,
	SegmentId,
	SegmentLayout,
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
] as const satisfies readonly SegmentId[];

export const REQUIRED_SEGMENT_IDS = ["metrics", "context"] as const satisfies readonly SegmentId[];
const SEGMENT_IDS = new Set<string>(PRODUCT_SEGMENT_ORDER);

const layout = (visible: readonly SegmentId[]): SegmentLayout => {
	const shown = new Set(visible);
	return PRODUCT_SEGMENT_ORDER.map((id) => ({ id, visible: shown.has(id) }));
};

export interface DisplayTemplate {
	preset: TemplateName;
	density: Density;
	segmentLayout: SegmentLayout;
}

export const DISPLAY_TEMPLATES: Record<TemplateName, DisplayTemplate> = {
	editorial: {
		preset: "editorial",
		density: "comfortable",
		segmentLayout: layout(["activity", "metrics", "context", "model", "git", "statuses", "menu"]),
	},
	minimal: {
		preset: "minimal",
		density: "compact",
		segmentLayout: layout(["activity", "metrics", "context", "model", "menu"]),
	},
	classic: {
		preset: "classic",
		density: "comfortable",
		segmentLayout: layout(["metrics", "context", "model", "git", "statuses"]),
	},
};

export const isSegmentId = (value: unknown): value is SegmentId =>
	typeof value === "string" && SEGMENT_IDS.has(value);

export const cloneSegmentLayout = (value: readonly { id: SegmentId; visible: boolean }[]): SegmentLayout =>
	value.map((entry) => ({ ...entry }));

export const legacySegmentsToLayout = (segments: readonly SegmentId[]): SegmentLayout =>
	normalizeSegmentLayout(segments.map((id) => ({ id, visible: true })));

/** Completes already-validated entries without changing their relative order. */
export const normalizeSegmentLayout = (
	entries: readonly { id: SegmentId; visible: boolean }[],
): SegmentLayout => {
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
		if ((REQUIRED_SEGMENT_IDS as readonly SegmentId[]).includes(entry.id)) entry.visible = true;
	}
	return result;
};

export const toggleSegmentVisibility = (
	value: readonly { id: SegmentId; visible: boolean }[],
	id: SegmentId,
	visible?: boolean,
): SegmentLayout =>
	value.map((entry) => ({
		...entry,
		visible:
			entry.id === id && !(REQUIRED_SEGMENT_IDS as readonly SegmentId[]).includes(id)
				? (visible ?? !entry.visible)
				: entry.visible,
	}));

export const reorderSegment = (
	value: readonly { id: SegmentId; visible: boolean }[],
	id: SegmentId,
	direction: "earlier" | "later",
): SegmentLayout => {
	const result = cloneSegmentLayout(value);
	const index = result.findIndex((entry) => entry.id === id);
	const target = direction === "earlier" ? index - 1 : index + 1;
	if (index < 0 || target < 0 || target >= result.length) return result;
	const current = result[index];
	const neighbor = result[target];
	if (!current || !neighbor) return result;
	result[index] = neighbor;
	result[target] = current;
	return result;
};

const layoutsEqual = (
	left: readonly { id: SegmentId; visible: boolean }[],
	right: readonly { id: SegmentId; visible: boolean }[],
): boolean =>
	left.length === right.length &&
	left.every((entry, index) => entry.id === right[index]?.id && entry.visible === right[index]?.visible);

export const derivePresetIdentity = (
	display: Pick<DisplaySettings, "density" | "segmentLayout">,
): PresetName => {
	for (const name of ["editorial", "minimal", "classic"] as const) {
		const template = DISPLAY_TEMPLATES[name];
		if (display.density === template.density && layoutsEqual(display.segmentLayout, template.segmentLayout)) {
			return name;
		}
	}
	return "custom";
};

export const applyDisplayTemplate = (name: TemplateName): DisplaySettings => {
	const template = DISPLAY_TEMPLATES[name];
	return {
		preset: name,
		density: template.density,
		segmentLayout: cloneSegmentLayout(template.segmentLayout),
	};
};

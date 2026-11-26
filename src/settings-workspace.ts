import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	applyDisplayTemplate,
	cloneLayout,
	derivePresetIdentity,
	isPinnedSegment,
	reorderSegment,
	segmentFields,
	TEMPLATE_NAMES,
	toggleFooterField,
	toggleSegmentVisibility,
} from "./display.js";
import { renderFooterLine } from "./footer.js";
import type { ThemeLike } from "./palette.js";
import { DEFAULT_SIDEBAR_PANEL_LAYOUT } from "./sidebar-panels.js";
import { errorMessage, fitToWidth } from "./text.js";
import type {
	AtelierConfig,
	ConfigurationSource,
	DisplayPatch,
	DisplayProvenance,
	DisplaySettings,
	FooterFieldId,
	FooterState,
	SegmentId,
	SessionDisplayOverride,
	SidebarPanelId,
	SidebarPanelLayout,
} from "./types.js";

export interface SidebarPanelSetting {
	id: SidebarPanelId;
	title: string;
	available: boolean;
	visible: boolean;
}

const OVERLAY_MAX_HEIGHT_PERCENT = 95;
export const DISPLAY_SETTINGS_OVERLAY_MAX_HEIGHT = `${OVERLAY_MAX_HEIGHT_PERCENT}%` as const;
export const DISPLAY_SETTINGS_OVERLAY_MARGIN = 1;

/**
 * Match Pi TUI's overlay max-height calculation for Display Settings.
 * Percentages are floored and the one-cell margin is applied on both sides.
 */
export function getDisplaySettingsViewportHeight(terminalRows: number): number {
	const rows = Math.max(0, Math.floor(terminalRows));
	const availableHeight = Math.max(1, rows - DISPLAY_SETTINGS_OVERLAY_MARGIN * 2);
	const maxHeight = Math.floor((rows * OVERLAY_MAX_HEIGHT_PERCENT) / 100);
	return Math.max(1, Math.min(maxHeight, availableHeight));
}

export interface SettingsWorkspaceOptions {
	getDisplaySettings(): DisplaySettings;
	getDisplayProvenance(): DisplayProvenance;
	getSessionDisplayOverride(): SessionDisplayOverride | undefined;
	replaceSessionDisplayOverride(value: SessionDisplayOverride | undefined): void;
	clearSessionDisplayOverride(): void;
	persistUserDisplayPatch(patch: DisplayPatch): Promise<void>;
	applySavedUserDisplayPatch(patch: DisplayPatch): void;
	getRenderConfig(): AtelierConfig;
	getSidebarPanelSettings(): readonly SidebarPanelSetting[];
	/** Live overlay viewport height in rows; without it the workspace renders in full. */
	getViewportHeight?(): number;
	theme: ThemeLike;
	colorEnabled?: boolean;
	requestWorkspaceRender(): void;
	requestLiveRender(): void;
	close(): void;
	report?(message: string, kind: "info" | "warning" | "error"): void;
}

export interface SettingsWorkspace {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

type ActionId = "save" | "revert" | "undo" | "sidebar-default";
type Row =
	| { kind: "preset" }
	| { kind: "density" }
	| { kind: "segment"; id: SegmentId }
	| { kind: "field"; id: FooterFieldId }
	| { kind: "sidebarPanel"; id: SidebarPanelId };
/** The two visible sections, which are also the Tab stops. */
type Section = "rail" | "sidebar";

/** Shortcut letter handled for each action, in either case; the key bar shows it in lowercase. */
const ACTION_KEYS: Record<ActionId, string> = { save: "S", revert: "R", undo: "U", "sidebar-default": "D" };
const TITLE = "Display settings";
/** Content width at which the Status rail and Sidebar sections sit side by side. */
const TWO_COLUMN_MIN_WIDTH = 82;
const COLUMN_GUTTER = 4;
/** Settings rows the scrolling area keeps before the preview is shown above it. */
const MIN_SCROLL_ROWS = 10;
/** Settings rows the scrolling area keeps before the detail line is shown below it. */
const MIN_DETAIL_SCROLL_ROWS = 3;

const SEGMENT_LABELS: Record<SegmentId, string> = {
	pi: "Pi",
	brand: "Brand",
	activity: "Activity",
	metrics: "Tokens & cost",
	performance: "Speed",
	context: "Context",
	model: "Model",
	git: "Git",
	statuses: "Extension status",
	menu: "Menu shortcut",
};

const SEGMENT_DESCRIPTIONS: Record<SegmentId, string> = {
	pi: "A single π at the start of the rail, a compact alternative to Brand.",
	brand: "The Atelier mark at the start of the rail.",
	activity: "Whether Pi is working or ready.",
	metrics: "Input and output tokens, cache hit rate, and cost.",
	performance: "Time to first token and output speed.",
	context: "How much of the context window is in use.",
	model: "The current model and thinking level.",
	git: "The project folder and Git branch.",
	statuses: "Status text published by other extensions.",
	menu: "The shortcut that opens the Control Center.",
};

const FIELD_LABELS: Record<FooterFieldId, string> = {
	input: "Input tokens",
	output: "Output tokens",
	cache: "Cache",
	cost: "Cost",
	ttft: "First token",
	tps: "Tokens per second",
	contextWindow: "Window size",
	autoCompact: "Auto-compact",
	model: "Model name",
	thinking: "Thinking level",
	workspace: "Folder",
	branch: "Branch",
};

const FIELD_DESCRIPTIONS: Record<FooterFieldId, string> = {
	input: "Tokens sent to the model this session.",
	output: "Tokens the model wrote this session.",
	cache: "How much of the input came from the prompt cache.",
	cost: "What this session has cost so far.",
	ttft: "How long the last response took to start.",
	tps: "How fast the last response was written.",
	contextWindow: "The size of the context window, after the percentage.",
	autoCompact: "A mark shown while auto-compaction is on.",
	model: "The current model's name.",
	thinking: "The current thinking level.",
	workspace: "The project folder.",
	branch: "The Git branch, with * when there are uncommitted changes.",
};

const SOURCE_LABELS: Record<ConfigurationSource, string> = {
	product: "default",
	user: "saved",
	project: "project",
	session: "this session",
};

const SOURCE_SENTENCES: Record<ConfigurationSource, string> = {
	product: "Using the built-in default.",
	user: "From your saved settings.",
	project: "From this project's settings.",
	session: "Changed for this session only.",
};

/** How a segment's visibility or the segment order came to differ from the built-in default. */
const SOURCE_PHRASES: Record<Exclude<ConfigurationSource, "product">, string> = {
	user: "from your saved settings",
	project: "from this project's settings",
	session: "changed for this session",
};

const actionKey = (id: ActionId): string => ACTION_KEYS[id].toLowerCase();

const sectionOf = (row: Row): Section => (row.kind === "sidebarPanel" ? "sidebar" : "rail");

const sameRow = (left: Row, right: Row): boolean =>
	left.kind === right.kind && ("id" in left ? left.id : undefined) === ("id" in right ? right.id : undefined);

const cloneDisplay = (value: DisplaySettings): DisplaySettings => ({
	...value,
	segmentLayout: cloneLayout(value.segmentLayout),
	hiddenFooterFields: [...value.hiddenFooterFields],
});
const cloneOverride = (value: SessionDisplayOverride | undefined): SessionDisplayOverride | undefined =>
	value === undefined ? undefined : structuredClone(value);

const representativeState: FooterState = {
	activity: "working",
	workingLabel: "CRAFTING",
	modelId: "artisan-1",
	provider: "atelier",
	thinkingLevel: "high",
	branch: "feat/settings",
	dirty: true,
	workspacePulse: {
		status: "changed",
		data: {
			root: "/project",
			relativeCwd: "",
			branch: "feat/settings",
			snapshot: {
				trackedFiles: 2,
				untrackedFiles: 1,
				linesAdded: 24,
				linesRemoved: 3,
				binaryFiles: 0,
				submodules: 0,
				conflicts: 0,
			},
		},
	},
	metrics: {
		usageAvailable: true,
		costAvailable: true,
		input: 12_400,
		output: 3_200,
		cacheRead: 8_100,
		cacheWrite: 400,
		cacheHitPercent: 72.4,
		cost: 0.142,
		subscription: false,
		contextTokens: 32_000,
		contextWindow: 128_000,
		contextPercent: 25,
		autoCompact: true,
	},
	performance: { ttftMs: 680, tokensPerSecond: 54 },
	extensionStatuses: ["SYNC"],
};

interface LayoutLine {
	line: string;
	/** True only for the line that structurally represents the focused row. */
	focused?: boolean;
	/** A section heading: scrolling up to the row below it also brings the heading into view. */
	heading?: boolean;
}

const blankLines = (count: number): LayoutLine[] =>
	Array.from({ length: Math.max(0, count) }, () => ({ line: "" }));

/** A quiet frame for the rail preview, the only boxed element inside the workspace. */
function previewPanel(title: string, line: string, width: number, theme: ThemeLike): LayoutLine[] {
	if (width < 4) return [{ line: fitToWidth(line, width) }];
	const inner = width - 2;
	const edge = (text: string) => theme.fg("dim", text);
	const heading = ` ${title} `;
	const rule = Math.max(0, inner - 1 - visibleWidth(heading));
	return [
		{ line: `${edge("┌─")}${theme.fg("muted", heading)}${edge("─".repeat(rule))}${edge("┐")}` },
		{ line: `${edge("│")}${fitToWidth(line, inner)}${edge("│")}` },
		{ line: `${edge("└")}${edge("─".repeat(inner))}${edge("┘")}` },
	];
}

/** A section heading: the title, then a rule to the column edge. Lit while it holds the focus. */
function sectionHeading(title: string, active: boolean, width: number, theme: ThemeLike): LayoutLine {
	const label = theme.bold(theme.fg(active ? "accent" : "muted", title));
	const rule = Math.max(0, width - visibleWidth(title) - 1);
	return { line: `${label} ${theme.fg("dim", "─".repeat(rule))}`, heading: true };
}

interface KeyHint {
	key: string;
	label: string;
	/** Hints with the lowest priority are dropped first when the bar is too narrow. */
	priority: number;
	enabled?: boolean;
}

const HINT_GAP = "   ";

function renderKeyHints(hints: readonly KeyHint[], width: number, theme: ThemeLike): string {
	const kept = [...hints];
	const measure = (list: readonly KeyHint[]): number =>
		list.reduce(
			(sum, hint, index) =>
				sum + (index ? HINT_GAP.length : 0) + visibleWidth(hint.key) + 1 + visibleWidth(hint.label),
			0,
		);
	while (kept.length > 1 && measure(kept) > width) {
		const lowest = kept.reduce((low, hint) => (hint.priority < low.priority ? hint : low));
		kept.splice(kept.indexOf(lowest), 1);
	}
	return kept
		.map((hint) =>
			hint.enabled === false
				? theme.fg("dim", `${hint.key} ${hint.label}`)
				: `${theme.bold(hint.key)} ${theme.fg("muted", hint.label)}`,
		)
		.join(HINT_GAP);
}

/**
 * Fit the scrollable middle of the workspace into `rows`, keeping the focused
 * line visible and marking clipped content with scroll indicators.
 */
function virtualize(
	central: readonly LayoutLine[],
	rows: number,
	scrollOffset: number,
	width: number,
	theme: ThemeLike,
): { lines: LayoutLine[]; scrollOffset: number } {
	const more = (direction: "↑" | "↓"): LayoutLine => ({
		line: fitToWidth(theme.fg("dim", `  ${direction} more`), width),
	});
	const focused = Math.max(
		0,
		central.findIndex(({ focused }) => focused),
	);
	// The first row of a section brings its heading along when scrolled to from below,
	// provided the middle window has room for both.
	const anchor = rows >= 4 && central[focused - 1]?.heading ? focused - 1 : focused;
	if (central.length <= rows) return { lines: [...central], scrollOffset: 0 };
	// The sticky chrome fills the interior; there is no room for content or indicators.
	if (rows === 0) return { lines: [], scrollOffset: 0 };
	// One row cannot carry an indicator and a focused row simultaneously.
	if (rows === 1) {
		const offset = Math.min(focused, central.length - 1);
		return { lines: [central[offset] ?? { line: "" }], scrollOffset: offset };
	}
	// Two rows can show one indicator plus content, so prioritize the focused edge.
	if (rows === 2) {
		return focused <= 0
			? { lines: [central[0] ?? { line: "" }, more("↓")], scrollOffset: 0 }
			: { lines: [more("↑"), central[focused] ?? { line: "" }], scrollOffset: focused };
	}
	const topCapacity = rows - 1;
	const bottomOffset = central.length - topCapacity;
	const middleCapacity = rows - 2;
	let offset: number;
	if (focused < topCapacity) offset = 0;
	else if (focused >= bottomOffset) offset = bottomOffset;
	else {
		// A middle window has an indicator on both sides; offset 0 is the top window.
		const maxMiddleOffset = central.length - middleCapacity - 1;
		offset = Math.max(1, Math.min(scrollOffset, maxMiddleOffset));
		if (anchor < offset) offset = anchor;
		else if (focused >= offset + middleCapacity) offset = focused - middleCapacity + 1;
		offset = Math.max(1, Math.min(offset, maxMiddleOffset));
	}
	const atTop = offset === 0;
	const atBottom = offset === bottomOffset;
	const body = central.slice(offset, offset + rows - (atTop ? 0 : 1) - (atBottom ? 0 : 1));
	return {
		lines: [...(atTop ? [] : [more("↑")]), ...body, ...(atBottom ? [] : [more("↓")])],
		scrollOffset: offset,
	};
}

export function createSettingsWorkspace(options: SettingsWorkspaceOptions): SettingsWorkspace {
	let display = cloneDisplay(options.getDisplaySettings());
	let focus = 0;
	let undo:
		| { kind: "display"; value: SessionDisplayOverride | undefined }
		| { kind: "sidebar"; value: SidebarPanelLayout }
		| undefined;
	let sidebarDraft: SidebarPanelLayout = cloneLayout(options.getRenderConfig().sidebarPanelLayout);
	let sidebarDirty = false;
	let feedback: { message: string; kind: "info" | "warning" | "error" } | undefined;
	let saving = false;
	/**
	 * The Display last saved from this workspace. A project setting can keep a Session
	 * override alive after a save, so an override alone does not mean unsaved changes.
	 */
	let savedDisplay: string | undefined;
	let scrollOffset = 0;

	const rows = (): Row[] => [
		{ kind: "preset" },
		{ kind: "density" },
		...segmentRows(),
		...sidebarDraft.map((entry): Row => ({ kind: "sidebarPanel", id: entry.id })),
	];
	/** Each segment, followed by its fields while the segment is shown. */
	const segmentRows = (): Row[] =>
		display.segmentLayout.flatMap((entry): Row[] => [
			{ kind: "segment", id: entry.id },
			...(entry.visible ? segmentFields(entry.id).map((id): Row => ({ kind: "field", id })) : []),
		]);
	const rowIndex = (target: Row, allRows = rows()): number =>
		allRows.findIndex((row) => sameRow(row, target));
	const panelTitle = (id: SidebarPanelId): string =>
		options.getSidebarPanelSettings().find((setting) => setting.id === id)?.title || id;
	const rowLabel = (row: Row): string => {
		switch (row.kind) {
			case "preset":
				return "Preset";
			case "density":
				return "Density";
			case "segment":
				return SEGMENT_LABELS[row.id];
			case "field":
				return FIELD_LABELS[row.id];
			case "sidebarPanel":
				return panelTitle(row.id);
		}
	};

	/** Append newly registered panels to the draft (hidden) while keeping focus on the same row. */
	const absorbNewSidebarPanels = (): void => {
		const configuredIds = new Set(sidebarDraft.map((entry) => entry.id));
		const added = options.getSidebarPanelSettings().filter((setting) => !configuredIds.has(setting.id));
		if (added.length === 0) return;
		const focusedRow = rows()[focus];
		sidebarDraft.push(...added.map((setting) => ({ id: setting.id, visible: false })));
		if (focusedRow) focus = Math.max(0, rowIndex(focusedRow));
	};
	const request = (live = false): void => {
		options.requestWorkspaceRender();
		if (live) options.requestLiveRender();
	};
	const tell = (message: string, kind: "info" | "warning" | "error" = "info"): void => {
		feedback = { message, kind };
		options.report?.(message, kind);
	};
	const warn = (message: string): void => {
		tell(message, "warning");
		request();
	};
	/** Replace the Display, keeping the focus on its row, or on the segment of a field row that went away. */
	const setDisplay = (next: DisplaySettings): void => {
		const focusedRow = rows()[focus];
		display = next;
		if (!focusedRow) return;
		const parent =
			focusedRow.kind === "field"
				? display.segmentLayout.find((entry) => segmentFields(entry.id).includes(focusedRow.id))
				: undefined;
		const index = rowIndex(focusedRow);
		if (index >= 0) focus = index;
		else if (parent) focus = Math.max(0, rowIndex({ kind: "segment", id: parent.id }));
	};
	const refresh = (): void => setDisplay(cloneDisplay(options.getDisplaySettings()));
	const commitMutation = (next: DisplaySettings, message: string): void => {
		undo = { kind: "display", value: cloneOverride(options.getSessionDisplayOverride()) };
		const complete = cloneDisplay(next);
		complete.preset = derivePresetIdentity(complete);
		options.replaceSessionDisplayOverride(complete);
		setDisplay(complete);
		tell(message);
		request(true);
	};
	const changeSidebar = (next: SidebarPanelLayout, message: string): void => {
		undo = { kind: "sidebar", value: cloneLayout(sidebarDraft) };
		sidebarDraft = next;
		sidebarDirty = true;
		tell(message);
		request();
	};
	const revert = (): void => {
		const previous = options.getSessionDisplayOverride();
		// Without a Session override there is nothing to revert; keep any Sidebar Undo intact.
		if (previous === undefined) {
			warn("No status rail changes to revert");
			return;
		}
		undo = { kind: "display", value: cloneOverride(previous) };
		options.clearSessionDisplayOverride();
		refresh();
		tell("Reverted this session's status rail changes");
		request(true);
	};
	const undoOnce = (): void => {
		const previous = undo;
		if (!previous) {
			warn("Nothing to undo");
			return;
		}
		undo = undefined;
		if (previous.kind === "sidebar") {
			sidebarDraft = previous.value;
			sidebarDirty = true;
			tell("Undid the last sidebar change");
			request();
		} else {
			options.replaceSessionDisplayOverride(previous.value);
			refresh();
			tell("Undid the last status rail change");
			request(true);
		}
	};
	const restoreSidebarDefault = (): void =>
		changeSidebar(
			cloneLayout(DEFAULT_SIDEBAR_PANEL_LAYOUT),
			"Sidebar reset to the default panels; save to apply",
		);
	const save = async (): Promise<void> => {
		if (saving) return;
		if (sidebarDirty && !sidebarDraft.some((entry) => entry.visible)) {
			warn("Keep at least one sidebar panel shown");
			return;
		}
		saving = true;
		request();
		const patch: DisplayPatch = {
			...cloneDisplay(display),
			...(sidebarDirty ? { sidebarPanelLayout: cloneLayout(sidebarDraft) } : {}),
		};
		try {
			await options.persistUserDisplayPatch(patch);
			options.applySavedUserDisplayPatch(patch);
			refresh();
			savedDisplay = JSON.stringify(display);
			if (sidebarDirty) {
				sidebarDirty = false;
				if (undo?.kind === "sidebar") undo = undefined;
			}
			tell("Saved as your default");
		} catch (error) {
			tell(`Save failed: ${errorMessage(error)}`, "error");
		} finally {
			saving = false;
			request(true);
		}
	};
	const runAction = (id: ActionId): void => {
		if (id === "save") void save();
		else if (id === "revert") revert();
		else if (id === "undo") undoOnce();
		else restoreSidebarDefault();
	};
	const cyclePreset = (step: 1 | -1): void => {
		const current = TEMPLATE_NAMES.findIndex((name) => name === display.preset);
		const count = TEMPLATE_NAMES.length;
		// A custom layout steps onto the first preset going forward and the last going back.
		const index = current < 0 ? (step > 0 ? 0 : count - 1) : (current + step + count) % count;
		const next = TEMPLATE_NAMES[index] ?? "editorial";
		commitMutation(applyDisplayTemplate(next, display.hiddenFooterFields), `Switched to the ${next} preset`);
	};
	const toggleDensity = (): void => {
		const density = display.density === "compact" ? "comfortable" : "compact";
		commitMutation({ ...cloneDisplay(display), density }, `Density set to ${density}`);
	};
	const activate = (): void => {
		const row = rows()[focus];
		if (!row) return;
		switch (row.kind) {
			case "preset":
				cyclePreset(1);
				return;
			case "density":
				toggleDensity();
				return;
			case "segment": {
				const label = SEGMENT_LABELS[row.id];
				const visible = display.segmentLayout.find((entry) => entry.id === row.id)?.visible;
				commitMutation(
					{ ...cloneDisplay(display), segmentLayout: toggleSegmentVisibility(display.segmentLayout, row.id) },
					`${label} ${visible ? "hidden" : "shown"}`,
				);
				return;
			}
			case "field": {
				const hidden = display.hiddenFooterFields.includes(row.id);
				commitMutation(
					{
						...cloneDisplay(display),
						hiddenFooterFields: toggleFooterField(display.hiddenFooterFields, row.id),
					},
					`${FIELD_LABELS[row.id]} ${hidden ? "shown" : "hidden"}`,
				);
				return;
			}
			case "sidebarPanel": {
				const index = sidebarDraft.findIndex((item) => item.id === row.id);
				const entry = sidebarDraft[index];
				if (!entry) return;
				const next = cloneLayout(sidebarDraft);
				next[index] = { ...entry, visible: !entry.visible };
				changeSidebar(next, `${panelTitle(row.id)} ${entry.visible ? "hidden" : "shown"}; save to apply`);
			}
		}
	};
	const move = (direction: "earlier" | "later"): void => {
		const row = rows()[focus];
		if (!row || (row.kind !== "segment" && row.kind !== "sidebarPanel")) {
			warn(
				row?.kind === "field"
					? "Fields keep their place in the segment; move the segment instead"
					: "Only rail segments and sidebar panels can be moved",
			);
			return;
		}
		const label = rowLabel(row);
		const layout = row.kind === "segment" ? display.segmentLayout : sidebarDraft;
		const index = layout.findIndex((entry) => entry.id === row.id);
		const target = direction === "earlier" ? index - 1 : index + 1;
		const neighbor = row.kind === "segment" ? display.segmentLayout[target] : undefined;
		if (row.kind === "segment" && (isPinnedSegment(row.id) || (neighbor && isPinnedSegment(neighbor.id)))) {
			warn(`${SEGMENT_LABELS.pi} always leads the rail`);
			return;
		}
		if (target < 0 || target >= layout.length) {
			warn(`${label} is already ${direction === "earlier" ? "first" : "last"}`);
			return;
		}
		const where = direction === "earlier" ? "up" : "down";
		if (row.kind === "sidebarPanel") {
			const next = cloneLayout(sidebarDraft);
			const [moved] = next.splice(index, 1);
			if (moved) next.splice(target, 0, moved);
			changeSidebar(next, `Moved ${label} ${where}; save to apply`);
		} else {
			commitMutation(
				{ ...cloneDisplay(display), segmentLayout: reorderSegment(display.segmentLayout, row.id, direction) },
				`Moved ${label} ${where}`,
			);
		}
		focus = rowIndex(row);
	};
	/** Move the focus to the first row of the other section. */
	const jumpSection = (): void => {
		const allRows = rows();
		const current = allRows[focus];
		const target: Section = current && sectionOf(current) === "rail" ? "sidebar" : "rail";
		focus = Math.max(
			0,
			allRows.findIndex((row) => sectionOf(row) === target),
		);
	};
	const actionForKey = (data: string): ActionId | undefined =>
		(Object.keys(ACTION_KEYS) as ActionId[]).find((id) => ACTION_KEYS[id] === data.toUpperCase());

	const describe = (row: Row | undefined): string => {
		if (!row) return "";
		const provenance = options.getDisplayProvenance();
		switch (row.kind) {
			case "preset":
				return `A starting layout for the status rail. ${SOURCE_SENTENCES[provenance.preset]}`;
			case "density":
				return `Compact uses shorter forms so more fits on one line. ${SOURCE_SENTENCES[provenance.density]}`;
			case "segment": {
				const visibility = provenance.visibility[row.id];
				return [
					SEGMENT_DESCRIPTIONS[row.id],
					isPinnedSegment(row.id) ? "Always first." : "",
					visibility === "product" ? "" : `Visibility ${SOURCE_PHRASES[visibility]}.`,
					provenance.order === "product" ? "" : `Order ${SOURCE_PHRASES[provenance.order]}.`,
				]
					.filter(Boolean)
					.join(" ");
			}
			case "field":
				return [
					FIELD_DESCRIPTIONS[row.id],
					provenance.fields === "product" ? "" : `Fields ${SOURCE_PHRASES[provenance.fields]}.`,
				]
					.filter(Boolean)
					.join(" ");
			case "sidebarPanel":
				if (options.getSidebarPanelSettings().find((setting) => setting.id === row.id)?.available === false)
					return "Not available in this session. It keeps its place for later.";
				// Showing Session starts model requests, so the cost is stated where it is turned on.
				return row.id === "session"
					? "Goal and status of this session. Unless Session recap is off in Settings, a model writes them after each run, which costs tokens. Sidebar changes apply when you save."
					: "Sidebar changes apply when you save.";
		}
	};

	interface Content {
		top: LayoutLine[];
		central: LayoutLine[];
		bottom: LayoutLine[];
		status: string;
	}

	const buildContent = (width: number): Content => {
		const { theme } = options;
		const provenance = options.getDisplayProvenance();
		const allRows = rows();
		const selected = allRows[focus];
		const sessionChanged = options.getSessionDisplayOverride() !== undefined;
		const sidebarSettings = new Map(options.getSidebarPanelSettings().map((entry) => [entry.id, entry]));
		const isFocused = (row: Row): boolean => selected !== undefined && sameRow(row, selected);
		const marker = (focused: boolean): string => (focused ? theme.fg("accent", "›") : " ");
		const name = (text: string, focused: boolean, quiet = false): string =>
			focused ? theme.fg("accent", text) : quiet ? theme.fg("muted", text) : text;
		const dot = (visible: boolean): string => (visible ? theme.fg("accent", "●") : theme.fg("dim", "○"));

		const settingLine = (row: Row, value: string, source: ConfigurationSource): LayoutLine => {
			const focused = isFocused(row);
			const shown = focused ? theme.fg("accent", `‹ ${value} ›`) : `  ${value}  `;
			// Label 9 + value 16 + the longest source (12) fits a 41-column two-column half.
			return {
				line: `${marker(focused)} ${fitToWidth(name(rowLabel(row), focused), 9)}${fitToWidth(shown, 16)}${theme.fg("dim", SOURCE_LABELS[source])}`,
				focused,
			};
		};
		const isSegmentVisible = (row: Row): boolean =>
			display.segmentLayout.some((entry) => entry.visible && sameRow({ kind: "segment", id: entry.id }, row));
		const toggleLine = (row: Row, title: string, visible: boolean, depth = 0, tag = ""): LayoutLine => {
			const focused = isFocused(row);
			const label = name(title, focused, !visible);
			return {
				line: `${marker(focused)} ${"  ".repeat(depth)}${dot(visible)} ${tag ? `${fitToWidth(label, 18)}${theme.fg("dim", tag)}` : label}`,
				focused,
			};
		};

		const railSection = (columnWidth: number): LayoutLine[] => [
			sectionHeading(
				"Status rail",
				selected !== undefined && sectionOf(selected) === "rail",
				columnWidth,
				theme,
			),
			settingLine({ kind: "preset" }, display.preset, provenance.preset),
			settingLine({ kind: "density" }, display.density, provenance.density),
			{ line: "" },
			...segmentRows().map((row) =>
				row.kind === "field"
					? toggleLine(row, rowLabel(row), !display.hiddenFooterFields.includes(row.id), 1)
					: toggleLine(
							row,
							rowLabel(row),
							isSegmentVisible(row),
							0,
							row.kind === "segment" && isPinnedSegment(row.id) ? "always first" : "",
						),
			),
		];
		const sidebarSection = (columnWidth: number): LayoutLine[] => [
			sectionHeading(
				"Sidebar",
				selected !== undefined && sectionOf(selected) === "sidebar",
				columnWidth,
				theme,
			),
			...sidebarDraft.map((entry) =>
				toggleLine(
					{ kind: "sidebarPanel", id: entry.id },
					sidebarSettings.get(entry.id)?.title || entry.id,
					entry.visible,
					0,
					sidebarSettings.get(entry.id)?.available === false ? "unavailable" : "",
				),
			),
		];

		let central: LayoutLine[];
		if (width >= TWO_COLUMN_MIN_WIDTH) {
			const leftWidth = Math.floor((width - COLUMN_GUTTER) / 2);
			const rightWidth = width - COLUMN_GUTTER - leftWidth;
			const left = railSection(leftWidth);
			const right = sidebarSection(rightWidth);
			const height = Math.max(left.length, right.length);
			central = Array.from({ length: height }, (_, index) => {
				const leftLine = left[index];
				const rightLine = right[index];
				return {
					line: `${fitToWidth(leftLine?.line ?? "", leftWidth)}${" ".repeat(COLUMN_GUTTER)}${rightLine?.line ?? ""}`,
					focused: Boolean(leftLine?.focused || rightLine?.focused),
				};
			});
		} else {
			central = [...railSection(width), { line: "" }, ...sidebarSection(width)];
		}

		const previewLine = renderFooterLine(
			representativeState,
			{ ...options.getRenderConfig(), ...cloneDisplay(display) },
			theme,
			Math.max(1, width - 4),
			{ colorEnabled: options.colorEnabled ?? true },
		);
		const top = [...previewPanel("Preview", ` ${previewLine}`, width, theme), { line: "" }];

		const detail = feedback
			? feedback.kind === "info"
				? feedback.message
				: theme.fg(feedback.kind, feedback.message)
			: theme.fg("muted", describe(selected));
		const reorderable =
			(selected?.kind === "segment" && !isPinnedSegment(selected.id)) || selected?.kind === "sidebarPanel";
		const toggleable =
			selected?.kind === "sidebarPanel" || selected?.kind === "segment" || selected?.kind === "field";
		const hints: KeyHint[] = [
			{ key: "↑↓", label: "select", priority: 7 },
			...(selected?.kind === "preset" || selected?.kind === "density"
				? [{ key: "←→", label: "change", priority: 8 }]
				: toggleable
					? [{ key: "enter", label: "show/hide", priority: 8 }]
					: []),
			...(reorderable ? [{ key: "⇧↑↓", label: "move", priority: 6 }] : []),
			{ key: "tab", label: "other section", priority: 3 },
			{ key: actionKey("save"), label: saving ? "saving…" : "save", priority: 9 },
			// Available actions outrank dimmed ones when the bar runs out of room.
			{ key: actionKey("undo"), label: "undo", priority: undo ? 6 : 2, enabled: undo !== undefined },
			{
				key: actionKey("revert"),
				label: "revert",
				priority: sessionChanged ? 5 : 1,
				enabled: sessionChanged,
			},
			{ key: actionKey("sidebar-default"), label: "reset sidebar", priority: 2 },
			{ key: "esc", label: "close", priority: 10 },
		];
		const bottom = [
			{ line: truncateToWidth(detail, width, "…") },
			{ line: renderKeyHints(hints, width, theme) },
		];
		const status = saving
			? theme.fg("muted", "Saving…")
			: sidebarDirty || (sessionChanged && JSON.stringify(display) !== savedDisplay)
				? theme.fg("warning", "Unsaved changes")
				: theme.fg("dim", "No changes");
		return { top, central, bottom, status };
	};

	const navigate = (update: () => void): void => {
		update();
		feedback = undefined;
		request();
	};

	return {
		invalidate() {},
		handleInput(data: string) {
			absorbNewSidebarPanels();
			const action = actionForKey(data);
			const row = rows()[focus];
			if (matchesKey(data, "up")) navigate(() => (focus = Math.max(0, focus - 1)));
			else if (matchesKey(data, "down")) navigate(() => (focus = Math.min(rows().length - 1, focus + 1)));
			else if (matchesKey(data, "shift+up")) move("earlier");
			else if (matchesKey(data, "shift+down")) move("later");
			else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) navigate(jumpSection);
			else if ((matchesKey(data, "left") || matchesKey(data, "right")) && row?.kind === "preset")
				cyclePreset(matchesKey(data, "left") ? -1 : 1);
			else if ((matchesKey(data, "left") || matchesKey(data, "right")) && row?.kind === "density")
				toggleDensity();
			else if (matchesKey(data, "enter") || data === " ") activate();
			else if (matchesKey(data, "escape")) options.close();
			else if (action) runAction(action);
		},
		render(width: number): string[] {
			if (width <= 0) return [];
			// Panels registered while the workspace is open appear without waiting for input.
			absorbNewSidebarPanels();
			const { theme } = options;
			const outerInner = Math.max(0, width - 2);
			const contentWidth = Math.max(0, outerInner - 2);
			const { top, central, bottom, status } = buildContent(contentWidth);
			const border = (text: string) => theme.fg("borderAccent", text);
			const topBorder = (): string => {
				const title = theme.bold(theme.fg("accent", TITLE));
				for (const right of [` ${status} `, ""]) {
					const fill = width - 3 - visibleWidth(TITLE) - 1 - visibleWidth(right) - 2;
					if (fill >= 1) return `${border("╭─ ")}${title} ${border("─".repeat(fill))}${right}${border("─╮")}`;
				}
				return border(`╭${"─".repeat(outerInner)}╮`);
			};
			const frame = (lines: readonly LayoutLine[]): string[] =>
				[
					topBorder(),
					...lines.map(({ line }) => `${border("│")} ${fitToWidth(line, contentWidth)} ${border("│")}`),
					border(`╰${"─".repeat(outerInner)}╯`),
				].map((line) => truncateToWidth(line, width, ""));

			const viewportHeight = options.getViewportHeight?.();
			if (viewportHeight === undefined) return frame([...top, ...central, { line: "" }, ...bottom]);

			// Pi clamps an overlay's maxHeight to at least one row. Keep the reported
			// viewport as-is, however: callers can report zero while the terminal is
			// being resized, and returning no lines is safer than overflowing it.
			const height = Math.max(0, Math.floor(viewportHeight));
			if (height === 0) return [];
			if (height === 1) return [fitToWidth(theme.bold(TITLE), width)];

			// Keep the preview, the focused row's detail, and the key bar fixed. Only the
			// sections between them scroll, so the frame is never clipped.
			const interiorRows = height - 2;
			const fixedBottom = [{ line: "" }, ...bottom];
			// Short viewports drop the preview first, then the detail line, and always keep
			// the key bar. The preview returns only once the settings keep a useful height.
			const withPreview = interiorRows - top.length - fixedBottom.length >= MIN_SCROLL_ROWS;
			const withDetail = interiorRows - bottom.length >= MIN_DETAIL_SCROLL_ROWS;
			const head = withPreview ? top : [];
			const foot = withPreview ? fixedBottom : withDetail ? bottom : bottom.slice(-1);
			const centralRows = Math.max(0, interiorRows - head.length - foot.length);
			const virtualized = virtualize(central, centralRows, scrollOffset, contentWidth, theme);
			scrollOffset = virtualized.scrollOffset;
			const centralLines = [...virtualized.lines, ...blankLines(centralRows - virtualized.lines.length)];
			return frame([...head, ...centralLines, ...foot].slice(0, interiorRows));
		},
	};
}

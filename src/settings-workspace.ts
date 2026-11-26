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
	SidebarStyle,
} from "./types.js";

export interface SidebarPanelSetting {
	id: SidebarPanelId;
	title: string;
	available: boolean;
	visible: boolean;
}

/** The pages of the Settings workspace, in Tab order. */
export const SETTINGS_PAGES = ["general", "rail", "sidebar", "recap"] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];

const OVERLAY_MAX_HEIGHT_PERCENT = 95;
export const SETTINGS_OVERLAY_MAX_HEIGHT = `${OVERLAY_MAX_HEIGHT_PERCENT}%` as const;
export const SETTINGS_OVERLAY_MARGIN = 1;

/**
 * Match Pi TUI's overlay max-height calculation for the Settings workspace.
 * Percentages are floored and the one-cell margin is applied on both sides.
 */
export function getSettingsViewportHeight(terminalRows: number): number {
	const rows = Math.max(0, Math.floor(terminalRows));
	const availableHeight = Math.max(1, rows - SETTINGS_OVERLAY_MARGIN * 2);
	const maxHeight = Math.floor((rows * OVERLAY_MAX_HEIGHT_PERCENT) / 100);
	return Math.max(1, Math.min(maxHeight, availableHeight));
}

/**
 * User-only preferences. Each one is applied and saved as it changes, unlike the
 * Display and the Sidebar panel layout, which the workspace saves on `s`.
 */
export interface SettingsPreferences {
	setNerdFont(enabled: boolean): Promise<void>;
	setShowFooter(enabled: boolean): Promise<void>;
	setCompletionNotifications(enabled: boolean): Promise<void>;
	setPrefillEnabled(enabled: boolean): Promise<void>;
	setSidebarStyle(style: SidebarStyle): Promise<void>;
	setShowSidebarOnStartup(enabled: boolean): Promise<void>;
	isToolListExpanded(): boolean;
	toggleToolList(): Promise<void>;
	setSessionRecap(enabled: boolean): Promise<void>;
	/** An empty model means the session's own model. */
	setSessionRecapModel(model: string): Promise<void>;
	/** `provider/id` of each model a recap can use, besides the session's own. */
	getRecapModels(): readonly string[];
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
	preferences: SettingsPreferences;
	/** The page shown first; General by default. */
	initialPage?: SettingsPage;
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
	/** Show a message on the detail line, in place of the selected row's description. */
	showMessage(message: string, kind: "info" | "warning" | "error"): void;
}

type PreferenceId =
	| "font"
	| "footer"
	| "notifications"
	| "sidebarStyle"
	| "sidebarStartup"
	| "toolList"
	| "prefill"
	| "recap"
	| "recapModel";
type ActionId = "save" | "revert" | "undo" | "sidebar-default";
type Row =
	| { kind: "preference"; id: PreferenceId }
	| { kind: "preset" }
	| { kind: "density" }
	| { kind: "segment"; id: SegmentId }
	| { kind: "field"; id: FooterFieldId }
	| { kind: "sidebarPanel"; id: SidebarPanelId }
	/** One model in the open Recap model list; an empty id is the session's own model. */
	| { kind: "recapModel"; id: string };

/** Shortcut letter handled for each action, in either case; the key bar shows it in lowercase. */
const ACTION_KEYS: Record<ActionId, string> = { save: "S", revert: "R", undo: "U", "sidebar-default": "D" };
const TITLE = "Settings";
/** Content width at which the page list sits beside the page instead of above it as tabs. */
const PAGE_LIST_MIN_WIDTH = 72;
/** Width of the page list: the selection bar, the longest title, and an unsaved mark. */
const PAGE_LIST_WIDTH = 17;
/** The page list, then a divider with a space on either side. */
const PAGE_LIST_COLUMN = PAGE_LIST_WIDTH + 3;
const TAB_GAP = 2;
/** Width of the name column of setting rows, so every value starts in the same column. */
const SETTING_NAME_WIDTH = 18;
/** Width of the value column when a source follows it. */
const SETTING_VALUE_WIDTH = 17;
/** Settings rows the scrolling area keeps before the preview is shown above it. */
const MIN_SCROLL_ROWS = 10;
/** Settings rows the scrolling area keeps before the page note is shown above it. */
const MIN_NOTE_SCROLL_ROWS = 4;
/** Settings rows the scrolling area keeps before the detail line is shown below it. */
const MIN_DETAIL_SCROLL_ROWS = 3;

const PAGE_TITLES: Record<SettingsPage, string> = {
	general: "General",
	rail: "Status rail",
	sidebar: "Sidebar",
	recap: "Session recap",
};

/** The preferences each page lists first, in order. */
const PAGE_PREFERENCES: Record<SettingsPage, readonly PreferenceId[]> = {
	general: ["font", "footer", "notifications"],
	rail: [],
	sidebar: ["sidebarStyle", "sidebarStartup", "toolList", "prefill"],
	recap: ["recap", "recapModel"],
};

/** How changes on each page are kept, shown above its settings. */
const PAGE_NOTES: Record<SettingsPage, string> = {
	general: "Saved as you change them.",
	rail: "Changes apply to this session now. Press s to save them.",
	sidebar: "Panel changes apply when you press s. The rest save at once.",
	recap: "Saved as you change them.",
};

const PREFERENCE_LABELS: Record<PreferenceId, string> = {
	font: "Font",
	footer: "Atelier footer",
	notifications: "Notifications",
	sidebarStyle: "Style",
	sidebarStartup: "Show at startup",
	toolList: "Tool list",
	prefill: "Prefill progress",
	recap: "Session recap",
	recapModel: "Recap model",
};

const PREFERENCE_DESCRIPTIONS: Record<PreferenceId, string> = {
	font: "Plain text works with any font. Nerd Font adds icons but needs a Nerd Font in your terminal.",
	footer: "The status rail and composer. Off restores Pi's own footer and composer when Settings closes.",
	notifications: "Notify when a run finishes.",
	sidebarStyle: "Framed panels with lit borders, or quiet headings without frames.",
	sidebarStartup: "Show the sidebar when Pi starts.",
	toolList: "List tool names in the sidebar.",
	prefill: "While a local model reads a long prompt, a sidebar panel shows how far it has read.",
	recap:
		"A model writes the Session panel's goal once and its status after each run, which costs tokens. Off uses /atelier goal, the session name, and the last reply.",
	recapModel: "The session model reuses its prompt cache. Another model gets a transcript excerpt.",
};

const SESSION_MODEL_LABEL = "Session model";

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
const onOff = (value: boolean): string => (value ? "On" : "Off");

const rowId = (row: Row): string | undefined => ("id" in row ? row.id : undefined);
const sameRow = (left: Row, right: Row): boolean => left.kind === right.kind && rowId(left) === rowId(right);

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

/** A list heading: the title, then a rule to the column edge. */
function sectionHeading(title: string, width: number, theme: ThemeLike): LayoutLine {
	const rule = Math.max(0, width - visibleWidth(title) - 1);
	return {
		line: `${theme.bold(theme.fg("muted", title))} ${theme.fg("dim", "─".repeat(rule))}`,
		heading: true,
	};
}

interface KeyHint {
	key: string;
	label: string;
	/** Hints with the lowest priority are dropped first when the bar is too narrow. */
	priority: number;
	enabled?: boolean;
}

const HINT_GAP = "  ";
/** The least space between the row's keys and the keys that work on the whole page. */
const HINT_GROUP_GAP = 4;

const hintWidth = (hint: KeyHint): number => visibleWidth(hint.key) + 3 + visibleWidth(hint.label);
const groupWidth = (group: readonly KeyHint[]): number =>
	group.reduce((sum, hint, index) => sum + (index ? HINT_GAP.length : 0) + hintWidth(hint), 0);

/** A key as a keycap, `[enter] change`; a key that does nothing right now is dimmed whole. */
function keycap(hint: KeyHint, theme: ThemeLike): string {
	if (hint.enabled === false) return theme.fg("dim", `[${hint.key}] ${hint.label}`);
	return `${theme.fg("dim", "[")}${theme.bold(theme.fg("accent", hint.key))}${theme.fg("dim", "]")} ${theme.fg("muted", hint.label)}`;
}

/**
 * The key bar: keys for the selected row on the left, keys for the whole page on the
 * right. Hints with the lowest priority are dropped first when the bar is too narrow.
 */
function renderKeyHints(
	rowHints: readonly KeyHint[],
	pageHints: readonly KeyHint[],
	width: number,
	theme: ThemeLike,
): string {
	const row = [...rowHints];
	const page = [...pageHints];
	const measure = (): number =>
		groupWidth(row) + groupWidth(page) + (row.length && page.length ? HINT_GROUP_GAP : 0);
	while (row.length + page.length > 1 && measure() > width) {
		const lowest = [...row, ...page].reduce((low, hint) => (hint.priority < low.priority ? hint : low));
		const group = row.includes(lowest) ? row : page;
		group.splice(group.indexOf(lowest), 1);
	}
	const left = row.map((hint) => keycap(hint, theme)).join(HINT_GAP);
	const right = page.map((hint) => keycap(hint, theme)).join(HINT_GAP);
	const gap = Math.max(
		row.length && page.length ? HINT_GROUP_GAP : 0,
		width - groupWidth(row) - groupWidth(page),
	);
	return `${left}${" ".repeat(gap)}${right}`;
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
	const { preferences } = options;
	let display = cloneDisplay(options.getDisplaySettings());
	let page: SettingsPage = options.initialPage ?? "general";
	/** Each page keeps its own selection, so Tab returns to where you left it. */
	const focusByPage: Record<SettingsPage, number> = { general: 0, rail: 0, sidebar: 0, recap: 0 };
	/** Segments whose fields are listed below them. */
	const openSegments = new Set<SegmentId>();
	let recapModelsOpen = false;
	let undo:
		| { kind: "display"; value: SessionDisplayOverride | undefined }
		| { kind: "sidebar"; value: SidebarPanelLayout }
		| undefined;
	let sidebarDraft: SidebarPanelLayout = cloneLayout(options.getRenderConfig().sidebarPanelLayout);
	let sidebarDirty = false;
	/** Set by Escape while panel changes are unsaved; a second Escape then closes without them. */
	let discardArmed = false;
	let feedback: { message: string; kind: "info" | "warning" | "error" } | undefined;
	let saving = false;
	/**
	 * The Display last saved from this workspace. A project setting can keep a Session
	 * override alive after a save, so an override alone does not mean unsaved changes.
	 */
	let savedDisplay: string | undefined;
	let scrollOffset = 0;

	const recapModelIds = (): string[] => {
		const configured = options.getRenderConfig().sessionRecapModel;
		const available = preferences.getRecapModels();
		// A saved model that is unavailable now stays listed, so the current choice is visible.
		return ["", ...available, ...(configured && !available.includes(configured) ? [configured] : [])];
	};
	/** Each segment, followed by its fields while the segment is shown and open. */
	const segmentRows = (): Row[] =>
		display.segmentLayout.flatMap((entry): Row[] => [
			{ kind: "segment", id: entry.id },
			...(entry.visible && openSegments.has(entry.id)
				? segmentFields(entry.id).map((id): Row => ({ kind: "field", id }))
				: []),
		]);
	const rows = (target: SettingsPage = page): Row[] => {
		const listed = PAGE_PREFERENCES[target].map((id): Row => ({ kind: "preference", id }));
		switch (target) {
			case "general":
				return listed;
			case "rail":
				return [{ kind: "preset" }, { kind: "density" }, ...segmentRows()];
			case "sidebar":
				return [...listed, ...sidebarDraft.map((entry): Row => ({ kind: "sidebarPanel", id: entry.id }))];
			case "recap":
				return [
					...listed,
					...(recapModelsOpen ? recapModelIds().map((id): Row => ({ kind: "recapModel", id })) : []),
				];
		}
	};
	const rowIndex = (target: Row, allRows: Row[]): number => allRows.findIndex((row) => sameRow(row, target));
	const focusRow = (target: Row): void => {
		focusByPage[page] = Math.max(0, rowIndex(target, rows()));
	};
	const selectedRow = (): Row | undefined => rows()[focusByPage[page]];
	const panelTitle = (id: SidebarPanelId): string =>
		options.getSidebarPanelSettings().find((setting) => setting.id === id)?.title || id;
	const rowLabel = (row: Row): string => {
		switch (row.kind) {
			case "preference":
				return PREFERENCE_LABELS[row.id];
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
			case "recapModel":
				return row.id || SESSION_MODEL_LABEL;
		}
	};
	const preferenceValue = (id: PreferenceId): string => {
		const config = options.getRenderConfig();
		switch (id) {
			case "font":
				return config.nerdFont ? "Nerd Font" : "Plain text";
			case "footer":
				return onOff(config.showFooter);
			case "notifications":
				return onOff(config.completionNotifications);
			case "sidebarStyle":
				return config.sidebarStyle === "framed" ? "Framed" : "Minimal";
			case "sidebarStartup":
				return onOff(config.showSidebarOnStartup);
			case "toolList":
				return preferences.isToolListExpanded() ? "Expanded" : "Collapsed";
			case "prefill":
				return onOff(config.prefillEnabled);
			case "recap":
				return onOff(config.sessionRecap);
			case "recapModel":
				return config.sessionRecapModel || SESSION_MODEL_LABEL;
		}
	};
	const railUnsaved = (): boolean =>
		options.getSessionDisplayOverride() !== undefined && JSON.stringify(display) !== savedDisplay;
	const pageUnsaved = (target: SettingsPage): boolean =>
		target === "rail" ? railUnsaved() : target === "sidebar" && sidebarDirty;

	/** Append newly registered panels to the draft (hidden) while keeping focus on the same row. */
	const absorbNewSidebarPanels = (): void => {
		const configuredIds = new Set(sidebarDraft.map((entry) => entry.id));
		const added = options.getSidebarPanelSettings().filter((setting) => !configuredIds.has(setting.id));
		if (added.length === 0) return;
		const focusedRow = rows("sidebar")[focusByPage.sidebar];
		sidebarDraft.push(...added.map((setting) => ({ id: setting.id, visible: false })));
		if (focusedRow) focusByPage.sidebar = Math.max(0, rowIndex(focusedRow, rows("sidebar")));
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
		const focusedRow = rows("rail")[focusByPage.rail];
		display = next;
		if (!focusedRow) return;
		const parent =
			focusedRow.kind === "field"
				? display.segmentLayout.find((entry) => segmentFields(entry.id).includes(focusedRow.id))
				: undefined;
		const index = rowIndex(focusedRow, rows("rail"));
		if (index >= 0) focusByPage.rail = index;
		else if (parent)
			focusByPage.rail = Math.max(0, rowIndex({ kind: "segment", id: parent.id }, rows("rail")));
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
	/** Undo reverses the latest change of the page in view: the rail or the sidebar panels. */
	const undoAvailable = (): boolean =>
		(undo?.kind === "display" && page === "rail") || (undo?.kind === "sidebar" && page === "sidebar");
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
		if (!previous || !undoAvailable()) {
			warn("Nothing to undo on this page");
			return;
		}
		undo = undefined;
		if (previous.kind === "sidebar") {
			sidebarDraft = previous.value;
			sidebarDirty = true;
			tell("Undid the last sidebar panel change");
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
			"Panels reset to the defaults; press s to apply",
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
	/** Actions that belong to one page do nothing elsewhere, so a stray key cannot change an unseen page. */
	const runAction = (id: ActionId): void => {
		if (id === "save") void save();
		else if (id === "undo") undoOnce();
		else if (id === "revert" && page === "rail") revert();
		else if (id === "sidebar-default" && page === "sidebar") restoreSidebarDefault();
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
	/** Apply and save a preference; its own confirmation arrives through `showMessage`. */
	const changePreference = (id: Exclude<PreferenceId, "recapModel">): void => {
		const config = options.getRenderConfig();
		const pending = (() => {
			switch (id) {
				case "font":
					return preferences.setNerdFont(!config.nerdFont);
				case "footer":
					return preferences.setShowFooter(!config.showFooter);
				case "notifications":
					return preferences.setCompletionNotifications(!config.completionNotifications);
				case "sidebarStyle":
					return preferences.setSidebarStyle(config.sidebarStyle === "framed" ? "minimal" : "framed");
				case "sidebarStartup":
					return preferences.setShowSidebarOnStartup(!config.showSidebarOnStartup);
				case "toolList":
					return preferences.toggleToolList();
				case "prefill":
					return preferences.setPrefillEnabled(!config.prefillEnabled);
				case "recap":
					return preferences.setSessionRecap(!config.sessionRecap);
			}
		})();
		feedback = undefined;
		request(true);
		void pending
			.catch((error: unknown) =>
				tell(`Could not change ${PREFERENCE_LABELS[id]}: ${errorMessage(error)}`, "error"),
			)
			.finally(() => request(true));
	};
	const setRecapModelsOpen = (open: boolean): void => {
		recapModelsOpen = open;
		if (open) {
			const configured = options.getRenderConfig().sessionRecapModel;
			focusRow({ kind: "recapModel", id: configured });
		} else focusRow({ kind: "preference", id: "recapModel" });
	};
	const chooseRecapModel = (id: string): void => {
		setRecapModelsOpen(false);
		feedback = undefined;
		request();
		void preferences
			.setSessionRecapModel(id)
			.catch((error: unknown) => tell(`Could not change Recap model: ${errorMessage(error)}`, "error"))
			.finally(() => request());
	};
	const canOpenFields = (id: SegmentId): boolean =>
		segmentFields(id).length > 0 && display.segmentLayout.some((entry) => entry.id === id && entry.visible);
	const setSegmentOpen = (id: SegmentId, open: boolean): void => {
		if (open && canOpenFields(id)) openSegments.add(id);
		else if (!open) openSegments.delete(id);
		focusRow({ kind: "segment", id });
	};
	const parentSegment = (id: FooterFieldId): SegmentId | undefined =>
		display.segmentLayout.find((entry) => segmentFields(entry.id).includes(id))?.id;
	/** ←/→: step a value, or close and open a list, like a tree. */
	const step = (direction: 1 | -1): void => {
		const row = selectedRow();
		switch (row?.kind) {
			case "preset":
				cyclePreset(direction);
				return;
			case "density":
				toggleDensity();
				return;
			case "preference":
				if (row.id === "recapModel") navigate(() => setRecapModelsOpen(direction > 0));
				else changePreference(row.id);
				return;
			case "segment":
				navigate(() => setSegmentOpen(row.id, direction > 0));
				return;
			case "field": {
				const parent = parentSegment(row.id);
				if (direction < 0 && parent) navigate(() => setSegmentOpen(parent, false));
				return;
			}
			case "recapModel":
				if (direction < 0) navigate(() => setRecapModelsOpen(false));
				return;
		}
	};
	const activate = (): void => {
		const row = selectedRow();
		if (!row) return;
		switch (row.kind) {
			case "preference":
				if (row.id === "recapModel") navigate(() => setRecapModelsOpen(!recapModelsOpen));
				else changePreference(row.id);
				return;
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
				changeSidebar(next, `${panelTitle(row.id)} ${entry.visible ? "hidden" : "shown"}; press s to apply`);
				return;
			}
			case "recapModel":
				chooseRecapModel(row.id);
		}
	};
	const move = (direction: "earlier" | "later"): void => {
		const row = selectedRow();
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
			changeSidebar(next, `Moved ${label} ${where}; press s to apply`);
		} else {
			commitMutation(
				{ ...cloneDisplay(display), segmentLayout: reorderSegment(display.segmentLayout, row.id, direction) },
				`Moved ${label} ${where}`,
			);
		}
		focusRow(row);
	};
	/** Rows a page's pane holds unscrolled: the note, the rail preview, and the settings with their headings. */
	const paneRows = (target: SettingsPage): number =>
		2 +
		(target === "rail" ? 4 : 0) +
		rows(target).length +
		(target === "rail" || target === "sidebar" ? 2 : 0);
	const switchPage = (offset: 1 | -1): void => {
		const index = SETTINGS_PAGES.indexOf(page);
		page = SETTINGS_PAGES[(index + offset + SETTINGS_PAGES.length) % SETTINGS_PAGES.length] ?? "general";
		scrollOffset = 0;
	};
	const actionForKey = (data: string): ActionId | undefined =>
		(Object.keys(ACTION_KEYS) as ActionId[]).find((id) => ACTION_KEYS[id] === data.toUpperCase());

	const describe = (row: Row | undefined): string => {
		if (!row) return "";
		const provenance = options.getDisplayProvenance();
		switch (row.kind) {
			case "preference":
				return PREFERENCE_DESCRIPTIONS[row.id];
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
					? "Goal and status of this session. Unless Session recap is off, a model writes them after each run, which costs tokens."
					: "Shown in the sidebar in this order.";
			case "recapModel":
				return row.id
					? "Gets a transcript excerpt without tool output."
					: "Reuses the conversation's prompt cache; nothing leaves the current provider.";
		}
	};

	/** The page note, or a warning when another setting keeps the page from having an effect. */
	const pageNote = (): { text: string; warning: boolean } => {
		const config = options.getRenderConfig();
		if (page === "rail" && !config.showFooter)
			return {
				text: "The Atelier footer is off, so the rail is hidden. Turn it on in General.",
				warning: true,
			};
		const sessionPanel = options.getSidebarPanelSettings().find((setting) => setting.id === "session");
		if (page === "recap" && config.sessionRecap && sessionPanel?.visible === false)
			return {
				text: "Recaps are written only while the Session panel is shown. Show it on the Sidebar page.",
				warning: true,
			};
		return { text: PAGE_NOTES[page], warning: false };
	};

	interface Content {
		/** The page note, pinned above the settings. */
		note: LayoutLine[];
		/** The rail preview, pinned below the note on the Status rail page. */
		preview: LayoutLine[];
		central: LayoutLine[];
		bottom: LayoutLine[];
		status: string;
	}

	const buildContent = (paneWidth: number, barWidth: number): Content => {
		const { theme } = options;
		const provenance = options.getDisplayProvenance();
		const selected = selectedRow();
		const sidebarSettings = new Map(options.getSidebarPanelSettings().map((entry) => [entry.id, entry]));
		const isFocused = (row: Row): boolean => selected !== undefined && sameRow(row, selected);
		const marker = (focused: boolean): string => (focused ? theme.fg("accent", "›") : " ");
		const name = (text: string, focused: boolean, quiet = false): string =>
			focused ? theme.fg("accent", text) : quiet ? theme.fg("muted", text) : text;
		const dot = (visible: boolean): string => (visible ? theme.fg("accent", "●") : theme.fg("dim", "○"));

		/** A name and its current value; ‹ › around the focused value say it can be changed. */
		const settingLine = (row: Row, value: string, source?: ConfigurationSource): LayoutLine => {
			const focused = isFocused(row);
			const shown = focused ? theme.fg("accent", `‹ ${value} ›`) : `  ${value}  `;
			const tail = source
				? `${fitToWidth(shown, SETTING_VALUE_WIDTH)}${theme.fg("dim", SOURCE_LABELS[source])}`
				: shown;
			return {
				line: `${marker(focused)} ${fitToWidth(name(rowLabel(row), focused), SETTING_NAME_WIDTH)}${tail}`,
				focused,
			};
		};
		const toggleLine = (row: Row, visible: boolean, depth = 0, tag = ""): LayoutLine => {
			const focused = isFocused(row);
			const label = name(rowLabel(row), focused, !visible);
			return {
				line: `${marker(focused)} ${"  ".repeat(depth)}${dot(visible)} ${tag ? `${fitToWidth(label, SETTING_NAME_WIDTH)}${theme.fg("dim", tag)}` : label}`,
				focused,
			};
		};
		const segmentTag = (id: SegmentId, visible: boolean): string => {
			if (isPinnedSegment(id)) return "always first";
			const fields = segmentFields(id);
			if (!visible || fields.length === 0) return "";
			const shown = fields.filter((field) => !display.hiddenFooterFields.includes(field)).length;
			return `${openSegments.has(id) ? "▾" : "▸"} ${shown} of ${fields.length} fields`;
		};
		const preferenceLines = (): LayoutLine[] =>
			PAGE_PREFERENCES[page].map((id) => settingLine({ kind: "preference", id }, preferenceValue(id)));

		let central: LayoutLine[];
		switch (page) {
			case "general":
				central = preferenceLines();
				break;
			case "rail":
				central = [
					settingLine({ kind: "preset" }, display.preset, provenance.preset),
					settingLine({ kind: "density" }, display.density, provenance.density),
					{ line: "" },
					sectionHeading("Segments", paneWidth, theme),
					...segmentRows().map((row) => {
						if (row.kind === "field") return toggleLine(row, !display.hiddenFooterFields.includes(row.id), 1);
						const id = row.kind === "segment" ? row.id : undefined;
						const visible = display.segmentLayout.some((entry) => entry.id === id && entry.visible);
						return toggleLine(row, visible, 0, id ? segmentTag(id, visible) : "");
					}),
				];
				break;
			case "sidebar":
				central = [
					...preferenceLines(),
					{ line: "" },
					sectionHeading("Panels", paneWidth, theme),
					...sidebarDraft.map((entry) =>
						toggleLine(
							{ kind: "sidebarPanel", id: entry.id },
							entry.visible,
							0,
							sidebarSettings.get(entry.id)?.available === false ? "unavailable" : "",
						),
					),
				];
				break;
			case "recap": {
				const configured = options.getRenderConfig().sessionRecapModel;
				central = [
					...preferenceLines(),
					...(recapModelsOpen
						? recapModelIds().map((id) => {
								const row: Row = { kind: "recapModel", id };
								const focused = isFocused(row);
								const current = id === configured;
								const mark = current ? theme.fg("accent", "◉") : theme.fg("dim", "○");
								return {
									line: `${marker(focused)}   ${mark} ${name(rowLabel(row), focused, !current)}`,
									focused,
								};
							})
						: []),
				];
				break;
			}
		}

		const { text: noteText, warning } = pageNote();
		const note = [
			{ line: truncateToWidth(theme.fg(warning ? "warning" : "muted", noteText), paneWidth, "…") },
			{ line: "" },
		];

		let preview: LayoutLine[] = [];
		if (page === "rail") {
			const previewLine = renderFooterLine(
				representativeState,
				{ ...options.getRenderConfig(), ...cloneDisplay(display) },
				theme,
				Math.max(1, paneWidth - 4),
				{ colorEnabled: options.colorEnabled ?? true },
			);
			preview = [...previewPanel("Preview", ` ${previewLine}`, paneWidth, theme), { line: "" }];
		}

		const detail = feedback
			? feedback.kind === "info"
				? feedback.message
				: theme.fg(feedback.kind, feedback.message)
			: theme.fg("muted", describe(selected));
		const pageHints: KeyHint[] = [
			{ key: "↑↓", label: "select", priority: 3 },
			{ key: "tab", label: "next page", priority: 11 },
			...(page === "rail" || page === "sidebar" || pageUnsaved("rail") || pageUnsaved("sidebar")
				? [
						{
							key: actionKey("save"),
							label: saving ? "saving…" : "save",
							priority: pageUnsaved("rail") || pageUnsaved("sidebar") ? 9 : 6,
						},
					]
				: []),
			// Available actions outrank dimmed ones when the bar runs out of room.
			...(page === "rail" || page === "sidebar"
				? [
						{
							key: actionKey("undo"),
							label: "undo",
							priority: undoAvailable() ? 5 : 2,
							enabled: undoAvailable(),
						},
					]
				: []),
			...(page === "rail"
				? [
						{
							key: actionKey("revert"),
							label: "revert",
							priority: options.getSessionDisplayOverride() ? 4 : 1,
							enabled: options.getSessionDisplayOverride() !== undefined,
						},
					]
				: []),
			...(page === "sidebar"
				? [{ key: actionKey("sidebar-default"), label: "reset panels", priority: 2 }]
				: []),
			{ key: "esc", label: "close", priority: 10 },
		];
		const bottom = [
			{ line: truncateToWidth(detail, barWidth, "…") },
			{ line: theme.fg("dim", "─".repeat(Math.max(0, barWidth))) },
			{ line: renderKeyHints(rowHints(selected), pageHints, barWidth, theme) },
		];
		const status = saving
			? theme.fg("muted", "Saving…")
			: pageUnsaved("rail") || pageUnsaved("sidebar")
				? theme.fg("warning", "Unsaved changes")
				: theme.fg("dim", "No changes");
		return { note, preview, central, bottom, status };
	};

	/** Keys that act on the selected row, most useful first. */
	const rowHints = (row: Row | undefined): KeyHint[] => {
		switch (row?.kind) {
			case "preference":
				return row.id === "recapModel"
					? [{ key: "enter", label: recapModelsOpen ? "close list" : "choose", priority: 12 }]
					: [{ key: "enter", label: "change", priority: 12 }];
			case "preset":
			case "density":
				return [{ key: "←→", label: "change", priority: 12 }];
			case "segment": {
				const open = openSegments.has(row.id);
				return [
					{ key: "enter", label: "show/hide", priority: 12 },
					...(canOpenFields(row.id)
						? [{ key: open ? "←" : "→", label: open ? "close fields" : "fields", priority: 7 }]
						: []),
					...(isPinnedSegment(row.id) ? [] : [{ key: "⇧↑↓", label: "move", priority: 5 }]),
				];
			}
			case "field":
				return [
					{ key: "enter", label: "show/hide", priority: 12 },
					{ key: "←", label: "back", priority: 5 },
				];
			case "sidebarPanel":
				return [
					{ key: "enter", label: "show/hide", priority: 12 },
					{ key: "⇧↑↓", label: "move", priority: 5 },
				];
			case "recapModel":
				return [
					{ key: "enter", label: "use", priority: 12 },
					{ key: "←", label: "back", priority: 5 },
				];
			default:
				return [];
		}
	};

	/** The page list beside a wide page: a bar marks the open page, a dot one with unsaved changes. */
	const pageList = (): string[] => {
		const { theme } = options;
		return SETTINGS_PAGES.map((id) => {
			const active = id === page;
			const title = active
				? theme.bold(theme.fg("accent", PAGE_TITLES[id]))
				: theme.fg("muted", PAGE_TITLES[id]);
			const unsaved = pageUnsaved(id) ? theme.fg("warning", " •") : "";
			return `${active ? theme.fg("accent", "▌") : " "} ${title}${unsaved}`;
		});
	};

	/** Tabs above a narrow page, underlined under the open one; just the open page when they do not fit. */
	const pageTabs = (width: number): LayoutLine[] => {
		const { theme } = options;
		const labels = SETTINGS_PAGES.map((id) => ({
			id,
			title: PAGE_TITLES[id],
			unsaved: pageUnsaved(id) ? " •" : "",
		}));
		const total = labels.reduce(
			(sum, label, index) => sum + (index ? TAB_GAP : 0) + visibleWidth(label.title + label.unsaved),
			0,
		);
		const titleOf = (label: (typeof labels)[number]): string =>
			`${label.id === page ? theme.bold(theme.fg("accent", label.title)) : theme.fg("muted", label.title)}${theme.fg("warning", label.unsaved)}`;
		const underline = (spans: { width: number; active: boolean }[]): string => {
			const drawn = spans
				.map((span) =>
					span.active ? theme.fg("accent", "━".repeat(span.width)) : theme.fg("dim", "─".repeat(span.width)),
				)
				.join("");
			const used = spans.reduce((sum, span) => sum + span.width, 0);
			return `${drawn}${theme.fg("dim", "─".repeat(Math.max(0, width - used)))}`;
		};
		if (total <= width) {
			const spans = labels.flatMap((label, index) => [
				...(index ? [{ width: TAB_GAP, active: false }] : []),
				{ width: visibleWidth(label.title + label.unsaved), active: label.id === page },
			]);
			return [
				{ line: labels.map(titleOf).join(" ".repeat(TAB_GAP)) },
				{ line: underline(spans) },
				{ line: "" },
			];
		}
		const current = labels.find((label) => label.id === page) ?? labels[0];
		if (!current) return [];
		const position = theme.fg("dim", `  ${SETTINGS_PAGES.indexOf(page) + 1} of ${SETTINGS_PAGES.length}`);
		return [
			{ line: truncateToWidth(`${titleOf(current)}${position}`, width, "…") },
			{ line: underline([{ width: visibleWidth(current.title + current.unsaved), active: true }]) },
			{ line: "" },
		];
	};

	const navigate = (update: () => void): void => {
		update();
		feedback = undefined;
		request();
	};

	return {
		invalidate() {},
		showMessage(message, kind) {
			tell(message, kind);
			request();
		},
		handleInput(data: string) {
			absorbNewSidebarPanels();
			const escape = matchesKey(data, "escape");
			if (!escape) discardArmed = false;
			const action = actionForKey(data);
			const count = rows().length;
			if (matchesKey(data, "up"))
				navigate(() => (focusByPage[page] = Math.max(0, Math.min(count - 1, focusByPage[page] - 1))));
			else if (matchesKey(data, "down"))
				navigate(() => (focusByPage[page] = Math.max(0, Math.min(count - 1, focusByPage[page] + 1))));
			else if (matchesKey(data, "shift+up")) move("earlier");
			else if (matchesKey(data, "shift+down")) move("later");
			else if (matchesKey(data, "shift+tab")) navigate(() => switchPage(-1));
			else if (matchesKey(data, "tab")) navigate(() => switchPage(1));
			else if (matchesKey(data, "left")) step(-1);
			else if (matchesKey(data, "right")) step(1);
			else if (matchesKey(data, "enter") || data === " ") activate();
			else if (escape) {
				if (sidebarDirty && !discardArmed) {
					discardArmed = true;
					warn("Panel changes are unsaved. s saves them; esc again closes without them.");
				} else options.close();
			} else if (action) runAction(action);
		},
		render(width: number): string[] {
			if (width <= 0) return [];
			// Panels registered while the workspace is open appear without waiting for input.
			absorbNewSidebarPanels();
			const { theme } = options;
			const outerInner = Math.max(0, width - 2);
			const contentWidth = Math.max(0, outerInner - 2);
			const wide = contentWidth >= PAGE_LIST_MIN_WIDTH;
			const paneWidth = wide ? contentWidth - PAGE_LIST_COLUMN : contentWidth;
			const { note, preview, central, bottom, status } = buildContent(paneWidth, contentWidth);
			const tabs = wide ? [] : pageTabs(contentWidth);
			const list = wide ? pageList() : [];
			const divider = theme.fg("dim", "│");
			/** Set the page list beside the page, for as many rows as the page has. */
			const besideList = (pane: readonly LayoutLine[]): LayoutLine[] =>
				wide
					? pane.map((entry, index) => ({
							line: `${fitToWidth(list[index] ?? "", PAGE_LIST_WIDTH)} ${divider} ${entry.line}`,
						}))
					: [...pane];
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
			if (viewportHeight === undefined) {
				const pane = [...note, ...preview, ...central];
				return frame([
					...tabs,
					...besideList([...pane, ...blankLines(list.length - pane.length)]),
					{ line: "" },
					...bottom,
				]);
			}

			// Pi clamps an overlay's maxHeight to at least one row. Keep the reported
			// viewport as-is, however: callers can report zero while the terminal is
			// being resized, and returning no lines is safer than overflowing it.
			// The frame keeps the height of the tallest page, so it does not jump between pages,
			// and does not grow past it into empty rows.
			const naturalHeight =
				2 + tabs.length + Math.max(list.length, ...SETTINGS_PAGES.map(paneRows)) + 1 + bottom.length;
			const height = Math.min(Math.max(0, Math.floor(viewportHeight)), naturalHeight);
			if (height === 0) return [];
			if (height === 1) return [fitToWidth(theme.bold(TITLE), width)];

			// Keep the tabs, the page note, the preview, the selected row's detail, and the
			// key bar fixed. Only the settings between them scroll, so the frame is never clipped.
			const interiorRows = height - 2;
			const fixedBottom = [{ line: "" }, ...bottom];
			// Short viewports drop the preview first, then the page note, then the detail
			// line, and always keep the key bar.
			const room = interiorRows - tabs.length - fixedBottom.length;
			const withNote = room - note.length >= MIN_NOTE_SCROLL_ROWS;
			const withPreview = withNote && room - note.length - preview.length >= MIN_SCROLL_ROWS;
			const withDetail = interiorRows - tabs.length - bottom.length >= MIN_DETAIL_SCROLL_ROWS;
			const head = [...(withNote ? note : []), ...(withPreview ? preview : [])];
			const foot = withNote ? fixedBottom : withDetail ? bottom : bottom.slice(-1);
			const centralRows = Math.max(0, interiorRows - tabs.length - head.length - foot.length);
			const virtualized = virtualize(central, centralRows, scrollOffset, paneWidth, theme);
			scrollOffset = virtualized.scrollOffset;
			const pane = [...head, ...virtualized.lines, ...blankLines(centralRows - virtualized.lines.length)];
			return frame([...tabs, ...besideList(pane), ...foot].slice(0, interiorRows));
		},
	};
}

import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	applyDisplayTemplate,
	cloneLayout,
	derivePresetIdentity,
	isRequiredSegment,
	reorderSegment,
	TEMPLATE_NAMES,
	toggleSegmentVisibility,
} from "./display.js";
import { renderFooterLine } from "./footer.js";
import type { ThemeLike } from "./palette.js";
import { DEFAULT_SIDEBAR_PANEL_LAYOUT } from "./sidebar-panels.js";
import { errorMessage, fitToWidth } from "./text.js";
import type {
	AtelierConfig,
	DisplayPatch,
	DisplayProvenance,
	DisplaySettings,
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
	/** True when a contributed panel supplies compact/expanded rich representations. */
	collapsible?: boolean;
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
	| { kind: "sidebarPanel"; id: SidebarPanelId }
	| { kind: "action"; id: ActionId };

/** Shortcut letter shown next to, and handled for, each action row. */
const ACTION_KEYS: Record<ActionId, string> = { save: "S", revert: "R", undo: "U", "sidebar-default": "D" };
const TITLE = "DISPLAY SETTINGS";
const KEY_HINTS = "↑/↓ Select · Enter Change · S Save · Esc Close";

const sameRow = (left: Row, right: Row): boolean =>
	left.kind === right.kind && ("id" in left ? left.id : undefined) === ("id" in right ? right.id : undefined);

const cloneDisplay = (value: DisplaySettings): DisplaySettings => ({
	...value,
	segmentLayout: cloneLayout(value.segmentLayout),
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
}

const blankLines = (count: number): LayoutLine[] =>
	Array.from({ length: Math.max(0, count) }, () => ({ line: "" }));

function panel(
	title: string,
	lines: readonly LayoutLine[],
	width: number,
	theme: ThemeLike,
	accent = false,
): LayoutLine[] {
	const withFocus = (line: string, focused: boolean | undefined): LayoutLine =>
		focused === undefined ? { line } : { line, focused };
	if (width < 4) return lines.map(({ line, focused }) => withFocus(fitToWidth(line, width), focused));
	const inner = width - 2;
	const edge = (text: string) => theme.fg(accent ? "borderAccent" : "muted", text);
	const heading = ` ${title} `;
	const rule = Math.max(0, inner - visibleWidth(heading));
	return [
		{
			line: `${edge("┌")}${theme.bold(theme.fg(accent ? "accent" : "muted", heading))}${edge("─".repeat(rule))}${edge("┐")}`,
		},
		...lines.map(({ line, focused }) =>
			withFocus(`${edge("│")}${fitToWidth(line, inner)}${edge("│")}`, focused),
		),
		{ line: `${edge("└")}${edge("─".repeat(inner))}${edge("┘")}` },
	];
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
): { lines: LayoutLine[]; scrollOffset: number } {
	const more = (direction: "↑" | "↓"): LayoutLine => ({ line: fitToWidth(`${direction} more`, width) });
	const focused = Math.max(
		0,
		central.findIndex(({ focused }) => focused),
	);
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
		if (focused < offset) offset = focused;
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
		| { kind: "sidebar"; value: { layout: SidebarPanelLayout; collapsed: Record<string, boolean> } }
		| undefined;
	let sidebarDraft: SidebarPanelLayout = cloneLayout(options.getRenderConfig().sidebarPanelLayout);
	let sidebarDirty = false;
	let collapseDraft: Record<string, boolean> = {
		...(options.getRenderConfig().contributedPanelCollapsed ?? {}),
	};
	let collapseDirty = false;
	let feedback = "";
	let saving = false;
	let scrollOffset = 0;

	const rows = (): Row[] => [
		{ kind: "preset" },
		{ kind: "density" },
		...display.segmentLayout.map((entry): Row => ({ kind: "segment", id: entry.id })),
		{ kind: "action", id: "save" },
		{ kind: "action", id: "revert" },
		{ kind: "action", id: "undo" },
		...sidebarDraft.map((entry): Row => ({ kind: "sidebarPanel", id: entry.id })),
		{ kind: "action", id: "sidebar-default" },
	];
	const rowIndex = (target: Row, allRows = rows()): number =>
		allRows.findIndex((row) => sameRow(row, target));

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
		feedback = message;
		options.report?.(message, kind);
	};
	const warn = (message: string): void => {
		tell(message, "warning");
		request();
	};
	const refresh = (): void => {
		display = cloneDisplay(options.getDisplaySettings());
	};
	const commitMutation = (next: DisplaySettings, message: string): void => {
		undo = { kind: "display", value: cloneOverride(options.getSessionDisplayOverride()) };
		const complete = cloneDisplay(next);
		complete.preset = derivePresetIdentity(complete);
		options.replaceSessionDisplayOverride(complete);
		display = complete;
		tell(message);
		request(true);
	};
	const recordSidebarUndo = (): void => {
		undo = {
			kind: "sidebar",
			value: {
				layout: cloneLayout(sidebarDraft),
				collapsed: { ...collapseDraft },
			},
		};
	};
	const changeSidebar = (next: SidebarPanelLayout, message: string): void => {
		recordSidebarUndo();
		sidebarDraft = next;
		sidebarDirty = true;
		tell(message);
		request();
	};
	const revert = (): void => {
		undo = { kind: "display", value: cloneOverride(options.getSessionDisplayOverride()) };
		options.clearSessionDisplayOverride();
		refresh();
		tell("Reverted to Effective lower-layer settings");
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
			sidebarDraft = previous.value.layout;
			collapseDraft = previous.value.collapsed;
			sidebarDirty = true;
			collapseDirty = true;
			tell("Undid the last Sidebar change");
			request();
		} else {
			options.replaceSessionDisplayOverride(previous.value);
			refresh();
			tell("Undid the last Display change");
			request(true);
		}
	};
	const restoreSidebarDefault = (): void =>
		changeSidebar(cloneLayout(DEFAULT_SIDEBAR_PANEL_LAYOUT), "Restored product Sidebar default");
	const save = async (): Promise<void> => {
		if (saving) return;
		if (sidebarDirty && !sidebarDraft.some((entry) => entry.visible)) {
			warn("At least one Sidebar panel must remain visible");
			return;
		}
		saving = true;
		request();
		const patch: DisplayPatch = {
			...cloneDisplay(display),
			...(sidebarDirty ? { sidebarPanelLayout: cloneLayout(sidebarDraft) } : {}),
			...(collapseDirty ? { contributedPanelCollapsed: { ...collapseDraft } } : {}),
		};
		try {
			await options.persistUserDisplayPatch(patch);
			options.applySavedUserDisplayPatch(patch);
			refresh();
			if (sidebarDirty) {
				sidebarDirty = false;
				if (undo?.kind === "sidebar") undo = undefined;
			}
			if (collapseDirty) collapseDirty = false;
			tell("Saved as User default");
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
	const activate = (): void => {
		const row = rows()[focus];
		if (!row) return;
		switch (row.kind) {
			case "preset": {
				const current = TEMPLATE_NAMES.findIndex((name) => name === display.preset);
				const next = TEMPLATE_NAMES[(current + 1) % TEMPLATE_NAMES.length] ?? "editorial";
				commitMutation(applyDisplayTemplate(next), `Applied ${next} preset`);
				return;
			}
			case "density":
				commitMutation(
					{ ...cloneDisplay(display), density: display.density === "compact" ? "comfortable" : "compact" },
					"Changed density",
				);
				return;
			case "segment":
				if (isRequiredSegment(row.id)) {
					warn(`${row.id} is required; use Shift+Up/Down to reorder`);
					return;
				}
				commitMutation(
					{ ...cloneDisplay(display), segmentLayout: toggleSegmentVisibility(display.segmentLayout, row.id) },
					`Toggled ${row.id}`,
				);
				return;
			case "sidebarPanel": {
				const index = sidebarDraft.findIndex((item) => item.id === row.id);
				const entry = sidebarDraft[index];
				if (!entry) return;
				const next = cloneLayout(sidebarDraft);
				next[index] = { ...entry, visible: !entry.visible };
				changeSidebar(next, `${row.id} ${entry.visible ? "hidden" : "shown"}`);
				return;
			}
			case "action":
				runAction(row.id);
		}
	};
	const toggleCollapse = (): void => {
		const row = rows()[focus];
		if (!row || row.kind !== "sidebarPanel") {
			tell("Select a contributed panel to collapse or expand", "warning");
			request();
			return;
		}
		const available = options.getSidebarPanelSettings().find((entry) => entry.id === row.id);
		if (available?.collapsible !== true) {
			tell(`${row.id} does not offer a compact representation`, "warning");
			request();
			return;
		}
		recordSidebarUndo();
		collapseDraft[row.id] = collapseDraft[row.id] !== true;
		collapseDirty = true;
		tell(`${row.id} ${collapseDraft[row.id] ? "collapsed" : "expanded"}`);
		request();
	};
	const move = (direction: "earlier" | "later"): void => {
		const row = rows()[focus];
		if (!row || (row.kind !== "segment" && row.kind !== "sidebarPanel")) {
			warn("Select a Segment or Sidebar panel to reorder");
			return;
		}
		const layout = row.kind === "segment" ? display.segmentLayout : sidebarDraft;
		const index = layout.findIndex((entry) => entry.id === row.id);
		const target = direction === "earlier" ? index - 1 : index + 1;
		if (target < 0 || target >= layout.length) {
			warn(`${row.id} is already at the ${direction === "earlier" ? "start" : "end"}`);
			return;
		}
		if (row.kind === "sidebarPanel") {
			const next = cloneLayout(sidebarDraft);
			const [moved] = next.splice(index, 1);
			if (moved) next.splice(target, 0, moved);
			changeSidebar(next, `Moved ${row.id} ${direction}`);
		} else {
			commitMutation(
				{ ...cloneDisplay(display), segmentLayout: reorderSegment(display.segmentLayout, row.id, direction) },
				`Moved ${row.id} ${direction}`,
			);
		}
		focus = rowIndex(row);
	};
	const actionForKey = (data: string): ActionId | undefined =>
		(Object.keys(ACTION_KEYS) as ActionId[]).find((id) => ACTION_KEYS[id] === data.toUpperCase());

	const buildContent = (outerInner: number): { content: LayoutLine[]; sessionChanged: boolean } => {
		const { theme } = options;
		const provenance = options.getDisplayProvenance();
		const allRows = rows();
		const rowLine = (row: Row, text: string): LayoutLine => {
			const focused = focus === rowIndex(row, allRows);
			return { line: `${focused ? theme.fg("accent", "›") : " "} ${text}`, focused };
		};
		const actionLine = (id: ActionId, label: string, hint = ACTION_KEYS[id]): LayoutLine =>
			rowLine({ kind: "action", id }, `${label.padEnd(16)}${hint}`);
		const sessionChanged = options.getSessionDisplayOverride() !== undefined;
		const displayLines: LayoutLine[] = [
			rowLine({ kind: "preset" }, `Preset       ${display.preset.padEnd(13)} ${provenance.preset}`),
			rowLine({ kind: "density" }, `Density      ${display.density.padEnd(13)} ${provenance.density}`),
			{ line: "" },
			actionLine("save", "Save default", saving ? "saving…" : ACTION_KEYS.save),
			actionLine("revert", "Revert session"),
			actionLine("undo", "Undo", undo ? ACTION_KEYS.undo : "—"),
		];
		const segmentLines: LayoutLine[] = [
			{ line: theme.fg("muted", `  ● shown   ○ hidden   ◆ required   order ${provenance.order}`) },
			{ line: "" },
			...display.segmentLayout.map((entry, index) => {
				const required = isRequiredSegment(entry.id);
				const state = required ? "◆" : entry.visible ? "●" : "○";
				return rowLine(
					{ kind: "segment", id: entry.id },
					`${String(index + 1).padStart(2)}  ${state} ${entry.id.padEnd(12)}${required ? "  required" : ""}`,
				);
			}),
		];
		const sidebarSettings = new Map(options.getSidebarPanelSettings().map((entry) => [entry.id, entry]));
		const sidebarLines: LayoutLine[] = [
			{ line: theme.fg("muted", `  ● shown   ○ hidden   ${sidebarDirty ? "draft · " : ""}saved order`) },
			{ line: "" },
			...sidebarDraft.map((entry, index) => {
				const setting = sidebarSettings.get(entry.id);
				const suffix =
					setting?.available === false
						? "  unavailable"
						: setting?.collapsible
							? `  ${collapseDraft[entry.id] === true ? "collapsed" : "expanded"}`
							: "";
				return rowLine(
					{ kind: "sidebarPanel", id: entry.id },
					`${String(index + 1).padStart(2)}  ${entry.visible ? "●" : "○"} ${setting?.title || entry.id}${suffix}`,
				);
			}),
			{ line: "" },
			actionLine("sidebar-default", "Restore default"),
		];
		const previewLine = renderFooterLine(
			representativeState,
			{ ...options.getRenderConfig(), ...cloneDisplay(display) },
			theme,
			Math.max(1, outerInner - 6),
			{ colorEnabled: options.colorEnabled ?? true },
		);
		const preview = [
			...panel("Preview", [{ line: `  ${previewLine}` }], outerInner, theme, true),
			{ line: "" },
			...panel(
				"Sidebar Preview",
				sidebarDraft.filter((entry) => entry.visible).map((entry) => ({ line: `  ${entry.id}` })),
				outerInner,
				theme,
			),
		];
		let editing: LayoutLine[];
		if (outerInner >= 72) {
			const leftWidth = Math.max(28, Math.floor((outerInner - 2) * 0.4));
			const rightWidth = outerInner - leftWidth - 2;
			const height = Math.max(displayLines.length, segmentLines.length);
			const left = panel(
				"Display",
				[...displayLines, ...blankLines(height - displayLines.length)],
				leftWidth,
				theme,
			);
			const right = panel(
				"Segment Editor",
				[...segmentLines, ...blankLines(height - segmentLines.length)],
				rightWidth,
				theme,
			);
			editing = [
				...left.map((leftLine, index) => ({
					line: `${leftLine.line}  ${right[index]?.line ?? fitToWidth("", rightWidth)}`,
					focused: Boolean(leftLine.focused || right[index]?.focused),
				})),
				{ line: "" },
				...panel("Sidebar Editor", sidebarLines, outerInner, theme),
			];
		} else {
			editing = [
				...panel("Display", displayLines, outerInner, theme),
				{ line: "" },
				...panel("Segment Editor", segmentLines, outerInner, theme),
				{ line: "" },
				...panel("Sidebar Editor", sidebarLines, outerInner, theme),
			];
		}
		const selected = allRows[focus];
		let guidance = KEY_HINTS;
		if (selected?.kind === "segment") {
			const required = isRequiredSegment(selected.id);
			const visibility = required
				? "required"
				: display.segmentLayout.find((entry) => entry.id === selected.id)?.visible
					? "shown"
					: "hidden";
			guidance = `${selected.id} · ${visibility} · source:${provenance.visibility[selected.id]} · order:${provenance.order} · ${required ? "Shift+↑/↓ Reorder" : "Enter Toggle · Shift+↑/↓ Reorder"}`;
		} else if (selected?.kind === "preset" || selected?.kind === "density") {
			guidance = `${selected.kind} · source:${provenance[selected.kind]} · Enter Change · U Undo`;
		} else if (selected?.kind === "sidebarPanel") {
			const entry = sidebarDraft.find((item) => item.id === selected.id);
			const setting = sidebarSettings.get(selected.id);
			const available = setting?.available !== false;
			const collapseHint =
				setting?.collapsible === true
					? ` · ${collapseDraft[selected.id] === true ? "collapsed" : "expanded"}`
					: "";
			const collapseKey = setting?.collapsible === true ? " · C Collapse" : "";
			guidance = `${selected.id} · ${entry?.visible ? "shown" : "hidden"} · ${available ? "available" : "unavailable"}${collapseHint} · Enter Toggle${collapseKey} · Shift+↑/↓ Reorder`;
		} else if (selected?.kind === "action") {
			guidance = `${selected.id} · Enter or ${ACTION_KEYS[selected.id]}`;
		}
		const status = saving ? "saving…" : sessionChanged || sidebarDirty ? "session changed" : "effective";
		const content: LayoutLine[] = [
			{
				line: fitToWidth(
					`${theme.bold(TITLE)}  ${theme.fg(sessionChanged ? "warning" : "success", status)}`,
					outerInner,
				),
			},
			{ line: fitToWidth(theme.fg("muted", KEY_HINTS), outerInner) },
			{ line: "" },
			...preview,
			{ line: "" },
			...editing,
			{ line: "" },
			...(feedback ? [{ line: fitToWidth(feedback, outerInner) }] : []),
			{ line: fitToWidth(guidance, outerInner) },
		];
		return { content, sessionChanged };
	};

	return {
		invalidate() {},
		handleInput(data: string) {
			absorbNewSidebarPanels();
			const action = actionForKey(data);
			if (matchesKey(data, "up")) {
				focus = Math.max(0, focus - 1);
				request();
			} else if (matchesKey(data, "down")) {
				focus = Math.min(rows().length - 1, focus + 1);
				request();
			} else if (matchesKey(data, "shift+up")) move("earlier");
			else if (matchesKey(data, "shift+down")) move("later");
			else if (matchesKey(data, "enter") || data === " ") activate();
			else if (matchesKey(data, "escape")) options.close();
			else if (data.toLowerCase() === "c") toggleCollapse();
			else if (action) runAction(action);
		},
		render(width: number): string[] {
			if (width <= 0) return [];
			// Panels registered while the workspace is open appear without waiting for input.
			absorbNewSidebarPanels();
			const outerInner = Math.max(0, width - 2);
			const { content } = buildContent(outerInner);
			const border = (text: string) => options.theme.fg("borderAccent", text);
			const frame = (lines: readonly LayoutLine[]): string[] =>
				[
					border(`╭${"─".repeat(outerInner)}╮`),
					...lines.map(({ line }) => `${border("│")}${fitToWidth(line, outerInner)}${border("│")}`),
					border(`╰${"─".repeat(outerInner)}╯`),
				].map((line) => truncateToWidth(line, width, ""));

			const viewportHeight = options.getViewportHeight?.();
			if (viewportHeight === undefined) return frame(content);

			// Pi clamps an overlay's maxHeight to at least one row. Keep the reported
			// viewport as-is, however: callers can report zero while the terminal is
			// being resized, and returning no lines is safer than overflowing it.
			const height = Math.max(0, Math.floor(viewportHeight));
			if (height === 0) return [];
			if (height === 1) return [fitToWidth(options.theme.bold(TITLE), width)];

			// Keep the heading, global key hints, and contextual guidance fixed. Only the
			// central preview/editor content is virtualized so the frame is never clipped.
			const fixedTop = content.slice(0, 2);
			const fixedBottom = content.slice(-1);
			const interiorRows = height - 2;
			if (interiorRows < fixedTop.length + fixedBottom.length) {
				// There is room for a frame, but not for the complete sticky chrome.
				// Prefer the heading over dropping the outer frame at tiny heights.
				return frame([...fixedTop, ...fixedBottom].slice(0, interiorRows));
			}
			const central = content.slice(2, -1);
			while (central.at(-1)?.line === "") central.pop();
			const centralRows = interiorRows - fixedTop.length - fixedBottom.length;
			const virtualized = virtualize(central, centralRows, scrollOffset, outerInner);
			scrollOffset = virtualized.scrollOffset;
			const centralLines = [...virtualized.lines, ...blankLines(centralRows - virtualized.lines.length)];
			return frame([...fixedTop, ...centralLines, ...fixedBottom].slice(0, interiorRows));
		},
	};
}

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type OverlayHandle, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "./config.js";
import { contextRole } from "./footer.js";
import { type PrefillSnapshot, formatPrefillRows } from "./prefill.js";
import { hasCapturingOverlay } from "./image-compositor.js";
import { formatTokens } from "./metrics.js";
import { type AtelierPalette, createPalette, type PaletteRole, type ThemeLike } from "./palette.js";
import {
	EMPTY_RUN_ACTIVITY,
	formatDuration,
	isCompletionGlowing,
	type RunActivitySnapshot,
	type ToolActivity,
} from "./run-activity.js";
import { isBuiltinSidebarPanelId, type SidebarPanelData } from "./sidebar-panels.js";
import { createSplitPaneController, type SidebarMode, type SidebarStatus } from "./split-pane.js";
import { createInertAtelierState } from "./state.js";
import { type SubagentCostChartGraphics, subagentCostChart } from "./subagent-cost-chart.js";
import { errorMessage, fitToWidth, PLACEHOLDER, sanitizeInline } from "./text.js";
import type {
	AtelierConfig,
	AtelierState,
	BuiltinSidebarPanelId,
	NormalizedTodo,
	SidebarStyle,
	WorkspacePulseState,
} from "./types.js";
import type { ChangedFile } from "./workspace-pulse.js";

export interface SidebarSnapshotInput {
	state: AtelierState;
	sessionName?: string;
	activeToolCount: number;
	availableToolCount: number;
	activeToolNames?: readonly string[];
	runActivity?: RunActivitySnapshot;
	todos?: readonly NormalizedTodo[];
	sidebarPanels?: readonly SidebarPanelData[];
	/** Live prefill progress for the current provider request; absent whenever nothing is prefilling. */
	prefill?: PrefillSnapshot;
}

export interface SidebarSnapshot extends AtelierState {
	sessionName?: string;
	activeToolCount: number;
	availableToolCount: number;
	activeToolNames: readonly string[];
	runActivity: RunActivitySnapshot;
	todos: readonly NormalizedTodo[];
	sidebarPanels: readonly SidebarPanelData[];
	prefill?: PrefillSnapshot;
}

export function buildSidebarSnapshot(input: SidebarSnapshotInput): SidebarSnapshot {
	return {
		...input.state,
		...(input.sessionName ? { sessionName: input.sessionName } : {}),
		activeToolCount: input.activeToolCount,
		availableToolCount: input.availableToolCount,
		activeToolNames: [...new Set((input.activeToolNames ?? []).map(sanitizeInline).filter(Boolean))].sort(
			(a, b) => a.localeCompare(b, "en"),
		),
		runActivity: input.runActivity ?? EMPTY_RUN_ACTIVITY,
		todos: input.todos ?? [],
		sidebarPanels: input.sidebarPanels ?? [],
		...(input.prefill ? { prefill: input.prefill } : {}),
	};
}

const COMPACT_SIDEBAR_MAX_WIDTH = 39;
const LABEL_COLUMN_WIDTH = 12;
/** A lit frame's jewel alternates once per animation tick while the agent works. */
const SIDEBAR_ANIMATION_INTERVAL_MS = 1_000;
/** Running tools listed during a turn; the rest are counted. */
const MAX_ACTIVE_TOOLS = 3;
/** Changed files listed before the rest are counted. */
const MAX_LISTED_FILES = 5;
/** Open todos listed before the rest are counted. */
const MAX_LISTED_TODOS = 8;

/** Text, or the placeholder (painted dim) when there is none. */
function valueRow(value: string | undefined, palette: AtelierPalette, role: PaletteRole): string {
	const text = value === undefined ? "" : sanitizeInline(value);
	return text ? palette.paint(role, text) : palette.paint("dim", PLACEHOLDER);
}

function renderDock(
	rows: string[],
	width: number,
	height: number,
	palette: AtelierPalette,
	resizing: boolean,
): string[] {
	const contentWidth = Math.max(0, width - 2);
	const edge = resizing ? `${palette.paint("warning", "│")} ` : "  ";
	return Array.from({ length: height }, (_, index) =>
		truncateToWidth(`${edge}${fitToWidth(rows[index] ?? "", contentWidth)}`, width, ""),
	);
}

/** Painted text on both ends of one row. The right side stays whole and the left gives way first. */
function splitRow(left: string, right: string, width: number): string {
	if (!right) return truncateToWidth(left, width, "…");
	const rightWidth = visibleWidth(right);
	if (rightWidth + 1 >= width) return truncateToWidth(right, width, "…");
	const fittedLeft = truncateToWidth(left, width - rightWidth - 1, "…");
	return `${fittedLeft}${" ".repeat(width - visibleWidth(fittedLeft) - rightWidth)}${right}`;
}

/** Keep the end of a path, where the file name is, when it is too long for the row. */
function truncateStart(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 1) return "…".slice(0, width);
	const characters = [...text];
	let tail = "";
	for (let index = characters.length - 1; index >= 0; index -= 1) {
		const next = `${characters[index]}${tail}`;
		if (visibleWidth(next) > width - 1) break;
		tail = next;
	}
	return `…${tail}`;
}

/** One fact per row: the label on the left, the value on the right. */
function labeledRow(
	label: string,
	value: string,
	width: number,
	palette: AtelierPalette,
	role: PaletteRole = "primary",
	labelRole: PaletteRole = "muted",
	progress?: { fraction: number; style: SidebarStyle },
): string {
	const left = truncateToWidth(label, Math.min(LABEL_COLUMN_WIDTH, Math.max(0, width - 8)), "…");
	const right = truncateToWidth(value, Math.max(0, width - visibleWidth(left) - 1), "…");
	const meterWidth = width - visibleWidth(left) - visibleWidth(right) - 2;
	if (progress !== undefined && meterWidth >= 4) {
		return `${palette.paint(labelRole, left)} ${progressMeter(progress.fraction * 100, meterWidth, palette, role, progress.style)} ${palette.paint(role, right)}`;
	}
	return truncateToWidth(
		`${palette.paint(labelRole, left)}${" ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)))}${palette.paint(role, right)}`,
		width,
		"",
	);
}

/** Framed panels keep the solid bar in eighth-cell steps; the minimal style draws a thin rule in half cells. */
const METER_GLYPHS: Record<SidebarStyle, { full: string; partial: string; track: string }> = {
	framed: { full: "█", partial: "▏▎▍▌▋▊▉", track: "░" },
	minimal: { full: "━", partial: "╸", track: "─" },
};

function progressMeter(
	percent: number,
	meterWidth: number,
	palette: AtelierPalette,
	role: PaletteRole,
	style: SidebarStyle,
): string {
	const glyphs = METER_GLYPHS[style];
	const steps = glyphs.partial.length + 1;
	const units = Math.min(
		meterWidth * steps,
		Math.max(percent > 0 ? 1 : 0, Math.round((percent * meterWidth * steps) / 100)),
	);
	const full = Math.floor(units / steps);
	const partial = units % steps;
	const fill = glyphs.full.repeat(full) + (partial ? (glyphs.partial[partial - 1] ?? "") : "");
	return `${palette.paint(role, fill)}${palette.paint("dim", glyphs.track.repeat(meterWidth - full - (partial ? 1 : 0)))}`;
}

function runSummary(activity: RunActivitySnapshot, now: number): string {
	if (activity.phase === "idle") return "";
	const elapsed = formatDuration(
		activity.phase === "settled"
			? (activity.durationMs ?? now - (activity.startedAt ?? now))
			: now - (activity.startedAt ?? now),
	);
	if (activity.phase === "settled") return `last run ${elapsed}`;
	return activity.turnNumber === undefined ? elapsed : `Turn ${activity.turnNumber}  ${elapsed}`;
}

/** The one line that says whether the agent is working, ready, or failed. */
function statusRow(
	snapshot: SidebarSnapshot,
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
	now: number,
): string {
	const working = snapshot.activity === "working";
	const failed = snapshot.activity === "error";
	const glyph = working ? "◆" : failed ? "×" : "●";
	const label = working ? "Working" : failed ? "Error" : "Ready";
	const summary = runSummary(snapshot.runActivity, now);
	return splitRow(
		`${palette.paint(snapshot.activity, glyph)} ${theme.bold(palette.paint(snapshot.activity, label))}`,
		summary ? palette.paint("muted", summary) : "",
		width,
	);
}

const TOOL_STATUS = {
	running: { role: "working", glyph: "◐" },
	done: { role: "ready", glyph: "✓" },
	failed: { role: "error", glyph: "✗" },
} as const satisfies Record<ToolActivity["status"], { role: PaletteRole; glyph: string }>;

const MIN_TOOL_SUMMARY_COLUMNS = 6;

/** Shared across rows so summaries line up in one column. */
function toolNameWidth(tools: readonly ToolActivity[], contentWidth: number): number {
	const widest = Math.max(4, ...tools.map((tool) => visibleWidth(tool.name || "tool")));
	return Math.min(widest, 10, Math.max(0, contentWidth));
}

function toolActivityRow(
	tool: ToolActivity,
	contentWidth: number,
	nameWidth: number,
	palette: AtelierPalette,
	now: number,
): string {
	const status = TOOL_STATUS[tool.status];
	const elapsed = tool.durationMs ?? now - tool.startedAt;
	// Successful tools under a second carry no timing worth reading; failures always keep theirs.
	const trailing = tool.status !== "done" || elapsed >= 1_000 ? formatDuration(elapsed) : "";
	const trailingWidth = trailing ? visibleWidth(trailing) + 1 : 0;
	// Glyph and trailing timing are kept whole. On narrow rows the name gives way
	// first, then the summary is dropped rather than shown as a lone ellipsis.
	const available = Math.max(0, contentWidth - trailingWidth - 2);
	let fittedNameWidth = Math.min(
		nameWidth,
		Math.max(Math.min(4, available), available - MIN_TOOL_SUMMARY_COLUMNS - 1),
	);
	let summaryWidth = available - fittedNameWidth - 1;
	if (summaryWidth < 3) {
		fittedNameWidth = Math.min(nameWidth, available);
		summaryWidth = 0;
	}
	const name = palette.paint(
		"muted",
		sanitizeInline(truncateToWidth(tool.name || "tool", fittedNameWidth, "…")),
	);
	const summary = tool.summary
		? palette.paint("primary", sanitizeInline(truncateToWidth(tool.summary, summaryWidth, "…")))
		: palette.paint("dim", PLACEHOLDER);
	const row = [
		palette.paint(status.role, status.glyph),
		fittedNameWidth > 0 ? fitToWidth(name, fittedNameWidth) : "",
		summaryWidth > 0 ? fitToWidth(summary, summaryWidth) : "",
		trailing ? palette.paint(tool.status === "done" ? "muted" : status.role, trailing) : "",
	]
		.filter(Boolean)
		.join(" ");
	return truncateToWidth(row, contentWidth, "");
}

function toolCountRow(activity: RunActivitySnapshot, palette: AtelierPalette): string {
	const total = activity.completedCount + activity.failedCount;
	const tools = `${total} ${total === 1 ? "tool" : "tools"}`;
	return activity.failedCount > 0
		? `${palette.paint("muted", `${tools}, `)}${palette.paint("error", `${activity.failedCount} failed`)}`
		: palette.paint("muted", tools);
}

const TODO_CHECK = {
	completed: { role: "ready", glyph: "✓" },
	in_progress: { role: "warning", glyph: "◐" },
	pending: { role: "dim", glyph: "○" },
} as const satisfies Record<NormalizedTodo["status"], { role: PaletteRole; glyph: string }>;

/** Rows for one panel, and the summary shown beside its title. */
interface SectionContent {
	summary?: string;
	rows: string[];
}

function todoSection(snapshot: SidebarSnapshot, width: number, palette: AtelierPalette): SectionContent {
	const todos = snapshot.todos;
	if (todos.length === 0) return { rows: [] };
	const done = todos.filter((todo) => todo.status === "completed").length;
	// A long list keeps the open work in view; the summary still counts what is done.
	const listed =
		todos.length > MAX_LISTED_TODOS ? todos.filter((todo) => todo.status !== "completed") : todos;
	const shown = listed.slice(0, MAX_LISTED_TODOS);
	const overflow = listed.length - shown.length;
	return {
		summary: palette.paint(done === todos.length ? "ready" : "muted", `${done} of ${todos.length}`),
		rows: [
			...shown.map((todo) => {
				const check = TODO_CHECK[todo.status];
				const text = truncateToWidth(sanitizeInline(todo.text), Math.max(0, width - 2), "…");
				return `${palette.paint(check.role, check.glyph)} ${palette.paint(todo.status === "completed" ? "dim" : "primary", text)}`;
			}),
			...(overflow > 0 ? [palette.paint("muted", `${overflow} more`)] : []),
		],
	};
}

const ERROR_STATUS = /\b(error|failed?|failure|offline|unavailable)\b/i;
const WARNING_STATUS = /\b(warn(?:ing)?|blocked|degraded)\b/i;

/** Extension statuses that need attention, most severe kind first. */
function statusAlerts(snapshot: SidebarSnapshot): { role: "error" | "warning"; text: string }[] {
	return snapshot.extensionStatuses
		.map(sanitizeInline)
		.flatMap((text): { role: "error" | "warning"; text: string }[] => {
			if (ERROR_STATUS.test(text)) return [{ role: "error", text }];
			if (WARNING_STATUS.test(text)) return [{ role: "warning", text }];
			return [];
		});
}

/** Context rests in its own hue in the sidebar; the warning and danger roles stay shared. */
function sidebarContextRole(percent: number | null, config: AtelierConfig): PaletteRole {
	const role = contextRole(percent, config, "dim");
	return role === "context" ? "cache" : role;
}

function contextSection(
	snapshot: SidebarSnapshot,
	config: AtelierConfig,
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
): SectionContent {
	const { metrics } = snapshot;
	if (metrics.contextTokens === null || metrics.contextPercent === null) {
		return { rows: [palette.paint("dim", "Unavailable")] };
	}
	const role = sidebarContextRole(metrics.contextPercent, config);
	const percent = Math.max(0, metrics.contextPercent);
	const percentText = `${percent.toFixed(1)}%`;
	const meterWidth = width - visibleWidth(percentText) - 1;
	const percentage = theme.bold(palette.paint(role, percentText));
	const windowText = metrics.contextWindow > 0 ? formatTokens(metrics.contextWindow) : PLACEHOLDER;
	return {
		summary: palette.paint("muted", `${formatTokens(metrics.contextTokens)} of ${windowText}`),
		rows: [
			meterWidth >= 4
				? `${progressMeter(percent, meterWidth, palette, role, config.sidebarStyle)} ${percentage}`
				: percentage,
		],
	};
}

/** The transient Prefill panel: the same bar Context uses, plus the queued-token rows. */
function prefillRows(
	snapshot: SidebarSnapshot,
	config: AtelierConfig,
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
): string[] {
	const prefill = snapshot.prefill;
	if (!prefill) return [];
	const percentText = config.prefillViews.includes("percent") ? `${Math.round(prefill.percent * 100)}%` : "";
	const percentWidth = percentText ? visibleWidth(percentText) : 0;
	const meterWidth = Math.max(0, width - percentWidth - (percentText ? 1 : 0));
	const meter = progressMeter(prefill.percent * 100, meterWidth, palette, "working", config.sidebarStyle);
	const percentage = theme.bold(palette.paint("working", percentText));
	return [
		percentText && meterWidth > 0 ? `${meter} ${percentage}` : percentText || meter,
		...formatPrefillRows(prefill, config.prefillViews).map((row) =>
			labeledRow(row.label, row.value, width, palette, "primary", "muted"),
		),
	];
}

/** The right-hand +/− columns of a changed-file row, sized once for the whole list. */
interface DiffColumns {
	added: number;
	removed: number;
	width: number;
}

/** A line count with its sign, such as `+12` or `−3`; empty for zero. */
const signedCount = (sign: "+" | "−", count: number | undefined): string =>
	count ? `${sign}${formatTokens(count)}` : "";

function addedText(file: ChangedFile): string {
	if (file.status === "new") return "new";
	if (file.status === "binary") return "binary";
	if (file.status === "conflict" && file.added === undefined) return "conflict";
	return signedCount("+", file.added);
}

function removedText(file: ChangedFile): string {
	if (file.status !== "modified" && file.status !== "conflict") return "";
	return signedCount("−", file.removed);
}

/** Labels such as "binary" span both columns; line counts size them. */
function diffColumns(files: readonly ChangedFile[], totals: { added: number; removed: number }): DiffColumns {
	const counted = files.filter((file) => file.status === "modified" || file.added !== undefined);
	const added = Math.max(
		0,
		...counted.map((file) => visibleWidth(addedText(file))),
		visibleWidth(signedCount("+", totals.added)),
	);
	const removed = Math.max(
		0,
		...counted.map((file) => visibleWidth(removedText(file))),
		visibleWidth(signedCount("−", totals.removed)),
	);
	const labels = files.filter((file) => !counted.includes(file)).map((file) => visibleWidth(addedText(file)));
	const numeric = added + (removed ? removed + 1 : 0);
	return { added, removed, width: Math.max(numeric, ...labels) };
}

function diffCells(
	added: string,
	removed: string,
	columns: DiffColumns,
	palette: AtelierPalette,
	addedRole: PaletteRole,
): string {
	const addedCell = palette.paint(addedRole, added.padStart(columns.added));
	return columns.removed
		? `${addedCell} ${palette.paint("error", removed.padStart(columns.removed))}`
		: addedCell;
}

function changedFileRow(
	file: ChangedFile,
	columns: DiffColumns,
	width: number,
	palette: AtelierPalette,
): string {
	const conflict = file.status === "conflict";
	const right =
		file.status === "modified" || (conflict && file.added !== undefined)
			? diffCells(addedText(file), removedText(file), columns, palette, conflict ? "error" : "chartGreen")
			: palette.paint(
					file.status === "new" ? "chartGreen" : conflict ? "error" : "muted",
					addedText(file).padStart(columns.width),
				);
	const room = Math.max(1, width - visibleWidth(right) - 1);
	const path = truncateStart(sanitizeInline(file.path) || PLACEHOLDER, room);
	return splitRow(palette.paint(conflict ? "error" : "primary", path), right, width);
}

interface ChangedFilesSection {
	summary?: string;
	/** Always shown while the section is: the state, or the most important file. */
	lead: string[];
	/** Further files, most important first. */
	files: string[];
	/** Counts files beyond the list. */
	more: string[];
	stale: string[];
}

function changedFilesSection(
	pulse: WorkspacePulseState,
	width: number,
	palette: AtelierPalette,
): ChangedFilesSection {
	const empty = { files: [], more: [], stale: [] };
	switch (pulse.status) {
		case "inspecting":
			return { ...empty, lead: [palette.paint("dim", "Checking…")] };
		case "not-repo":
			return { ...empty, lead: [palette.paint("dim", "Not a Git repository")] };
		case "unavailable":
			return { ...empty, lead: [palette.paint("warning", "Git unavailable")] };
	}
	const git = pulse.data.snapshot;
	const stale = pulse.status === "stale" ? [palette.paint("dim", "May be out of date")] : [];
	const changedCount = git.trackedFiles - git.submodules + git.untrackedFiles;
	if (pulse.status === "clean" || changedCount <= 0) {
		return { ...empty, stale, lead: [palette.paint("dim", "No changes")] };
	}
	const files = git.files ?? [];
	const totals = { added: git.linesAdded, removed: git.linesRemoved };
	const shown = files.slice(0, MAX_LISTED_FILES);
	const columns = diffColumns(shown, totals);
	const summary =
		totals.added || totals.removed
			? diffCells(
					signedCount("+", totals.added),
					signedCount("−", totals.removed),
					columns,
					palette,
					"chartGreen",
				)
			: undefined;
	const rows = shown.map((file) => changedFileRow(file, columns, width, palette));
	const remaining = changedCount - shown.length;
	const more =
		remaining > 0
			? [palette.paint("muted", rows.length > 0 ? `${remaining} more` : `${remaining} changed files`)]
			: [];
	return {
		...(summary ? { summary } : {}),
		lead: rows.slice(0, 1),
		files: rows.slice(1),
		more,
		stale,
	};
}

/** Usage counts keep one decimal (and reach billions) where the rail rounds harder. */
function formatUsageTokens(count: number): string {
	if (count < 1_000) return Math.trunc(count).toString();
	if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${(count / 1_000_000_000).toFixed(1)}B`;
}

function agentRows(
	snapshot: SidebarSnapshot,
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
): string[] {
	const knownModel = Boolean(snapshot.modelId || snapshot.provider);
	const value = (text: string | undefined) => (text ? sanitizeInline(text) || PLACEHOLDER : PLACEHOLDER);
	return [
		splitRow(
			palette.paint("muted", "Model"),
			theme.bold(valueRow(snapshot.modelId, palette, "primary")),
			width,
		),
		labeledRow("Provider", value(snapshot.provider), width, palette, snapshot.provider ? "primary" : "dim"),
		labeledRow(
			"Thinking",
			value(snapshot.thinkingLevel),
			width,
			palette,
			snapshot.thinkingLevel ? "primary" : "dim",
		),
		labeledRow(
			"Billing",
			knownModel ? (snapshot.metrics.subscription ? "Subscription" : "Metered") : PLACEHOLDER,
			width,
			palette,
			knownModel ? "primary" : "dim",
		),
		...(snapshot.sessionName
			? [labeledRow("Session", sanitizeInline(snapshot.sessionName), width, palette)]
			: []),
	];
}

function usageRows(
	snapshot: SidebarSnapshot,
	config: AtelierConfig,
	width: number,
	palette: AtelierPalette,
): string[] {
	const { metrics } = snapshot;
	const rows: string[] = [];
	if (metrics.usageAvailable) {
		const hit = metrics.cacheHitPercent === undefined ? undefined : `${metrics.cacheHitPercent.toFixed(1)}%`;
		rows.push(
			labeledRow("Input", formatUsageTokens(metrics.input), width, palette),
			labeledRow("Output", formatUsageTokens(metrics.output), width, palette),
			labeledRow("Cache read", formatUsageTokens(metrics.cacheRead), width, palette),
			labeledRow("Cache hit", hit ?? PLACEHOLDER, width, palette, hit ? "primary" : "dim"),
		);
	}
	if (metrics.costAvailable) {
		rows.push(
			labeledRow("Cost", `$${Math.max(0, metrics.cost).toFixed(config.currencyDecimals)}`, width, palette),
		);
	}
	return rows;
}

function subagentRows(
	snapshot: SidebarSnapshot,
	config: AtelierConfig,
	width: number,
	palette: AtelierPalette,
	chartGraphics: SubagentCostChartGraphics,
): string[] {
	const usage = snapshot.subagentUsage;
	if (!usage || (!usage.runs.length && !usage.unavailable && !usage.pending && !usage.limited)) return [];
	return [
		...subagentCostChart(usage, width, config.currencyDecimals, config.nerdFont, palette, chartGraphics),
		...(usage.pending ? [palette.paint("dim", "Running · curves update on reply")] : []),
		...(usage.unavailable || usage.limited
			? [palette.paint("warning", "Partial · metadata unavailable")]
			: []),
		palette.paint("dim", "/atelier usage · expand graph"),
	];
}

function activeToolNameRows(
	snapshot: SidebarSnapshot,
	contentWidth: number,
	palette: AtelierPalette,
): string[] {
	const names = snapshot.activeToolNames.map((name) => palette.paint("primary", name));
	let leftColumnWidth = 0;
	let rightColumnWidth = 0;
	for (const [index, name] of names.entries()) {
		if (index % 2 === 0) leftColumnWidth = Math.max(leftColumnWidth, visibleWidth(name));
		else rightColumnWidth = Math.max(rightColumnWidth, visibleWidth(name));
	}
	const columnGap = "  ";
	if (leftColumnWidth + visibleWidth(columnGap) + rightColumnWidth > contentWidth) return names;

	const rows: string[] = [];
	for (let index = 0; index < names.length; index += 2) {
		const left = names[index] ?? "";
		const right = names[index + 1];
		rows.push(right === undefined ? left : `${fitToWidth(left, leftColumnWidth)}${columnGap}${right}`);
	}
	return rows;
}

/**
 * Lower ranks give way first when the sidebar is short. Required groups use
 * Infinity and are only cut by the dock once every optional group is gone.
 */
const DROP_RANK = {
	toolName: 0,
	moreFiles: 3,
	listedFile: 5,
	staleFiles: 6,
	toolsStatus: 10,
	subagents: 18,
	usage: 20,
	contributed: 25,
	agent: 28,
	workspace: 30,
	olderRecentTool: 50,
	aggregate: 60,
	latestRecentTool: 70,
	activeTool: 75,
	alerts: 80,
	todos: 90,
	/** Transient section with a row cap: it outranks every optional section, so a short terminal
	 * loses Changed files or Todos before it loses the one thing the user is waiting for. */
	prefill: 100,
	required: Number.POSITIVE_INFINITY,
} as const;

/** One Sidebar panel: framed with a crown and bottom border, or a heading in the minimal style. */
interface Section {
	id: string;
	title: string;
	/** Painted text on the right of the crown. */
	summary?: string;
	/** The state that lights this frame; frames without one stay a neutral grey. */
	lit?: PaletteRole;
}

interface SidebarGroup {
	name: string;
	/** Section shared by adjacent groups with the same section ID. */
	section?: Section;
	rows: string[];
	dropRank: number;
	/** Shown only once one of these groups has been dropped; a summary of rows still visible adds nothing. */
	summarizes?: readonly string[];
}

function activityGroups(
	snapshot: SidebarSnapshot,
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
	now: number,
): SidebarGroup[] {
	const lit: PaletteRole | undefined =
		snapshot.activity !== "ready"
			? snapshot.activity
			: isCompletionGlowing(snapshot.runActivity, now)
				? "success"
				: undefined;
	const section: Section = { id: "activity", title: "Activity", ...(lit ? { lit } : {}) };
	const activity = snapshot.runActivity;
	const liveTurn = activity.phase === "running";
	const activeIds = new Set(activity.activeTools.map((tool) => tool.id));
	const sortedActive = activity.activeTools
		.map((tool, index) => ({ index, tool }))
		.sort((left, right) => left.tool.startedAt - right.tool.startedAt || left.index - right.index)
		.map(({ tool }) => tool);
	// The newest running tools stay in view; older ones are counted.
	const visibleActive = liveTurn ? sortedActive.slice(-MAX_ACTIVE_TOOLS) : sortedActive;
	const hiddenActive = sortedActive.length - visibleActive.length;
	const recent = liveTurn ? [] : activity.recentTools.filter((tool) => !activeIds.has(tool.id)).slice(0, 3);
	const nameWidth = toolNameWidth([...visibleActive, ...recent], width);
	const toolCount = activity.completedCount + activity.failedCount;
	const aggregate = liveTurn
		? hiddenActive > 0
			? [palette.paint("muted", `${hiddenActive} more running`)]
			: []
		: toolCount === 0
			? []
			: [toolCountRow(activity, palette)];
	// When every counted tool has its own row, the count only matters once a row is dropped for height.
	const summarizes =
		liveTurn || toolCount > recent.length ? undefined : recent.map((tool) => `activityRecent:${tool.id}`);
	return [
		{
			name: "activityStatus",
			section,
			rows: [statusRow(snapshot, width, palette, theme, now)],
			dropRank: DROP_RANK.required,
		},
		...visibleActive.map((tool, index) => ({
			name: `activityActive:${tool.id}`,
			section,
			rows: [toolActivityRow(tool, width, nameWidth, palette, now)],
			dropRank: DROP_RANK.activeTool + (index + 1) / 100,
		})),
		...recent.map((tool, index) => ({
			name: `activityRecent:${tool.id}`,
			section,
			rows: [toolActivityRow(tool, width, nameWidth, palette, now)],
			dropRank:
				index === 0 ? DROP_RANK.latestRecentTool : DROP_RANK.olderRecentTool + (recent.length - index - 1),
		})),
		{
			name: "activityAggregate",
			section,
			rows: aggregate,
			dropRank: DROP_RANK.aggregate,
			...(summarizes ? { summarizes } : {}),
		},
	];
}

/** Rows each panel adds around its content: crown, bottom border, and spacer; or heading and spacer. */
const CHROME_ROWS: Record<SidebarStyle, number> = { framed: 3, minimal: 2 };

/** Content rows do not wrap; each panel adds its style's chrome rows. */
function measureGroups(groups: readonly SidebarGroup[], style: SidebarStyle): number {
	let height = 0;
	let previous: SidebarGroup | undefined;
	for (const group of groups) {
		height += group.rows.length;
		if (group.section && group.section.id !== previous?.section?.id) height += CHROME_ROWS[style];
		previous = group;
	}
	return height;
}

const CROWN_PREFIX_WIDTH = visibleWidth("╭─ ✦ ");

/** Whether a summary fits beside the title: on the crown with one rule column, or on a heading row. */
function summaryFits(section: Section, width: number, style: SidebarStyle): boolean {
	if (!section.summary) return true;
	const title = visibleWidth(section.title);
	const summary = visibleWidth(section.summary);
	return style === "framed"
		? width - CROWN_PREFIX_WIDTH - title - 1 - summary - 3 >= 1
		: title + 2 + summary <= width;
}

/**
 * A summary too wide for its crown becomes the panel's first row, right-aligned,
 * so a narrow sidebar keeps the value. Runs before height is measured.
 */
function placeSummaries(
	groups: readonly SidebarGroup[],
	headingWidth: number,
	innerWidth: number,
	style: SidebarStyle,
): SidebarGroup[] {
	const moved = new Map<string, Section>();
	const seen = new Set<string>();
	return groups.map((group) => {
		const section = group.section;
		if (!section) return group;
		if (!seen.has(section.id)) {
			seen.add(section.id);
			if (!summaryFits(section, headingWidth, style)) {
				const { summary, ...rest } = section;
				moved.set(section.id, rest);
				return { ...group, section: rest, rows: [splitRow("", summary ?? "", innerWidth), ...group.rows] };
			}
		}
		const replacement = moved.get(section.id);
		return replacement ? { ...group, section: replacement } : group;
	});
}

function withoutRedundantSummaries(groups: readonly SidebarGroup[]): SidebarGroup[] {
	const names = new Set(groups.map((group) => group.name));
	return groups.filter((group) => !group.summarizes || group.summarizes.some((name) => !names.has(name)));
}

function composeGroups(groups: readonly SidebarGroup[], height: number, style: SidebarStyle): SidebarGroup[] {
	const available = groups.filter((group) => group.rows.length > 0);
	const kept = new Set(available.map((group) => group.name));
	const fits = () =>
		measureGroups(withoutRedundantSummaries(available.filter((group) => kept.has(group.name))), style) <=
		height;
	// Drop the lowest-ranked group until the rest fit, recounting so newly adjacent groups share a panel.
	const dropped: SidebarGroup[] = [];
	while (!fits()) {
		let drop: SidebarGroup | undefined;
		for (const group of withoutRedundantSummaries(
			available.filter((candidate) => kept.has(candidate.name)),
		)) {
			if (group.dropRank < (drop?.dropRank ?? DROP_RANK.required)) drop = group;
		}
		// Only required rows remain; the dock clips whatever still does not fit.
		if (!drop) break;
		kept.delete(drop.name);
		dropped.push(drop);
	}
	// A tall group dropped late can free room for smaller ones dropped before it; take them back, best first.
	for (const group of dropped.reverse()) {
		kept.add(group.name);
		if (!fits()) kept.delete(group.name);
	}
	return withoutRedundantSummaries(available.filter((group) => kept.has(group.name)));
}

/** Paint a frame piece: neutral grey at rest, the state's own color when lit. */
function paintFrame(section: Section, palette: AtelierPalette, text: string): string {
	return section.lit ? palette.paint(section.lit, text) : palette.paintTint("muted", text, 0);
}

function panelRows(
	section: Section,
	rows: readonly string[],
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
	jewel: string,
): string[] {
	const safeWidth = Math.max(4, width);
	const innerWidth = safeWidth - 4;
	const title = theme.bold(palette.paint("primary", section.title.toUpperCase()));
	const tail = section.summary
		? ` ${section.summary}${paintFrame(section, palette, " ╮")}`
		: paintFrame(section, palette, "╮");
	const fill = Math.max(
		0,
		safeWidth - CROWN_PREFIX_WIDTH - visibleWidth(section.title) - 1 - visibleWidth(tail),
	);
	const jewelRole: PaletteRole = section.lit ?? "muted";
	const crown = `${paintFrame(section, palette, "╭─ ")}${palette.paint(jewelRole, jewel)} ${title} ${paintFrame(section, palette, "─".repeat(fill))}${tail}`;
	const edge = paintFrame(section, palette, "│");
	return [
		truncateToWidth(crown, safeWidth, ""),
		...rows.map((row) => `${edge} ${fitToWidth(row, innerWidth)} ${edge}`),
		paintFrame(section, palette, `╰${"─".repeat(safeWidth - 2)}╯`),
		"",
	];
}

/** The frameless style: a heading that takes the state color when lit, rows, and a spacer. */
function headingRows(
	section: Section,
	rows: readonly string[],
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
): string[] {
	const title = theme.bold(palette.paint(section.lit ?? "primary", section.title));
	return [splitRow(title, section.summary ?? "", width), ...rows, ""];
}

function renderGroups(
	groups: readonly SidebarGroup[],
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
	now: number,
	style: SidebarStyle,
): string[] {
	const rendered: string[] = [];
	const pulse = Math.floor(now / SIDEBAR_ANIMATION_INTERVAL_MS) % 2 === 1;
	let index = 0;
	while (index < groups.length) {
		const group = groups[index];
		if (!group?.section) {
			rendered.push(...(group?.rows ?? []));
			index += 1;
			continue;
		}
		const section = group.section;
		const rows: string[] = [];
		while (groups[index]?.section?.id === section.id) {
			rows.push(...(groups[index]?.rows ?? []));
			index += 1;
		}
		rendered.push(
			...(style === "framed"
				? panelRows(section, rows, width, palette, theme, section.lit === "working" && pulse ? "✧" : "✦")
				: headingRows(section, rows, width, palette, theme)),
		);
	}
	return rendered;
}

export interface SidebarRenderOptions {
	colorEnabled?: boolean;
	now?: number;
	resizing?: boolean;
	chartGraphics?: SubagentCostChartGraphics;
}

export function renderSidebarLines(
	snapshot: SidebarSnapshot,
	config: AtelierConfig,
	theme: ThemeLike,
	width: number,
	height: number,
	{ colorEnabled = true, now = Date.now(), resizing = false, chartGraphics = {} }: SidebarRenderOptions = {},
): string[] {
	const palette = createPalette(theme, colorEnabled);
	const safeWidth = Math.max(0, Math.trunc(width));
	const safeHeight = Math.max(0, Math.trunc(height));
	if (safeWidth <= 0 || safeHeight <= 0) return [];
	const style = config.sidebarStyle;
	const panelWidth = Math.max(0, safeWidth - 2);
	// Framed rows sit inside two border columns with a space of padding on each side;
	// frameless rows keep one column of margin from the terminal edge.
	const contentWidth = Math.max(0, panelWidth - (style === "framed" ? 4 : 1));
	// A frame's crown spans the whole panel; a minimal heading spans the content.
	const headingWidth = style === "framed" ? panelWidth : contentWidth;
	const alerts = statusAlerts(snapshot);
	const builtinPanels: Record<BuiltinSidebarPanelId, () => SidebarGroup[]> = {
		agent: () => [
			{
				name: "agent",
				section: { id: "agent", title: "Agent" },
				rows: agentRows(snapshot, contentWidth, palette, theme),
				dropRank: DROP_RANK.agent,
			},
		],
		activity: () => activityGroups(snapshot, contentWidth, palette, theme, now),
		alerts: () => [
			{
				name: "alerts",
				section: {
					id: "alerts",
					title: "Alerts",
					lit: alerts.some((alert) => alert.role === "error") ? "error" : "warning",
				},
				rows: alerts.map(({ role, text }) =>
					palette.paint(role, truncateToWidth(`${role === "error" ? "✕" : "▲"} ${text}`, contentWidth, "…")),
				),
				dropRank: DROP_RANK.alerts,
			},
		],
		todos: () => {
			const { summary, rows } = todoSection(snapshot, contentWidth, palette);
			return [
				{
					name: "todos",
					section: { id: "todos", title: "Todos", ...(summary ? { summary } : {}) },
					rows,
					dropRank: DROP_RANK.todos,
				},
			];
		},
		context: () => {
			const { summary, rows } = contextSection(snapshot, config, contentWidth, palette, theme);
			// The frame lights only past the configured warning and danger thresholds.
			const role = sidebarContextRole(snapshot.metrics.contextPercent, config);
			const lit = role === "warning" || role === "error" ? role : undefined;
			return [
				{
					name: "context",
					section: {
						id: "context",
						title: "Context",
						...(summary ? { summary } : {}),
						...(lit ? { lit } : {}),
					},
					rows,
					dropRank: DROP_RANK.required,
				},
			];
		},
		prefill: () => [
			{
				name: "prefill",
				section: { id: "prefill", title: "Prefill", lit: "working" },
				rows: prefillRows(snapshot, config, contentWidth, palette, theme),
				// Transient, but the last optional group to go while it is shown.
				dropRank: DROP_RANK.prefill,
			},
		],
		workspace: () => {
			const files = changedFilesSection(snapshot.workspacePulse, contentWidth, palette);
			const section: Section = {
				id: "workspace",
				title: "Changed files",
				...("data" in snapshot.workspacePulse && snapshot.workspacePulse.data.snapshot.conflicts > 0
					? { lit: "error" as const }
					: {}),
				...(files.summary ? { summary: files.summary } : {}),
			};
			return [
				{ name: "changedFilesLead", section, rows: files.lead, dropRank: DROP_RANK.workspace },
				...files.files.map((row, index) => ({
					name: `changedFile:${index}`,
					section,
					rows: [row],
					dropRank: DROP_RANK.listedFile + (files.files.length - index) / 100,
				})),
				{ name: "changedFilesMore", section, rows: files.more, dropRank: DROP_RANK.moreFiles },
				{ name: "changedFilesStale", section, rows: files.stale, dropRank: DROP_RANK.staleFiles },
			];
		},
		usage: () => [
			{
				name: "usage",
				section: { id: "usage", title: "Usage" },
				rows: usageRows(snapshot, config, contentWidth, palette),
				dropRank: DROP_RANK.usage,
			},
		],
		subagents: () => [
			{
				name: "subagentCostChart",
				section: { id: "subagents", title: "Subagents" },
				rows: subagentRows(snapshot, config, contentWidth, palette, chartGraphics),
				dropRank: DROP_RANK.subagents,
			},
		],
		tools: () => {
			const showToolNames = config.showSidebarToolNames && safeWidth > COMPACT_SIDEBAR_MAX_WIDTH;
			const nameRows = showToolNames ? activeToolNameRows(snapshot, contentWidth, palette) : [];
			const count = `${snapshot.activeToolCount} of ${snapshot.availableToolCount}`;
			// Above a list of names the count sits beside the heading; on its own it is a labeled row.
			const section: Section = {
				id: "tools",
				title: "Tools",
				...(nameRows.length > 0 ? { summary: palette.paint("muted", count) } : {}),
			};
			return [
				{
					name: "toolsStatus",
					section,
					rows: nameRows.length > 0 ? [] : [labeledRow("Enabled", count, contentWidth, palette)],
					dropRank: DROP_RANK.toolsStatus,
				},
				...nameRows.map((row, index) => ({
					name: `activeToolNames:${index}`,
					section,
					rows: [row],
					dropRank: DROP_RANK.toolName + (nameRows.length - index) / 100,
				})),
			];
		},
	};

	// The user-owned layout is the only source of top-to-bottom order, and only
	// visible panels are built. Saved contributed panels without a current
	// registration stay in the layout, so Settings can still list them as unavailable.
	const contributed = new Map(snapshot.sidebarPanels.map((panel) => [panel.id, panel]));
	const ordered: SidebarGroup[] = resizing
		? [
				{
					name: "resize",
					rows: [palette.paint("warning", "RESIZE · drag divider"), ""],
					dropRank: DROP_RANK.required,
				},
			]
		: [];
	let availableVisible = false;
	for (const entry of config.sidebarPanelLayout) {
		if (!entry.visible) continue;
		if (isBuiltinSidebarPanelId(entry.id)) {
			availableVisible = true;
			ordered.push(...builtinPanels[entry.id]());
			continue;
		}
		const panel = contributed.get(entry.id);
		if (!panel) continue;
		availableVisible = true;
		const rows = panel.keyValues?.length
			? panel.keyValues.map((row) =>
					labeledRow(
						row.label,
						row.value,
						contentWidth,
						palette,
						row.valueRole ?? panel.role ?? "primary",
						row.labelRole ?? "muted",
						row.progress === undefined ? undefined : { fraction: row.progress, style },
					),
				)
			: panel.rows
					.filter((row) => row.text)
					.map((row) => palette.paint(row.role ?? panel.role ?? "primary", row.text));
		ordered.push({
			name: `contributed:${panel.id}`,
			section: { id: panel.id, title: panel.title || panel.id },
			rows: rows.length > 0 ? rows : [palette.paint("dim", "No data")],
			dropRank: DROP_RANK.contributed,
		});
	}
	if (!availableVisible) {
		ordered.push({
			name: "empty",
			section: { id: "__empty__", title: "Sidebar" },
			rows: ["No available panels", "Open /atelier Settings"],
			dropRank: DROP_RANK.required,
		});
	}
	return renderDock(
		renderGroups(
			composeGroups(placeSummaries(ordered, headingWidth, contentWidth, style), safeHeight, style),
			headingWidth,
			palette,
			theme,
			now,
			style,
		),
		safeWidth,
		safeHeight,
		palette,
		resizing,
	);
}

export interface SidebarComponentOptions {
	getSnapshot(): SidebarSnapshot;
	getConfig(): AtelierConfig;
	getHeight(): number;
	isResizing?(): boolean;
	canRenderImages?(): boolean;
	theme: ThemeLike;
	colorEnabled?: boolean;
}

function renderSidebarError(error: unknown, width: number, height: number, resizing: boolean): string[] {
	let detail = "Unknown error";
	try {
		detail = sanitizeInline(errorMessage(error)) || detail;
	} catch {
		// Keep the fallback render path safe even for unusual thrown values.
	}
	const safeWidth = Math.max(0, Math.trunc(width));
	const safeHeight = Math.max(0, Math.trunc(height));
	if (safeWidth <= 0 || safeHeight <= 0) return [];
	const plain: AtelierPalette = {
		colorEnabled: false,
		tinted: false,
		paint: (_role, text) => text,
		paintTint: (_role, text) => text,
	};
	return renderDock(["Sidebar unavailable", detail], safeWidth, safeHeight, plain, resizing);
}

export function createSidebarComponent(options: SidebarComponentOptions): Component {
	const imageOwner = {};
	return {
		render(width) {
			const height = options.getHeight();
			let resizing = false;
			try {
				resizing = options.isResizing?.() ?? false;
				return renderSidebarLines(options.getSnapshot(), options.getConfig(), options.theme, width, height, {
					colorEnabled: options.colorEnabled ?? true,
					resizing,
					chartGraphics: {
						imageOwner: options.canRenderImages ? imageOwner : undefined,
						suspendPlot: options.canRenderImages?.() === false,
					},
				});
			} catch (error) {
				return renderSidebarError(error, width, height, resizing);
			}
		},
		invalidate() {},
	};
}

export interface SidebarController {
	show(): void;
	setMode(mode: SidebarMode): void;
	getStatus(): SidebarStatus;
	hide(): void;
	toggle(): void;
	isVisible(): boolean;
	beginResize(): boolean;
	isResizing(): boolean;
	requestRender(): void;
	dispose(): void;
}

export interface SidebarControllerOptions {
	ctx: ExtensionContext;
	getSnapshot(): SidebarSnapshot;
	getConfig(): AtelierConfig;
	colorEnabled?: boolean;
	shouldAnimate?(): boolean;
	/** Preferred sidebar width when the session starts. */
	initialWidth?: number;
	/** A confirmed resize changed the preferred width. */
	onResizeCommit?(width: number): void;
	onWarning?(message: string): void;
	onError?(error: unknown): void;
}

/** Reads live data until detached, then serves the last plain copy to a stale overlay. */
function createRetirableSidebarBinding(options: SidebarControllerOptions): {
	getSnapshot(): SidebarSnapshot;
	getConfig(): AtelierConfig;
	detach(): void;
} {
	let readSnapshot: (() => SidebarSnapshot) | undefined = options.getSnapshot;
	let readConfig: (() => AtelierConfig) | undefined = options.getConfig;
	let snapshot = buildSidebarSnapshot({
		state: createInertAtelierState(null),
		activeToolCount: 0,
		availableToolCount: 0,
	});
	let config = structuredClone(DEFAULT_CONFIG);
	return {
		getSnapshot: () => (readSnapshot ? readSnapshot() : snapshot),
		getConfig: () => (readConfig ? readConfig() : config),
		detach: () => {
			if (readSnapshot) {
				try {
					snapshot = structuredClone(readSnapshot());
				} catch {
					// The inert snapshot is already detached from the retired runtime.
				}
			}
			if (readConfig) {
				try {
					config = structuredClone(readConfig());
				} catch {
					// Keep the last plain configuration snapshot.
				}
			}
			readSnapshot = undefined;
			readConfig = undefined;
		},
	};
}

export function createSidebarController(options: SidebarControllerOptions): SidebarController {
	const binding = createRetirableSidebarBinding(options);
	let enabled = false;
	let disposed = false;
	let generation = 0;
	let closeOverlay: (() => void) | undefined;
	let restoreStoppedCursor: (() => void) | undefined;
	let requestOverlayRender: (() => void) | undefined;
	let overlayHandle: OverlayHandle | undefined;
	let animationTimer: ReturnType<typeof setInterval> | undefined;

	const reportError = (error: unknown) => {
		try {
			options.onError?.(error);
		} catch {
			// External error reporting must not interrupt lifecycle cleanup.
		}
	};

	const safely = (action: () => unknown): boolean => {
		try {
			action();
			return true;
		} catch (error) {
			reportError(error);
			return false;
		}
	};

	const split = createSplitPaneController({
		...(options.initialWidth === undefined ? {} : { initialWidth: options.initialWidth }),
		subscribeInput: (handler) => options.ctx.ui.onTerminalInput(handler),
		onVisibilityChange: () => syncAnimation(),
		onResizeChange: () => {
			safely(() => requestOverlayRender?.());
		},
		...(options.onResizeCommit ? { onResizeCommit: options.onResizeCommit } : {}),
		...(options.onWarning ? { onWarning: options.onWarning } : {}),
		...(options.onError ? { onError: options.onError } : {}),
	});

	const stopAnimation = () => {
		if (!animationTimer) return;
		clearInterval(animationTimer);
		animationTimer = undefined;
	};

	const syncAnimation = () => {
		if (
			!enabled ||
			split.getStatus().presentation !== "shown" ||
			!options.shouldAnimate?.() ||
			!requestOverlayRender
		) {
			stopAnimation();
			return;
		}
		if (animationTimer) return;
		animationTimer = setInterval(() => {
			safely(() => requestOverlayRender?.());
			// Animation can end without an event, such as when a completion glow fades.
			syncAnimation();
		}, SIDEBAR_ANIMATION_INTERVAL_MS);
		animationTimer.unref();
	};

	const clearOverlayCallbacks = () => {
		closeOverlay = undefined;
		restoreStoppedCursor = undefined;
		requestOverlayRender = undefined;
		overlayHandle = undefined;
	};

	/** Abandon a show attempt that failed or was superseded. */
	const abandonShow = () => {
		enabled = false;
		stopAnimation();
		clearOverlayCallbacks();
		safely(split.hide);
	};

	const hide = () => {
		if (!enabled && !closeOverlay && !overlayHandle && !split.isEnabled()) return;
		enabled = false;
		generation += 1;
		stopAnimation();
		safely(split.cancelResize);
		const close = closeOverlay;
		const handle = overlayHandle;
		const restoreCursor = restoreStoppedCursor;
		clearOverlayCallbacks();
		if (close) safely(close);
		else if (handle) safely(() => handle.hide());
		safely(split.hide);
		if (restoreCursor) safely(restoreCursor);
	};

	const show = () => {
		if (disposed || enabled) return;
		if (options.ctx.mode !== "tui") {
			reportError(new Error("Pi Atelier sidebar requires TUI mode"));
			return;
		}

		enabled = true;
		const currentGeneration = ++generation;
		if (!safely(split.show)) {
			abandonShow();
			return;
		}
		try {
			const pending = options.ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					let closed = false;
					const close = () => {
						if (closed) return;
						closed = true;
						done(undefined);
					};
					if (!safely(() => split.attach(tui))) {
						generation += 1;
						abandonShow();
						safely(close);
					} else if (!enabled || generation !== currentGeneration) {
						close();
					} else {
						closeOverlay = close;
						restoreStoppedCursor = () => {
							// Pi can close overlays after stop() restored the terminal (#72).
							// The internal flag is optional; never change the cursor of a live TUI.
							if ((tui as { stopped?: boolean }).stopped) tui.terminal.showCursor();
						};
						requestOverlayRender = () => tui.requestRender();
						syncAnimation();
					}
					return createSidebarComponent({
						getSnapshot: binding.getSnapshot,
						getConfig: binding.getConfig,
						getHeight: () => tui.terminal.rows,
						isResizing: split.isResizing,
						canRenderImages: () => !hasCapturingOverlay(tui),
						theme,
						...(options.colorEnabled === undefined ? {} : { colorEnabled: options.colorEnabled }),
					});
				},
				{
					overlay: true,
					overlayOptions: () => split.overlayOptions(),
					onHandle: (handle) => {
						if (enabled && generation === currentGeneration) {
							overlayHandle = handle;
							syncAnimation();
						} else {
							safely(() => handle.hide());
						}
					},
				},
			);
			void pending
				.catch((error: unknown) => {
					reportError(error);
				})
				.finally(() => {
					if (generation === currentGeneration) abandonShow();
				});
		} catch (error) {
			if (generation === currentGeneration) abandonShow();
			reportError(error);
		}
	};

	return {
		show: () => show(),
		hide,
		setMode(mode) {
			safely(() => split.setMode(mode));
			syncAnimation();
		},
		getStatus: split.getStatus,
		toggle() {
			if (enabled) hide();
			else show();
		},
		isVisible() {
			return enabled && split.getStatus().presentation === "shown";
		},
		beginResize: split.beginResize,
		isResizing: split.isResizing,
		requestRender() {
			// Still refresh the overlay if adapter reconciliation fails.
			if (!safely(split.requestRender)) safely(() => requestOverlayRender?.());
			syncAnimation();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			hide();
			binding.detach();
			safely(split.dispose);
		},
	};
}

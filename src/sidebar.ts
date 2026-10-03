import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type OverlayHandle, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "./config.js";
import { displayHomePath } from "./display-path.js";
import { contextRole } from "./footer.js";
import { hasCapturingOverlay } from "./image-compositor.js";
import { formatTokens } from "./metrics.js";
import { type AtelierPalette, createPalette, type PaletteRole, type ThemeLike } from "./palette.js";
import {
	EMPTY_RUN_ACTIVITY,
	formatDuration,
	responsePerformanceValues,
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
	WorkspacePulseState,
} from "./types.js";
import type { WorkspacePulseData } from "./workspace-pulse.js";

export interface SidebarSnapshotInput {
	state: AtelierState;
	cwd: string;
	sessionName?: string;
	sessionFile?: string;
	branchEntryCount: number;
	activeToolCount: number;
	availableToolCount: number;
	activeToolNames?: readonly string[];
	runActivity?: RunActivitySnapshot;
	todos?: readonly NormalizedTodo[];
	sidebarPanels?: readonly SidebarPanelData[];
}

export interface SidebarSnapshot extends AtelierState {
	projectName: string;
	cwd: string;
	sessionName?: string;
	persisted: boolean;
	branchEntryCount: number;
	activeToolCount: number;
	availableToolCount: number;
	activeToolNames: readonly string[];
	runActivity: RunActivitySnapshot;
	todos: readonly NormalizedTodo[];
	sidebarPanels: readonly SidebarPanelData[];
}

function workspacePulseData(pulse: WorkspacePulseState): WorkspacePulseData | undefined {
	return "data" in pulse ? pulse.data : undefined;
}

export function buildSidebarSnapshot(input: SidebarSnapshotInput): SidebarSnapshot {
	const pulseData = workspacePulseData(input.state.workspacePulse);
	const projectName = basename(pulseData?.root ?? input.cwd) || pulseData?.root || input.cwd;
	return {
		...input.state,
		projectName,
		cwd: input.cwd,
		...(input.sessionName ? { sessionName: input.sessionName } : {}),
		persisted: Boolean(input.sessionFile),
		branchEntryCount: input.branchEntryCount,
		activeToolCount: input.activeToolCount,
		availableToolCount: input.availableToolCount,
		activeToolNames: [...new Set((input.activeToolNames ?? []).map(sanitizeInline).filter(Boolean))].sort(
			(a, b) => a.localeCompare(b, "en"),
		),
		runActivity: input.runActivity ?? EMPTY_RUN_ACTIVITY,
		todos: input.todos ?? [],
		sidebarPanels: input.sidebarPanels ?? [],
	};
}

const COMPACT_SIDEBAR_MAX_WIDTH = 39;
const LABEL_COLUMN_WIDTH = 12;
/** The AGENT jewel alternates once per animation tick while the agent works. */
const SIDEBAR_ANIMATION_INTERVAL_MS = 1_000;

type Jewel = "✦" | "✧";

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

function panelRows(
	title: string,
	rows: readonly string[],
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
	role: PaletteRole,
	jewel: Jewel,
): string[] {
	const safeWidth = Math.max(4, width);
	const innerWidth = safeWidth - 4;
	const crownPrefix = `╭─ ${jewel} `;
	const crownFill = "─".repeat(Math.max(0, safeWidth - visibleWidth(crownPrefix) - visibleWidth(title) - 2));
	const top = `${palette.paint(role, crownPrefix)}${theme.bold(palette.paint(role, title))} ${palette.paint(
		role,
		`${crownFill}╮`,
	)}`;
	// The frame carries a quiet shade of the crown's hue so each panel reads as one object.
	const edge = palette.paintTint(role, "│");
	const body = rows.map((row) => `${edge} ${fitToWidth(row, innerWidth)} ${edge}`);
	return [top, ...body, palette.paintTint(role, `╰${"─".repeat(safeWidth - 2)}╯`), ""];
}

/** Align names and values consistently across all built-in panels. */
function labeledRow(
	label: string,
	value: string,
	width: number,
	palette: AtelierPalette,
	role: PaletteRole = "primary",
	labelRole: PaletteRole = "muted",
): string {
	const left = truncateToWidth(label, Math.min(LABEL_COLUMN_WIDTH, Math.max(0, width - 8)), "…");
	const right = truncateToWidth(value, Math.max(0, width - visibleWidth(left) - 1), "…");
	return truncateToWidth(
		`${palette.paint(labelRole, left)}${" ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)))}${palette.paint(role, right)}`,
		width,
		"",
	);
}

function agentRows(
	snapshot: SidebarSnapshot,
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
): string[] {
	const working = snapshot.activity === "working";
	const label = working ? "Working" : "Ready";
	const phrase = working && snapshot.workingLabel ? ` · ${sanitizeInline(snapshot.workingLabel)}` : "";
	const knownModel = Boolean(snapshot.modelId || snapshot.provider);
	return [
		theme.bold(palette.paint(snapshot.activity, `${working ? "◆" : "●"} ${label}${phrase}`)),
		theme.bold(valueRow(snapshot.modelId, palette, "primary")),
		valueRow(snapshot.provider, palette, "muted"),
		labeledRow(
			"Thinking",
			snapshot.thinkingLevel ? sanitizeInline(snapshot.thinkingLevel) || PLACEHOLDER : PLACEHOLDER,
			width,
			palette,
			snapshot.thinkingLevel ? "primary" : "dim",
		),
		labeledRow(
			"Billing",
			knownModel ? (snapshot.metrics.subscription ? "Subscription" : "Metered") : PLACEHOLDER,
			width,
			palette,
			knownModel && snapshot.metrics.subscription ? "ready" : "muted",
		),
	];
}

/** nf-oct-git_branch, matching the footer's Git icon. */
const BRANCH_ICON = "";

const PULSE_STATUS_LABEL = {
	clean: "Clean",
	stale: "Stale",
	conflict: "Conflicts",
	changed: "Modified",
} as const;

function workspacePulseRows(
	pulse: WorkspacePulseState,
	width: number,
	palette: AtelierPalette,
): { core: string[]; details: string[] } {
	switch (pulse.status) {
		case "inspecting":
			return { core: [palette.paint("muted", "inspecting…")], details: [] };
		case "not-repo":
			return { core: [palette.paint("dim", "not a Git repository")], details: [] };
		case "unavailable":
			return { core: [palette.paint("warning", "Git unavailable")], details: [] };
	}
	const git = pulse.data.snapshot;
	const clean = pulse.status === "clean";
	const statusRole = pulse.status === "conflict" ? "error" : clean ? "muted" : "warning";
	const core = [labeledRow("Git", PULSE_STATUS_LABEL[pulse.status], width, palette, statusRole)];
	if (!clean) {
		const files = `${formatTokens(git.trackedFiles)} ${git.trackedFiles === 1 ? "file" : "files"}`;
		const added = `+${formatTokens(git.linesAdded)}`;
		const removed = `−${formatTokens(git.linesRemoved)}`;
		const lines = `${palette.paint("chartGreen", added)}  ${palette.paint("error", removed)}`;
		// One "4 files  +54  −20" row when it fits, otherwise files and lines on their own rows.
		if (visibleWidth(`Changed ${files}  ${added}  ${removed}`) <= width)
			core.push(labeledRow("Changed", `${files}  ${lines}`, width, palette));
		else core.push(labeledRow("Changed", files, width, palette), labeledRow("Lines", lines, width, palette));
	}
	if (git.conflicts > 0)
		core.push(labeledRow("Conflicts", formatTokens(git.conflicts), width, palette, "error"));
	const details = (
		[
			["Untracked", git.untrackedFiles],
			["Binary", git.binaryFiles],
			["Submodules", git.submodules],
		] as const
	)
		.filter(([, count]) => count > 0)
		.map(([label, count]) => labeledRow(label, formatTokens(count), width, palette));
	return { core, details };
}

/** Context rests in its own hue in the sidebar; the warning and danger roles stay shared. */
function sidebarContextRole(percent: number | null, config: AtelierConfig): PaletteRole {
	const role = contextRole(percent, config, "dim");
	return role === "context" ? "cache" : role;
}

function contextRows(
	snapshot: SidebarSnapshot,
	config: AtelierConfig,
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
): string[] {
	const { metrics } = snapshot;
	if (metrics.contextTokens === null || metrics.contextPercent === null) {
		return [palette.paint("dim", "Context unavailable")];
	}
	const role = sidebarContextRole(metrics.contextPercent, config);
	const percent = Math.max(0, metrics.contextPercent);
	const percentText = `${percent.toFixed(1)}%`;
	const percentWidth = Math.max(6, visibleWidth(percentText));
	const meterWidth = Math.max(0, width - percentWidth - 2);
	const units = Math.min(
		meterWidth * 8,
		Math.max(percent > 0 ? 1 : 0, Math.round((percent * meterWidth * 8) / 100)),
	);
	const full = Math.floor(units / 8);
	const fraction = units % 8;
	const fill = "█".repeat(full) + (fraction ? "▏▎▍▌▋▊▉"[fraction - 1] : "");
	// A shared background covers the unused part of the fractional cell too,
	// keeping even 1% usage attached to its track. Reset before the percentage.
	const meter = palette.colorEnabled
		? `\u001b[48;2;48;53;56m${palette.paint(role, fill)}${" ".repeat(meterWidth - full - (fraction ? 1 : 0))}\u001b[49m`
		: `${palette.paint(role, "█".repeat(full))}${palette.paint("dim", "░".repeat(meterWidth - full))}`;
	const percentage = theme.bold(palette.paint(role, percentText.padStart(percentWidth)));
	const usage = `${formatTokens(metrics.contextTokens)} / ${metrics.contextWindow > 0 ? formatTokens(metrics.contextWindow) : PLACEHOLDER}`;
	return [
		meterWidth > 0 ? `${meter}  ${percentage}` : percentage,
		labeledRow("Tokens", usage, width, palette, "muted"),
	];
}

/** Usage counts keep one decimal (and reach billions) where the rail rounds harder. */
function formatUsageTokens(count: number): string {
	if (count < 1_000) return Math.trunc(count).toString();
	if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${(count / 1_000_000_000).toFixed(1)}B`;
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
			labeledRow("Input", formatUsageTokens(metrics.input), width, palette, "input"),
			labeledRow("Output", formatUsageTokens(metrics.output), width, palette, "output"),
			labeledRow("Cache read", formatUsageTokens(metrics.cacheRead), width, palette, "cache"),
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

const TODO_CHECK = {
	completed: { role: "ready", glyph: "✓" },
	in_progress: { role: "warning", glyph: "◐" },
	pending: { role: "dim", glyph: "○" },
} as const satisfies Record<NormalizedTodo["status"], { role: PaletteRole; glyph: string }>;

function todosRows(snapshot: SidebarSnapshot, palette: AtelierPalette): string[] {
	const todos = snapshot.todos;
	if (todos.length === 0) return [];
	const done = todos.filter((todo) => todo.status === "completed").length;
	const visible =
		snapshot.runActivity.phase === "running" ? todos.filter((todo) => todo.status === "in_progress") : todos;
	return [
		palette.paint("muted", `${done}/${todos.length}`),
		...visible.map((todo) => {
			const check = TODO_CHECK[todo.status];
			const textRole = todo.status === "completed" ? "dim" : "primary";
			return `${palette.paint(check.role, check.glyph)} ${palette.paint("accent", `#${todo.id}`)} ${palette.paint(
				textRole,
				sanitizeInline(todo.text),
			)}`;
		}),
	];
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
	extraLive = 0,
): string {
	const status = TOOL_STATUS[tool.status];
	const live = tool.status === "running";
	const elapsed = tool.durationMs ?? now - tool.startedAt;
	// Successful tools under a second carry no timing worth reading; failures always keep theirs.
	const duration = tool.status !== "done" || elapsed >= 1_000 ? formatDuration(elapsed) : "";
	const trailing = live && extraLive > 0 ? `${duration} · +${extraLive}` : duration;
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
		"dim",
		sanitizeInline(truncateToWidth(tool.name || "tool", fittedNameWidth, "…")),
	);
	const summary = tool.summary
		? palette.paint(
				tool.status === "done" ? "muted" : "primary",
				sanitizeInline(truncateToWidth(tool.summary, summaryWidth, "…")),
			)
		: palette.paint("dim", PLACEHOLDER);
	const row = [
		palette.paint(status.role, status.glyph),
		fittedNameWidth > 0 ? fitToWidth(name, fittedNameWidth) : "",
		summaryWidth > 0 ? fitToWidth(summary, summaryWidth) : "",
		trailing ? palette.paint(tool.status === "done" ? "dim" : status.role, trailing) : "",
	]
		.filter(Boolean)
		.join(" ");
	return truncateToWidth(row, contentWidth, "");
}

function runPhaseRole(activity: RunActivitySnapshot): PaletteRole {
	if (activity.phase === "running") return "working";
	return activity.failedCount > 0 ? "error" : "chartGreen";
}

function runSummaryRow(
	activity: RunActivitySnapshot,
	width: number,
	palette: AtelierPalette,
	now: number,
): string {
	const role = runPhaseRole(activity);
	const settled = activity.phase === "settled";
	const label = settled
		? "Last run"
		: activity.turnNumber === undefined
			? "Run"
			: `Turn ${activity.turnNumber}`;
	const duration = formatDuration(
		settled ? (activity.durationMs ?? now - (activity.startedAt ?? now)) : now - (activity.startedAt ?? now),
	);
	return labeledRow(label, duration, width, palette, role, role);
}

function toolCountRow(activity: RunActivitySnapshot, width: number, palette: AtelierPalette): string {
	const { completedCount, failedCount } = activity;
	const value = failedCount > 0 ? `${completedCount} done · ${failedCount} failed` : `${completedCount} done`;
	return labeledRow("Tools", value, width, palette, failedCount > 0 ? "error" : "muted");
}

function responsePerformanceRows(
	activity: RunActivitySnapshot,
	width: number,
	palette: AtelierPalette,
): string[] {
	const { ttft, tps } = responsePerformanceValues(activity.performance);
	return [
		labeledRow("First token", ttft.text, width, palette, ttft.available ? "output" : "dim"),
		labeledRow(
			width < 25 ? "Speed" : "Output speed",
			tps.available ? `${tps.text} tok/s` : tps.text,
			width,
			palette,
			tps.available ? "output" : "dim",
		),
	];
}

/**
 * Lower ranks give way first when the sidebar is short. Required groups use
 * Infinity and are only trimmed row by row after every optional group is gone.
 */
const DROP_RANK = {
	toolName: 0,
	session: 4,
	location: 5,
	pulseDetails: 6,
	toolsStatus: 10,
	subagents: 18,
	usage: 20,
	contributed: 25,
	workspace: 30,
	olderRecentTool: 50,
	aggregate: 60,
	latestRecentTool: 70,
	activeTool: 75,
	alerts: 80,
	todos: 90,
	required: Number.POSITIVE_INFINITY,
} as const;

interface PanelChrome {
	id: string;
	title: string;
	role: PaletteRole;
	jewel?: Jewel;
}

interface SidebarGroup {
	name: string;
	/** Panel chrome shared by adjacent groups with the same panel ID. */
	panel?: PanelChrome;
	rows: string[];
	dropRank: number;
	/** Shown only once one of these groups has been dropped; a summary of rows still visible adds nothing. */
	summarizes?: readonly string[];
}

function activityGroups(
	snapshot: SidebarSnapshot,
	contentWidth: number,
	palette: AtelierPalette,
	now: number,
	panel: PanelChrome,
): SidebarGroup[] {
	const activity = snapshot.runActivity;
	const liveTurn = activity.phase === "running";
	const activeIds = new Set(activity.activeTools.map((tool) => tool.id));
	const sortedActive = activity.activeTools
		.map((tool, index) => ({ index, tool }))
		.sort((left, right) => left.tool.startedAt - right.tool.startedAt || left.index - right.index)
		.map(({ tool }) => tool);
	const visibleActive = liveTurn ? sortedActive.slice(-1) : sortedActive;
	const extraLive = sortedActive.length - visibleActive.length;
	const recent = liveTurn ? [] : activity.recentTools.filter((tool) => !activeIds.has(tool.id)).slice(0, 3);
	const nameWidth = toolNameWidth([...visibleActive, ...recent], contentWidth);
	const toolCount = activity.completedCount + activity.failedCount;
	const aggregate = liveTurn || toolCount === 0 ? [] : [toolCountRow(activity, contentWidth, palette)];
	// When every counted tool has its own row, the count only matters once a row is dropped for height.
	const summarizes =
		toolCount > recent.length ? undefined : recent.map((tool) => `activityRecent:${tool.id}`);
	return [
		{
			name: "activityCore",
			panel,
			rows: [
				...(activity.phase === "idle" ? [] : [runSummaryRow(activity, contentWidth, palette, now)]),
				...responsePerformanceRows(activity, contentWidth, palette),
			],
			dropRank: DROP_RANK.required,
		},
		...visibleActive.map((tool, index) => ({
			name: `activityActive:${tool.id}`,
			panel,
			rows: [toolActivityRow(tool, contentWidth, nameWidth, palette, now, extraLive)],
			dropRank: DROP_RANK.activeTool + (visibleActive.length - index) / 100,
		})),
		...recent.map((tool, index) => ({
			name: `activityRecent:${tool.id}`,
			panel,
			rows: [toolActivityRow(tool, contentWidth, nameWidth, palette, now)],
			dropRank:
				index === 0 ? DROP_RANK.latestRecentTool : DROP_RANK.olderRecentTool + (recent.length - index - 1),
		})),
		{
			name: "activityAggregate",
			panel,
			rows: aggregate,
			dropRank: DROP_RANK.aggregate,
			...(summarizes ? { summarizes } : {}),
		},
	];
}

/** Content rows do not wrap; each contiguous panel adds a header, bottom border, and spacer. */
function measureGroups(groups: readonly SidebarGroup[]): number {
	let height = 0;
	let previous: SidebarGroup | undefined;
	for (const group of groups) {
		height += group.rows.length;
		if (group.panel && group.panel.id !== previous?.panel?.id) height += 3;
		previous = group;
	}
	return height;
}

function withoutRedundantSummaries(groups: readonly SidebarGroup[]): SidebarGroup[] {
	const names = new Set(groups.map((group) => group.name));
	return groups.filter((group) => !group.summarizes || group.summarizes.some((name) => !names.has(name)));
}

function composeGroups(groups: readonly SidebarGroup[], height: number): SidebarGroup[] {
	let candidate = groups.filter((group) => group.rows.length > 0);
	// Recount cheap row metadata after removal so newly adjacent groups share panel chrome.
	// Painting happens only after selection, never for the discarded candidates.
	while (measureGroups(withoutRedundantSummaries(candidate)) > height) {
		let drop: SidebarGroup | undefined;
		for (const group of withoutRedundantSummaries(candidate)) {
			if (group.dropRank < (drop?.dropRank ?? DROP_RANK.required)) drop = group;
		}
		if (drop) {
			const name = drop.name;
			candidate = candidate.filter((group) => group.name !== name);
			continue;
		}
		// Once optional panels are gone, reduce metadata before clipping the
		// required Agent/Activity/Context hierarchy in a very short terminal.
		const compact = [
			{ name: "agent", minimum: 2 },
			{ name: "activityCore", minimum: 1 },
			{ name: "context", minimum: 1 },
		].find(({ name, minimum }) =>
			candidate.some((group) => group.name === name && group.rows.length > minimum),
		);
		if (!compact) break;
		candidate = candidate.map((group) =>
			group.name === compact.name ? { ...group, rows: group.rows.slice(0, -1) } : group,
		);
	}
	return withoutRedundantSummaries(candidate);
}

function renderGroups(
	groups: readonly SidebarGroup[],
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
): string[] {
	const rendered: string[] = [];
	let index = 0;
	while (index < groups.length) {
		const group = groups[index];
		if (!group?.panel) {
			rendered.push(...(group?.rows ?? []));
			index += 1;
			continue;
		}
		const panel = group.panel;
		const rows: string[] = [];
		while (groups[index]?.panel?.id === panel.id) {
			rows.push(...(groups[index]?.rows ?? []));
			index += 1;
		}
		rendered.push(...panelRows(panel.title, rows, width, palette, theme, panel.role, panel.jewel ?? "✦"));
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
	const contentWidth = safeWidth - 2;
	const panelWidth = Math.max(0, contentWidth - 4);
	const alerts = statusAlerts(snapshot);
	const builtinPanels: Record<BuiltinSidebarPanelId, () => SidebarGroup[]> = {
		agent: () => [
			{
				name: "agent",
				panel: {
					id: "agent",
					title: "AGENT",
					role: snapshot.activity,
					jewel:
						snapshot.activity === "working" && Math.floor(now / SIDEBAR_ANIMATION_INTERVAL_MS) % 2 === 1
							? "✧"
							: "✦",
				},
				rows: agentRows(snapshot, panelWidth, palette, theme),
				dropRank: DROP_RANK.required,
			},
		],
		activity: () =>
			activityGroups(snapshot, panelWidth, palette, now, {
				id: "activity",
				title: "ACTIVITY",
				role: runPhaseRole(snapshot.runActivity),
			}),
		alerts: () => [
			{
				name: "alerts",
				panel: {
					id: "alerts",
					title: "ALERTS",
					role: alerts.some((alert) => alert.role === "error") ? "error" : "warning",
				},
				rows: alerts.map(({ role, text }) => palette.paint(role, `${role === "error" ? "✕" : "▲"} ${text}`)),
				dropRank: DROP_RANK.alerts,
			},
		],
		todos: () => [
			{
				name: "todos",
				panel: { id: "todos", title: "TODOS", role: "accent" },
				rows: todosRows(snapshot, palette),
				dropRank: DROP_RANK.todos,
			},
		],
		context: () => [
			{
				name: "context",
				panel: {
					id: "context",
					title: "CONTEXT",
					role: sidebarContextRole(snapshot.metrics.contextPercent, config),
				},
				rows: contextRows(snapshot, config, panelWidth, palette, theme),
				dropRank: DROP_RANK.required,
			},
		],
		workspace: () => {
			const panel = { id: "workspace", title: "WORKSPACE", role: "accent" } as const;
			const pulseData = workspacePulseData(snapshot.workspacePulse);
			const pulse = workspacePulseRows(snapshot.workspacePulse, panelWidth, palette);
			const location = pulseData
				? pulseData.relativeCwd
					? [palette.paint("muted", `./${sanitizeInline(pulseData.relativeCwd)}`)]
					: []
				: [
						palette.paint(
							"muted",
							sanitizeInline(snapshot.cwd) ? displayHomePath(sanitizeInline(snapshot.cwd)) : PLACEHOLDER,
						),
					];
			const sessionName = snapshot.sessionName ? sanitizeInline(snapshot.sessionName) || PLACEHOLDER : "";
			return [
				{
					name: "workspaceCore",
					panel,
					rows: [
						theme.bold(valueRow(snapshot.projectName, palette, "primary")),
						// The branch takes the full row so long names are not cut short by a label column.
						...(snapshot.branch
							? [
									palette.paint(
										"accent",
										`${config.nerdFont ? BRANCH_ICON : "⎇"} ${sanitizeInline(snapshot.branch) || PLACEHOLDER}`,
									),
								]
							: []),
					],
					dropRank: DROP_RANK.workspace,
				},
				{ name: "workspaceLocation", panel, rows: location, dropRank: DROP_RANK.location },
				{ name: "workspaceCore", panel, rows: pulse.core, dropRank: DROP_RANK.workspace },
				{ name: "workspaceDetails", panel, rows: pulse.details, dropRank: DROP_RANK.pulseDetails },
				{
					name: "workspaceSession",
					panel,
					rows: [
						...(sessionName ? [labeledRow("Session", sessionName, panelWidth, palette)] : []),
						labeledRow("History", `${snapshot.branchEntryCount} entries`, panelWidth, palette),
						labeledRow("Storage", snapshot.persisted ? "Saved" : "Temporary", panelWidth, palette, "muted"),
					],
					dropRank: DROP_RANK.session,
				},
			];
		},
		usage: () => [
			{
				name: "usage",
				panel: { id: "usage", title: "USAGE", role: "chartGold" },
				rows: usageRows(snapshot, config, panelWidth, palette),
				dropRank: DROP_RANK.usage,
			},
		],
		subagents: () => [
			{
				name: "subagentCostChart",
				panel: { id: "subagents", title: "SUBAGENTS", role: "output" },
				rows: subagentRows(snapshot, config, panelWidth, palette, chartGraphics),
				dropRank: DROP_RANK.subagents,
			},
		],
		tools: () => {
			const panel = { id: "tools", title: "TOOLS", role: "chartPink" } as const;
			const showToolNames = config.showSidebarToolNames && safeWidth > COMPACT_SIDEBAR_MAX_WIDTH;
			const nameRows = showToolNames ? activeToolNameRows(snapshot, panelWidth, palette) : [];
			return [
				{
					name: "toolsStatus",
					panel,
					rows: [
						labeledRow(
							"Enabled",
							`${snapshot.activeToolCount} / ${snapshot.availableToolCount}`,
							panelWidth,
							palette,
						),
					],
					dropRank: DROP_RANK.toolsStatus,
				},
				...nameRows.map((row, index) => ({
					name: `activeToolNames:${index}`,
					panel,
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
		const rows = panel.rows
			.filter((row) => row.text)
			.map((row) => palette.paint(row.role ?? panel.role ?? "primary", row.text));
		ordered.push({
			name: `contributed:${panel.id}`,
			panel: { id: panel.id, title: (panel.title || panel.id).toUpperCase(), role: panel.role ?? "accent" },
			rows: rows.length > 0 ? rows : [palette.paint("dim", "No data")],
			dropRank: DROP_RANK.contributed,
		});
	}
	if (!availableVisible) {
		ordered.push({
			name: "empty",
			panel: { id: "__empty__", title: "SIDEBAR", role: "muted" },
			rows: ["No available panels", "Open /atelier Settings"],
			dropRank: DROP_RANK.required,
		});
	}
	return renderDock(
		renderGroups(composeGroups(ordered, safeHeight), contentWidth, palette, theme),
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
		cwd: options.ctx.cwd,
		branchEntryCount: 0,
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
		subscribeInput: (handler) => options.ctx.ui.onTerminalInput(handler),
		onVisibilityChange: () => syncAnimation(),
		onResizeChange: () => {
			safely(() => requestOverlayRender?.());
		},
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

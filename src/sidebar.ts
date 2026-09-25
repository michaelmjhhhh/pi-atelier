import { homedir } from "node:os";
import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type OverlayHandle, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeLike } from "./footer.js";
import { aggregateMetrics, formatTokens } from "./metrics.js";
import { type AtelierPalette, createPalette, type PaletteRole } from "./palette.js";
import {
	EMPTY_RUN_ACTIVITY,
	formatDuration,
	responsePerformanceValues,
	type RunActivitySnapshot,
	type ToolActivity,
} from "./run-activity.js";
import {
	BUILTIN_SIDEBAR_PANEL_IDS,
	isSidebarPanelContributionId,
	SIDEBAR_PANEL_MAX_ROW_CHARS,
	SIDEBAR_PANEL_MAX_ROWS,
	SIDEBAR_PANEL_MAX_TITLE_CHARS,
	type SidebarPanelData,
	type SidebarPanelRole,
	sanitizeSidebarPanelText,
} from "./sidebar-panels.js";
import {
	createSplitPaneController,
	type SplitPaneController,
	type SidebarMode,
	type SidebarStatus,
} from "./split-pane.js";
import {
	DEFAULT_CONFIG,
	type AtelierConfig,
	type AtelierState,
	type NormalizedTodo,
	type WorkspacePulseState,
} from "./types.js";
import type { WorkspacePulseData } from "./workspace-pulse.js";

export type {
	SidebarPanelContribution,
	SidebarPanelData,
	SidebarPanelDiscoveryEvent,
	SidebarPanelEvent,
	SidebarPanelEventTransport,
	SidebarPanelRegisterEvent,
	SidebarPanelRegistry,
	SidebarPanelRegistryOptions,
	SidebarPanelRole,
	SidebarPanelRow,
	SidebarPanelUnregisterEvent,
} from "./sidebar-panels.js";
export {
	BUILTIN_SIDEBAR_PANEL_IDS,
	createSidebarPanelRegistry,
	DEFAULT_SIDEBAR_PANEL_LAYOUT,
	isSidebarPanelContributionId,
	isSidebarPanelId,
	isSidebarPanelRequestId,
	isSidebarPanelSource,
	isSidebarPanelTextWithinRawLimit,
	registerSidebarPanel,
	SIDEBAR_PANEL_EVENT_CHANNEL,
	SIDEBAR_PANEL_MAX_ID_CHARS,
	SIDEBAR_PANEL_MAX_PANELS,
	SIDEBAR_PANEL_MAX_RAW_REQUEST_ID_CODE_UNITS,
	SIDEBAR_PANEL_MAX_RAW_ROW_CODE_UNITS,
	SIDEBAR_PANEL_MAX_RAW_TITLE_CODE_UNITS,
	SIDEBAR_PANEL_MAX_ROW_CHARS,
	SIDEBAR_PANEL_MAX_ROWS,
	SIDEBAR_PANEL_MAX_SOURCE_CHARS,
	SIDEBAR_PANEL_MAX_TITLE_CHARS,
	SIDEBAR_PANEL_MAX_TRACKED_SOURCES,
	sanitizeSidebarPanelText,
} from "./sidebar-panels.js";

export interface SidebarSnapshotInput {
	state: AtelierState;
	cwd: string;
	sessionName?: string;
	sessionFile?: string;
	branchEntryCount: number;
	activeToolCount: number;
	availableToolCount: number;
	activeToolNames?: readonly string[];
	extensionStatuses: readonly string[];
	runActivity?: RunActivitySnapshot;
	todos?: readonly NormalizedTodo[];
	sidebarPanels?: readonly SidebarPanelData[];
}

export interface SidebarSnapshot extends AtelierState {
	projectName: string;
	cwd: string;
	sessionName?: string;
	sessionFile?: string;
	persisted: boolean;
	branchEntryCount: number;
	activeToolCount: number;
	availableToolCount: number;
	activeToolNames: readonly string[];
	runActivity: RunActivitySnapshot;
	todos: readonly NormalizedTodo[];
	sidebarPanels?: readonly SidebarPanelData[];
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
		...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
		persisted: Boolean(input.sessionFile),
		branchEntryCount: input.branchEntryCount,
		activeToolCount: input.activeToolCount,
		availableToolCount: input.availableToolCount,
		activeToolNames: [...new Set((input.activeToolNames ?? []).map(sanitize).filter(Boolean))].sort((a, b) =>
			a.localeCompare(b, "en"),
		),
		extensionStatuses: input.extensionStatuses,
		runActivity: input.runActivity ?? EMPTY_RUN_ACTIVITY,
		todos: input.todos ?? [],
		sidebarPanels: input.sidebarPanels ?? [],
	};
}

const sanitize = (text: string): string =>
	text
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

const display = (value: string | undefined): string => {
	const safe = value === undefined ? "" : sanitize(value);
	return safe || "—";
};

const finiteCount = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);

function shortPath(path: string): string {
	const safe = sanitize(path);
	const home = homedir();
	if (safe === home) return "~";
	if (home && safe.startsWith(`${home}/`)) return `~${safe.slice(home.length)}`;
	return safe || "—";
}

function padToWidth(text: string, width: number): string {
	const safeWidth = Math.max(0, Math.trunc(width));
	const content = truncateToWidth(text, safeWidth, "");
	return `${content}${" ".repeat(Math.max(0, safeWidth - visibleWidth(content)))}`;
}

function renderDock(
	rows: string[],
	width: number,
	height: number,
	palette: AtelierPalette,
	resizing = false,
): string[] {
	const safeWidth = Math.max(0, Math.trunc(width));
	const safeHeight = Math.max(0, Math.trunc(height));
	if (safeWidth <= 0 || safeHeight <= 0) return [];
	const contentWidth = Math.max(0, safeWidth - 2);
	const edge = resizing ? `${palette.paint("warning", "│")} ` : "  ";
	return Array.from({ length: safeHeight }, (_, index) => {
		const content = truncateToWidth(rows[index] ?? "", contentWidth, "");
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
		return truncateToWidth(`${edge}${content}${padding}`, safeWidth, "");
	});
}

function panelRows(
	title: string,
	rows: readonly string[],
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
	role: PaletteRole,
	jewel: "✦" | "✧",
): string[] {
	const safeWidth = Math.max(4, Math.trunc(width));
	const innerWidth = Math.max(0, safeWidth - 4);
	const safeTitle = sanitizeSidebarPanelText(title, SIDEBAR_PANEL_MAX_TITLE_CHARS).toUpperCase();
	const crownPrefix = `╭─ ${jewel} `;
	const crownFill = "─".repeat(
		Math.max(0, safeWidth - visibleWidth(crownPrefix) - visibleWidth(safeTitle) - 2),
	);
	const top = `${palette.paint(role, crownPrefix)}${theme.bold(
		palette.paint(role, safeTitle),
	)} ${palette.paint(role, `${crownFill}╮`)}`;
	const body = rows.map((row) => {
		const content = padToWidth(row, innerWidth);
		return `${palette.paint("dim", "│")} ${content} ${palette.paint("dim", "│")}`;
	});
	return [top, ...body, palette.paint("dim", `╰${"─".repeat(safeWidth - 2)}╯`), ""];
}

function valueRow(value: string | undefined, palette: AtelierPalette, role: PaletteRole): string {
	const text = display(value);
	return palette.paint(text === "—" ? "dim" : role, text);
}

const COMPACT_SIDEBAR_MAX_WIDTH = 39;

interface SidebarLayout {
	showToolNames: boolean;
}

function sidebarLayout(width: number, config: AtelierConfig): SidebarLayout {
	const compact = width <= COMPACT_SIDEBAR_MAX_WIDTH;
	return {
		showToolNames: config.showSidebarToolNames && !compact,
	};
}

function activitySymbol(activity: SidebarSnapshot["activity"]): string {
	if (activity === "error") return "✕";
	if (activity === "warning") return "▲";
	if (activity === "working") return "◆";
	return "●";
}

/** Align names and values consistently across all built-in panels. */
function labeledRow(
	label: string,
	value: string,
	width: number,
	palette: AtelierPalette,
	role: PaletteRole = "primary",
): string {
	const safeWidth = Math.max(0, Math.trunc(width));
	const left = truncateToWidth(label, Math.min(12, Math.max(0, safeWidth - 8)), "…");
	const right = truncateToWidth(value, Math.max(0, safeWidth - visibleWidth(left) - 1), "…");
	return truncateToWidth(
		`${palette.paint("muted", left)}${" ".repeat(Math.max(1, safeWidth - visibleWidth(left) - visibleWidth(right)))}${palette.paint(role, right)}`,
		safeWidth,
		"",
	);
}

function agentRows(
	snapshot: SidebarSnapshot,
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
): string[] {
	const activity = `${snapshot.activity.slice(0, 1).toUpperCase()}${snapshot.activity.slice(1)}`;
	const working =
		snapshot.activity === "working" && snapshot.workingLabel ? ` · ${sanitize(snapshot.workingLabel)}` : "";
	const knownModel = Boolean(snapshot.modelId || snapshot.provider);
	return [
		theme.bold(
			palette.paint(snapshot.activity, `${activitySymbol(snapshot.activity)} ${activity}${working}`),
		),
		theme.bold(valueRow(snapshot.modelId, palette, "primary")),
		valueRow(snapshot.provider, palette, "muted"),
		labeledRow(
			"Thinking",
			display(snapshot.thinkingLevel),
			width,
			palette,
			snapshot.thinkingLevel ? "primary" : "dim",
		),
		labeledRow(
			"Billing",
			knownModel ? (snapshot.metrics.subscription ? "Subscription" : "Metered") : "—",
			width,
			palette,
			knownModel && snapshot.metrics.subscription ? "ready" : "muted",
		),
	];
}

function formatPulseCount(value: number): string {
	const count = finiteCount(value);
	if (count < 1_000) return count.toString();
	if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
}

interface WorkspacePulseRows {
	core: string[];
	details: string[];
}

function workspacePulseRows(
	pulse: WorkspacePulseState,
	width: number,
	palette: AtelierPalette,
): WorkspacePulseRows {
	if (pulse.status === "inspecting") return { core: [palette.paint("muted", "inspecting…")], details: [] };
	if (pulse.status === "not-repo")
		return { core: [palette.paint("dim", "not a Git repository")], details: [] };
	if (pulse.status === "unavailable")
		return { core: [palette.paint("warning", "Git unavailable")], details: [] };
	if (!("data" in pulse)) return { core: [], details: [] };
	const git = pulse.data.snapshot;
	const clean = pulse.status === "clean";
	const status = clean
		? "Clean"
		: pulse.status === "stale"
			? "Stale"
			: pulse.status === "conflict"
				? "Conflicts"
				: "Modified";
	const core = [
		labeledRow(
			"Git",
			status,
			width,
			palette,
			pulse.status === "conflict" ? "error" : clean ? "muted" : "warning",
		),
	];
	if (!clean)
		core.push(
			labeledRow("Changed", `${formatPulseCount(git.trackedFiles)} tracked`, width, palette),
			labeledRow(
				"Lines",
				`+${formatPulseCount(git.linesAdded)}  −${formatPulseCount(git.linesRemoved)}`,
				width,
				palette,
			),
		);
	if (git.conflicts > 0)
		core.push(labeledRow("Conflicts", formatPulseCount(git.conflicts), width, palette, "error"));
	const details = [
		...(git.untrackedFiles > 0
			? [labeledRow("Untracked", formatPulseCount(git.untrackedFiles), width, palette)]
			: []),
		...(git.binaryFiles > 0 ? [labeledRow("Binary", formatPulseCount(git.binaryFiles), width, palette)] : []),
		...(git.submodules > 0
			? [labeledRow("Submodules", formatPulseCount(git.submodules), width, palette)]
			: []),
	];
	return { core, details };
}

interface WorkspaceRows {
	identity: string[];
	location: string[];
	pulseCore: string[];
	pulseDetails: string[];
	session: string[];
}

function workspaceRows(
	snapshot: SidebarSnapshot,
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
): WorkspaceRows {
	const identity = [
		theme.bold(valueRow(snapshot.projectName, palette, "primary")),
		...(snapshot.branch ? [labeledRow("Branch", display(snapshot.branch), width, palette, "accent")] : []),
	];
	const pulseData = workspacePulseData(snapshot.workspacePulse);
	const location = pulseData?.relativeCwd
		? [palette.paint("muted", `./${sanitize(pulseData.relativeCwd)}`)]
		: pulseData
			? []
			: [palette.paint("muted", shortPath(snapshot.cwd))];
	const pulse = workspacePulseRows(snapshot.workspacePulse, width, palette);
	const session = [
		...(snapshot.sessionName ? [labeledRow("Session", display(snapshot.sessionName), width, palette)] : []),
		labeledRow("History", `${finiteCount(snapshot.branchEntryCount)} entries`, width, palette),
		labeledRow("Storage", snapshot.persisted ? "Saved" : "Temporary", width, palette, "muted"),
	];
	return { identity, location, pulseCore: pulse.core, pulseDetails: pulse.details, session };
}

function contextRole(snapshot: SidebarSnapshot, config: AtelierConfig): PaletteRole {
	const percent = snapshot.metrics.contextPercent;
	if (percent === null || !Number.isFinite(percent)) return "dim";
	if (percent >= config.contextDanger) return "error";
	if (percent >= config.contextWarning) return "warning";
	return "context";
}

function contextRows(
	snapshot: SidebarSnapshot,
	config: AtelierConfig,
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
	colorEnabled: boolean,
): string[] {
	const { metrics } = snapshot;
	if (
		metrics.contextTokens === null ||
		!Number.isFinite(metrics.contextTokens) ||
		metrics.contextPercent === null ||
		!Number.isFinite(metrics.contextPercent)
	) {
		return [palette.paint("dim", "Context unavailable")];
	}
	const role = contextRole(snapshot, config);
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
	const meter = colorEnabled
		? `\u001b[48;2;48;53;56m${palette.paint(role, fill)}${" ".repeat(meterWidth - full - (fraction ? 1 : 0))}\u001b[49m`
		: `${palette.paint(role, "█".repeat(full))}${palette.paint("dim", "░".repeat(meterWidth - full))}`;
	const percentage = theme.bold(palette.paint(role, percentText.padStart(percentWidth)));
	const usage = `${formatTokens(metrics.contextTokens)} / ${metrics.contextWindow > 0 ? formatTokens(metrics.contextWindow) : "—"}`;
	return [
		meterWidth > 0 ? `${meter}  ${percentage}` : percentage,
		labeledRow("Tokens", usage, width, palette, "muted"),
	];
}

const currencyDecimals = (value: number): number =>
	Number.isFinite(value) ? Math.min(6, Math.max(0, Math.trunc(value))) : 0;

function formatUsageTokens(count: number): string {
	const safe = Number.isFinite(count) ? Math.max(0, count) : 0;
	if (safe < 1_000) return Math.trunc(safe).toString();
	if (safe < 1_000_000) return `${(safe / 1_000).toFixed(1)}k`;
	if (safe < 1_000_000_000) return `${(safe / 1_000_000).toFixed(1)}M`;
	return `${(safe / 1_000_000_000).toFixed(1)}B`;
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
		const hit =
			metrics.cacheHitPercent !== undefined && Number.isFinite(metrics.cacheHitPercent)
				? `${metrics.cacheHitPercent.toFixed(1)}%`
				: "—";
		rows.push(
			labeledRow("Input", formatUsageTokens(metrics.input), width, palette, "input"),
			labeledRow("Output", formatUsageTokens(metrics.output), width, palette, "output"),
			labeledRow("Cache read", formatUsageTokens(metrics.cacheRead), width, palette, "cache"),
			labeledRow("Cache hit", hit, width, palette, hit === "—" ? "dim" : "primary"),
		);
	}
	if (metrics.costAvailable) {
		const cost = Math.max(0, Number.isFinite(metrics.cost) ? metrics.cost : 0).toFixed(
			currencyDecimals(config.currencyDecimals),
		);
		rows.push(labeledRow("Cost", `$${cost}`, width, palette));
	}
	return rows;
}

function toolsStatusRows(snapshot: SidebarSnapshot, width: number, palette: AtelierPalette): string[] {
	return [
		labeledRow(
			"Enabled",
			`${finiteCount(snapshot.activeToolCount)} / ${finiteCount(snapshot.availableToolCount)}`,
			width,
			palette,
		),
	];
}

function activeToolNameRows(
	snapshot: SidebarSnapshot,
	contentWidth: number,
	palette: AtelierPalette,
): string[] {
	const names = snapshot.activeToolNames.map((name) => palette.paint("primary", name));
	if (names.length === 0) return [];

	const leftColumnWidth = names.reduce(
		(maximum, name, index) => (index % 2 === 0 ? Math.max(maximum, visibleWidth(name)) : maximum),
		0,
	);
	const rightColumnWidth = names.reduce(
		(maximum, name, index) => (index % 2 === 1 ? Math.max(maximum, visibleWidth(name)) : maximum),
		0,
	);
	const columnGap = "  ";
	if (leftColumnWidth + visibleWidth(columnGap) + rightColumnWidth > contentWidth) return names;

	const rows: string[] = [];
	for (let index = 0; index < names.length; index += 2) {
		const left = names[index] ?? "";
		const right = names[index + 1];
		rows.push(right === undefined ? left : `${padToWidth(left, leftColumnWidth)}${columnGap}${right}`);
	}
	return rows;
}

function todosRows(snapshot: SidebarSnapshot, palette: AtelierPalette): string[] {
	const todoList = snapshot.todos;
	if (todoList.length === 0) return [];

	const done = todoList.filter((t) => t.status === "completed").length;
	const total = todoList.length;
	const rows = [palette.paint("muted", `${done}/${total}`)];
	const visible =
		snapshot.runActivity.phase === "running"
			? todoList.filter((todo) => todo.status === "in_progress")
			: todoList;

	for (const todo of visible) {
		let check: string;
		if (todo.status === "completed") check = palette.paint("ready", "✓");
		else if (todo.status === "in_progress") check = palette.paint("warning", "◐");
		else check = palette.paint("dim", "○");
		const id = palette.paint("accent", `#${todo.id}`);
		const text =
			todo.status === "completed"
				? palette.paint("dim", sanitize(todo.text))
				: palette.paint("primary", sanitize(todo.text));
		rows.push(`${check} ${id} ${text}`);
	}
	return rows;
}

const exceptionStatusPattern =
	/\b(error|failed?|failure|warn(?:ing)?|offline|unavailable|blocked|degraded)\b/i;

function statusDetailPanelRole(snapshot: SidebarSnapshot): PaletteRole {
	return snapshot.extensionStatuses.some((status) =>
		/\b(error|failed?|failure|offline|unavailable)\b/i.test(sanitize(status)),
	)
		? "error"
		: "warning";
}

function statusDetailRows(snapshot: SidebarSnapshot, palette: AtelierPalette): string[] {
	const statuses = snapshot.extensionStatuses
		.map(sanitize)
		.filter((status) => status && exceptionStatusPattern.test(status));
	if (statuses.length === 0) return [];
	return [
		...statuses.map((status) => {
			const role: PaletteRole = /\b(error|failed?|failure|offline|unavailable)\b/i.test(status)
				? "error"
				: "warning";
			return palette.paint(role, `${role === "error" ? "✕" : "▲"} ${status}`);
		}),
	];
}

interface ActivityGroups {
	core: string[];
	active: Array<{ id: string; row: string }>;
	recent: Array<{ id: string; row: string }>;
	aggregate: string[];
}

interface SidebarGroup {
	name: string;
	panel?: string;
	panelId?: string;
	panelRole?: PaletteRole;
	panelJewel?: "✦" | "✧";
	rows: string[];
	required: boolean;
	dropRank: number;
}

function renderGroups(
	groups: readonly SidebarGroup[],
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
): string[] {
	const rendered: string[] = [];
	for (let index = 0; index < groups.length; ) {
		const group = groups[index];
		if (!group) break;
		if (!group.panel) {
			rendered.push(...group.rows);
			index += 1;
			continue;
		}

		const rows: string[] = [];
		let next = index;
		while (groups[next]?.panel === group.panel && groups[next]?.panelId === group.panelId) {
			rows.push(...(groups[next]?.rows ?? []));
			next += 1;
		}
		if (rows.length > 0) {
			rendered.push(
				...panelRows(
					group.panel,
					rows,
					width,
					palette,
					theme,
					group.panelRole ?? "accent",
					group.panelJewel ?? "✦",
				),
			);
		}
		index = next;
	}
	return rendered;
}

function contributedRows(panel: SidebarPanelData, palette: AtelierPalette): string[] {
	const rows = panel.rows.slice(0, SIDEBAR_PANEL_MAX_ROWS).map((row) => {
		const text = sanitizeSidebarPanelText(
			typeof row === "string" ? row : row.text,
			SIDEBAR_PANEL_MAX_ROW_CHARS,
		);
		const role = typeof row === "string" ? panel.role : (row.role ?? panel.role);
		return palette.paint((role ?? "primary") as SidebarPanelRole, text);
	});
	return rows.filter((row) => visibleWidth(row) > 0);
}

function durationForTool(tool: ToolActivity, now: number): string {
	return formatDuration(tool.durationMs ?? Math.max(0, now - tool.startedAt));
}

function toolStatusRole(status: ToolActivity["status"]): PaletteRole {
	if (status === "failed") return "error";
	if (status === "running") return "working";
	return "ready";
}

function toolStatusLabel(tool: ToolActivity, now: number): string {
	const duration = durationForTool(tool, now);
	if (tool.status === "running") return duration;
	return `${tool.status} ${duration}`;
}

function toolActivityRow(
	tool: ToolActivity,
	contentWidth: number,
	palette: AtelierPalette,
	now: number,
	extraLive = 0,
): string {
	const safeName = sanitize(tool.name) || "tool";
	const safeSummary = sanitize(tool.summary);
	const status =
		extraLive > 0 && tool.status === "running"
			? `${durationForTool(tool, now)} · +${finiteCount(extraLive)}`
			: toolStatusLabel(tool, now);
	const statusWidth = visibleWidth(status);
	const nameWidth = Math.min(Math.max(visibleWidth(safeName), 4), 10, Math.max(0, contentWidth));
	const summaryWidth = Math.max(0, contentWidth - nameWidth - statusWidth - 2);
	const statusText = truncateToWidth(status, Math.max(0, contentWidth - nameWidth - summaryWidth - 2), "");
	const row = `${padToWidth(palette.paint("muted", safeName), nameWidth)} ${padToWidth(
		palette.paint(safeSummary ? "primary" : "dim", safeSummary || "—"),
		summaryWidth,
	)} ${palette.paint(toolStatusRole(tool.status), statusText)}`;
	return truncateToWidth(row, contentWidth, "");
}

function runSummaryRow(activity: RunActivitySnapshot, palette: AtelierPalette, now: number): string {
	if (activity.phase === "idle") return palette.paint("ready", "Ready");
	const duration =
		activity.phase === "settled"
			? formatDuration(activity.durationMs ?? Math.max(0, now - (activity.startedAt ?? now)))
			: formatDuration(Math.max(0, now - (activity.startedAt ?? now)));
	const role: PaletteRole =
		activity.phase === "running" ? "working" : activity.failedCount > 0 ? "error" : "ready";
	if (activity.phase === "settled") return palette.paint(role, `Last run · ${duration}`);

	const label = activity.turnNumber === undefined ? "Run" : `Turn ${finiteCount(activity.turnNumber)}`;
	return palette.paint(role, `${label} · ${activity.phase} ${duration}`);
}

function responsePerformanceRows(
	activity: RunActivitySnapshot,
	width: number,
	palette: AtelierPalette,
): string[] {
	const { ttft, tps } = responsePerformanceValues(activity.performance);
	return [
		labeledRow(
			"First token",
			ttft.available ? ttft.text : "—",
			width,
			palette,
			ttft.available ? "output" : "dim",
		),
		labeledRow(
			width < 25 ? "Speed" : "Output speed",
			tps.available ? `${tps.text} tok/s` : "—",
			width,
			palette,
			tps.available ? "output" : "dim",
		),
	];
}

function activityRows(
	activity: RunActivitySnapshot,
	contentWidth: number,
	palette: AtelierPalette,
	now: number,
): ActivityGroups {
	const liveTurn = activity.phase === "running";
	const activeIds = new Set(activity.activeTools.map((tool) => tool.id));
	const sortedActive = activity.activeTools
		.map((tool, index) => ({ index, tool }))
		.sort((left, right) => left.tool.startedAt - right.tool.startedAt || left.index - right.index)
		.map(({ tool }) => tool);
	const visibleActive = liveTurn ? sortedActive.slice(-1) : sortedActive;
	const extraLive = liveTurn ? Math.max(0, sortedActive.length - visibleActive.length) : 0;
	const active = visibleActive.map((tool) => ({
		id: tool.id,
		row: toolActivityRow(tool, contentWidth, palette, now, extraLive),
	}));
	const recent = liveTurn
		? []
		: activity.recentTools
				.filter((tool) => !activeIds.has(tool.id))
				.slice(0, 3)
				.map((tool) => ({ id: tool.id, row: toolActivityRow(tool, contentWidth, palette, now) }));
	const aggregateText = liveTurn ? "" : aggregateActivityText(activity);
	return {
		core: [
			...(activity.phase === "idle" ? [] : [runSummaryRow(activity, palette, now)]),
			...responsePerformanceRows(activity, contentWidth, palette),
		],
		active,
		recent,
		aggregate: aggregateText
			? [palette.paint(activity.failedCount > 0 ? "error" : "ready", aggregateText)]
			: [],
	};
}

function aggregateActivityText(activity: RunActivitySnapshot): string {
	const completed = finiteCount(activity.completedCount);
	const failed = finiteCount(activity.failedCount);
	if (completed === 0 && failed === 0) return "";
	return `tools ${completed} done · ${failed} failed`;
}

function activitySidebarGroups(
	snapshot: SidebarSnapshot,
	contentWidth: number,
	palette: AtelierPalette,
	now: number,
): SidebarGroup[] {
	const groups = activityRows(snapshot.runActivity, contentWidth, palette, now);
	const recentCount = groups.recent.length;
	const panelRole: PaletteRole =
		snapshot.runActivity.phase === "running"
			? "working"
			: snapshot.runActivity.failedCount > 0
				? "error"
				: "ready";
	return [
		{
			name: "activityCore",
			panel: "ACTIVITY",
			panelId: "activity",
			panelRole,
			rows: groups.core,
			required: true,
			dropRank: Number.POSITIVE_INFINITY,
		},
		...groups.active.map((active, index, rows) => ({
			name: `activityActive:${active.id}`,
			panel: "ACTIVITY",
			panelId: "activity",
			panelRole,
			rows: [active.row],
			required: false,
			dropRank: 35 + (rows.length - index) / 100 + 40,
		})),
		...groups.recent.map((recent, index) => ({
			name: `activityRecent:${recent.id}`,
			panel: "ACTIVITY",
			panelId: "activity",
			panelRole,
			rows: [recent.row],
			required: false,
			dropRank: (index === 0 ? 30 : 10 + (recentCount - index - 1)) + 40,
		})),
		{
			name: "activityAggregate",
			panel: "ACTIVITY",
			panelId: "activity",
			panelRole,
			rows: groups.aggregate,
			required: false,
			dropRank: 60,
		},
	].filter((group) => group.rows.length > 0);
}

/** Content rows do not wrap; each contiguous panel adds a header, bottom border, and spacer. */
function measureGroups(groups: readonly SidebarGroup[]): number {
	let height = 0;
	let previous: SidebarGroup | undefined;
	for (const group of groups) {
		height += group.rows.length;
		if (group.panel && (group.panel !== previous?.panel || group.panelId !== previous?.panelId)) {
			height += 3;
		}
		previous = group;
	}
	return height;
}

function composeGroups(groups: readonly SidebarGroup[], height: number): SidebarGroup[] {
	let candidate = groups.filter((group) => group.rows.length > 0);
	// Recount cheap row metadata after removal so newly adjacent groups share panel chrome.
	// Painting happens only after selection, never for the discarded candidates.
	while (measureGroups(candidate) > height) {
		let dropIndex = -1;
		let dropRank = Number.POSITIVE_INFINITY;
		for (const [index, group] of candidate.entries()) {
			if (group.required || group.dropRank >= dropRank) continue;
			dropRank = group.dropRank;
			dropIndex = index;
		}
		if (dropIndex === -1) {
			// Once optional panels are gone, reduce metadata before clipping the
			// required Agent/Activity/Context hierarchy in a very short terminal.
			const compact = [
				{ name: "agent", minimum: 2 },
				{ name: "activityCore", minimum: 1 },
				{ name: "context", minimum: 1 },
			].find(({ name, minimum }) =>
				candidate.some((group) => group.name === name && group.rows.length > minimum),
			);
			if (!compact) return candidate;
			candidate = candidate.map((group) =>
				group.name === compact.name ? { ...group, rows: group.rows.slice(0, -1) } : group,
			);
			continue;
		}
		const dropName = candidate[dropIndex]?.name;
		candidate = candidate.filter((group, index) =>
			dropName ? group.name !== dropName : index !== dropIndex,
		);
	}
	return candidate;
}

export function renderSidebarLines(
	snapshot: SidebarSnapshot,
	config: AtelierConfig,
	theme: ThemeLike,
	width: number,
	height: number,
	colorEnabled = true,
	now = Date.now(),
	resizing = false,
): string[] {
	const palette = createPalette(theme, colorEnabled);
	const safeWidth = Math.max(0, Math.trunc(width));
	const safeHeight = Math.max(0, Math.trunc(height));
	if (safeWidth <= 0 || safeHeight <= 0) return [];
	const contentWidth = Math.max(0, safeWidth - 2);
	const panelContentWidth = Math.max(0, contentWidth - 4);
	const layout = sidebarLayout(safeWidth, config);
	const toolNameRows = layout.showToolNames ? activeToolNameRows(snapshot, panelContentWidth, palette) : [];
	const workspace = workspaceRows(snapshot, panelContentWidth, palette, theme);
	const groups: SidebarGroup[] = [
		...(resizing
			? [
					{
						name: "resize",
						rows: [palette.paint("warning", "RESIZE · drag divider"), ""],
						required: true,
						dropRank: Number.POSITIVE_INFINITY,
					},
				]
			: []),
		{
			name: "agent",
			panel: "AGENT",
			panelId: "agent",
			panelRole: snapshot.activity,
			panelJewel: snapshot.activity === "working" && Math.floor(now / 400) % 2 === 1 ? "✧" : "✦",
			rows: agentRows(snapshot, panelContentWidth, palette, theme),
			required: true,
			dropRank: Number.POSITIVE_INFINITY,
		},
		...activitySidebarGroups(snapshot, panelContentWidth, palette, now),
		{
			name: "statusDetails",
			panel: "ALERTS",
			panelId: "alerts",
			panelRole: statusDetailPanelRole(snapshot),
			rows: statusDetailRows(snapshot, palette),
			required: false,
			dropRank: 80,
		},
		{
			name: "todos",
			panel: "TODOS",
			panelId: "todos",
			panelRole: "accent",
			rows: todosRows(snapshot, palette),
			required: false,
			dropRank: 90,
		},
		{
			name: "context",
			panel: "CONTEXT",
			panelId: "context",
			panelRole: contextRole(snapshot, config),
			rows: contextRows(snapshot, config, panelContentWidth, palette, theme, colorEnabled),
			required: true,
			dropRank: Number.POSITIVE_INFINITY,
		},
		{
			name: "workspaceCore",
			panel: "WORKSPACE",
			panelId: "workspace",
			panelRole: "accent",
			rows: workspace.identity,
			required: false,
			dropRank: 30,
		},
		{
			name: "workspaceLocation",
			panel: "WORKSPACE",
			panelId: "workspace",
			panelRole: "accent",
			rows: workspace.location,
			required: false,
			dropRank: 5,
		},
		{
			name: "workspaceCore",
			panel: "WORKSPACE",
			panelId: "workspace",
			panelRole: "accent",
			rows: workspace.pulseCore,
			required: false,
			dropRank: 30,
		},
		{
			name: "workspaceDetails",
			panel: "WORKSPACE",
			panelId: "workspace",
			panelRole: "accent",
			rows: workspace.pulseDetails,
			required: false,
			dropRank: 6,
		},
		{
			name: "workspaceSession",
			panel: "WORKSPACE",
			panelId: "workspace",
			panelRole: "accent",
			rows: workspace.session,
			required: false,
			dropRank: 4,
		},
		{
			name: "usage",
			panel: "USAGE",
			panelId: "usage",
			panelRole: "output",
			rows: usageRows(snapshot, config, panelContentWidth, palette),
			required: false,
			dropRank: 20,
		},
		{
			name: "toolsStatus",
			panel: "TOOLS",
			panelId: "tools",
			panelRole: "cache",
			rows: toolsStatusRows(snapshot, panelContentWidth, palette),
			required: false,
			dropRank: 10,
		},
		...toolNameRows.map((row, index, rows) => ({
			name: `activeToolNames:${index}`,
			panel: "TOOLS",
			panelId: "tools",
			panelRole: "cache" as const,
			rows: [row],
			required: false,
			dropRank: (rows.length - index) / 100,
		})),
	];

	// Keep panel content grouped while making the user-owned order the only
	// source of top-to-bottom composition. Contributed panels are available only
	// when a current registry snapshot exists; their saved entries remain in the
	// layout and are therefore still visible to Settings as unavailable.
	const contributed = new Map((snapshot.sidebarPanels ?? []).map((panel) => [panel.id, panel]));
	const grouped = new Map<string, SidebarGroup[]>();
	for (const group of groups) {
		const id = group.panelId;
		if (!id) continue;
		const list = grouped.get(id) ?? [];
		list.push(group);
		grouped.set(id, list);
	}
	const ordered: SidebarGroup[] = groups.filter((group) => !group.panel);
	let availableVisible = false;
	for (const entry of config.sidebarPanelLayout) {
		if (!entry.visible) continue;
		const builtin = BUILTIN_SIDEBAR_PANEL_IDS.includes(
			entry.id as (typeof BUILTIN_SIDEBAR_PANEL_IDS)[number],
		);
		const panel = isSidebarPanelContributionId(entry.id) ? contributed.get(entry.id) : undefined;
		if (builtin) {
			availableVisible = true;
			ordered.push(...(grouped.get(entry.id) ?? []));
		} else if (panel) {
			availableVisible = true;
			const rows = contributedRows(panel, palette);
			ordered.push({
				name: `contributed:${panel.id}`,
				panel: sanitize(panel.title).toUpperCase() || panel.id,
				panelId: panel.id,
				panelRole: panel.role ?? "accent",
				rows: rows.length > 0 ? rows : [palette.paint("dim", "No data")],
				required: false,
				dropRank: 25,
			});
		}
	}
	if (!availableVisible) {
		ordered.push({
			name: "empty",
			panel: "SIDEBAR",
			panelId: "__empty__",
			panelRole: "muted",
			rows: ["No available panels", "Open /atelier Settings"],
			required: true,
			dropRank: Number.POSITIVE_INFINITY,
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
	theme: ThemeLike;
	colorEnabled?: boolean;
}

function renderSidebarError(error: unknown, width: number, height: number, resizing = false): string[] {
	let detail = "Unknown error";
	try {
		detail = sanitize(error instanceof Error ? error.message : String(error)) || detail;
	} catch {
		// Keep the fallback render path safe even for unusual thrown values.
	}
	return renderDock(
		["Sidebar unavailable", detail],
		width,
		height,
		{
			paint: (_role, text) => text,
		},
		resizing,
	);
}

export function createSidebarComponent(options: SidebarComponentOptions): Component {
	return {
		render(width) {
			const height = options.getHeight();
			let resizing = false;
			try {
				resizing = options.isResizing?.() ?? false;
				return renderSidebarLines(
					options.getSnapshot(),
					options.getConfig(),
					options.theme,
					width,
					height,
					options.colorEnabled ?? true,
					Date.now(),
					resizing,
				);
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
	getWidth(): number;
	requestRender(): void;
	dispose(): void;
}

export interface SidebarControllerOptions {
	ctx: ExtensionContext;
	getSnapshot(): SidebarSnapshot;
	getConfig(): AtelierConfig;
	colorEnabled?: boolean;
	shouldAnimate?(): boolean;
	animationIntervalMs?: number;
	onWarning?(message: string): void;
	onError?(error: unknown): void;
}

interface RetirableSidebarBinding {
	getSnapshot(): SidebarSnapshot;
	getConfig(): AtelierConfig;
	isResizing(): boolean;
	setResizing(reader: () => boolean): void;
	detach(): void;
}

function createDetachedSidebarSnapshot(cwd: string): SidebarSnapshot {
	return buildSidebarSnapshot({
		state: {
			activity: "ready",
			dirty: false,
			workspacePulse: { status: "unavailable" },
			metrics: aggregateMetrics([], { subscription: false, autoCompact: null }),
			extensionStatuses: [],
		},
		cwd,
		branchEntryCount: 0,
		activeToolCount: 0,
		availableToolCount: 0,
		activeToolNames: [],
		extensionStatuses: [],
		todos: [],
		sidebarPanels: [],
	});
}

function createRetirableSidebarBinding(options: SidebarControllerOptions): RetirableSidebarBinding {
	let readSnapshot: (() => SidebarSnapshot) | undefined = options.getSnapshot;
	let readConfig: (() => AtelierConfig) | undefined = options.getConfig;
	let readResizing: (() => boolean) | undefined;
	let snapshot = createDetachedSidebarSnapshot(typeof options.ctx.cwd === "string" ? options.ctx.cwd : "");
	let config = structuredClone(DEFAULT_CONFIG);
	return {
		getSnapshot: () => (readSnapshot ? readSnapshot() : snapshot),
		getConfig: () => (readConfig ? readConfig() : config),
		isResizing: () => readResizing?.() ?? false,
		setResizing: (reader) => {
			if (readSnapshot) readResizing = reader;
		},
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
			readResizing = undefined;
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
	const animationIntervalMs = Math.max(1, Math.trunc(options.animationIntervalMs ?? 1_000));

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

	const split: SplitPaneController = createSplitPaneController({
		subscribeInput: (handler) => options.ctx.ui.onTerminalInput(handler),
		onVisibilityChange: () => syncAnimation(),
		onResizeChange: () => {
			safely(() => requestOverlayRender?.());
		},
		...(options.onWarning ? { onWarning: options.onWarning } : {}),
		...(options.onError ? { onError: options.onError } : {}),
	});

	binding.setResizing(split.isResizing);

	const stopAnimation = () => {
		if (!animationTimer) return;
		clearInterval(animationTimer);
		animationTimer = undefined;
	};

	const syncAnimation = () => {
		if (
			!enabled ||
			split.getStatus().presentation !== "shown" ||
			options.shouldAnimate?.() !== true ||
			!requestOverlayRender
		) {
			stopAnimation();
			return;
		}
		if (animationTimer) return;
		animationTimer = setInterval(() => {
			safely(() => requestOverlayRender?.());
		}, animationIntervalMs);
		animationTimer.unref?.();
	};

	const clearOverlayCallbacks = () => {
		closeOverlay = undefined;
		restoreStoppedCursor = undefined;
		requestOverlayRender = undefined;
		overlayHandle = undefined;
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

	const show = (mode: Exclude<SidebarMode, "off"> = "on") => {
		if (disposed) return;
		if (enabled) {
			safely(() => split.show(mode));
			syncAnimation();
			return;
		}
		if (options.ctx.mode !== "tui") {
			reportError(new Error("Pi Atelier sidebar requires TUI mode"));
			return;
		}

		enabled = true;
		const currentGeneration = ++generation;
		if (!safely(() => split.show(mode))) {
			enabled = false;
			stopAnimation();
			clearOverlayCallbacks();
			safely(split.hide);
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
						enabled = false;
						generation += 1;
						stopAnimation();
						clearOverlayCallbacks();
						safely(split.hide);
						safely(close);
					} else {
						if (enabled && generation === currentGeneration) {
							closeOverlay = close;
							restoreStoppedCursor = () => {
								// Pi can close overlays after stop() restored the terminal (#72).
								// The internal flag is optional; never change the cursor of a live TUI.
								if ((tui as unknown as { stopped?: boolean }).stopped === true) {
									tui.terminal.showCursor();
								}
							};
							requestOverlayRender = () => tui.requestRender();
							syncAnimation();
						} else {
							close();
						}
					}
					return createSidebarComponent({
						getSnapshot: binding.getSnapshot,
						getConfig: binding.getConfig,
						getHeight: () => tui.terminal.rows,
						isResizing: binding.isResizing,
						theme: theme as unknown as ThemeLike,
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
					if (generation !== currentGeneration) return;
					enabled = false;
					stopAnimation();
					clearOverlayCallbacks();
					safely(split.hide);
				});
		} catch (error) {
			if (generation === currentGeneration) {
				enabled = false;
				stopAnimation();
				clearOverlayCallbacks();
				safely(split.hide);
			}
			reportError(error);
		}
	};

	return {
		show: () => show(),
		hide,
		setMode(mode) {
			if (mode === "off") hide();
			else show(mode);
		},
		getStatus: split.getStatus,
		toggle() {
			if (split.getStatus().presentation === "shown") hide();
			else show();
		},
		isVisible() {
			return enabled && split.getStatus().presentation === "shown";
		},
		beginResize: split.beginResize,
		isResizing: split.isResizing,
		getWidth: split.getSidebarWidth,
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

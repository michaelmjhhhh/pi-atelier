import { homedir } from "node:os";
import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type OverlayHandle, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeLike } from "./footer.js";
import { formatTokens } from "./metrics.js";
import { type AtelierPalette, createPalette, type PaletteRole } from "./palette.js";
import {
	EMPTY_RUN_ACTIVITY,
	formatDuration,
	formatResponsePerformance,
	type RunActivitySnapshot,
	type ToolActivity,
} from "./run-activity.js";
import { createSplitPaneController, type SplitPaneController } from "./split-pane.js";
import type { AtelierConfig, AtelierState, WorkspacePulseState } from "./types.js";
import type { WorkspacePulseData } from "./workspace-pulse.js";

export interface SidebarSnapshotInput {
	state: AtelierState;
	cwd: string;
	sessionName?: string;
	sessionFile?: string;
	branchEntryCount: number;
	activeToolCount: number;
	availableToolCount: number;
	skillsCount: number;
	activeToolNames?: readonly string[];
	extensionStatuses: readonly string[];
	runActivity?: RunActivitySnapshot;
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
	skillsCount: number;
	activeToolNames: readonly string[];
	runActivity: RunActivitySnapshot;
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
		skillsCount: input.skillsCount,
		activeToolNames: [...new Set((input.activeToolNames ?? []).map(sanitize).filter(Boolean))].sort((a, b) =>
			a.localeCompare(b, "en"),
		),
		extensionStatuses: input.extensionStatuses,
		runActivity: input.runActivity ?? EMPTY_RUN_ACTIVITY,
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
	const divider = palette.paint(resizing ? "warning" : "dim", "│");
	return Array.from({ length: safeHeight }, (_, index) => {
		const content = truncateToWidth(rows[index] ?? "", contentWidth, "");
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
		return truncateToWidth(`${divider} ${content}${padding}`, safeWidth, "");
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
	const safeTitle = sanitize(title).toUpperCase();
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

const COMPACT_SIDEBAR_MAX_WIDTH = 43;

interface SidebarLayout {
	compact: boolean;
	showToolNames: boolean;
}

function sidebarLayout(width: number, config: AtelierConfig): SidebarLayout {
	const compact = width <= COMPACT_SIDEBAR_MAX_WIDTH;
	return {
		compact,
		showToolNames: config.showSidebarToolNames && !compact,
	};
}

function activityRole(activity: SidebarSnapshot["activity"]): PaletteRole {
	if (activity === "error") return "error";
	if (activity === "warning") return "warning";
	if (activity === "working") return "working";
	return "ready";
}

function activitySymbol(activity: SidebarSnapshot["activity"]): string {
	if (activity === "error") return "✕";
	if (activity === "warning") return "▲";
	if (activity === "working") return "◆";
	return "●";
}

function agentRows(
	snapshot: SidebarSnapshot,
	layout: SidebarLayout,
	contentWidth: number,
	palette: AtelierPalette,
	theme: ThemeLike,
): string[] {
	const activity = `${snapshot.activity.slice(0, 1).toUpperCase()}${snapshot.activity.slice(1)}`;
	const workingLabel =
		snapshot.activity === "working" && snapshot.workingLabel
			? sanitize(snapshot.workingLabel).toLowerCase()
			: "";
	const activityText = workingLabel ? `${activity} · ${workingLabel}` : activity;
	const status = theme.bold(
		palette.paint(
			activityRole(snapshot.activity),
			`${activitySymbol(snapshot.activity)} ${activityText || "—"}`,
		),
	);
	const model = valueRow(snapshot.modelId, palette, "primary");
	const provider = snapshot.provider ? palette.paint("muted", display(snapshot.provider).toUpperCase()) : "";
	const thinking = snapshot.thinkingLevel
		? palette.paint("primary", display(snapshot.thinkingLevel).toUpperCase())
		: "";
	const access =
		snapshot.modelId || snapshot.provider
			? palette.paint(
					snapshot.metrics.subscription ? "ready" : "muted",
					snapshot.metrics.subscription ? "SUBSCRIPTION" : "METERED",
				)
			: "";
	const separator = ` ${palette.paint("dim", "·")} `;

	if (layout.compact) {
		const rows = [status, model];
		if (provider) rows.push(provider);
		const secondary = [thinking, access].filter(Boolean);
		if (secondary.length > 0) rows.push(secondary.join(separator));
		return rows;
	}

	const metadata = [provider, thinking, access].filter(Boolean);
	return [
		spacedRow(status, model, contentWidth),
		metadata.length > 0 ? metadata.join(separator) : palette.paint("dim", "—"),
	];
}

function pulseIndicator(pulse: WorkspacePulseState): { symbol: string; role: PaletteRole } {
	if (pulse.status === "conflict") return { symbol: "✕", role: "error" };
	if (pulse.status === "changed") return { symbol: "▲", role: "warning" };
	if (pulse.status === "stale") return { symbol: "~", role: "warning" };
	if (pulse.status === "clean") return { symbol: "", role: "ready" };
	return { symbol: "", role: "dim" };
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
	layout: SidebarLayout,
	palette: AtelierPalette,
): WorkspacePulseRows {
	if (pulse.status === "inspecting") return { core: [palette.paint("muted", "inspecting…")], details: [] };
	if (pulse.status === "not-repo")
		return { core: [palette.paint("dim", "not a Git repository")], details: [] };
	if (pulse.status === "unavailable")
		return { core: [palette.paint("warning", "Git unavailable")], details: [] };
	if (!("data" in pulse)) return { core: [], details: [] };

	const { snapshot } = pulse.data;
	if (pulse.status === "clean") return { core: [palette.paint("ready", "✓ clean")], details: [] };
	const tracked = `${formatPulseCount(snapshot.trackedFiles)} tracked`;
	const lines = `+${formatPulseCount(snapshot.linesAdded)}  −${formatPulseCount(snapshot.linesRemoved)}`;
	const role = pulse.status === "stale" ? "warning" : "primary";
	const prefix = pulse.status === "stale" ? "~ stale · " : "";
	const core = layout.compact
		? [palette.paint(role, `${prefix}${tracked}`), palette.paint(role, lines)]
		: [palette.paint(role, `${prefix}${tracked}  ${lines}`)];
	if (snapshot.conflicts > 0)
		core.push(palette.paint("error", `${finiteCount(snapshot.conflicts)} conflicts`));
	const details = [
		snapshot.untrackedFiles > 0
			? layout.compact
				? `?${formatPulseCount(snapshot.untrackedFiles)}`
				: `${formatPulseCount(snapshot.untrackedFiles)} untracked`
			: "",
		snapshot.binaryFiles > 0
			? layout.compact
				? `bin${formatPulseCount(snapshot.binaryFiles)}`
				: `${formatPulseCount(snapshot.binaryFiles)} binary`
			: "",
		snapshot.submodules > 0
			? layout.compact
				? `sub${formatPulseCount(snapshot.submodules)}`
				: `${formatPulseCount(snapshot.submodules)} submodule`
			: "",
	].filter(Boolean);
	return { core, details: details.length > 0 ? [palette.paint("muted", details.join(" · "))] : [] };
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
	layout: SidebarLayout,
	palette: AtelierPalette,
): WorkspaceRows {
	const project = valueRow(snapshot.projectName, palette, "primary");
	const branch = snapshot.branch ? palette.paint("accent", display(snapshot.branch)) : "";
	const indicator = pulseIndicator(snapshot.workspacePulse);
	const gitState = branch && indicator.symbol ? palette.paint(indicator.role, indicator.symbol) : "";
	const identity = branch ? `${project} ${palette.paint("dim", "·")} ${branch} ${gitState}` : project;
	const identityRows = layout.compact ? [project, ...(branch ? [`${branch} ${gitState}`] : [])] : [identity];
	const pulseData = workspacePulseData(snapshot.workspacePulse);
	const location = pulseData?.relativeCwd
		? [palette.paint("muted", `./${sanitize(pulseData.relativeCwd)}`)]
		: pulseData
			? []
			: [palette.paint("muted", shortPath(snapshot.cwd))];
	const pulse = workspacePulseRows(snapshot.workspacePulse, layout, palette);
	const sessionName = snapshot.sessionName ? sanitize(snapshot.sessionName) : "";
	const session = [
		...(sessionName ? [palette.paint("primary", sessionName)] : []),
		`${palette.paint("primary", `${finiteCount(snapshot.branchEntryCount)} entries`)} ${palette.paint(
			"dim",
			"·",
		)} ${palette.paint(snapshot.persisted ? "ready" : "muted", snapshot.persisted ? "persisted" : "ephemeral")}`,
	];
	return {
		identity: identityRows,
		location,
		pulseCore: pulse.core,
		pulseDetails: pulse.details,
		session,
	};
}

function contextRole(snapshot: SidebarSnapshot, config: AtelierConfig): PaletteRole {
	const percent = snapshot.metrics.contextPercent;
	if (percent === null || !Number.isFinite(percent)) return "dim";
	if (percent >= config.contextDanger) return "error";
	if (percent >= config.contextWarning) return "warning";
	return "context";
}

function spacedRow(left: string, right: string, width: number): string {
	const safeWidth = Math.max(0, Math.trunc(width));
	const rightWidth = visibleWidth(right);
	const leftMax = Math.max(0, safeWidth - rightWidth - 1);
	const safeLeft = truncateToWidth(left, leftMax, "");
	const gap = " ".repeat(Math.max(1, safeWidth - visibleWidth(safeLeft) - rightWidth));
	return truncateToWidth(`${safeLeft}${gap}${right}`, safeWidth, "");
}

function contextRows(
	snapshot: SidebarSnapshot,
	config: AtelierConfig,
	contentWidth: number,
	layout: SidebarLayout,
	palette: AtelierPalette,
): string[] {
	const { metrics } = snapshot;
	const available =
		metrics.contextTokens !== null &&
		Number.isFinite(metrics.contextTokens) &&
		metrics.contextPercent !== null &&
		Number.isFinite(metrics.contextPercent);
	if (!available) {
		return [palette.paint("dim", "Context unavailable")];
	}

	const role = contextRole(snapshot, config);
	const usage = `${formatTokens(metrics.contextTokens ?? 0)} / ${
		metrics.contextWindow > 0 ? formatTokens(metrics.contextWindow) : "—"
	}`;
	const percent = `${metrics.contextPercent?.toFixed(1)}%`;
	const meterWidth = layout.compact
		? Math.max(1, Math.min(10, contentWidth - 2))
		: Math.max(1, Math.min(10, contentWidth - visibleWidth(usage) - visibleWidth(percent) - 4));
	const filled = Math.min(
		meterWidth,
		Math.max(0, Math.round(((metrics.contextPercent ?? 0) / 100) * meterWidth)),
	);
	const meter = `${palette.paint("dim", "[")}${palette.paint(role, "■".repeat(filled))}${palette.paint(
		"dim",
		"·".repeat(Math.max(0, meterWidth - filled)),
	)}${palette.paint("dim", "]")}`;
	if (layout.compact) {
		return [spacedRow(palette.paint(role, usage), palette.paint(role, percent), contentWidth), meter];
	}
	return [spacedRow(palette.paint(role, usage), palette.paint(role, percent), contentWidth), meter];
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

function metricValue(label: string, value: string, palette: AtelierPalette, role: PaletteRole): string {
	return `${palette.paint("muted", label)} ${palette.paint(role, value)}`;
}

function metricPairRows(
	left: string,
	right: string,
	contentWidth: number,
	layout: SidebarLayout,
	palette: AtelierPalette,
): string[] {
	const separator = layout.compact ? ` ${palette.paint("dim", "·")} ` : "  ";
	const inline = `${left}${separator}${right}`;
	return visibleWidth(inline) <= contentWidth ? [inline] : [left, right];
}

function usageRows(
	snapshot: SidebarSnapshot,
	config: AtelierConfig,
	contentWidth: number,
	layout: SidebarLayout,
	palette: AtelierPalette,
): string[] {
	const { metrics } = snapshot;
	if (!metrics.usageAvailable && !metrics.costAvailable) return [];

	const rows: string[] = [];
	if (metrics.usageAvailable) {
		rows.push(
			...metricPairRows(
				metricValue("In", formatUsageTokens(metrics.input), palette, "input"),
				metricValue("Out", formatUsageTokens(metrics.output), palette, "output"),
				contentWidth,
				layout,
				palette,
			),
		);
		const hit =
			metrics.cacheHitPercent !== undefined && Number.isFinite(metrics.cacheHitPercent)
				? `${metrics.cacheHitPercent.toFixed(1)}%`
				: "—";
		rows.push(
			...metricPairRows(
				metricValue("Cache", formatUsageTokens(metrics.cacheRead), palette, "cache"),
				layout.compact
					? palette.paint(hit === "—" ? "dim" : "cache", hit)
					: metricValue("Hit", hit, palette, hit === "—" ? "dim" : "cache"),
				contentWidth,
				layout,
				palette,
			),
		);
	}
	if (metrics.costAvailable && metrics.cost > 0) {
		const cost = `$${Math.max(0, Number.isFinite(metrics.cost) ? metrics.cost : 0).toFixed(
			currencyDecimals(config.currencyDecimals),
		)}`;
		rows.push(metricValue("Cost", cost, palette, "cost"));
	}
	return rows;
}

function toolsStatusRows(
	snapshot: SidebarSnapshot,
	showToolNames: boolean,
	contentWidth: number,
	palette: AtelierPalette,
): string[] {
	const disclosure = showToolNames ? "▾" : "▸";
	const rows = [
		spacedRow(
			palette.paint(
				"primary",
				`${finiteCount(snapshot.activeToolCount)} / ${finiteCount(snapshot.availableToolCount)} active`,
			),
			palette.paint("dim", disclosure),
			contentWidth,
		),
	];
	if (finiteCount(snapshot.skillsCount) > 0) {
		rows.push(spacedRow(palette.paint("primary", `${finiteCount(snapshot.skillsCount)} skills`), "", contentWidth));
	}
	return rows;
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
		while (groups[next]?.panel === group.panel) {
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
): string {
	const safeName = sanitize(tool.name) || "tool";
	const safeSummary = sanitize(tool.summary);
	const status = toolStatusLabel(tool, now);
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

function responsePerformanceRow(activity: RunActivitySnapshot, palette: AtelierPalette): string {
	return palette.paint("output", formatResponsePerformance(activity.performance));
}

function activityRows(
	activity: RunActivitySnapshot,
	contentWidth: number,
	palette: AtelierPalette,
	now: number,
): ActivityGroups {
	const activeIds = new Set(activity.activeTools.map((tool) => tool.id));
	const active = activity.activeTools
		.map((tool, index) => ({ index, tool }))
		.sort((left, right) => left.tool.startedAt - right.tool.startedAt || left.index - right.index)
		.map(({ tool }) => ({ id: tool.id, row: toolActivityRow(tool, contentWidth, palette, now) }));
	const recent = activity.recentTools
		.filter((tool) => !activeIds.has(tool.id))
		.slice(0, 3)
		.map((tool) => ({ id: tool.id, row: toolActivityRow(tool, contentWidth, palette, now) }));
	const aggregateText = aggregateActivityText(activity);
	return {
		core: [runSummaryRow(activity, palette, now), responsePerformanceRow(activity, palette)],
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
			panelRole,
			rows: groups.core,
			required: true,
			dropRank: Number.POSITIVE_INFINITY,
		},
		...groups.active.map((active, index, rows) => ({
			name: `activityActive:${active.id}`,
			panel: "ACTIVITY",
			panelRole,
			rows: [active.row],
			required: false,
			dropRank: 35 + (rows.length - index) / 100,
		})),
		...groups.recent.map((recent, index) => ({
			name: `activityRecent:${recent.id}`,
			panel: "ACTIVITY",
			panelRole,
			rows: [recent.row],
			required: false,
			dropRank: index === 0 ? 30 : 10 + (recentCount - index - 1),
		})),
		{
			name: "activityAggregate",
			panel: "ACTIVITY",
			panelRole,
			rows: groups.aggregate,
			required: false,
			dropRank: 20,
		},
	].filter((group) => group.rows.length > 0);
}

function composeGroups(
	groups: SidebarGroup[],
	height: number,
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
): SidebarGroup[] {
	let candidate = groups.filter((group) => group.rows.length > 0);
	while (renderGroups(candidate, width, palette, theme).length > height) {
		let dropIndex = -1;
		let dropRank = Number.POSITIVE_INFINITY;
		for (const [index, group] of candidate.entries()) {
			if (group.required || group.dropRank >= dropRank) continue;
			dropRank = group.dropRank;
			dropIndex = index;
		}
		if (dropIndex === -1) return candidate;
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
	const workspace = workspaceRows(snapshot, layout, palette);
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
		...(config.showSidebarAgent
			? [
					{
						name: "agent",
						panel: "AGENT",
						panelRole: activityRole(snapshot.activity),
						panelJewel: (snapshot.activity === "working" && Math.floor(now / 400) % 2 === 1 ? "✧" : "✦") as "✦" | "✧",
						rows: agentRows(snapshot, layout, panelContentWidth, palette, theme),
						required: true,
						dropRank: Number.POSITIVE_INFINITY,
					},
				]
			: []),
		...activitySidebarGroups(snapshot, panelContentWidth, palette, now).map((group) => ({
			...group,
			required: group.name === "activityCore",
			dropRank: group.name === "activityCore" ? Number.POSITIVE_INFINITY : group.dropRank + 40,
		})),
		{
			name: "statusDetails",
			panel: "ALERTS",
			panelRole: statusDetailPanelRole(snapshot),
			rows: statusDetailRows(snapshot, palette),
			required: false,
			dropRank: 80,
		},
		{
			name: "context",
			panel: "CONTEXT",
			panelRole: contextRole(snapshot, config),
			rows: contextRows(snapshot, config, panelContentWidth, layout, palette),
			required: true,
			dropRank: Number.POSITIVE_INFINITY,
		},
		{
			name: "workspaceCore",
			panel: "WORKSPACE",
			panelRole: "accent",
			rows: workspace.identity,
			required: false,
			dropRank: 30,
		},
		{
			name: "workspaceLocation",
			panel: "WORKSPACE",
			panelRole: "accent",
			rows: workspace.location,
			required: false,
			dropRank: 5,
		},
		{
			name: "workspaceCore",
			panel: "WORKSPACE",
			panelRole: "accent",
			rows: workspace.pulseCore,
			required: false,
			dropRank: 30,
		},
		{
			name: "workspaceDetails",
			panel: "WORKSPACE",
			panelRole: "accent",
			rows: workspace.pulseDetails,
			required: false,
			dropRank: 6,
		},
		{
			name: "workspaceSession",
			panel: "WORKSPACE",
			panelRole: "accent",
			rows: workspace.session,
			required: false,
			dropRank: 4,
		},
		{
			name: "usage",
			panel: "USAGE",
			panelRole: "output",
			rows: usageRows(snapshot, config, panelContentWidth, layout, palette),
			required: false,
			dropRank: 20,
		},
		{
			name: "toolsStatus",
			panel: "TOOLS",
			panelRole: "cache",
			rows: toolsStatusRows(snapshot, layout.showToolNames, panelContentWidth, palette),
			required: false,
			dropRank: 10,
		},
		...toolNameRows.map((row, index, rows) => ({
			name: `activeToolNames:${index}`,
			panel: "TOOLS",
			panelRole: "cache" as const,
			rows: [row],
			required: false,
			dropRank: (rows.length - index) / 100,
		})),
	];
	return renderDock(
		renderGroups(
			composeGroups(groups, safeHeight, contentWidth, palette, theme),
			contentWidth,
			palette,
			theme,
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

export function createSidebarController(options: SidebarControllerOptions): SidebarController {
	let enabled = false;
	let disposed = false;
	let generation = 0;
	let closeOverlay: (() => void) | undefined;
	let requestOverlayRender: (() => void) | undefined;
	let splitRequestRender: (() => void) | undefined;
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
		onResizeChange: () => {
			safely(() => requestOverlayRender?.());
			safely(() => splitRequestRender?.());
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
		if (!enabled || options.shouldAnimate?.() !== true || !requestOverlayRender) {
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
		requestOverlayRender = undefined;
		splitRequestRender = undefined;
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
		clearOverlayCallbacks();
		if (close) safely(close);
		else if (handle) safely(() => handle.hide());
		safely(split.hide);
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
						splitRequestRender = () => tui.requestRender();
						if (enabled && generation === currentGeneration) {
							closeOverlay = close;
							requestOverlayRender = () => tui.requestRender();
							syncAnimation();
						} else {
							close();
						}
					}
					return createSidebarComponent({
						getSnapshot: options.getSnapshot,
						getConfig: options.getConfig,
						getHeight: () => tui.terminal.rows,
						isResizing: split.isResizing,
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
		show,
		hide,
		toggle() {
			if (enabled) hide();
			else show();
		},
		isVisible() {
			return enabled;
		},
		beginResize: split.beginResize,
		isResizing: split.isResizing,
		getWidth: split.getSidebarWidth,
		requestRender() {
			safely(() => requestOverlayRender?.());
			safely(split.requestRender);
			syncAnimation();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			hide();
			safely(split.dispose);
		},
	};
}

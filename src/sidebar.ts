import { homedir } from "node:os";
import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ThemeLike } from "./footer.js";
import { formatTokens } from "./metrics.js";
import { type AtelierPalette, createPalette, type PaletteRole } from "./palette.js";
import {
	EMPTY_RUN_ACTIVITY,
	formatDuration,
	type RunActivitySnapshot,
	type ToolActivity,
} from "./run-activity.js";
import type { AtelierConfig, AtelierState } from "./types.js";

export interface SidebarSnapshotInput {
	state: AtelierState;
	cwd: string;
	sessionName?: string;
	sessionFile?: string;
	branchEntryCount: number;
	activeToolCount: number;
	availableToolCount: number;
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
	runActivity: RunActivitySnapshot;
}

export function buildSidebarSnapshot(input: SidebarSnapshotInput): SidebarSnapshot {
	const projectName = basename(input.cwd) || input.cwd;
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
		extensionStatuses: input.extensionStatuses,
		runActivity: input.runActivity ?? EMPTY_RUN_ACTIVITY,
	};
}

export function sidebarOverlayOptions(): OverlayOptions {
	return {
		anchor: "top-right",
		width: 44,
		maxHeight: "100%",
		margin: 0,
		nonCapturing: true,
		visible: (termWidth) => termWidth >= 88,
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

function renderDock(rows: string[], width: number, height: number, palette: AtelierPalette): string[] {
	const safeWidth = Math.max(0, Math.trunc(width));
	const safeHeight = Math.max(0, Math.trunc(height));
	if (safeWidth <= 0 || safeHeight <= 0) return [];
	const contentWidth = Math.max(0, safeWidth - 2);
	const divider = palette.paint("dim", "│");
	return Array.from({ length: safeHeight }, (_, index) => {
		const content = truncateToWidth(rows[index] ?? "", contentWidth, "");
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
		return truncateToWidth(`${divider} ${content}${padding}`, safeWidth, "");
	});
}

function headingRow(title: string, palette: AtelierPalette): string {
	return palette.paint("muted", sanitize(title).toUpperCase());
}

function valueRow(value: string | undefined, palette: AtelierPalette, role: PaletteRole): string {
	const text = display(value);
	return palette.paint(text === "—" ? "dim" : role, text);
}

function gitRow(snapshot: SidebarSnapshot, palette: AtelierPalette): string {
	const branch = display(snapshot.branch);
	const state = snapshot.branch ? (snapshot.dirty ? "modified" : "clean") : "—";
	return `${palette.paint(snapshot.branch ? "accent" : "dim", branch)} ${palette.paint("dim", "·")} ${palette.paint(
		snapshot.dirty ? "warning" : snapshot.branch ? "ready" : "dim",
		state,
	)}`;
}

function projectRows(snapshot: SidebarSnapshot, palette: AtelierPalette): string[] {
	return [
		headingRow("PROJECT", palette),
		valueRow(snapshot.projectName, palette, "primary"),
		palette.paint("muted", shortPath(snapshot.cwd)),
		gitRow(snapshot, palette),
		"",
	];
}

function agentRows(snapshot: SidebarSnapshot, palette: AtelierPalette, theme: ThemeLike): string[] {
	const provider = display(snapshot.provider);
	const thinking = display(snapshot.thinkingLevel);
	const activity = `${snapshot.activity.slice(0, 1).toUpperCase()}${snapshot.activity.slice(1)}`;
	const workingLabel =
		snapshot.activity === "working" && snapshot.workingLabel
			? sanitize(snapshot.workingLabel).toLowerCase()
			: "";
	const activityText = workingLabel ? `${activity} · ${workingLabel}` : activity;
	const activityRole: PaletteRole =
		snapshot.activity === "error"
			? "error"
			: snapshot.activity === "warning"
				? "warning"
				: snapshot.activity === "working"
					? "working"
					: "ready";
	return [
		headingRow("AGENT", palette),
		valueRow(snapshot.modelId, palette, "primary"),
		`${palette.paint(provider === "—" ? "dim" : "muted", provider)} ${palette.paint("dim", "·")} ${palette.paint(
			thinking === "—" ? "dim" : "primary",
			thinking,
		)}`,
		theme.bold(palette.paint(activityRole, activityText || "—")),
		"",
	];
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
	palette: AtelierPalette,
): string[] {
	const { metrics } = snapshot;
	const available =
		metrics.contextTokens !== null &&
		Number.isFinite(metrics.contextTokens) &&
		metrics.contextPercent !== null &&
		Number.isFinite(metrics.contextPercent);
	const role = contextRole(snapshot, config);
	const usage = available ? formatTokens(metrics.contextTokens ?? 0) : "—";
	const window = metrics.contextWindow > 0 ? formatTokens(metrics.contextWindow) : "—";
	const percent = available ? `${metrics.contextPercent?.toFixed(1)}%` : "—";
	const auto = metrics.autoCompact === null ? "—" : metrics.autoCompact ? "auto compact" : "manual compact";
	const barWidth = Math.max(0, contentWidth);
	const cells = available
		? Math.min(barWidth, Math.max(0, Math.round(((metrics.contextPercent ?? 0) / 100) * barWidth)))
		: 0;
	const bar = `${"█".repeat(cells)}${"░".repeat(Math.max(0, barWidth - cells))}`;
	return [
		headingRow("CONTEXT", palette),
		spacedRow(palette.paint(role, `${usage} / ${window}`), palette.paint(role, percent), contentWidth),
		palette.paint(role, bar),
		palette.paint(metrics.autoCompact === null ? "dim" : "muted", auto),
		"",
	];
}

function sessionRows(snapshot: SidebarSnapshot, palette: AtelierPalette): string[] {
	const rows = [headingRow("SESSION", palette)];
	const sessionName = snapshot.sessionName ? sanitize(snapshot.sessionName) : "";
	if (sessionName) rows.push(palette.paint("primary", sessionName));
	rows.push(
		`${palette.paint("primary", `${finiteCount(snapshot.branchEntryCount)} entries`)} ${palette.paint(
			"dim",
			"·",
		)} ${palette.paint(snapshot.persisted ? "ready" : "muted", snapshot.persisted ? "persisted" : "ephemeral")}`,
	);
	rows.push("");
	return rows;
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

function twoColumnRow(
	left: string,
	right: string,
	contentWidth: number,
	palette: AtelierPalette,
	leftRole: PaletteRole,
	rightRole: PaletteRole,
): string {
	const columnWidth = Math.max(0, Math.floor(contentWidth / 2));
	const rightWidth = Math.max(0, contentWidth - columnWidth);
	return `${padToWidth(palette.paint(leftRole, left), columnWidth)}${padToWidth(
		palette.paint(rightRole, right),
		rightWidth,
	)}`;
}

function usageRows(
	snapshot: SidebarSnapshot,
	config: AtelierConfig,
	contentWidth: number,
	palette: AtelierPalette,
): string[] {
	const { metrics } = snapshot;
	const unavailable = "—";
	const input = metrics.usageAvailable ? formatUsageTokens(metrics.input) : unavailable;
	const output = metrics.usageAvailable ? formatUsageTokens(metrics.output) : unavailable;
	const cache = metrics.usageAvailable ? formatUsageTokens(metrics.cacheRead) : unavailable;
	const hit =
		metrics.usageAvailable &&
		metrics.cacheHitPercent !== undefined &&
		Number.isFinite(metrics.cacheHitPercent)
			? `${metrics.cacheHitPercent.toFixed(1)}%`
			: unavailable;
	const cost = metrics.costAvailable
		? `$${Math.max(0, Number.isFinite(metrics.cost) ? metrics.cost : 0).toFixed(currencyDecimals(config.currencyDecimals))}`
		: "$—";
	const access = metrics.subscription ? "subscription" : "metered";
	return [
		headingRow("USAGE", palette),
		twoColumnRow("INPUT", "OUTPUT", contentWidth, palette, "muted", "muted"),
		twoColumnRow(input, output, contentWidth, palette, "input", "output"),
		twoColumnRow("CACHE", "HIT", contentWidth, palette, "muted", "muted"),
		twoColumnRow(cache, hit, contentWidth, palette, "cache", "cache"),
		twoColumnRow("COST", "ACCESS", contentWidth, palette, "muted", "muted"),
		twoColumnRow(cost, access, contentWidth, palette, "cost", metrics.subscription ? "ready" : "muted"),
		"",
	];
}

function toolsStatusRows(snapshot: SidebarSnapshot, palette: AtelierPalette): string[] {
	return [
		headingRow("TOOLS", palette),
		palette.paint(
			"primary",
			`${finiteCount(snapshot.activeToolCount)} / ${finiteCount(snapshot.availableToolCount)} active`,
		),
	];
}

function statusDetailRows(snapshot: SidebarSnapshot, palette: AtelierPalette): string[] {
	return snapshot.extensionStatuses.flatMap((status) => {
		const safe = sanitize(status);
		return safe ? [palette.paint("ready", safe)] : [];
	});
}

interface ActivityGroups {
	core: string[];
	recent: Array<{ id: string; row: string }>;
	aggregate: string[];
}

interface SidebarGroup {
	name: string;
	rows: string[];
	required: boolean;
	dropRank: number;
}

const flattenGroups = (groups: readonly SidebarGroup[]): string[] => groups.flatMap((group) => group.rows);

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

function activityRows(
	activity: RunActivitySnapshot,
	contentWidth: number,
	palette: AtelierPalette,
	now: number,
): ActivityGroups | undefined {
	const completed = finiteCount(activity.completedCount);
	const failed = finiteCount(activity.failedCount);
	const hasActivity =
		activity.activeTools.length > 0 || activity.recentTools.length > 0 || completed > 0 || failed > 0;
	if (activity.phase === "idle" && !hasActivity) return undefined;

	const activeIds = new Set(activity.activeTools.map((tool) => tool.id));
	const activeTools = activity.activeTools
		.map((tool, index) => ({ index, tool }))
		.sort((left, right) => left.tool.startedAt - right.tool.startedAt || left.index - right.index)
		.map(({ tool }) => tool);
	const recent = activity.recentTools
		.filter((tool) => !activeIds.has(tool.id))
		.slice(0, 3)
		.map((tool) => ({ id: tool.id, row: toolActivityRow(tool, contentWidth, palette, now) }));
	const aggregateText = aggregateActivityText(activity);
	return {
		core: [
			headingRow("ACTIVITY", palette),
			runSummaryRow(activity, palette, now),
			...activeTools.map((tool) => toolActivityRow(tool, contentWidth, palette, now)),
		],
		recent,
		aggregate: aggregateText
			? [palette.paint(activity.failedCount > 0 ? "error" : "ready", aggregateText), ""]
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
	if (!groups) return [];
	const recentCount = groups.recent.length;
	return [
		{ name: "activityCore", rows: groups.core, required: true, dropRank: Number.POSITIVE_INFINITY },
		...groups.recent.map((recent, index) => ({
			name: `activityRecent:${recent.id}`,
			rows: [recent.row],
			required: false,
			dropRank: index === 0 ? 30 : 10 + (recentCount - index - 1),
		})),
		{ name: "activityAggregate", rows: groups.aggregate, required: false, dropRank: 20 },
	].filter((group) => group.rows.length > 0);
}

function composeGroups(groups: SidebarGroup[], height: number): SidebarGroup[] {
	let candidate = groups;
	while (flattenGroups(candidate).length > height) {
		let dropIndex = -1;
		let dropRank = Number.POSITIVE_INFINITY;
		for (const [index, group] of candidate.entries()) {
			if (group.required || group.dropRank >= dropRank) continue;
			dropRank = group.dropRank;
			dropIndex = index;
		}
		if (dropIndex === -1) return candidate;
		candidate = candidate.filter((_group, index) => index !== dropIndex);
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
): string[] {
	const palette = createPalette(theme, colorEnabled);
	const safeWidth = Math.max(0, Math.trunc(width));
	const safeHeight = Math.max(0, Math.trunc(height));
	if (safeWidth <= 0 || safeHeight <= 0) return [];
	const contentWidth = Math.max(0, safeWidth - 2);
	const groups: SidebarGroup[] = [
		{
			name: "project",
			rows: projectRows(snapshot, palette),
			required: true,
			dropRank: Number.POSITIVE_INFINITY,
		},
		{
			name: "agent",
			rows: agentRows(snapshot, palette, theme),
			required: true,
			dropRank: Number.POSITIVE_INFINITY,
		},
		...activitySidebarGroups(snapshot, contentWidth, palette, now),
		{
			name: "context",
			rows: contextRows(snapshot, config, contentWidth, palette),
			required: true,
			dropRank: Number.POSITIVE_INFINITY,
		},
		{ name: "session", rows: sessionRows(snapshot, palette), required: false, dropRank: 60 },
		{
			name: "usage",
			rows: usageRows(snapshot, config, contentWidth, palette),
			required: false,
			dropRank: 50,
		},
		{ name: "toolsStatus", rows: toolsStatusRows(snapshot, palette), required: false, dropRank: 40 },
		{ name: "statusDetails", rows: statusDetailRows(snapshot, palette), required: false, dropRank: 0 },
	];
	return renderDock(flattenGroups(composeGroups(groups, safeHeight)), safeWidth, safeHeight, palette);
}

export interface SidebarComponentOptions {
	getSnapshot(): SidebarSnapshot;
	getConfig(): AtelierConfig;
	getHeight(): number;
	theme: ThemeLike;
	colorEnabled?: boolean;
}

function renderSidebarError(error: unknown, width: number, height: number): string[] {
	let detail = "Unknown error";
	try {
		detail = sanitize(error instanceof Error ? error.message : String(error)) || detail;
	} catch {
		// Keep the fallback render path safe even for unusual thrown values.
	}
	return renderDock(["Sidebar unavailable", detail], width, height, {
		paint: (_role, text) => text,
	});
}

export function createSidebarComponent(options: SidebarComponentOptions): Component {
	return {
		render(width) {
			const height = options.getHeight();
			try {
				return renderSidebarLines(
					options.getSnapshot(),
					options.getConfig(),
					options.theme,
					width,
					height,
					options.colorEnabled ?? true,
				);
			} catch (error) {
				return renderSidebarError(error, width, height);
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
	onError?(error: unknown): void;
}

export function createSidebarController(options: SidebarControllerOptions): SidebarController {
	let enabled = false;
	let generation = 0;
	let closeOverlay: (() => void) | undefined;
	let requestOverlayRender: (() => void) | undefined;
	let overlayHandle: OverlayHandle | undefined;
	let animationTimer: ReturnType<typeof setInterval> | undefined;
	const animationIntervalMs = Math.max(1, Math.trunc(options.animationIntervalMs ?? 1_000));

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
			requestOverlayRender?.();
		}, animationIntervalMs);
		animationTimer.unref?.();
	};

	const hide = () => {
		if (!enabled && !closeOverlay && !overlayHandle) return;
		enabled = false;
		generation += 1;
		stopAnimation();
		const close = closeOverlay;
		const handle = overlayHandle;
		closeOverlay = undefined;
		requestOverlayRender = undefined;
		overlayHandle = undefined;
		if (close) close();
		else handle?.hide();
	};

	const show = () => {
		if (enabled) return;
		if (options.ctx.mode !== "tui") {
			options.onError?.(new Error("Pi Atelier sidebar requires TUI mode"));
			return;
		}

		enabled = true;
		const currentGeneration = ++generation;
		try {
			const pending = options.ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					let closed = false;
					const close = () => {
						if (closed) return;
						closed = true;
						done(undefined);
					};
					if (enabled && generation === currentGeneration) {
						closeOverlay = close;
						requestOverlayRender = () => tui.requestRender();
						syncAnimation();
					} else {
						close();
					}
					return createSidebarComponent({
						getSnapshot: options.getSnapshot,
						getConfig: options.getConfig,
						getHeight: () => tui.terminal.rows,
						theme: theme as unknown as ThemeLike,
						...(options.colorEnabled === undefined ? {} : { colorEnabled: options.colorEnabled }),
					});
				},
				{
					overlay: true,
					overlayOptions: sidebarOverlayOptions(),
					onHandle: (handle) => {
						if (enabled && generation === currentGeneration) {
							overlayHandle = handle;
							syncAnimation();
						} else {
							handle.hide();
						}
					},
				},
			);
			void pending
				.catch((error: unknown) => options.onError?.(error))
				.finally(() => {
					if (generation !== currentGeneration) return;
					enabled = false;
					closeOverlay = undefined;
					requestOverlayRender = undefined;
					overlayHandle = undefined;
					syncAnimation();
				});
		} catch (error) {
			if (generation === currentGeneration) {
				enabled = false;
				closeOverlay = undefined;
				requestOverlayRender = undefined;
				overlayHandle = undefined;
				syncAnimation();
			}
			options.onError?.(error);
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
		requestRender() {
			requestOverlayRender?.();
			syncAnimation();
		},
		dispose: hide,
	};
}

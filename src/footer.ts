import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { formatTokens } from "./metrics.js";
import type { AtelierConfig, AtelierMetrics, AtelierState, SegmentId } from "./types.js";

export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export type ResponsiveMode = "gallery" | "balanced" | "focus" | "telemetry" | "safe";

interface FooterZones {
	workspace: string[];
	status?: string;
	menu?: string;
	telemetryFull: string[];
	requiredFull: string[];
	requiredCompact: string[];
}

const sanitize = (text: string): string =>
	text
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

export function selectResponsiveMode(width: number): ResponsiveMode {
	if (width >= 132) return "gallery";
	if (width >= 96) return "balanced";
	if (width >= 72) return "focus";
	if (width >= 56) return "telemetry";
	return "safe";
}

const unavailable = (theme: ThemeLike): string => theme.fg("dim", "—");
const usageValue = (metrics: AtelierMetrics, amount: number, theme: ThemeLike): string =>
	metrics.usageAvailable && Number.isFinite(amount) ? formatTokens(amount) : unavailable(theme);

function costValue(metrics: AtelierMetrics, decimals: number, compact: boolean, theme: ThemeLike): string {
	if (!metrics.costAvailable || !Number.isFinite(metrics.cost)) return unavailable(theme);
	if (compact && metrics.cost >= 1_000) return formatTokens(metrics.cost);
	return metrics.cost.toFixed(compact ? Math.min(2, decimals) : decimals);
}

function contextCore(metrics: AtelierMetrics, compact: boolean, theme: ThemeLike): string {
	const percent =
		metrics.contextPercent === null || !Number.isFinite(metrics.contextPercent)
			? "—"
			: `${metrics.contextPercent.toFixed(1)}%`;
	const capacity =
		Number.isFinite(metrics.contextWindow) && metrics.contextWindow >= 0
			? formatTokens(metrics.contextWindow)
			: unavailable(theme);
	return `${compact ? "" : "◔"}${percent}/${capacity}`;
}

function contextColor(metrics: AtelierMetrics, config: AtelierConfig): string {
	if (metrics.contextPercent === null || !Number.isFinite(metrics.contextPercent)) return "dim";
	if (metrics.contextPercent >= config.contextDanger) return "error";
	if (metrics.contextPercent >= config.contextWarning) return "warning";
	return "success";
}

function telemetry(metrics: AtelierMetrics, config: AtelierConfig, theme: ThemeLike) {
	const input = theme.fg("syntaxVariable", `↑${usageValue(metrics, metrics.input, theme)}`);
	const output = theme.fg("success", `↓${usageValue(metrics, metrics.output, theme)}`);
	const read = theme.fg("syntaxType", `R${usageValue(metrics, metrics.cacheRead, theme)}`);
	const write =
		metrics.cacheWrite > 0
			? theme.fg("syntaxType", `W${usageValue(metrics, metrics.cacheWrite, theme)}`)
			: "";
	const hitValue =
		metrics.cacheHitPercent !== undefined && Number.isFinite(metrics.cacheHitPercent)
			? `${metrics.cacheHitPercent.toFixed(1)}%`
			: unavailable(theme);
	const compactHitValue =
		metrics.cacheHitPercent !== undefined && Number.isFinite(metrics.cacheHitPercent)
			? `${Math.round(metrics.cacheHitPercent)}%`
			: unavailable(theme);
	const hit = theme.fg("syntaxType", `CH${hitValue}`);
	const compactHit = theme.fg("syntaxType", `CH${compactHitValue}`);
	const cost = theme.fg("warning", `$${costValue(metrics, config.currencyDecimals, false, theme)}`);
	const compactCost = theme.fg("warning", `$${costValue(metrics, config.currencyDecimals, true, theme)}`);
	const subscription = metrics.subscription ? theme.fg("muted", " (sub)") : "";
	const compactSubscription = metrics.subscription ? theme.fg("muted", "(sub)") : "";
	const context = theme.fg(contextColor(metrics, config), contextCore(metrics, false, theme));
	const compactContext = theme.fg(contextColor(metrics, config), contextCore(metrics, true, theme));
	const compaction =
		metrics.autoCompact === true
			? theme.fg("muted", " (auto)")
			: metrics.autoCompact === null
				? theme.fg("dim", " (—)")
				: "";
	const compactCompaction =
		metrics.autoCompact === true
			? theme.fg("muted", "(auto)")
			: metrics.autoCompact === null
				? theme.fg("dim", "(—)")
				: "";

	return {
		metricsFull: [
			`${input} ${output}`,
			[read, write, hit].filter(Boolean).join(" "),
			`${cost}${subscription}`,
		],
		metricsCompact: [
			`${input}${output}`,
			`${read}${write}`,
			`${compactHit}${compactCost}${compactSubscription}`,
		],
		contextFull: `${context}${compaction}`,
		contextCompact: `${compactContext}${compactCompaction}`,
	};
}

function activity(state: AtelierState, full: boolean, theme: ThemeLike): string {
	const labels = { ready: "READY", working: "WORKING", warning: "WARNING", error: "ERROR" } as const;
	const colors = { ready: "success", working: "accent", warning: "warning", error: "error" } as const;
	return theme.fg(colors[state.activity], full ? `● ${labels[state.activity]}` : "●");
}

function bounded(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width), "");
}

function buildZones(
	state: AtelierState,
	config: AtelierConfig,
	theme: ThemeLike,
	mode: ResponsiveMode,
): FooterZones {
	const enabled = new Set<SegmentId>(config.segments);
	const workspace: string[] = [];
	if (enabled.has("brand") && config.ornament !== "none") {
		if (mode === "gallery") workspace.push(theme.fg("accent", theme.bold("◆ ATELIER")));
		else if (mode === "balanced") workspace.push(theme.fg("accent", theme.bold("◆")));
	}
	if (enabled.has("activity") && mode !== "telemetry" && mode !== "safe") {
		workspace.push(activity(state, mode === "gallery" || mode === "balanced", theme));
	}
	if (
		enabled.has("model") &&
		state.modelId &&
		(mode === "gallery" || mode === "balanced" || mode === "focus")
	) {
		const modelBudget = mode === "gallery" ? 30 : mode === "balanced" ? 22 : 16;
		const thinking = state.thinkingLevel
			? mode === "gallery"
				? ` · ${state.thinkingLevel}`
				: mode === "balanced"
					? ` · ${state.thinkingLevel.slice(0, 1)}`
					: ""
			: "";
		workspace.push(`${theme.fg("text", bounded(state.modelId, modelBudget))}${theme.fg("muted", thinking)}`);
	}
	if (enabled.has("git") && state.branch && (mode === "gallery" || mode === "balanced")) {
		const branch = bounded(state.branch, mode === "gallery" ? 18 : 12);
		workspace.push(`${theme.fg("text", branch)}${state.dirty ? theme.fg("warning", " ✦") : ""}`);
	}
	let status: string | undefined;
	if (enabled.has("statuses") && config.showExtensionStatuses && mode === "gallery") {
		const statuses = state.extensionStatuses.map(sanitize).filter(Boolean).join(" ");
		if (statuses && visibleWidth(statuses) <= 24) status = theme.fg("muted", statuses);
	}

	const metrics = telemetry(state.metrics, config, theme);
	const shortcut = config.shortcut.toLowerCase() === "alt+a" ? "⌥A" : sanitize(config.shortcut).toUpperCase();
	const menu = enabled.has("menu")
		? theme.fg("accent", mode === "gallery" ? `${shortcut} MENU` : shortcut)
		: "";
	const telemetryFull: string[] = [];
	const telemetryCompact: string[] = [];
	const requiredFull: string[] = [];
	const requiredCompact: string[] = [];
	for (const id of config.segments) {
		if (id === "metrics") {
			telemetryFull.push(...metrics.metricsFull);
			telemetryCompact.push(...metrics.metricsCompact);
			requiredFull.push(...metrics.metricsFull);
			requiredCompact.push(...metrics.metricsCompact);
		} else if (id === "context") {
			telemetryFull.push(metrics.contextFull);
			telemetryCompact.push(metrics.contextCompact);
			requiredFull.push(metrics.contextFull);
			requiredCompact.push(metrics.contextCompact);
		} else if (id === "menu" && menu) {
			telemetryFull.push(menu);
			telemetryCompact.push(menu);
		}
	}
	return {
		workspace,
		...(status ? { status } : {}),
		...(menu ? { menu } : {}),
		telemetryFull: config.density === "compact" ? telemetryCompact : telemetryFull,
		requiredFull,
		requiredCompact,
	};
}

function joinGroups(groups: string[], separator: string): string {
	return groups.filter(Boolean).join(separator);
}

function renderGallery(zones: FooterZones, width: number): string {
	const right = joinGroups(zones.telemetryFull, "  ");
	let left = joinGroups(zones.workspace, "  ");
	if (zones.status) {
		const withStatus = joinGroups([...zones.workspace, zones.status], "  ");
		if (width - visibleWidth(withStatus) - visibleWidth(right) >= 2) left = withStatus;
	}
	const padding = width - visibleWidth(left) - visibleWidth(right);
	if (padding >= 2) return `${left}${" ".repeat(padding)}${right}`;
	return "";
}

function renderWithOptionalWorkspace(zones: FooterZones, width: number, separator: string): string {
	let workspace = [...zones.workspace];
	const required = zones.requiredCompact;
	while (workspace.length > 0 && visibleWidth(joinGroups([...workspace, ...required], separator)) > width) {
		workspace.pop();
	}
	let groups = [...workspace, ...required];
	if (zones.menu && visibleWidth(joinGroups([...groups, zones.menu], separator)) <= width) {
		groups = [...groups, zones.menu];
	}
	return joinGroups(groups, separator);
}

function renderBalanced(zones: FooterZones, width: number, theme: ThemeLike): string {
	return renderWithOptionalWorkspace(zones, width, theme.fg("borderMuted", " │ "));
}

function renderFocus(zones: FooterZones, width: number, theme: ThemeLike): string {
	return renderWithOptionalWorkspace(zones, width, theme.fg("borderMuted", " · "));
}

function renderTelemetry(zones: FooterZones): string {
	return joinGroups(zones.requiredCompact, " ");
}

export function renderFooterLine(
	state: AtelierState,
	config: AtelierConfig,
	theme: ThemeLike,
	width: number,
): string {
	if (width <= 0) return "";
	const mode = selectResponsiveMode(width);
	const zones = buildZones(state, config, theme, mode);
	let line: string;
	if (mode === "gallery") {
		line =
			renderGallery(zones, width) ||
			renderBalanced(buildZones(state, config, theme, "balanced"), width, theme);
	} else if (mode === "balanced") line = renderBalanced(zones, width, theme);
	else if (mode === "focus") line = renderFocus(zones, width, theme);
	else line = renderTelemetry(zones);
	return truncateToWidth(line, width, "");
}

export interface FooterComponentOptions {
	getState(): AtelierState;
	getConfig(): AtelierConfig;
	requestRender(): void;
	onBranchChange(callback: () => void): () => void;
	theme: ThemeLike;
}

export function createFooterComponent(options: FooterComponentOptions): Component & { dispose(): void } {
	let disposed = false;
	const unsubscribe = options.onBranchChange(options.requestRender);
	return {
		render(width) {
			return [renderFooterLine(options.getState(), options.getConfig(), options.theme, width)];
		},
		invalidate() {},
		dispose() {
			if (disposed) return;
			disposed = true;
			unsubscribe();
		},
	};
}

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

function headingRow(title: string, contentWidth: number, palette: AtelierPalette): string {
	const safeTitle = sanitize(title).toUpperCase();
	const prefix = `${safeTitle} `;
	const ruleWidth = Math.max(0, contentWidth - visibleWidth(prefix));
	return palette.paint("muted", `${prefix}${"─".repeat(ruleWidth)}`);
}

function valueRow(value: string | undefined, palette: AtelierPalette, role: PaletteRole): string {
	const text = display(value);
	return palette.paint(text === "—" ? "dim" : role, text);
}

function gitRow(snapshot: SidebarSnapshot, palette: AtelierPalette): string {
	const branch = display(snapshot.branch);
	const state = snapshot.branch ? (snapshot.dirty ? "modified" : "clean") : "—";
	return `${palette.paint(snapshot.branch ? "accent" : "dim", `◆ ${branch}`)} ${palette.paint(
		"dim",
		"•",
	)} ${palette.paint(snapshot.dirty ? "warning" : snapshot.branch ? "ready" : "dim", state)}`;
}

function renderBrandMark(theme: ThemeLike, palette: AtelierPalette): string[] {
	return [
		palette.paint("accent", "▛▀▜  ▀█▀"),
		palette.paint("accent", "▌ ▐   █ "),
		palette.paint("accent", "▙▄▟   █ "),
		theme.bold(palette.paint("primary", "ATELIER")),
	];
}

function projectRows(snapshot: SidebarSnapshot, contentWidth: number, palette: AtelierPalette): string[] {
	return [
		headingRow("PROJECT", contentWidth, palette),
		valueRow(snapshot.projectName, palette, "primary"),
		palette.paint("muted", shortPath(snapshot.cwd)),
		gitRow(snapshot, palette),
	];
}

function agentRows(
	snapshot: SidebarSnapshot,
	contentWidth: number,
	palette: AtelierPalette,
	theme: ThemeLike,
): string[] {
	const provider = display(snapshot.provider);
	const thinking = display(snapshot.thinkingLevel);
	const activityText =
		snapshot.activity === "working" && snapshot.workingLabel
			? sanitize(snapshot.workingLabel)
			: snapshot.activity.toUpperCase();
	const activityRole: PaletteRole =
		snapshot.activity === "error"
			? "error"
			: snapshot.activity === "warning"
				? "warning"
				: snapshot.activity === "working"
					? "working"
					: "ready";
	return [
		headingRow("AGENT", contentWidth, palette),
		valueRow(snapshot.modelId, palette, "primary"),
		`${palette.paint(provider === "—" ? "dim" : "muted", provider)} ${palette.paint("dim", "•")} ${palette.paint(
			thinking === "—" ? "dim" : "primary",
			thinking,
		)}`,
		theme.bold(palette.paint(activityRole, `● ${activityText || "—"}`)),
	];
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
	const barWidth = Math.min(20, Math.max(0, contentWidth));
	const cells = available
		? Math.min(barWidth, Math.max(0, Math.round(((metrics.contextPercent ?? 0) / 100) * barWidth)))
		: 0;
	const bar = `${"█".repeat(cells)}${"░".repeat(Math.max(0, barWidth - cells))}`;
	return [
		headingRow("CONTEXT", contentWidth, palette),
		palette.paint(role, `${usage} / ${window}  ${percent}`),
		palette.paint(role, bar),
		palette.paint(metrics.autoCompact === null ? "dim" : "muted", auto),
		"",
	];
}

function sessionRows(snapshot: SidebarSnapshot, contentWidth: number, palette: AtelierPalette): string[] {
	const rows = [headingRow("SESSION", contentWidth, palette)];
	const sessionName = snapshot.sessionName ? sanitize(snapshot.sessionName) : "";
	if (sessionName) rows.push(palette.paint("primary", sessionName));
	rows.push(
		`${palette.paint("primary", `${finiteCount(snapshot.branchEntryCount)} entries`)} ${palette.paint(
			"dim",
			"•",
		)} ${palette.paint(snapshot.persisted ? "ready" : "muted", snapshot.persisted ? "persisted" : "ephemeral")}`,
	);
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
		headingRow("USAGE", contentWidth, palette),
		twoColumnRow("INPUT", "OUTPUT", contentWidth, palette, "muted", "muted"),
		twoColumnRow(input, output, contentWidth, palette, "input", "output"),
		twoColumnRow("CACHE", "HIT", contentWidth, palette, "muted", "muted"),
		twoColumnRow(cache, hit, contentWidth, palette, "cache", "cache"),
		twoColumnRow("COST", "ACCESS", contentWidth, palette, "muted", "muted"),
		twoColumnRow(cost, access, contentWidth, palette, "cost", metrics.subscription ? "ready" : "muted"),
	];
}

function toolsRows(snapshot: SidebarSnapshot, contentWidth: number, palette: AtelierPalette): string[] {
	return [
		headingRow("TOOLS", contentWidth, palette),
		palette.paint(
			"primary",
			`${finiteCount(snapshot.activeToolCount)} / ${finiteCount(snapshot.availableToolCount)} active`,
		),
	];
}

function statusRows(snapshot: SidebarSnapshot, contentWidth: number, palette: AtelierPalette): string[] {
	const rows = [headingRow("STATUS", contentWidth, palette)];
	for (const status of snapshot.extensionStatuses) {
		const safe = sanitize(status);
		if (safe) rows.push(palette.paint("ready", `✓ ${safe}`));
	}
	if (rows.length === 1) rows.push(palette.paint("dim", "—"));
	return rows;
}

type SidebarGroup = {
	name: "brand" | "project" | "agent" | "context" | "session" | "usage" | "tools" | "statuses";
	rows: string[];
};

const flattenGroups = (groups: readonly SidebarGroup[]): string[] => groups.flatMap((group) => group.rows);

function composeGroups(required: SidebarGroup[], optional: SidebarGroup[], height: number): SidebarGroup[] {
	const groups = [...required, ...optional];
	if (flattenGroups(groups).length <= height) return groups;
	const remainingOptional = [...optional];
	while (remainingOptional.length > 0) {
		remainingOptional.pop();
		const candidate = [...required, ...remainingOptional];
		if (flattenGroups(candidate).length <= height) return candidate;
	}
	return required;
}

export function renderSidebarLines(
	snapshot: SidebarSnapshot,
	config: AtelierConfig,
	theme: ThemeLike,
	width: number,
	height: number,
	colorEnabled = true,
): string[] {
	const palette = createPalette(theme, colorEnabled);
	const safeWidth = Math.max(0, Math.trunc(width));
	const safeHeight = Math.max(0, Math.trunc(height));
	if (safeWidth <= 0 || safeHeight <= 0) return [];
	const contentWidth = Math.max(0, safeWidth - 2);
	const required: SidebarGroup[] = [
		{ name: "brand", rows: [...renderBrandMark(theme, palette), ""] },
		{ name: "project", rows: projectRows(snapshot, contentWidth, palette) },
		{ name: "agent", rows: agentRows(snapshot, contentWidth, palette, theme) },
		{ name: "context", rows: contextRows(snapshot, config, contentWidth, palette) },
	];
	const optional: SidebarGroup[] = [
		{ name: "session", rows: sessionRows(snapshot, contentWidth, palette) },
		{ name: "usage", rows: usageRows(snapshot, config, contentWidth, palette) },
		{ name: "tools", rows: toolsRows(snapshot, contentWidth, palette) },
		{ name: "statuses", rows: statusRows(snapshot, contentWidth, palette) },
	];
	return renderDock(
		flattenGroups(composeGroups(required, optional, safeHeight)),
		safeWidth,
		safeHeight,
		palette,
	);
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
	return renderDock(["PI ATELIER", "Sidebar unavailable", detail], width, height, {
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
	onError?(error: unknown): void;
}

export function createSidebarController(options: SidebarControllerOptions): SidebarController {
	let enabled = false;
	let generation = 0;
	let closeOverlay: (() => void) | undefined;
	let requestOverlayRender: (() => void) | undefined;
	let overlayHandle: OverlayHandle | undefined;

	const hide = () => {
		if (!enabled && !closeOverlay && !overlayHandle) return;
		enabled = false;
		generation += 1;
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
						if (enabled && generation === currentGeneration) overlayHandle = handle;
						else handle.hide();
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
				});
		} catch (error) {
			if (generation === currentGeneration) {
				enabled = false;
				closeOverlay = undefined;
				requestOverlayRender = undefined;
				overlayHandle = undefined;
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
		},
		dispose: hide,
	};
}

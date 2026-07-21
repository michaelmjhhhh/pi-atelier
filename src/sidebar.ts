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
		anchor: "right-center",
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

function titleRow(title: string, innerWidth: number, palette: AtelierPalette, theme: ThemeLike): string {
	const text = theme.bold(palette.paint("accent", sanitize(title)));
	const left = Math.max(0, Math.floor((innerWidth - visibleWidth(text)) / 2));
	return `${" ".repeat(left)}${text}`;
}

function sectionRow(title: string, _innerWidth: number, palette: AtelierPalette): string {
	return palette.paint("muted", sanitize(title).toUpperCase());
}

function valueRow(
	value: string | undefined,
	_innerWidth: number,
	palette: AtelierPalette,
	role: PaletteRole,
): string {
	const text = display(value);
	return palette.paint(text === "—" ? "dim" : role, text);
}

function gitRow(snapshot: SidebarSnapshot, _innerWidth: number, palette: AtelierPalette): string {
	const branch = display(snapshot.branch);
	const state = snapshot.branch ? (snapshot.dirty ? "modified" : "clean") : "—";
	return `${palette.paint(snapshot.branch ? "accent" : "dim", `◆ ${branch}`)} ${palette.paint(
		"dim",
		"•",
	)} ${palette.paint(snapshot.dirty ? "warning" : snapshot.branch ? "ready" : "dim", state)}`;
}

function agentRows(
	snapshot: SidebarSnapshot,
	innerWidth: number,
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
		valueRow(snapshot.modelId, innerWidth, palette, "primary"),
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
	_innerWidth: number,
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
	const cells = available
		? Math.min(20, Math.max(0, Math.round(((metrics.contextPercent ?? 0) / 100) * 20)))
		: 0;
	const bar = `${"█".repeat(cells)}${"░".repeat(20 - cells)}`;
	return [
		palette.paint(role, `${usage} / ${window}  ${percent}`),
		palette.paint(role, bar),
		palette.paint(metrics.autoCompact === null ? "dim" : "muted", auto),
	];
}

function sessionRows(snapshot: SidebarSnapshot, _innerWidth: number, palette: AtelierPalette): string[] {
	const rows = [valueRow(snapshot.sessionName, _innerWidth, palette, "primary")];
	if (snapshot.sessionFile) rows.push(palette.paint("muted", shortPath(snapshot.sessionFile)));
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

function usageRows(
	snapshot: SidebarSnapshot,
	config: AtelierConfig,
	_innerWidth: number,
	palette: AtelierPalette,
): string[] {
	const { metrics } = snapshot;
	const unavailable = "—";
	const input = metrics.usageAvailable ? formatTokens(metrics.input) : unavailable;
	const output = metrics.usageAvailable ? formatTokens(metrics.output) : unavailable;
	const cache = metrics.usageAvailable ? formatTokens(metrics.cacheRead) : unavailable;
	const hit =
		metrics.usageAvailable &&
		metrics.cacheHitPercent !== undefined &&
		Number.isFinite(metrics.cacheHitPercent)
			? `${metrics.cacheHitPercent.toFixed(1)}%`
			: unavailable;
	const cost = metrics.costAvailable
		? `$${Math.max(0, Number.isFinite(metrics.cost) ? metrics.cost : 0).toFixed(currencyDecimals(config.currencyDecimals))}`
		: "$—";
	return [
		`${palette.paint("input", `in ${input}`)} ${palette.paint("output", `out ${output}`)} ${palette.paint(
			"cache",
			`cache ${cache}`,
		)}`,
		`${palette.paint("cache", `hit ${hit}`)} ${palette.paint("cost", `cost ${cost}`)} ${palette.paint(
			metrics.subscription ? "ready" : "muted",
			metrics.subscription ? "subscription" : "metered",
		)}`,
	];
}

function statusRows(snapshot: SidebarSnapshot, _innerWidth: number, palette: AtelierPalette): string[] {
	const rows = [
		palette.paint(
			"primary",
			`${finiteCount(snapshot.activeToolCount)} / ${finiteCount(snapshot.availableToolCount)} active`,
		),
	];
	for (const status of snapshot.extensionStatuses) {
		const safe = sanitize(status);
		if (safe) rows.push(palette.paint("ready", `✓ ${safe}`));
	}
	return rows;
}

function frameRows(rows: string[], width: number, palette: AtelierPalette): string[] {
	const safeWidth = Math.max(0, Math.trunc(width));
	if (safeWidth <= 0) return [];
	const innerWidth = Math.max(0, safeWidth - 2);
	const border = (text: string) => palette.paint("dim", text);
	const framed = rows.map((row) => {
		const content = truncateToWidth(row, innerWidth, "");
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
		return truncateToWidth(`${border("│")}${content}${padding}${border("│")}`, safeWidth, "");
	});
	return [
		truncateToWidth(border(`╭${"─".repeat(innerWidth)}╮`), safeWidth, ""),
		...framed,
		truncateToWidth(border(`╰${"─".repeat(innerWidth)}╯`), safeWidth, ""),
	];
}

export function renderSidebarLines(
	snapshot: SidebarSnapshot,
	config: AtelierConfig,
	theme: ThemeLike,
	width: number,
	colorEnabled = true,
): string[] {
	if (width <= 0) return [];
	const palette = createPalette(theme, colorEnabled);
	const innerWidth = Math.max(1, width - 2);
	const rows = [
		titleRow("PI ATELIER", innerWidth, palette, theme),
		sectionRow("PROJECT", innerWidth, palette),
		valueRow(snapshot.projectName, innerWidth, palette, "primary"),
		valueRow(shortPath(snapshot.cwd), innerWidth, palette, "muted"),
		gitRow(snapshot, innerWidth, palette),
		sectionRow("AGENT", innerWidth, palette),
		agentRows(snapshot, innerWidth, palette, theme),
		sectionRow("CONTEXT", innerWidth, palette),
		contextRows(snapshot, config, innerWidth, palette),
		sectionRow("SESSION", innerWidth, palette),
		sessionRows(snapshot, innerWidth, palette),
		sectionRow("USAGE", innerWidth, palette),
		usageRows(snapshot, config, innerWidth, palette),
		sectionRow("TOOLS & STATUS", innerWidth, palette),
		statusRows(snapshot, innerWidth, palette),
	].flat();
	return frameRows(rows, width, palette);
}

export interface SidebarComponentOptions {
	getSnapshot(): SidebarSnapshot;
	getConfig(): AtelierConfig;
	theme: ThemeLike;
	colorEnabled?: boolean;
}

function renderSidebarError(error: unknown, width: number): string[] {
	let detail = "Unknown error";
	try {
		detail = sanitize(error instanceof Error ? error.message : String(error)) || detail;
	} catch {
		// Keep the fallback render path safe even for unusual thrown values.
	}
	return frameRows(["PI ATELIER", "Sidebar unavailable", detail], width, {
		paint: (_role, text) => text,
	});
}

export function createSidebarComponent(options: SidebarComponentOptions): Component {
	return {
		render(width) {
			try {
				return renderSidebarLines(
					options.getSnapshot(),
					options.getConfig(),
					options.theme,
					width,
					options.colorEnabled ?? true,
				);
			} catch (error) {
				return renderSidebarError(error, width);
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

import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens } from "./metrics.js";
import { type AtelierPalette, createPalette, type PaletteRole } from "./palette.js";
import { responsePerformanceValues } from "./run-activity.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { AtelierConfig, AtelierMetrics, AtelierState, DisplayValue, FooterState } from "./types.js";

export interface ThemeLike {
	readonly name?: string;
	fg(color: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
}

const WORKING_DOT_FRAMES = ["...", "..", "."] as const;
const WORKING_ANIMATION_INTERVAL_MS = 400;

// Nerd Font glyphs, matching the icon vocabulary used by shell prompts.
const FOOTER_ICONS = {
	brand: "\ue795", // nf-dev-terminal
	model: "\ueb08", // nf-cod-hubot
	thinking: "\uf0eb", // nf-fa-lightbulb
	git: "\uf418", // nf-oct-git_branch (Starship's Nerd Font preset)
	workspace: "\uf07b", // nf-fa-folder
	input: "\uf019", // nf-fa-download
	output: "\uf093", // nf-fa-upload
	cache: "\uf1c0", // nf-fa-database
	performance: "\uf017", // nf-fa-clock
	speed: "\uf0e7", // nf-fa-bolt
	context: "\uf2db", // nf-fa-microchip
	autoCompact: "\uf021", // nf-fa-refresh
	menu: "\uf013", // nf-fa-gear
	separator: "\ue0b1", // nf-pl-right_soft_divider
} as const;

const PLAIN_SYMBOLS: Record<keyof typeof FOOTER_ICONS, string> = {
	brand: "",
	model: "",
	thinking: "think",
	git: "git",
	workspace: "",
	input: "in",
	output: "out",
	cache: "cache",
	performance: "TTFT",
	speed: "TPS",
	context: "ctx",
	autoCompact: "auto",
	menu: "",
	separator: "|",
};
type FooterSymbols = typeof PLAIN_SYMBOLS;

type FooterZone = "left" | "right";
type FooterItemId =
	| "brand"
	| "status"
	| "activity"
	| "model"
	| "thinking"
	| "workspace"
	| "git"
	| "input"
	| "output"
	| "performance"
	| "cache"
	| "cost"
	| "context"
	| "menu";

interface FooterItem {
	id: FooterItemId;
	zone: FooterZone;
	full: string;
	compact: string;
	dropRank: number;
	required: boolean;
}

type FooterSurface = "all" | "header" | "telemetry";
const HEADER_ITEMS = new Set<FooterItemId>([
	"brand",
	"activity",
	"model",
	"thinking",
	"workspace",
	"git",
	"status",
	"context",
]);

// Related readings share a quiet space; separate concerns get a visible divider.
const ITEM_GROUP: Record<FooterItemId, string> = {
	brand: "brand",
	status: "status",
	activity: "activity",
	model: "model",
	thinking: "model",
	workspace: "workspace",
	git: "workspace",
	input: "usage",
	output: "usage",
	cache: "usage",
	cost: "usage",
	performance: "performance",
	context: "context",
	menu: "menu",
};

const DROP = {
	brand: 0,
	status: 0,
	git: 55,
	workspace: 50,
	thinking: 10,
	cost: 20,
	model: 60,
	input: 40,
	output: 40,
	performance: 45,
	cache: 50,
	menu: 0,
	activity: Number.POSITIVE_INFINITY,
	context: Number.POSITIVE_INFINITY,
} as const;

const sanitize = (text: string): string =>
	text
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

function paintValue(value: DisplayValue, role: PaletteRole, palette: AtelierPalette): string {
	return palette.paint(value.available ? role : "dim", value.text);
}

function metric(label: string, value: DisplayValue, palette: AtelierPalette, role: PaletteRole): string {
	return `${palette.paint("muted", label)} ${paintValue(value, role, palette)}`;
}

function availableValue(available: boolean, value: number): DisplayValue {
	return available && Number.isFinite(value)
		? { text: formatTokens(value), available: true }
		: { text: "—", available: false };
}

function percentValue(value: number | null | undefined, decimals: number): DisplayValue {
	return value !== null && value !== undefined && Number.isFinite(value)
		? { text: `${value.toFixed(decimals)}%`, available: true }
		: { text: "—", available: false };
}

function costValue(metrics: AtelierMetrics, decimals: number): DisplayValue {
	if (!metrics.costAvailable || !Number.isFinite(metrics.cost)) return { text: "$—", available: false };
	return { text: `$${metrics.cost.toFixed(decimals)}`, available: true };
}

function contextRole(metrics: AtelierMetrics, config: AtelierConfig): PaletteRole {
	if (metrics.contextPercent === null || !Number.isFinite(metrics.contextPercent)) return "context";
	if (metrics.contextPercent >= config.contextDanger) return "error";
	if (metrics.contextPercent >= config.contextWarning) return "warning";
	return "context";
}

function activityText(
	state: AtelierState,
	palette: AtelierPalette,
	theme: ThemeLike,
	workingDots: string,
	compact: boolean,
	nerdFont: boolean,
): string {
	const fallback = state.activity.toUpperCase();
	const label = state.activity === "working" && !compact ? (state.workingLabel ?? fallback) : fallback;
	const dots =
		state.activity === "working" && !compact ? workingDots.padEnd(WORKING_DOT_FRAMES[0].length, " ") : "";
	return palette.paint(state.activity, theme.bold(`${nerdFont ? "● " : ""}${sanitize(label)}${dots}`));
}

function buildItems(
	state: FooterState,
	config: AtelierConfig,
	theme: ThemeLike,
	colorEnabled: boolean,
	workingDots: string,
	symbols: FooterSymbols,
): FooterItem[] {
	const palette = createPalette(theme, colorEnabled);
	const items: FooterItem[] = [];
	const itemIds = new Set<FooterItemId>();
	const compactDensity = config.density === "compact";
	const icon = (symbol: string, text: string, role: PaletteRole = "muted"): string =>
		symbol ? `${palette.paint(role, symbol)} ${text}` : text;
	const add = (item: FooterItem): void => {
		if (itemIds.has(item.id)) return;
		itemIds.add(item.id);
		items.push(compactDensity ? { ...item, full: item.compact } : item);
	};

	for (const entry of config.segmentLayout) {
		if (!entry.visible) continue;
		const segment = entry.id;
		if (segment === "brand") {
			const brand = icon(symbols.brand, palette.paint("muted", "ATELIER"), "accent");
			add({
				id: "brand",
				zone: "left",
				full: brand,
				compact: brand,
				dropRank: DROP.brand,
				required: false,
			});
			continue;
		}

		if (segment === "activity") {
			add({
				id: "activity",
				zone: "left",
				full: activityText(state, palette, theme, workingDots, false, config.nerdFont),
				compact: activityText(state, palette, theme, workingDots, true, config.nerdFont),
				dropRank: DROP.activity,
				required: true,
			});
			continue;
		}

		if (segment === "model") {
			const model = state.modelId ? sanitize(state.modelId) : "";
			if (model) {
				const rendered = icon(symbols.model, palette.paint("accent", theme.bold(model)), "accent");
				add({
					id: "model",
					zone: "left",
					full: rendered,
					compact: icon(
						symbols.model,
						palette.paint("accent", theme.bold(truncateToWidth(model, 24, "…"))),
						"accent",
					),
					dropRank: DROP.model,
					required: false,
				});
			}
			const thinking = state.thinkingLevel ? sanitize(state.thinkingLevel) : "";
			if (thinking) {
				const role = thinking === "off" ? "dim" : "accent";
				const rendered = icon(symbols.thinking, palette.paint(role, thinking), role);
				add({
					id: "thinking",
					zone: "left",
					full: rendered,
					compact: rendered,
					dropRank: DROP.thinking,
					required: false,
				});
			}
			continue;
		}

		if (segment === "git") {
			const workspace = state.workspaceLabel ? sanitize(state.workspaceLabel) : "";
			if (workspace) {
				add({
					id: "workspace",
					zone: "left",
					full: icon(symbols.workspace, palette.paint("cache", workspace), "cache"),
					compact: icon(
						symbols.workspace,
						palette.paint("cache", truncateToWidth(workspace, 18, "…")),
						"cache",
					),
					dropRank: DROP.workspace,
					required: false,
				});
			}
			const branch = state.branch ? sanitize(state.branch) : "";
			if (branch) {
				const rendered = icon(
					symbols.git,
					`${palette.paint("input", branch)}${state.dirty ? palette.paint("warning", "*") : ""}`,
					"input",
				);
				add({
					id: "git",
					zone: "left",
					full: rendered,
					compact: icon(
						symbols.git,
						`${palette.paint("input", truncateToWidth(branch, 18, "…"))}${state.dirty ? palette.paint("warning", "*") : ""}`,
						"input",
					),
					dropRank: DROP.git,
					required: false,
				});
			}
			continue;
		}

		if (segment === "statuses") {
			const statuses = state.extensionStatuses.map(sanitize).filter(Boolean).join(" ");
			if (statuses) {
				const rendered = palette.paint("muted", statuses);
				add({
					id: "status",
					zone: "left",
					full: rendered,
					compact: rendered,
					dropRank: DROP.status,
					required: false,
				});
			}
			continue;
		}

		if (segment === "metrics") {
			const metrics = state.metrics;
			const input = availableValue(metrics.usageAvailable, metrics.input);
			const output = availableValue(metrics.usageAvailable, metrics.output);
			const cache = percentValue(metrics.cacheHitPercent, 0);
			const cacheDetail = [
				metric("read", availableValue(metrics.usageAvailable, metrics.cacheRead), palette, "cache"),
				metrics.cacheWrite > 0
					? metric("write", availableValue(metrics.usageAvailable, metrics.cacheWrite), palette, "cache")
					: "",
				metric("hit", percentValue(metrics.cacheHitPercent, 1), palette, "cache"),
			]
				.filter(Boolean)
				.join(" ");
			const cost = `${paintValue(costValue(metrics, config.currencyDecimals), "cost", palette)}${
				metrics.subscription ? palette.paint("muted", " (sub)") : ""
			}`;

			add({
				id: "input",
				zone: "right",
				full: icon(symbols.input, paintValue(input, "input", palette), input.available ? "input" : "dim"),
				compact: icon(symbols.input, paintValue(input, "input", palette)),
				dropRank: DROP.input,
				required: false,
			});
			add({
				id: "output",
				zone: "right",
				full: icon(
					symbols.output,
					paintValue(output, "output", palette),
					output.available ? "output" : "dim",
				),
				compact: icon(symbols.output, paintValue(output, "output", palette)),
				dropRank: DROP.output,
				required: false,
			});
			add({
				id: "cache",
				zone: "right",
				full: icon(
					symbols.cache,
					config.preset === "classic" ? cacheDetail : paintValue(cache, "cache", palette),
					cache.available ? "cache" : "dim",
				),
				compact: icon(symbols.cache, paintValue(cache, "cache", palette)),
				dropRank: DROP.cache,
				required: false,
			});
			add({ id: "cost", zone: "right", full: cost, compact: cost, dropRank: DROP.cost, required: false });
			continue;
		}

		if (segment === "performance") {
			const values = responsePerformanceValues(state.performance);
			const compact = [
				icon(symbols.performance, paintValue(values.ttft, "output", palette)),
				icon(
					symbols.speed,
					paintValue(values.tps, "output", palette) +
						(values.tps.available && config.nerdFont ? palette.paint("muted", "/s") : ""),
				),
			].join("  ");
			add({
				id: "performance",
				zone: "right",
				full: compact,
				compact,
				dropRank: DROP.performance,
				required: false,
			});
			continue;
		}

		if (segment === "context") {
			const metrics = state.metrics;
			const role = contextRole(metrics, config);
			const contextCompact = icon(
				symbols.context,
				paintValue(percentValue(metrics.contextPercent, 1), role, palette),
				role,
			);
			const contextFull = `${contextCompact}${
				Number.isFinite(metrics.contextWindow) && metrics.contextWindow > 0
					? palette.paint("muted", ` / ${formatTokens(metrics.contextWindow)}`)
					: ""
			}${metrics.autoCompact === true ? ` ${palette.paint("muted", symbols.autoCompact)}` : ""}`;
			add({
				id: "context",
				zone: "right",
				full: contextFull,
				compact: contextCompact,
				dropRank: DROP.context,
				required: true,
			});
			continue;
		}

		if (segment === "menu") {
			const configuredShortcut = sanitize(config.shortcut);
			const configuredLabel = configuredShortcut.toUpperCase();
			const shortcut =
				configuredShortcut && configuredShortcut.toLowerCase() !== DEFAULT_CONFIG.shortcut
					? `${DEFAULT_CONFIG.shortcut.toUpperCase()} / ${configuredLabel}`
					: DEFAULT_CONFIG.shortcut.toUpperCase();
			if (shortcut) {
				const rendered = palette.paint("menu", shortcut);
				add({
					id: "menu",
					zone: "right",
					full: icon(symbols.menu, rendered, "menu"),
					compact: rendered,
					dropRank: DROP.menu,
					required: false,
				});
			}
		}
	}

	return items;
}

function renderItems(
	items: FooterItem[],
	compactIds: Set<FooterItemId>,
	palette: AtelierPalette,
	separator: string,
): string {
	return items
		.map((item, index) => {
			const text = compactIds.has(item.id) ? item.compact : item.full;
			const previous = items[index - 1];
			if (!previous) return text;
			if (ITEM_GROUP[previous.id] !== ITEM_GROUP[item.id])
				return `${palette.paint("dim", ` ${separator} `)}${text}`;
			return `${ITEM_GROUP[item.id] === "model" || ITEM_GROUP[item.id] === "workspace" ? palette.paint("dim", " · ") : "  "}${text}`;
		})
		.join("");
}

function compose(
	items: FooterItem[],
	width: number,
	palette: AtelierPalette,
	separator: string,
	flow = false,
): string {
	const active = [...items];
	const compactIds = new Set<FooterItemId>();
	const left = () =>
		renderItems(
			active.filter((item) => item.zone === "left"),
			compactIds,
			palette,
			separator,
		);
	const right = () =>
		renderItems(
			active.filter((item) => item.zone === "right"),
			compactIds,
			palette,
			separator,
		);
	const measured = () => {
		const leftText = left();
		const rightText = right();
		return visibleWidth(leftText) + visibleWidth(rightText) + (leftText && rightText ? (flow ? 3 : 2) : 0);
	};

	const droppable = active.filter((item) => !item.required).sort((a, b) => a.dropRank - b.dropRank);
	// Long contributed statuses must not force the rest of the rail into compact form.
	for (const item of droppable.filter((candidate) => candidate.dropRank === 0)) {
		if (measured() <= width) break;
		const index = active.findIndex((candidate) => candidate.id === item.id);
		if (index >= 0) active.splice(index, 1);
	}

	// Give up secondary detail first; retain the model and prompt icons.
	if (measured() > width) compactIds.add("context");
	if (measured() > width) {
		for (const item of active) {
			if (item.id !== "activity" && item.full !== item.compact) compactIds.add(item.id);
		}
	}

	for (const item of droppable) {
		if (measured() <= width) break;
		const index = active.findIndex((candidate) => candidate.id === item.id);
		if (index >= 0) active.splice(index, 1);
	}

	for (const item of active.filter((candidate) => candidate.required)) {
		if (measured() <= width) break;
		if (item.full !== item.compact) compactIds.add(item.id);
	}

	// A clipped header would hide essential state from the complete footer below.
	if (flow && measured() > width) return "";

	const leftText = left();
	const rightText = right();
	if (flow) {
		return truncateToWidth(
			[leftText, rightText].filter(Boolean).join(palette.paint("dim", ` ${separator} `)),
			width,
			"",
		);
	}
	const gap = width - visibleWidth(leftText) - visibleWidth(rightText);
	if (leftText && rightText && gap >= 2) return `${leftText}${" ".repeat(gap)}${rightText}`;
	return truncateToWidth([leftText, rightText].filter(Boolean).join("  "), width, "");
}

export function renderFooterLine(
	state: FooterState,
	config: AtelierConfig,
	theme: ThemeLike,
	width: number,
	colorEnabled = true,
	workingDots = "...",
	surface: FooterSurface = "all",
): string {
	if (width <= 0) return "";
	const palette = createPalette(theme, colorEnabled);
	const symbols = config.nerdFont ? FOOTER_ICONS : PLAIN_SYMBOLS;
	let items = buildItems(state, config, theme, colorEnabled, workingDots, symbols);
	if (surface === "header") items = items.filter((item) => HEADER_ITEMS.has(item.id));
	if (surface === "telemetry") {
		const metrics = state.metrics;
		const available: Partial<Record<FooterItemId, boolean>> = {
			input: metrics.usageAvailable && Number.isFinite(metrics.input),
			output: metrics.usageAvailable && Number.isFinite(metrics.output),
			cache:
				Number.isFinite(metrics.cacheHitPercent) || (config.preset === "classic" && metrics.usageAvailable),
			cost: metrics.costAvailable && Number.isFinite(metrics.cost),
			performance: responsePerformanceValues(state.performance).ttft.available,
		};
		items = items
			.filter((item) => !HEADER_ITEMS.has(item.id) && available[item.id] !== false)
			.map((item) => ({ ...item, zone: item.id === "performance" || item.id === "menu" ? "right" : "left" }));
	}
	const line = compose(items, width, palette, symbols.separator, surface === "header");
	if (surface === "telemetry" && items.length > 0 && items.every((item) => item.zone === "right")) {
		return `${" ".repeat(Math.max(0, width - visibleWidth(line)))}${line}`;
	}
	return truncateToWidth(line, width, "");
}

export interface FooterComponentOptions {
	getState(): FooterState;
	getConfig(): AtelierConfig;
	colorEnabled?: boolean;
	requestRender(): void;
	onBranchChange(callback: () => void): () => void;
	theme: ThemeLike;
}

export interface AtelierFooterComponent extends Component {
	renderHeader(width: number): string;
	renderTelemetry(width: number): string[];
	dispose(): void;
}

export function createFooterComponent(options: FooterComponentOptions): AtelierFooterComponent {
	let disposed = false;
	let frameIndex = 0;
	let animationTimer: ReturnType<typeof setInterval> | undefined;
	const unsubscribe = options.onBranchChange(options.requestRender);

	const stopAnimation = (): void => {
		if (animationTimer) {
			clearInterval(animationTimer);
			animationTimer = undefined;
		}
		frameIndex = 0;
	};

	const syncAnimation = (visible: boolean): void => {
		if (disposed || !visible) {
			stopAnimation();
			return;
		}
		if (animationTimer) return;
		animationTimer = setInterval(() => {
			if (disposed) return;
			frameIndex = (frameIndex + 1) % WORKING_DOT_FRAMES.length;
			options.requestRender();
		}, WORKING_ANIMATION_INTERVAL_MS);
	};

	const renderSurface = (width: number, surface: FooterSurface): string => {
		const state = options.getState();
		const config = options.getConfig();
		const colorEnabled = options.colorEnabled ?? true;
		const workingDots = WORKING_DOT_FRAMES[frameIndex] ?? WORKING_DOT_FRAMES[0];
		const line = renderFooterLine(state, config, options.theme, width, colorEnabled, workingDots, surface);
		const fullActivity = activityText(
			state,
			createPalette(options.theme, colorEnabled),
			options.theme,
			workingDots,
			false,
			config.nerdFont,
		);
		if (surface !== "telemetry") syncAnimation(state.activity === "working" && line.includes(fullActivity));
		return line;
	};

	return {
		render(width) {
			return [renderSurface(width, "all")];
		},
		renderHeader(width) {
			return renderSurface(width, "header");
		},
		renderTelemetry(width) {
			const line = renderSurface(Math.max(0, width - 4), "telemetry");
			return line ? [`  ${line}  `] : [];
		},
		invalidate() {},
		dispose() {
			if (disposed) return;
			disposed = true;
			stopAnimation();
			unsubscribe();
		},
	};
}

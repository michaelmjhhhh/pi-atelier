import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "./config.js";
import { formatTokens } from "./metrics.js";
import { type AtelierPalette, createPalette, type PaletteRole, type ThemeLike } from "./palette.js";
import { responsePerformanceValues } from "./run-activity.js";
import { PLACEHOLDER, sanitizeInline } from "./text.js";
import type {
	AtelierConfig,
	AtelierMetrics,
	AtelierState,
	DisplayValue,
	FooterState,
	SegmentId,
} from "./types.js";

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
	full: string;
	compact: string;
}

type FooterSurface = "all" | "header" | "telemetry";

/**
 * Placement per item. Related readings share a `group` (a quiet space between
 * them); lower `dropRank` items give way first and `Infinity` marks required ones.
 */
const ITEM_META: Record<
	FooterItemId,
	{ zone: FooterZone; group: string; dropRank: number; header: boolean }
> = {
	brand: { zone: "left", group: "brand", dropRank: 0, header: true },
	status: { zone: "left", group: "status", dropRank: 0, header: true },
	activity: { zone: "left", group: "activity", dropRank: Number.POSITIVE_INFINITY, header: true },
	model: { zone: "left", group: "model", dropRank: 60, header: true },
	thinking: { zone: "left", group: "model", dropRank: 10, header: true },
	workspace: { zone: "left", group: "workspace", dropRank: 50, header: true },
	git: { zone: "left", group: "workspace", dropRank: 55, header: true },
	input: { zone: "right", group: "usage", dropRank: 40, header: false },
	output: { zone: "right", group: "usage", dropRank: 40, header: false },
	cache: { zone: "right", group: "usage", dropRank: 50, header: false },
	cost: { zone: "right", group: "usage", dropRank: 20, header: false },
	performance: { zone: "right", group: "performance", dropRank: 45, header: false },
	context: { zone: "right", group: "context", dropRank: Number.POSITIVE_INFINITY, header: true },
	menu: { zone: "right", group: "menu", dropRank: 0, header: false },
};

const isRequired = (item: FooterItem): boolean => ITEM_META[item.id].dropRank === Number.POSITIVE_INFINITY;

function paintValue(value: DisplayValue, role: PaletteRole, palette: AtelierPalette): string {
	return palette.paint(value.available ? role : "dim", value.text);
}

function metric(label: string, value: DisplayValue, palette: AtelierPalette, role: PaletteRole): string {
	return `${palette.paint("muted", label)} ${paintValue(value, role, palette)}`;
}

function availableValue(available: boolean, value: number): DisplayValue {
	return available ? { text: formatTokens(value), available: true } : { text: PLACEHOLDER, available: false };
}

function percentValue(value: number | null | undefined, decimals: number): DisplayValue {
	return value !== null && value !== undefined
		? { text: `${value.toFixed(decimals)}%`, available: true }
		: { text: PLACEHOLDER, available: false };
}

function costValue(metrics: AtelierMetrics, decimals: number): DisplayValue {
	if (!metrics.costAvailable) return { text: `$${PLACEHOLDER}`, available: false };
	return { text: `$${metrics.cost.toFixed(decimals)}`, available: true };
}

/** Threshold color for context usage; `fallback` covers an unknown percentage. */
export function contextRole(
	percent: number | null,
	config: Pick<AtelierConfig, "contextWarning" | "contextDanger">,
	fallback: PaletteRole,
): PaletteRole {
	if (percent === null) return fallback;
	if (percent >= config.contextDanger) return "error";
	if (percent >= config.contextWarning) return "warning";
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
	return palette.paint(state.activity, theme.bold(`${nerdFont ? "● " : ""}${sanitizeInline(label)}${dots}`));
}

interface ItemContext {
	state: FooterState;
	config: AtelierConfig;
	theme: ThemeLike;
	palette: AtelierPalette;
	symbols: FooterSymbols;
	workingDots: string;
}

const item = (id: FooterItemId, full: string, compact = full): FooterItem => ({ id, full, compact });

function iconFor(palette: AtelierPalette) {
	return (symbol: string, text: string, role: PaletteRole = "muted"): string =>
		symbol ? `${palette.paint(role, symbol)} ${text}` : text;
}

const SEGMENT_ITEMS: Record<SegmentId, (context: ItemContext) => FooterItem[]> = {
	brand: ({ palette, symbols }) => [
		item("brand", iconFor(palette)(symbols.brand, palette.paint("muted", "ATELIER"), "accent")),
	],
	activity: ({ state, palette, theme, workingDots, config }) => [
		item(
			"activity",
			activityText(state, palette, theme, workingDots, false, config.nerdFont),
			activityText(state, palette, theme, workingDots, true, config.nerdFont),
		),
	],
	model: ({ state, palette, theme, symbols }) => {
		const icon = iconFor(palette);
		const items: FooterItem[] = [];
		const model = state.modelId ? sanitizeInline(state.modelId) : "";
		if (model) {
			const paint = (text: string) =>
				icon(symbols.model, palette.paint("accent", theme.bold(text)), "accent");
			items.push(item("model", paint(model), paint(truncateToWidth(model, 24, "…"))));
		}
		const thinking = state.thinkingLevel ? sanitizeInline(state.thinkingLevel) : "";
		if (thinking) {
			const role = thinking === "off" ? "dim" : "accent";
			items.push(item("thinking", icon(symbols.thinking, palette.paint(role, thinking), role)));
		}
		return items;
	},
	git: ({ state, palette, symbols }) => {
		const icon = iconFor(palette);
		const items: FooterItem[] = [];
		const workspace = state.workspaceLabel ? sanitizeInline(state.workspaceLabel) : "";
		if (workspace) {
			const paint = (text: string) => icon(symbols.workspace, palette.paint("cache", text), "cache");
			items.push(item("workspace", paint(workspace), paint(truncateToWidth(workspace, 18, "…"))));
		}
		const branch = state.branch ? sanitizeInline(state.branch) : "";
		if (branch) {
			const dirty = state.dirty ? palette.paint("warning", "*") : "";
			const paint = (text: string) => icon(symbols.git, `${palette.paint("input", text)}${dirty}`, "input");
			items.push(item("git", paint(branch), paint(truncateToWidth(branch, 18, "…"))));
		}
		return items;
	},
	statuses: ({ state, palette }) => {
		const statuses = state.extensionStatuses.map(sanitizeInline).filter(Boolean).join(" ");
		return statuses ? [item("status", palette.paint("muted", statuses))] : [];
	},
	metrics: ({ state: { metrics }, config, palette, symbols }) => {
		const icon = iconFor(palette);
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
		return [
			item(
				"input",
				icon(symbols.input, paintValue(input, "input", palette), input.available ? "input" : "dim"),
				icon(symbols.input, paintValue(input, "input", palette)),
			),
			item(
				"output",
				icon(symbols.output, paintValue(output, "output", palette), output.available ? "output" : "dim"),
				icon(symbols.output, paintValue(output, "output", palette)),
			),
			item(
				"cache",
				icon(
					symbols.cache,
					config.preset === "classic" ? cacheDetail : paintValue(cache, "cache", palette),
					cache.available ? "cache" : "dim",
				),
				icon(symbols.cache, paintValue(cache, "cache", palette)),
			),
			item("cost", cost),
		];
	},
	performance: ({ state, config, palette, symbols }) => {
		const icon = iconFor(palette);
		const values = responsePerformanceValues(state.performance);
		const speedUnit = values.tps.available && config.nerdFont ? palette.paint("muted", "/s") : "";
		return [
			item(
				"performance",
				[
					icon(symbols.performance, paintValue(values.ttft, "output", palette)),
					icon(symbols.speed, paintValue(values.tps, "output", palette) + speedUnit),
				].join("  "),
			),
		];
	},
	context: ({ state: { metrics }, config, palette, symbols }) => {
		const role = contextRole(metrics.contextPercent, config, "context");
		const compact = iconFor(palette)(
			symbols.context,
			paintValue(percentValue(metrics.contextPercent, 1), role, palette),
			role,
		);
		const window =
			metrics.contextWindow > 0 ? palette.paint("muted", ` / ${formatTokens(metrics.contextWindow)}`) : "";
		const autoCompact = metrics.autoCompact ? ` ${palette.paint("muted", symbols.autoCompact)}` : "";
		return [item("context", `${compact}${window}${autoCompact}`, compact)];
	},
	menu: ({ config, palette, symbols }) => {
		const defaultLabel = DEFAULT_CONFIG.shortcut.toUpperCase();
		const configured = sanitizeInline(config.shortcut).toLowerCase();
		const shortcut =
			configured && configured !== DEFAULT_CONFIG.shortcut
				? `${defaultLabel} / ${configured.toUpperCase()}`
				: defaultLabel;
		const rendered = palette.paint("menu", shortcut);
		return [item("menu", iconFor(palette)(symbols.menu, rendered, "menu"), rendered)];
	},
};

function buildItems(context: ItemContext): FooterItem[] {
	const compactDensity = context.config.density === "compact";
	return context.config.segmentLayout
		.filter((entry) => entry.visible)
		.flatMap((entry) => SEGMENT_ITEMS[entry.id](context))
		.map((footerItem) => (compactDensity ? { ...footerItem, full: footerItem.compact } : footerItem));
}

interface PlacedItem extends FooterItem {
	zone: FooterZone;
}

function renderZone(
	items: readonly PlacedItem[],
	compactIds: ReadonlySet<FooterItemId>,
	palette: AtelierPalette,
	separator: string,
): string {
	return items
		.map((placed, index) => {
			const text = compactIds.has(placed.id) ? placed.compact : placed.full;
			const previous = items[index - 1];
			if (!previous) return text;
			const group = ITEM_META[placed.id].group;
			if (ITEM_META[previous.id].group !== group) return `${palette.paint("dim", ` ${separator} `)}${text}`;
			return `${group === "model" || group === "workspace" ? palette.paint("dim", " · ") : "  "}${text}`;
		})
		.join("");
}

/** Fit items to `width`: drop optional items, then fall back to compact forms. */
function compose(
	items: readonly PlacedItem[],
	width: number,
	palette: AtelierPalette,
	separator: string,
	flow: boolean,
): string {
	const active = [...items];
	const compactIds = new Set<FooterItemId>();
	const zone = (side: FooterZone) =>
		renderZone(
			active.filter((placed) => placed.zone === side),
			compactIds,
			palette,
			separator,
		);
	const flowGap = visibleWidth(` ${separator} `);
	const measured = () => {
		const leftText = zone("left");
		const rightText = zone("right");
		return (
			visibleWidth(leftText) + visibleWidth(rightText) + (leftText && rightText ? (flow ? flowGap : 2) : 0)
		);
	};
	const drop = (candidates: readonly PlacedItem[]): void => {
		for (const candidate of candidates) {
			if (measured() <= width) return;
			const index = active.indexOf(candidate);
			if (index >= 0) active.splice(index, 1);
		}
	};

	const droppable = active
		.filter((placed) => !isRequired(placed))
		.sort((a, b) => ITEM_META[a.id].dropRank - ITEM_META[b.id].dropRank);
	// Long contributed statuses must not force the rest of the rail into compact form.
	drop(droppable.filter((placed) => ITEM_META[placed.id].dropRank === 0));

	// Give up secondary detail first; retain the model and prompt icons.
	if (measured() > width) compactIds.add("context");
	if (measured() > width) {
		for (const placed of active) {
			if (placed.id !== "activity" && placed.full !== placed.compact) compactIds.add(placed.id);
		}
	}
	drop(droppable);
	for (const placed of active.filter(isRequired)) {
		if (measured() <= width) break;
		if (placed.full !== placed.compact) compactIds.add(placed.id);
	}

	// A clipped header would hide essential state from the complete footer below.
	if (flow && measured() > width) return "";

	const leftText = zone("left");
	const rightText = zone("right");
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

export interface FooterRenderOptions {
	colorEnabled?: boolean;
	workingDots?: string;
	surface?: FooterSurface;
}

interface RenderedFooter {
	line: string;
	/** Full-width working activity text, when the layout shows it. */
	workingActivity: string | undefined;
}

function renderFooter(
	state: FooterState,
	config: AtelierConfig,
	theme: ThemeLike,
	width: number,
	{ colorEnabled = true, workingDots = WORKING_DOT_FRAMES[0], surface = "all" }: FooterRenderOptions,
): RenderedFooter {
	if (width <= 0) return { line: "", workingActivity: undefined };
	const palette = createPalette(theme, colorEnabled);
	const symbols = config.nerdFont ? FOOTER_ICONS : PLAIN_SYMBOLS;
	const items = buildItems({ state, config, theme, palette, symbols, workingDots });
	const workingActivity =
		state.activity === "working" && config.density !== "compact"
			? items.find((footerItem) => footerItem.id === "activity")?.full
			: undefined;
	let placed: PlacedItem[];
	if (surface === "telemetry") {
		const { metrics } = state;
		const available: Partial<Record<FooterItemId, boolean>> = {
			input: metrics.usageAvailable,
			output: metrics.usageAvailable,
			cache: metrics.cacheHitPercent !== undefined || (config.preset === "classic" && metrics.usageAvailable),
			cost: metrics.costAvailable,
			performance: responsePerformanceValues(state.performance).ttft.available,
		};
		placed = items
			.filter((footerItem) => !ITEM_META[footerItem.id].header && available[footerItem.id] !== false)
			.map((footerItem) => ({
				...footerItem,
				zone: footerItem.id === "performance" || footerItem.id === "menu" ? "right" : "left",
			}));
	} else {
		placed = items
			.filter((footerItem) => surface === "all" || ITEM_META[footerItem.id].header)
			.map((footerItem) => ({ ...footerItem, zone: ITEM_META[footerItem.id].zone }));
	}
	const line = compose(placed, width, palette, symbols.separator, surface === "header");
	if (
		surface === "telemetry" &&
		placed.length > 0 &&
		placed.every((footerItem) => footerItem.zone === "right")
	) {
		return { line: `${" ".repeat(Math.max(0, width - visibleWidth(line)))}${line}`, workingActivity };
	}
	return { line: truncateToWidth(line, width, ""), workingActivity };
}

export function renderFooterLine(
	state: FooterState,
	config: AtelierConfig,
	theme: ThemeLike,
	width: number,
	options: FooterRenderOptions = {},
): string {
	return renderFooter(state, config, theme, width, options).line;
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
		const { line, workingActivity } = renderFooter(
			options.getState(),
			options.getConfig(),
			options.theme,
			width,
			{
				colorEnabled: options.colorEnabled ?? true,
				workingDots: WORKING_DOT_FRAMES[frameIndex] ?? WORKING_DOT_FRAMES[0],
				surface,
			},
		);
		// Animate only while the full working label is on screen; the telemetry row never shows it.
		if (surface !== "telemetry")
			syncAnimation(workingActivity !== undefined && line.includes(workingActivity));
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

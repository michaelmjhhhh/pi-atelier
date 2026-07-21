import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens } from "./metrics.js";
import { type AtelierPalette, createPalette, type PaletteRole } from "./palette.js";
import type { AtelierConfig, AtelierMetrics, AtelierState } from "./types.js";

export interface ThemeLike {
	readonly name?: string;
	fg(color: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
}

export type ResponsiveMode = "gallery" | "balanced" | "focus" | "telemetry" | "safe";

const WORKING_DOT_FRAMES = ["...", "..", "."] as const;
const WORKING_ANIMATION_INTERVAL_MS = 400;

type FooterZone = "left" | "right";
type FooterItemId =
	| "brand"
	| "status"
	| "activity"
	| "model"
	| "thinking"
	| "git"
	| "input"
	| "output"
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

const DROP = {
	brand: 0,
	status: 0,
	git: 10,
	thinking: 10,
	cost: 20,
	model: 30,
	input: 40,
	output: 40,
	cache: 50,
	menu: 60,
	activity: Number.POSITIVE_INFINITY,
	context: Number.POSITIVE_INFINITY,
} as const;

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

interface DisplayValue {
	text: string;
	available: boolean;
}

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

function costValue(metrics: AtelierMetrics, decimals: number, compact: boolean): DisplayValue {
	if (!metrics.costAvailable || !Number.isFinite(metrics.cost)) return { text: "$—", available: false };
	const amount =
		compact && metrics.cost >= 1_000
			? formatTokens(metrics.cost)
			: metrics.cost.toFixed(compact ? Math.min(2, decimals) : decimals);
	return { text: `$${amount}`, available: true };
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
): string {
	const fallback = state.activity.toUpperCase();
	const label = state.activity === "working" && !compact ? (state.workingLabel ?? fallback) : fallback;
	const dots = state.activity === "working" && !compact ? workingDots : "";
	const role: PaletteRole =
		state.activity === "ready"
			? "ready"
			: state.activity === "working"
				? "working"
				: state.activity === "warning"
					? "warning"
					: "error";
	return palette.paint(role, theme.bold(`● ${sanitize(label)}${dots}`));
}

function buildItems(
	state: AtelierState,
	config: AtelierConfig,
	theme: ThemeLike,
	colorEnabled: boolean,
	workingDots: string,
): FooterItem[] {
	const palette = createPalette(theme, colorEnabled);
	const items: FooterItem[] = [];
	const itemIds = new Set<FooterItemId>();
	const compactDensity = config.density === "compact";
	const add = (item: FooterItem): void => {
		if (itemIds.has(item.id)) return;
		itemIds.add(item.id);
		items.push(compactDensity ? { ...item, full: item.compact } : item);
	};

	for (const segment of config.segments) {
		if (segment === "brand") {
			if (config.preset !== "editorial" && config.ornament !== "none") {
				const brand = palette.paint("muted", "ATELIER");
				add({
					id: "brand",
					zone: "left",
					full: brand,
					compact: brand,
					dropRank: DROP.brand,
					required: false,
				});
			}
			continue;
		}

		if (segment === "activity") {
			add({
				id: "activity",
				zone: "left",
				full: activityText(state, palette, theme, workingDots, false),
				compact: activityText(state, palette, theme, workingDots, true),
				dropRank: DROP.activity,
				required: true,
			});
			continue;
		}

		if (segment === "model") {
			const model = state.modelId ? sanitize(state.modelId) : "";
			if (model) {
				const rendered = palette.paint("primary", model);
				add({
					id: "model",
					zone: "left",
					full: rendered,
					compact: rendered,
					dropRank: DROP.model,
					required: false,
				});
			}
			const thinking = state.thinkingLevel ? sanitize(state.thinkingLevel) : "";
			if (thinking) {
				const rendered = palette.paint("muted", thinking);
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
			const branch = state.branch ? sanitize(state.branch) : "";
			if (branch) {
				const rendered = `${palette.paint("primary", branch)}${state.dirty ? palette.paint("warning", "*") : ""}`;
				add({
					id: "git",
					zone: "left",
					full: rendered,
					compact: rendered,
					dropRank: DROP.git,
					required: false,
				});
			}
			continue;
		}

		if (segment === "statuses") {
			if (config.showExtensionStatuses) {
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
			}
			continue;
		}

		if (segment === "metrics") {
			const metrics = state.metrics;
			const inputFull = metric("in", availableValue(metrics.usageAvailable, metrics.input), palette, "input");
			const outputFull = metric(
				"out",
				availableValue(metrics.usageAvailable, metrics.output),
				palette,
				"output",
			);
			const cacheHit = metric("cache", percentValue(metrics.cacheHitPercent, 0), palette, "cache");
			const cacheDetail = [
				metric("read", availableValue(metrics.usageAvailable, metrics.cacheRead), palette, "cache"),
				metrics.cacheWrite > 0
					? metric("write", availableValue(metrics.usageAvailable, metrics.cacheWrite), palette, "cache")
					: "",
				metric("hit", percentValue(metrics.cacheHitPercent, 1), palette, "cache"),
			]
				.filter(Boolean)
				.join(" ");
			const cost = `${paintValue(costValue(metrics, config.currencyDecimals, false), "cost", palette)}${
				metrics.subscription ? palette.paint("muted", " (sub)") : ""
			}`;

			add({
				id: "input",
				zone: "right",
				full: inputFull,
				compact: inputFull,
				dropRank: DROP.input,
				required: false,
			});
			add({
				id: "output",
				zone: "right",
				full: outputFull,
				compact: outputFull,
				dropRank: DROP.output,
				required: false,
			});
			add({
				id: "cache",
				zone: "right",
				full: config.preset === "classic" ? cacheDetail : cacheHit,
				compact: cacheHit,
				dropRank: DROP.cache,
				required: false,
			});
			add({ id: "cost", zone: "right", full: cost, compact: cost, dropRank: DROP.cost, required: false });
			continue;
		}

		if (segment === "context") {
			const metrics = state.metrics;
			const role = contextRole(metrics, config);
			const contextFull = `${metric("ctx", percentValue(metrics.contextPercent, 1), palette, role)}${
				metrics.autoCompact === true ? palette.paint("muted", " (auto)") : ""
			}`;
			const contextCompact = metric("ctx", percentValue(metrics.contextPercent, 0), palette, role);
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
			const shortcut = configuredShortcut.toLowerCase() === "alt+a" ? "⌥A" : configuredShortcut.toUpperCase();
			if (shortcut) {
				const rendered = palette.paint("menu", shortcut);
				add({
					id: "menu",
					zone: "right",
					full: rendered,
					compact: rendered,
					dropRank: DROP.menu,
					required: false,
				});
			}
		}
	}

	return items;
}

function renderItems(items: FooterItem[], compactIds: Set<FooterItemId>, separator: string): string {
	return items
		.map((item) => (compactIds.has(item.id) ? item.compact : item.full))
		.filter(Boolean)
		.join(separator);
}

function compose(items: FooterItem[], width: number): string {
	const active = [...items];
	const compactIds = new Set<FooterItemId>();
	const left = () =>
		renderItems(
			active.filter((item) => item.zone === "left"),
			compactIds,
			" · ",
		);
	const right = () =>
		renderItems(
			active.filter((item) => item.zone === "right"),
			compactIds,
			"  ",
		);
	const measured = () => visibleWidth(left()) + visibleWidth(right()) + (left() && right() ? 2 : 0);

	const droppable = active.filter((item) => !item.required).sort((a, b) => a.dropRank - b.dropRank);
	for (const item of droppable) {
		if (measured() <= width) break;
		const index = active.findIndex((candidate) => candidate.id === item.id);
		if (index >= 0) active.splice(index, 1);
	}

	for (const item of active.filter((candidate) => candidate.required)) {
		if (measured() <= width) break;
		if (item.full !== item.compact) compactIds.add(item.id);
	}

	const leftText = left();
	const rightText = right();
	const gap = width - visibleWidth(leftText) - visibleWidth(rightText);
	if (leftText && rightText && gap >= 2) return `${leftText}${" ".repeat(gap)}${rightText}`;
	return truncateToWidth([leftText, rightText].filter(Boolean).join("  "), width, "");
}

export function renderFooterLine(
	state: AtelierState,
	config: AtelierConfig,
	theme: ThemeLike,
	width: number,
	colorEnabled = true,
	workingDots = "...",
): string {
	if (width <= 0) return "";
	const line = compose(buildItems(state, config, theme, colorEnabled, workingDots), width);
	return truncateToWidth(line, width, "");
}

export interface FooterComponentOptions {
	getState(): AtelierState;
	getConfig(): AtelierConfig;
	colorEnabled?: boolean;
	requestRender(): void;
	onBranchChange(callback: () => void): () => void;
	theme: ThemeLike;
}

export function createFooterComponent(options: FooterComponentOptions): Component & { dispose(): void } {
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

	return {
		render(width) {
			const state = options.getState();
			const config = options.getConfig();
			const colorEnabled = options.colorEnabled ?? true;
			const workingDots = WORKING_DOT_FRAMES[frameIndex] ?? WORKING_DOT_FRAMES[0];
			const line = renderFooterLine(state, config, options.theme, width, colorEnabled, workingDots);
			const fullActivity = activityText(
				state,
				createPalette(options.theme, colorEnabled),
				options.theme,
				workingDots,
				false,
			);
			syncAnimation(state.activity === "working" && line.includes(fullActivity));
			return [line];
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

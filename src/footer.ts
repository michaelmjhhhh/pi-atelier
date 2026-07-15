import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { formatCompactContext, formatCompactMetrics, formatContext, formatMetrics } from "./metrics.js";
import type { AtelierConfig, AtelierState, SegmentId } from "./types.js";

export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface Segment {
	id: SegmentId;
	priority: number;
	required: boolean;
	text: string;
}

const sanitize = (text: string): string =>
	text
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

function contextText(state: AtelierState, config: AtelierConfig, theme: ThemeLike, compact: boolean): string {
	const text = compact ? formatCompactContext(state.metrics) : formatContext(state.metrics);
	const percent = state.metrics.contextPercent;
	if (percent !== null && percent >= config.contextDanger) return theme.fg("error", text);
	if (percent !== null && percent >= config.contextWarning) return theme.fg("warning", text);
	return theme.fg("dim", text);
}

function buildSegment(
	id: SegmentId,
	state: AtelierState,
	config: AtelierConfig,
	theme: ThemeLike,
	compact: boolean,
): Segment | undefined {
	try {
		switch (id) {
			case "metrics":
				return {
					id,
					priority: 100,
					required: true,
					text: theme.fg(
						"dim",
						compact
							? formatCompactMetrics(state.metrics, config.currencyDecimals)
							: formatMetrics(state.metrics, config.currencyDecimals),
					),
				};
			case "context":
				return { id, priority: 100, required: true, text: contextText(state, config, theme, compact) };
			case "brand":
				return config.ornament === "none"
					? undefined
					: {
							id,
							priority: 0,
							required: false,
							text: theme.fg("accent", theme.bold(compact ? "◆" : "◆ ATELIER")),
						};
			case "activity": {
				const labels = { ready: "READY", working: "WORKING", warning: "WARNING", error: "ERROR" } as const;
				const colors = { ready: "success", working: "accent", warning: "warning", error: "error" } as const;
				const label = compact ? "●" : `● ${labels[state.activity]}`;
				return { id, priority: 4, required: false, text: theme.fg(colors[state.activity], label) };
			}
			case "model": {
				if (!state.modelId) return undefined;
				const text = compact
					? state.modelId
					: `${state.modelId}${state.thinkingLevel ? ` · ${state.thinkingLevel}` : ""}`;
				return { id, priority: 3, required: false, text: theme.fg("dim", text) };
			}
			case "git":
				return state.branch
					? {
							id,
							priority: 2,
							required: false,
							text: theme.fg("dim", `${state.branch}${state.dirty ? " ✦" : ""}`),
						}
					: undefined;
			case "statuses": {
				if (!config.showExtensionStatuses) return undefined;
				const text = state.extensionStatuses.map(sanitize).filter(Boolean).join(" ");
				return text ? { id, priority: 1, required: false, text: theme.fg("dim", text) } : undefined;
			}
			case "menu": {
				const shortcut =
					config.shortcut.toLowerCase() === "alt+a" ? "⌥A" : sanitize(config.shortcut).toUpperCase();
				return {
					id,
					priority: 2,
					required: false,
					text: theme.fg("accent", compact ? shortcut : `${shortcut} MENU`),
				};
			}
		}
	} catch {
		return id === "metrics" || id === "context"
			? { id, priority: 100, required: true, text: theme.fg("warning", "—") }
			: undefined;
	}
}

export function renderFooterLine(
	state: AtelierState,
	config: AtelierConfig,
	theme: ThemeLike,
	width: number,
): string {
	if (width <= 0) return "";
	const compact = width < 120 || config.density === "compact";
	const separator = compact ? " " : theme.fg("dim", " │ ");
	let segments = config.segments
		.map((id) => buildSegment(id, state, config, theme, compact))
		.filter((segment): segment is Segment => segment !== undefined);

	const render = () => segments.map((segment) => segment.text).join(separator);
	while (visibleWidth(render()) > width) {
		const removable = segments
			.map((segment, index) => ({ segment, index }))
			.filter(({ segment }) => !segment.required)
			.sort((a, b) => a.segment.priority - b.segment.priority)[0];
		if (!removable) break;
		segments = segments.filter((_, index) => index !== removable.index);
	}
	return truncateToWidth(render(), width, "");
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

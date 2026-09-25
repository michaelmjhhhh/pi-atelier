import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { openLifecycleOverlay, type OverlayLifetime } from "./overlay-lifecycle.js";
import { createPalette } from "./palette.js";
import { costLegendColumns, subagentCostChart } from "./subagent-cost-chart.js";
import type { SubagentUsageSnapshot } from "./subagent-usage.js";

export async function openSubagentUsage(
	ctx: ExtensionContext,
	snapshot: SubagentUsageSnapshot,
	decimals: number,
	lifetime: OverlayLifetime,
): Promise<void> {
	await openLifecycleOverlay<void>(
		ctx,
		(tui, theme, finish) => {
			let focused = -1;
			let pointIndex = -1;
			let legendPage = 0;
			let legendPageSize = 1;
			const imageOwner = {};
			const series = (snapshot.costHistory ?? []).filter((run) => run.points.length > 1);
			return {
				render(width) {
					const outerWidth = Math.max(1, Math.floor(width));
					const height = Math.max(1, Math.floor(tui.terminal.rows * 0.8) - 2);
					if (outerWidth < 28 || height < 6) return [truncateToWidth("Resize to view usage", outerWidth)];
					const contentWidth = outerWidth - 4;
					const border = (text: string) => theme.fg("borderAccent", text);
					const framed = (text: string): string => {
						const content = truncateToWidth(text, contentWidth, "…");
						return `${border("│")} ${content}${" ".repeat(Math.max(0, contentWidth - visibleWidth(content)))} ${border("│")}`;
					};
					const pageSize = Math.max(1, height - 5);
					const legendColumns = costLegendColumns(contentWidth);
					const awaitingRows = (snapshot.costHistory?.length ?? 0) > series.length ? 1 : 0;
					// Keep space for the graph and caption; paginate only the legend.
					const legendRows = Math.max(1, Math.min(5, Math.floor((pageSize - awaitingRows - 5) / 2)));
					legendPageSize = legendColumns * legendRows;
					const pageCount = Math.max(1, Math.ceil(series.length / legendPageSize));
					legendPage =
						focused >= 0 ? Math.floor(focused / legendPageSize) : Math.min(legendPage, pageCount - 1);
					const visibleLegendRows = Math.ceil(Math.min(series.length, legendPageSize) / legendColumns);
					const plotHeight = pageSize - visibleLegendRows - awaitingRows - (pageCount > 1 ? 1 : 0) - 4;
					const activeSeries = series[focused];
					const activePointIndex = activeSeries
						? Math.max(
								1,
								Math.min(
									pointIndex < 0 ? activeSeries.points.length - 1 : pointIndex,
									activeSeries.points.length - 1,
								),
							)
						: undefined;
					const point = activePointIndex === undefined ? undefined : activeSeries?.points[activePointIndex];
					const chart =
						plotHeight < 3
							? [theme.fg("dim", "Enlarge terminal to view the graph")]
							: subagentCostChart(
									snapshot,
									contentWidth,
									decimals,
									true,
									createPalette(theme, !process.env.NO_COLOR),
									{
										height: plotHeight,
										focusedSeries: activeSeries?.id,
										focusedPoint: activePointIndex,
										imageOwner,
										legendRows,
										legendPage,
									},
								);
					const number = activeSeries
						? (snapshot.costHistory ?? []).findIndex((run) => run.id === activeSeries.id) + 1
						: 0;
					const precision = Math.max(6, Math.min(8, decimals));
					const readout =
						point && activeSeries && activePointIndex !== undefined
							? [
									theme.fg(
										"accent",
										`#${number} · Point ${activePointIndex}/${activeSeries.points.length - 1} · ${((point.at - activeSeries.startedAt) / 1000).toFixed(1)}s`,
									),
									theme.fg(
										"text",
										`${contentWidth >= 40 ? "Total " : ""}$${point.cost.toFixed(precision)} · +$${(point.cost - (activeSeries.points[activePointIndex - 1]?.cost ?? 0)).toFixed(precision)}`,
									),
								]
							: ["", theme.fg("dim", "Elapsed seconds · select an agent to inspect points")];
					const lines = chart.length
						? [...chart, ...readout]
						: [theme.fg("dim", "No subagent cost history yet.")];
					const title = truncateToWidth(" SUBAGENT COST ", outerWidth - 4, "");
					const body = lines.slice(0, pageSize);
					while (body.length < pageSize) body.push("");
					return [
						border("╭─") +
							theme.fg("accent", theme.bold(title)) +
							border(`${"─".repeat(outerWidth - visibleWidth(title) - 3)}╮`),
						framed(""),
						...body.map(framed),
						framed(""),
						framed(theme.fg("dim", "←→ agent · [ ] point · ↑↓ legend · A all · Esc")),
						border(`╰${"─".repeat(outerWidth - 2)}╯`),
					];
				},
				invalidate() {},
				handleInput(data) {
					if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
						finish();
						return;
					}
					if (series.length && (matchesKey(data, "left") || matchesKey(data, "right"))) {
						pointIndex = -1;
						focused =
							focused < 0
								? matchesKey(data, "left")
									? series.length - 1
									: 0
								: (focused + (matchesKey(data, "left") ? -1 : 1) + series.length) % series.length;
					}
					if (series.length && (data === "[" || data === "]")) {
						if (focused < 0) {
							focused = 0;
							pointIndex = -1;
						}
						const last = (series[focused]?.points.length ?? 2) - 1;
						pointIndex = Math.max(
							1,
							Math.min(last, (pointIndex < 0 ? last : pointIndex) + (data === "[" ? -1 : 1)),
						);
					}
					if (data === "a" || data === "A") focused = -1;
					if (matchesKey(data, "up") || matchesKey(data, "pageUp")) {
						focused = -1;
						legendPage = Math.max(0, legendPage - 1);
					}
					if (matchesKey(data, "down") || matchesKey(data, "pageDown")) {
						focused = -1;
						legendPage = Math.min(Math.max(0, Math.ceil(series.length / legendPageSize) - 1), legendPage + 1);
					}
					tui.requestRender();
				},
			};
		},
		lifetime,
	);
}

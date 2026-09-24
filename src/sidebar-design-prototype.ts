/**
 * THROWAWAY UI exploration on prototype/sidebar-hierarchy.
 * Question: do quiet sections, grouped cards, or a compact ledger make live
 * sidebar information easier to scan? PI_ATELIER_SIDEBAR_DESIGN=A|B|C|original.
 * Keep the existing data, visibility, order, and overflow priorities.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeLike } from "./footer.js";
import { formatTokens } from "./metrics.js";
import type { AtelierPalette, PaletteRole } from "./palette.js";
import { responsePerformanceValues } from "./run-activity.js";
import type { SidebarSnapshot } from "./sidebar.js";
import { sanitizeSidebarPanelText } from "./sidebar-panels.js";
import type { AtelierConfig } from "./types.js";

export interface DesignGroup {
	name: string;
	panel?: string;
	panelId?: string;
	panelRole?: PaletteRole;
	rows: string[];
	required: boolean;
	dropRank: number;
}

export function sidebarDesign(): string {
	return process.env.PI_ATELIER_SIDEBAR_DESIGN ?? "A";
}

export function renderSidebarDesign(
	input: readonly DesignGroup[],
	snapshot: SidebarSnapshot,
	config: AtelierConfig,
	width: number,
	height: number,
	palette: AtelierPalette,
	theme: ThemeLike,
): string[] {
	const variant = sidebarDesign();
	const inner = Math.max(0, width - (variant === "B" ? 4 : 2));
	const paint = (role: PaletteRole, text: string) => palette.paint(role, text);
	const clean = (text: string | undefined) => sanitizeSidebarPanelText(text ?? "") || "—";
	const cut = (text: string, size = inner) => truncateToWidth(text, Math.max(0, size), "…");
	const pair = (label: string, value: string, role: PaletteRole = "primary") => {
		const left = cut(label, Math.min(12, Math.max(0, inner - 8)));
		const right = cut(value, Math.max(0, inner - visibleWidth(left) - 1));
		return `${paint("muted", left)}${" ".repeat(Math.max(1, inner - visibleWidth(left) - visibleWidth(right)))}${paint(role, right)}`;
	};
	const groups = input.map((group): DesignGroup => ({ ...group, rows: [...group.rows] }));
	const { metrics } = snapshot;
	const activity = `${snapshot.activity[0]?.toUpperCase()}${snapshot.activity.slice(1)}`;
	const symbol = { ready: "●", working: "◆", warning: "▲", error: "✕" }[snapshot.activity];
	const performance = responsePerformanceValues(snapshot.runActivity.performance);
	for (const group of groups) {
		switch (group.name) {
			case "agent":
				group.panel = "Session";
				group.rows = [
					theme.bold(
						paint(
							snapshot.activity,
							`${symbol} ${activity}${snapshot.workingLabel && snapshot.activity === "working" ? ` · ${clean(snapshot.workingLabel)}` : ""}`,
						),
					),
					theme.bold(paint("primary", clean(snapshot.modelId))),
					paint("muted", clean(snapshot.provider)),
					pair("Thinking", clean(snapshot.thinkingLevel)),
					pair("Billing", metrics.subscription ? "Subscription" : "Metered"),
				];
				if (variant === "C" && inner >= visibleWidth(`${clean(snapshot.provider)} · subscription`)) {
					group.rows = [
						group.rows[0]!,
						group.rows[1]!,
						paint(
							"muted",
							`${clean(snapshot.provider)} · ${metrics.subscription ? "subscription" : "metered"}`,
						),
						pair("Thinking", clean(snapshot.thinkingLevel)),
					];
				}
				break;
			case "activityCore":
				group.rows = [
					...(snapshot.runActivity.phase === "idle" ? [] : group.rows.slice(0, 1)),
					pair(
						"First token",
						performance.ttft.available ? performance.ttft.text : "—",
						performance.ttft.available ? "primary" : "dim",
					),
					pair(
						inner < 25 ? "Speed" : "Output speed",
						performance.tps.available ? `${performance.tps.text} tok/s` : "—",
						performance.tps.available ? "primary" : "dim",
					),
				];
				if (
					variant === "C" &&
					inner >= visibleWidth(`TTFT ${performance.ttft.text} · ${performance.tps.text} tok/s`)
				)
					group.rows = [
						...(snapshot.runActivity.phase === "idle" ? [] : group.rows.slice(0, 1)),
						paint(
							"muted",
							`TTFT ${performance.ttft.available ? performance.ttft.text : "—"} · ${performance.tps.available ? performance.tps.text : "—"} tok/s`,
						),
					];
				break;
			case "context": {
				const percent = metrics.contextPercent;
				if (percent === null || metrics.contextTokens === null || !Number.isFinite(percent)) break;
				const role: PaletteRole =
					percent >= config.contextDanger
						? "error"
						: percent >= config.contextWarning
							? "warning"
							: "primary";
				const used = `${formatTokens(metrics.contextTokens)} / ${formatTokens(metrics.contextWindow)}`;
				const meterWidth = Math.max(1, inner - 8);
				const filled = Math.max(0, Math.min(meterWidth, Math.round((percent * meterWidth) / 100)));
				const meter = `${paint(role === "primary" ? "context" : role, "━".repeat(filled))}${paint("dim", "─".repeat(meterWidth - filled))}`;
				group.rows =
					variant === "C"
						? [pair(`${percent.toFixed(1)}% used`, used, role)]
						: [`${meter} ${paint(role, `${percent.toFixed(1)}%`)}`, pair("Tokens", used)];
				break;
			}
			case "workspaceCore": {
				// Identity and Git pulse intentionally share a drop group in the host.
				const first = groups.find((item) => item.name === "workspaceCore");
				if (group === first) {
					group.rows = [
						theme.bold(paint("primary", clean(snapshot.projectName))),
						...(snapshot.branch ? [pair("Branch", clean(snapshot.branch))] : []),
					];
				} else if ("data" in snapshot.workspacePulse) {
					const pulse = snapshot.workspacePulse;
					const git = pulse.data.snapshot;
					group.rows = [
						pair(
							"Git",
							pulse.status === "clean"
								? "Clean"
								: pulse.status === "stale"
									? "Stale"
									: pulse.status === "conflict"
										? "Conflicts"
										: "Modified",
							pulse.status === "conflict" ? "error" : pulse.status === "clean" ? "muted" : "warning",
						),
						...(pulse.status === "clean"
							? []
							: [
									pair("Changed", `${git.trackedFiles} tracked`),
									pair("Lines", `+${git.linesAdded}  −${git.linesRemoved}`),
								]),
						...(git.conflicts > 0 ? [pair("Conflicts", String(git.conflicts), "error")] : []),
					];
				}
				break;
			}
			case "workspaceDetails":
				if ("data" in snapshot.workspacePulse) {
					const git = snapshot.workspacePulse.data.snapshot;
					group.rows = [
						...(git.untrackedFiles > 0 ? [pair("Untracked", String(git.untrackedFiles))] : []),
						...(git.binaryFiles > 0 ? [pair("Binary", String(git.binaryFiles))] : []),
						...(git.submodules > 0 ? [pair("Submodules", String(git.submodules))] : []),
					];
				}
				break;
			case "workspaceSession":
				group.rows = [
					...(snapshot.sessionName ? [pair("Session", clean(snapshot.sessionName))] : []),
					pair("History", `${snapshot.branchEntryCount} entries`),
					pair("Storage", snapshot.persisted ? "Saved" : "Temporary", "muted"),
				];
				break;
			case "toolsStatus":
				group.rows = [pair("Enabled", `${snapshot.activeToolCount} / ${snapshot.availableToolCount}`)];
				break;
			case "usage":
				group.rows = [
					...(metrics.usageAvailable
						? [
								pair("Input", formatTokens(metrics.input)),
								pair("Output", formatTokens(metrics.output)),
								pair("Cache read", formatTokens(metrics.cacheRead)),
								pair(
									"Cache hit",
									metrics.cacheHitPercent === undefined ? "—" : `${metrics.cacheHitPercent.toFixed(1)}%`,
								),
							]
						: []),
					...(metrics.costAvailable
						? [
								pair(
									"Cost",
									`$${Math.max(0, metrics.cost).toFixed(Math.min(6, Math.max(0, config.currencyDecimals)))}`,
								),
							]
						: []),
				];
				break;
		}
		if (group.panel) group.panel = group.panel[0] + group.panel.slice(1).toLowerCase();
	}

	// Adjacent panels can share a card without overriding the user's saved order.
	const sectionKey = (group: DesignGroup) => {
		if (variant !== "B") return group.panelId;
		if (group.panelId === "agent" || group.panelId === "activity") return "Live session";
		if (group.panelId === "context" || group.panelId === "usage") return "Resources";
		return group.panelId;
	};
	const render = (selected: DesignGroup[]) => {
		const rows: string[] = [];
		for (let index = 0; index < selected.length; ) {
			const group = selected[index]!;
			if (!group.panel) {
				rows.push(...group.rows);
				index++;
				continue;
			}
			const key = sectionKey(group);
			const body: string[] = [];
			const panelIds = new Set<string | undefined>();
			let previousId = group.panelId;
			do {
				const next = selected[index]!;
				panelIds.add(next.panelId);
				if (variant === "B" && next.panelId !== previousId) body.push("");
				body.push(...next.rows);
				previousId = next.panelId;
				index++;
			} while (index < selected.length && selected[index]!.panel && sectionKey(selected[index]!) === key);
			const title =
				variant === "B" && panelIds.size > 1 && (key === "Live session" || key === "Resources")
					? key
					: group.panel;
			if (variant === "B") {
				const heading = ` ${cut(title, Math.max(0, width - 5))} `;
				rows.push(paint("dim", `╭${heading}${"─".repeat(Math.max(0, width - visibleWidth(heading) - 2))}╮`));
				rows.push(
					...body.map(
						(row) =>
							`${paint("dim", "│")} ${cut(row)}${" ".repeat(Math.max(0, inner - visibleWidth(cut(row))))} ${paint("dim", "│")}`,
					),
				);
				rows.push(paint("dim", `╰${"─".repeat(Math.max(0, width - 2))}╯`), "");
			} else if (variant === "C") {
				rows.push(
					paint("dim", ` ${title.toUpperCase()} ${"─".repeat(Math.max(0, inner - visibleWidth(title) - 1))}`),
				);
				rows.push(...body.map((row) => ` ${cut(row)}`));
			} else {
				rows.push(` ${theme.bold(paint("muted", title))}`);
				rows.push(...body.map((row) => ` ${cut(row)}`), "");
			}
		}
		return rows;
	};
	let selected = groups.filter((group) => group.rows.length > 0);
	let rows = render(selected);
	while (rows.length > height) {
		const removable = selected.filter((group) => !group.required).sort((a, b) => a.dropRank - b.dropRank)[0];
		if (!removable) break;
		selected = selected.filter((group) => group.name !== removable.name);
		rows = render(selected);
	}
	return rows;
}

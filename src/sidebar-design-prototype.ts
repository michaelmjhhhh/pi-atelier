/**
 * THROWAWAY UI exploration on prototype/sidebar-hierarchy.
 * Question: which internal grouping makes the existing colorful, rounded
 * panels easier to scan? PI_ATELIER_SIDEBAR_DESIGN=A|B|C|original.
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
	panelJewel?: "✦" | "✧";
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
	renderPanel: (group: DesignGroup, rows: string[]) => string[],
): string[] {
	const variant = sidebarDesign();
	const inner = Math.max(0, width - 4);
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
					pair(
						"Billing",
						metrics.subscription ? "Subscription" : "Metered",
						metrics.subscription ? "ready" : "muted",
					),
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
						performance.ttft.available ? "output" : "dim",
					),
					pair(
						inner < 25 ? "Speed" : "Output speed",
						performance.tps.available ? `${performance.tps.text} tok/s` : "—",
						performance.tps.available ? "output" : "dim",
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
							: "context";
				const used = `${formatTokens(metrics.contextTokens)} / ${formatTokens(metrics.contextWindow)}`;
				const meterWidth = Math.max(1, inner - 8);
				// Eighth-cell precision keeps small nonzero usage visible. A textured
				// track reads as capacity rather than a horizontal section divider.
				const units = Math.min(
					meterWidth * 8,
					Math.max(percent > 0 ? 1 : 0, Math.round((percent * meterWidth * 8) / 100)),
				);
				const full = Math.floor(units / 8);
				const fraction = units % 8;
				const fill = "█".repeat(full) + (fraction ? "▏▎▍▌▋▊▉"[fraction - 1] : "");
				const meter = `${paint(role, fill)}${paint("dim", "░".repeat(meterWidth - full - (fraction ? 1 : 0)))}`;
				const percentLabel = theme.bold(paint(role, `${percent.toFixed(1)}%`.padStart(6)));
				group.rows =
					variant === "C" && visibleWidth(`${percent.toFixed(1)}% used ${used}`) <= inner
						? [pair(`${percent.toFixed(1)}% used`, used, role)]
						: [`${meter}  ${percentLabel}`, pair("Tokens", used, "muted")];
				break;
			}
			case "workspaceCore": {
				// Identity and Git pulse intentionally share a drop group in the host.
				const first = groups.find((item) => item.name === "workspaceCore");
				if (group === first) {
					group.rows = [
						theme.bold(paint("primary", clean(snapshot.projectName))),
						...(snapshot.branch ? [pair("Branch", clean(snapshot.branch), "accent")] : []),
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
								pair("Input", formatTokens(metrics.input), "input"),
								pair("Output", formatTokens(metrics.output), "output"),
								pair("Cache read", formatTokens(metrics.cacheRead), "cache"),
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
		// B explores subgroups inside the same original panels, never merged cards.
		if (variant === "B") {
			if (group.name === "agent") group.rows.splice(3, 0, "");
			if (group.name === "workspaceSession" && group.rows.length) {
				group.rows.unshift("", paint("muted", "Session"));
			}
			if (group.name === "workspaceCore" && group !== groups.find((item) => item.name === "workspaceCore")) {
				group.rows.unshift("", paint("muted", "Changes"));
			}
		}
	}

	const render = (selected: DesignGroup[]) => {
		const rows: string[] = [];
		for (let index = 0; index < selected.length; ) {
			const group = selected[index]!;
			if (!group.panel) {
				rows.push(...group.rows);
				index++;
				continue;
			}
			const body: string[] = [];
			do {
				body.push(...selected[index]!.rows);
				index++;
			} while (
				index < selected.length &&
				selected[index]!.panel === group.panel &&
				selected[index]!.panelId === group.panelId
			);
			// Reuse the actual original chrome: colored title/jewel, rounded border,
			// side padding, and spacing. Only the contents are under exploration.
			rows.push(...renderPanel(group, body));
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

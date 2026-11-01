import { visibleWidth } from "@earendil-works/pi-tui";
import { asciiGlyphText } from "./glyphs.js";
import { PANEL_KEYS, panelIdForTitle, t } from "./i18n.js";
import { createPalette, type PaletteRole, type ThemeLike } from "./palette.js";
import { FOOTER_OWNED_SECTIONS, SECTION_ROLES } from "./header-rail.js";
import { hasTopStripSurface } from "./surface-gates.js";
import { renderPanelCard } from "./panel-card.js";
import {
	isSectionExpanded,
	sectionDetailRows,
	sectionSummary,
	type SectionExpansion,
} from "./rail-sections.js";
import { isBuiltinSidebarPanelId } from "./sidebar-panels.js";
import { isColorEnabled, sanitizeInline } from "./text.js";
import type { AtelierConfig, BuiltinSidebarPanelId } from "./types.js";
import type { SidebarSnapshot } from "./sidebar.js";

export const RAIL_CARD_MIN_WIDTH = 24;
export const RAIL_CARD_MAX_WIDTH = 48;
const TERMINAL_SEQUENCE =
	/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;
const stripTerminalSequences = (text: string): string => text.replace(TERMINAL_SEQUENCE, "");
const ERROR_STATUS = /\b(error|failed?|failure|offline|unavailable)\b/i;

export function railStripLines(
	snapshot: SidebarSnapshot,
	config: AtelierConfig,
	theme: ThemeLike,
	width: number,
	rows: number,
	expansion: SectionExpansion,
): string[] {
	const safeWidth = Math.max(0, Math.trunc(width));
	if (!hasTopStripSurface(safeWidth, rows)) return [];
	const height = Math.max(3, Math.min(config.railTopHeight, rows - 16));
	const sections = config.sidebarPanelLayout.flatMap(({ id, visible }) => {
		if (!visible || !isBuiltinSidebarPanelId(id) || FOOTER_OWNED_SECTIONS.has(id)) return [];
		const role: PaletteRole | undefined =
			id === "agent"
				? snapshot.activity
				: id === "alerts"
					? snapshot.extensionStatuses.some((status) => ERROR_STATUS.test(sanitizeInline(status)))
						? "error"
						: "warning"
					: SECTION_ROLES[id];
		if (!role) return [];
		const expanded = isSectionExpanded(expansion, id);
		const summary = sectionSummary(snapshot, id, config.language);
		const details = expanded ? sectionDetailRows(snapshot, id, config.language, config.prefillViews) : [];
		if (expanded && !summary && details.length === 0) return [];
		return [{ id, role, expanded, summary, details }];
	});
	if (!sections.length) return [];

	const maxVisible = Math.max(
		1,
		Math.min(sections.length, Math.floor((safeWidth - 1) / (RAIL_CARD_MIN_WIDTH + 1))),
	);
	const compactMarker = height === 3 && sections.length > maxVisible;
	const markerText = `${config.nerdFont ? "…" : "..."} +${sections.length - maxVisible}`;
	const visibleCount = compactMarker
		? Math.max(
				1,
				Math.min(
					maxVisible,
					Math.floor((safeWidth - 2 - visibleWidth(` ${markerText}`) + 1) / (RAIL_CARD_MIN_WIDTH + 1)),
				),
			)
		: maxVisible;
	const visibleSections = sections.slice(0, visibleCount);
	const hidden = sections.length - visibleSections.length;
	const separatorColumns = visibleSections.length - 1;
	const markerColumns =
		compactMarker && hidden ? visibleWidth(` ${config.nerdFont ? "…" : "..."} +${hidden}`) : 0;
	const available = safeWidth - 2 - separatorColumns - markerColumns;
	const cardWidth = Math.max(
		RAIL_CARD_MIN_WIDTH,
		Math.min(RAIL_CARD_MAX_WIDTH, Math.floor(available / visibleSections.length)),
	);
	const markerRows = hidden && !compactMarker ? 1 : 0;
	const cardHeight = Math.max(3, height - markerRows);
	const bodyLimit = cardHeight - 2;
	const palette = createPalette(theme, isColorEnabled());
	const cards = visibleSections.map(({ id, role, expanded, summary, details }) => {
		const label = `${expanded ? "" : config.nerdFont ? "▸ " : "[+] "}${t(config.language, id)}`;
		const rawRows = expanded ? details : [summary];
		const content = rawRows.map((line) =>
			palette.paint("primary", sanitizeInline(config.nerdFont ? line : asciiGlyphText(line, "headerRail"))),
		);
		if (content.length > bodyLimit)
			content.splice(
				bodyLimit - 1,
				content.length - bodyLimit + 1,
				palette.paint("muted", config.nerdFont ? "…" : "..."),
			);
		return renderPanelCard(
			label,
			id === "agent" && snapshot.activity === "working" ? "✧" : "✦",
			role,
			content,
			cardWidth,
			!expanded,
			palette,
			theme,
			config.nerdFont,
		);
	});
	const bandHeight = Math.min(cardHeight, Math.max(...cards.map((card) => card.length)));
	const lines = Array.from(
		{ length: bandHeight },
		(_, row) => `  ${cards.map((card) => card[row] ?? " ".repeat(cardWidth)).join(" ")}`,
	);
	if (hidden) {
		if (compactMarker) lines[lines.length - 1] += ` ${config.nerdFont ? "…" : "..."} +${hidden}`;
		else lines.push(`  ${config.nerdFont ? "…" : "..."} +${hidden}`);
	}
	return lines.map((line) => line.replace(/\s+$/u, "")).filter((line) => visibleWidth(line) <= safeWidth);
}

export function railCardAt(
	rows: readonly string[],
	row: number,
	column: number,
): BuiltinSidebarPanelId | undefined {
	if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || column < 0) return undefined;
	const top = stripTerminalSequences(rows[0] ?? "");
	const titles = PANEL_KEYS.flatMap((key) => [t("en", key), t("it", key)]);
	const titlePattern = new RegExp(`(?:${titles.join("|")})(?=\\s|$)`, "g");
	for (const match of top.matchAll(titlePattern)) {
		const titleStart = match.index ?? 0;
		const id = panelIdForTitle(match[0]);
		if (!id) continue;
		let start = Math.max(top.lastIndexOf("╭", titleStart), top.lastIndexOf("+", titleStart));
		if (start < 0) continue;
		const topRight = Math.min(
			...[top.indexOf("╮", titleStart), top.indexOf("+", titleStart)].filter((value) => value >= 0),
		);
		if (!Number.isFinite(topRight)) continue;
		const end = topRight + 1;
		const bottomRow = rows.findIndex((line, index) => {
			if (index === 0) return false;
			const text = stripTerminalSequences(line);
			return (text[start] === "╰" || text[start] === "+") && (text[end - 1] === "╯" || text[end - 1] === "+");
		});
		if (column >= start && column < end && bottomRow >= row && bottomRow > 0) return id;
	}
	return undefined;
}

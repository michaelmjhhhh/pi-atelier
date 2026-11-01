import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createPalette, type PaletteRole, type ThemeLike } from "./palette.js";
import { t } from "./i18n.js";
import { asciiGlyphText, surfaceGlyphs } from "./glyphs.js";
import {
	isSectionExpanded,
	sectionDetailRows,
	type SectionExpansion,
	sectionSummary,
} from "./rail-sections.js";
import { isBuiltinSidebarPanelId } from "./sidebar-panels.js";
import { isColorEnabled, sanitizeInline } from "./text.js";
import type { AtelierConfig, BuiltinSidebarPanelId } from "./types.js";
import type { SidebarSnapshot } from "./sidebar.js";

export const SECTION_ROLES: Partial<Record<BuiltinSidebarPanelId, PaletteRole>> = {
	agent: "primary",
	activity: "working",
	alerts: "warning",
	todos: "accent",
	context: "context",
	workspace: "accent",
	usage: "chartGold",
	prefill: "working",
	subagents: "output",
	tools: "chartPink",
};
// Activity and Context remain owned by the footer when the rail is on top.
export const FOOTER_OWNED_SECTIONS = new Set<BuiltinSidebarPanelId>(["activity", "context"]);

export function renderHeaderRail(
	snapshot: SidebarSnapshot,
	config: AtelierConfig,
	theme: ThemeLike,
	width: number,
	expansion: SectionExpansion,
	focusedId?: string,
): string[] {
	const safeWidth = Math.max(0, Math.trunc(width));
	if (safeWidth === 0) return [];
	const palette = createPalette(theme, isColorEnabled());
	const glyphs = surfaceGlyphs("headerRail", config.nerdFont);
	const separator = `  ${glyphs.bullet}  `;
	const sections = config.sidebarPanelLayout.flatMap(({ id, visible }) => {
		if (
			!visible ||
			!isBuiltinSidebarPanelId(id) ||
			(config.panelPlacement === "top" && FOOTER_OWNED_SECTIONS.has(id))
		)
			return [];
		const role = SECTION_ROLES[id];
		if (!role) return [];
		const expanded = isSectionExpanded(expansion, id);
		const rawSummary = expanded ? sectionSummary(snapshot, id, config.language) : "";
		const summary = config.nerdFont ? rawSummary : asciiGlyphText(rawSummary, "headerRail");
		const details = expanded
			? sectionDetailRows(snapshot, id, config.language, config.prefillViews).map((line) =>
					config.nerdFont ? line : asciiGlyphText(line, "headerRail"),
				)
			: [];
		if (expanded && !summary && details.length === 0) return [];
		const marker = expanded ? glyphs.railExpanded : glyphs.railCollapsed;
		const content = `${marker} ${t(config.language, id)}${summary ? ` ${summary}` : ""}`;
		const text = focusedId === id ? theme.bold(`<${content}>`) : content;
		return [{ id, text: palette.paint(role, text), expanded, details }];
	});
	if (sections.length === 0) return [];

	const maxRows = Math.max(1, Math.min(4, Math.trunc(config.headerRailRows)));
	const titleRowLimit = Math.max(
		1,
		maxRows - Number(sections.some(({ expanded, details }) => expanded && details.length > 0)),
	);
	const rows: string[] = [];
	let sectionIndex = 0;
	while (sectionIndex < sections.length && rows.length < titleRowLimit) {
		let row = "";
		while (sectionIndex < sections.length) {
			const section = sections[sectionIndex]!.text;
			const next = row ? `${row}${separator}${section}` : section;
			if (visibleWidth(next) <= safeWidth) {
				row = next;
				sectionIndex++;
			} else if (!row) {
				row = truncateToWidth(section, safeWidth, glyphs.ellipsis);
				sectionIndex++;
				break;
			} else break;
		}
		rows.push(row);
	}

	const hiddenSections = sections.length - sectionIndex;
	if (hiddenSections > 0) {
		const marker = `${glyphs.ellipsis} +${hiddenSections}`;
		const suffix = `${separator}${marker}`;
		const finalRow = rows.length - 1;
		rows[finalRow] =
			`${truncateToWidth(rows[finalRow] ?? "", Math.max(0, safeWidth - visibleWidth(suffix)), glyphs.ellipsis)}${suffix}`;
		rows[finalRow] = truncateToWidth(rows[finalRow]!, safeWidth, glyphs.ellipsis);
	}

	const details = sections
		.slice(0, sectionIndex)
		.flatMap(({ id, expanded, details }) =>
			expanded ? details.map((line) => `${t(config.language, id)} ${sanitizeInline(line)}`) : [],
		);
	const availableDetailRows = Math.max(0, maxRows - rows.length);
	const visibleDetails = details.slice(0, availableDetailRows);
	const omittedDetails = details.length - visibleDetails.length;
	for (const detail of visibleDetails) rows.push(truncateToWidth(detail, safeWidth, glyphs.ellipsis));
	if (omittedDetails > 0 && visibleDetails.length > 0) {
		const suffix = ` ${glyphs.ellipsis} +${omittedDetails}`;
		const finalDetail = rows.length - 1;
		rows[finalDetail] =
			`${truncateToWidth(visibleDetails.at(-1)!, Math.max(0, safeWidth - visibleWidth(suffix)), glyphs.ellipsis)}${suffix}`;
	}
	return rows.filter(Boolean);
}

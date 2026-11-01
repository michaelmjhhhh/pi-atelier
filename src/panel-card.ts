import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { asciiGlyphText, surfaceGlyphs } from "./glyphs.js";
import type { AtelierPalette, PaletteRole, ThemeLike } from "./palette.js";
import { fitToWidth } from "./text.js";

export function renderPanelCard(
	title: string,
	jewel: string,
	role: PaletteRole,
	rows: readonly string[],
	width: number,
	collapsed: boolean,
	palette: AtelierPalette,
	theme: ThemeLike,
	nerdFont = true,
): string[] {
	const safeWidth = Math.max(7, Math.trunc(width));
	const glyphs = surfaceGlyphs("sidebar", nerdFont);
	const prefix = `${glyphs.topLeft}${glyphs.horizontal} ${nerdFont ? jewel : asciiGlyphText(jewel, "sidebar")} `;
	const safeTitle = truncateToWidth(
		nerdFont ? title : asciiGlyphText(title, "sidebar"),
		Math.max(0, safeWidth - visibleWidth(prefix) - 2),
		glyphs.ellipsis,
	);
	const crownFill = glyphs.horizontal.repeat(
		Math.max(0, safeWidth - visibleWidth(prefix) - visibleWidth(safeTitle) - 2),
	);
	const top = `${palette.paint(role, prefix)}${theme.bold(palette.paint(role, safeTitle))} ${palette.paint(
		role,
		`${crownFill}${glyphs.topRight}`,
	)}`;
	const edge = palette.paintTint(role, glyphs.vertical);
	const innerWidth = safeWidth - 4;
	const content = (collapsed ? [rows[0] ?? ""] : rows).map(
		(row) => `${edge} ${fitToWidth(row, innerWidth)} ${edge}`,
	);
	return [
		truncateToWidth(top, safeWidth, ""),
		...content,
		palette.paintTint(
			role,
			`${glyphs.bottomLeft}${glyphs.horizontal.repeat(safeWidth - 2)}${glyphs.bottomRight}`,
		),
	];
}

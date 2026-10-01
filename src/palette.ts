export type PaletteRole =
	| "accent"
	| "primary"
	| "muted"
	| "dim"
	| "ready"
	| "working"
	| "input"
	| "output"
	| "cache"
	| "cost"
	| "context"
	| "menu"
	| "warning"
	| "error"
	| "chartPink"
	| "chartGreen";

export interface PaletteTheme {
	readonly name?: string;
	fg(color: string, text: string): string;
}

/** The subset of Pi's theme that Atelier renders with. */
export interface ThemeLike extends PaletteTheme {
	bold(text: string): string;
}

export type Rgb = readonly [number, number, number];

/** Truecolor values used for every named theme, and by graphics that need RGB. */
export const PALETTE_RGB: Record<PaletteRole, Rgb> = {
	accent: [177, 140, 255],
	primary: [212, 212, 212],
	muted: [128, 128, 128],
	dim: [102, 102, 102],
	ready: [110, 168, 254],
	working: [255, 159, 67],
	input: [110, 168, 254],
	output: [177, 140, 255],
	cache: [125, 211, 252],
	cost: [255, 159, 67],
	context: [110, 168, 254],
	menu: [177, 140, 255],
	warning: [255, 159, 67],
	error: [255, 93, 115],
	chartPink: [244, 114, 182],
	chartGreen: [74, 222, 128],
};

const UNNAMED_THEME: Record<PaletteRole, string> = {
	accent: "accent",
	primary: "text",
	muted: "muted",
	dim: "dim",
	ready: "thinkingLow",
	working: "mdHeading",
	input: "thinkingLow",
	output: "thinkingHigh",
	cache: "syntaxType",
	cost: "mdHeading",
	context: "thinkingLow",
	menu: "thinkingHigh",
	warning: "warning",
	error: "error",
	chartPink: "syntaxString",
	chartGreen: "success",
};

/** Without color, only structural roles keep their own theme key; the rest read as plain text. */
const NO_COLOR_ROLES: ReadonlySet<PaletteRole> = new Set(["accent", "muted", "dim", "warning", "error"]);

export interface AtelierPalette {
	readonly colorEnabled: boolean;
	paint(role: PaletteRole, text: string): string;
}

export function paintRgb([red, green, blue]: Rgb, text: string): string {
	return `\u001b[38;2;${red};${green};${blue}m${text}\u001b[39m`;
}

export function createPalette(theme: PaletteTheme, colorEnabled: boolean): AtelierPalette {
	return {
		colorEnabled,
		paint(role, text) {
			if (!colorEnabled) return theme.fg(NO_COLOR_ROLES.has(role) ? role : "text", text);
			if (!theme.name) return theme.fg(UNNAMED_THEME[role], text);
			return paintRgb(PALETTE_RGB[role], text);
		},
	};
}

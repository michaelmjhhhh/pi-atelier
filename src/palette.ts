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
	| "chartGreen"
	| "chartGold";

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
	chartGold: [234, 200, 110],
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
	chartGold: "syntaxFunction",
};

/** Without color, only structural roles keep their own theme key; the rest read as plain text. */
const NO_COLOR_ROLES: ReadonlySet<PaletteRole> = new Set(["accent", "muted", "dim", "warning", "error"]);

export interface AtelierPalette {
	readonly colorEnabled: boolean;
	/** Whether paintTint renders role shades rather than falling back to dim. */
	readonly tinted: boolean;
	paint(role: PaletteRole, text: string): string;
	/** A subdued shade of a role for chrome (panel frames, meter tracks); dim without truecolor. */
	paintTint(role: PaletteRole, text: string, strength?: number): string;
}

/** The neutral every tint fades toward; mid-grey so tints stay legible on dark and light backgrounds. */
const TINT_BASE: Rgb = [92, 96, 102];

function tintRgb(role: PaletteRole, strength = 0.4): Rgb {
	const mix = (index: 0 | 1 | 2) =>
		Math.round(TINT_BASE[index] + (PALETTE_RGB[role][index] - TINT_BASE[index]) * strength);
	return [mix(0), mix(1), mix(2)];
}

export function paintRgb([red, green, blue]: Rgb, text: string): string {
	return `\u001b[38;2;${red};${green};${blue}m${text}\u001b[39m`;
}

export function createPalette(theme: PaletteTheme, colorEnabled: boolean): AtelierPalette {
	const tinted = colorEnabled && Boolean(theme.name);
	return {
		colorEnabled,
		tinted,
		paint(role, text) {
			if (!colorEnabled) return theme.fg(NO_COLOR_ROLES.has(role) ? role : "text", text);
			if (!theme.name) return theme.fg(UNNAMED_THEME[role], text);
			return paintRgb(PALETTE_RGB[role], text);
		},
		paintTint(role, text, strength) {
			if (!tinted) return theme.fg("dim", text);
			return paintRgb(tintRgb(role, strength), text);
		},
	};
}

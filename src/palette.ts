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
	| "error";

interface PaletteTheme {
	readonly name?: string;
	fg(color: string, text: string): string;
}

type Rgb = readonly [number, number, number];

const FIXED_DARK: Record<PaletteRole, Rgb> = {
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
};

const NO_COLOR: Record<PaletteRole, string> = {
	accent: "accent",
	primary: "text",
	muted: "muted",
	dim: "dim",
	ready: "text",
	working: "text",
	input: "text",
	output: "text",
	cache: "text",
	cost: "text",
	context: "text",
	menu: "text",
	warning: "warning",
	error: "error",
};

export interface AtelierPalette {
	paint(role: PaletteRole, text: string): string;
}

function rgb([red, green, blue]: Rgb, text: string): string {
	return `\u001b[38;2;${red};${green};${blue}m${text}\u001b[39m`;
}

export function createPalette(theme: PaletteTheme, colorEnabled: boolean): AtelierPalette {
	return {
		paint(role, text) {
			if (!colorEnabled) return theme.fg(NO_COLOR[role], text);
			if (!theme.name) return theme.fg(UNNAMED_THEME[role], text);
			return rgb(FIXED_DARK[role], text);
		},
	};
}

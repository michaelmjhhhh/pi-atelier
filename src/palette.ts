export type PaletteRole =
	| "accent"
	| "primary"
	| "muted"
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

type SpectrumRole = Exclude<PaletteRole, "accent" | "primary" | "muted">;
type Rgb = readonly [number, number, number];

const DARK: Record<SpectrumRole, Rgb> = {
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

const LIGHT: Record<SpectrumRole, Rgb> = {
	ready: [36, 95, 191],
	working: [180, 83, 9],
	input: [36, 95, 191],
	output: [112, 66, 193],
	cache: [8, 124, 158],
	cost: [180, 83, 9],
	context: [36, 95, 191],
	menu: [112, 66, 193],
	warning: [180, 83, 9],
	error: [198, 40, 69],
};

const CUSTOM: Record<PaletteRole, string> = {
	accent: "accent",
	primary: "text",
	muted: "muted",
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
			if (role === "accent" || role === "primary" || role === "muted") {
				return theme.fg(CUSTOM[role], text);
			}
			if (theme.name?.toLowerCase() === "dark") return rgb(DARK[role], text);
			if (theme.name?.toLowerCase() === "light") return rgb(LIGHT[role], text);
			return theme.fg(CUSTOM[role], text);
		},
	};
}

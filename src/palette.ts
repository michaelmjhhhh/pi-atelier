export type PaletteRole =
	| "brand"
	| "ready"
	| "working"
	| "warning"
	| "error"
	| "input"
	| "output"
	| "cache"
	| "cost"
	| "context"
	| "muted";

interface PaletteTheme {
	fg(color: string, text: string): string;
}

const RGB: Record<Exclude<PaletteRole, "muted">, readonly [number, number, number]> = {
	brand: [177, 140, 255],
	ready: [110, 168, 254],
	working: [255, 159, 67],
	warning: [255, 159, 67],
	error: [255, 93, 115],
	input: [110, 168, 254],
	output: [177, 140, 255],
	cache: [125, 211, 252],
	cost: [255, 159, 67],
	context: [110, 168, 254],
};

const FALLBACK: Record<PaletteRole, string> = {
	brand: "accent",
	ready: "text",
	working: "accent",
	warning: "accent",
	error: "error",
	input: "text",
	output: "text",
	cache: "muted",
	cost: "accent",
	context: "text",
	muted: "muted",
};

export interface AtelierPalette {
	paint(role: PaletteRole, text: string): string;
}

export function createPalette(theme: PaletteTheme, colorEnabled: boolean): AtelierPalette {
	return {
		paint(role, text) {
			if (!colorEnabled || role === "muted") return theme.fg(FALLBACK[role], text);
			const [red, green, blue] = RGB[role];
			return `\u001b[38;2;${red};${green};${blue}m${text}\u001b[39m`;
		},
	};
}

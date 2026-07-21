export type PaletteRole = "accent" | "primary" | "muted" | "warning" | "error";

interface PaletteTheme {
	fg(color: string, text: string): string;
}

const THEME_ROLE: Record<PaletteRole, string> = {
	accent: "accent",
	primary: "text",
	muted: "muted",
	warning: "warning",
	error: "error",
};

export interface AtelierPalette {
	paint(role: PaletteRole, text: string): string;
}

export function createPalette(theme: PaletteTheme, _colorEnabled: boolean): AtelierPalette {
	return {
		paint(role, text) {
			return theme.fg(THEME_ROLE[role], text);
		},
	};
}

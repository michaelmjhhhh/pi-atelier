export type GlyphSurface =
	| "footer"
	| "headerRail"
	| "sidebar"
	| "menu"
	| "settings"
	| "costChart"
	| "notification";

export interface SurfaceGlyphs {
	separator: string;
	bullet: string;
	ellipsis: string;
	horizontal: string;
	vertical: string;
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	branch: string;
	minus: string;
	meterFilled: string;
	meterEmpty: string;
	meterFractions: string;
	activityWorking: string;
	activityReady: string;
	activityError: string;
	panelCrown: string;
	todoPending: string;
	todoInProgress: string;
	todoCompleted: string;
	toolRunning: string;
	toolCompleted: string;
	toolError: string;
	alertError: string;
	alertWarning: string;
	railExpanded: string;
	railCollapsed: string;
	workingDots: string;
}

// ASCII mappings: filled meter "#", empty meter "-", branch "branch:", activity working "*", completed "+", error "x", panel crown "*", TODO pending "[ ]", in progress "[>]", completed "[x]".
const ASCII: SurfaceGlyphs = {
	separator: "|",
	bullet: "-",
	ellipsis: ".",
	horizontal: "-",
	vertical: "|",
	topLeft: "+",
	topRight: "+",
	bottomLeft: "+",
	bottomRight: "+",
	branch: "branch:",
	minus: "-",
	meterFilled: "#",
	meterEmpty: "-",
	meterFractions: "#######",
	activityWorking: "*",
	activityReady: "+",
	activityError: "x",
	panelCrown: "*",
	todoPending: "[ ]",
	todoInProgress: "[>]",
	todoCompleted: "[x]",
	toolRunning: "*",
	toolCompleted: "+",
	toolError: "x",
	alertError: "x",
	alertWarning: "!",
	railExpanded: "[-]",
	railCollapsed: "[+]",
	workingDots: "...",
};

const NERD: SurfaceGlyphs = {
	separator: "·",
	bullet: "·",
	ellipsis: "…",
	horizontal: "─",
	vertical: "│",
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	branch: "",
	minus: "−",
	meterFilled: "█",
	meterEmpty: "░",
	meterFractions: "▏▎▍▌▋▊▉",
	activityWorking: "◐",
	activityReady: "●",
	activityError: "×",
	panelCrown: "✦",
	todoPending: "○",
	todoInProgress: "◐",
	todoCompleted: "✓",
	toolRunning: "◐",
	toolCompleted: "✓",
	toolError: "✗",
	alertError: "✕",
	alertWarning: "▲",
	railExpanded: "▾",
	railCollapsed: "▸",
	workingDots: "...",
};

const SURFACES: Record<GlyphSurface, { ascii: SurfaceGlyphs; nerd: SurfaceGlyphs }> = {
	footer: { ascii: ASCII, nerd: NERD },
	headerRail: { ascii: ASCII, nerd: NERD },
	sidebar: { ascii: ASCII, nerd: NERD },
	menu: { ascii: ASCII, nerd: NERD },
	settings: { ascii: ASCII, nerd: NERD },
	costChart: { ascii: ASCII, nerd: NERD },
	notification: { ascii: ASCII, nerd: NERD },
};

export function surfaceGlyphs(surface: GlyphSurface, nerdFont: boolean): SurfaceGlyphs {
	return SURFACES[surface][nerdFont ? "nerd" : "ascii"];
}

export function asciiGlyphText(text: string, surface: GlyphSurface): string {
	const plain = surfaceGlyphs(surface, false);
	return text.replace(/[╭╮╰╯┌┐└┘─│✦✧◆×●◐✓✗✕▲○·…−█▏▎▍▌▋▊▉░›↑↓—±]/g, (glyph) => {
		switch (glyph) {
			case "╭":
			case "╮":
			case "╰":
			case "╯":
			case "┌":
			case "┐":
			case "└":
			case "┘":
				return "+";
			case "─":
			case "−":
			case "░":
			case "·":
				return "-";
			case "…":
				return plain.ellipsis;
			case "│":
				return "|";
			case "✦":
			case "✧":
			case "◆":
			case "◐":
				return "*";
			case "█":
			case "▏":
			case "▎":
			case "▍":
			case "▌":
			case "▋":
			case "▊":
			case "▉":
				return "#";
			case "●":
			case "✓":
				return "+";
			case "×":
			case "✗":
			case "✕":
				return "x";
			case "▲":
				return "!";
			case "○":
				return "o";
			case "›":
				return ">";
			case "↑":
				return "^";
			case "↓":
				return "v";
			case "—":
				return "-";
			case "±":
				return "+";
			default:
				return glyph;
		}
	});
}

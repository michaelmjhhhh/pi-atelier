import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { AtelierColorScheme, ColorSchemeBase, PaletteColorSpec } from "./types.js";

export const PALETTE_ROLES = [
	"accent",
	"primary",
	"muted",
	"dim",
	"ready",
	"working",
	"input",
	"output",
	"cache",
	"cost",
	"context",
	"menu",
	"warning",
	"error",
] as const;

export type PaletteRole = (typeof PALETTE_ROLES)[number];

interface PaletteTheme {
	readonly name?: string;
	fg(color: ThemeColor, text: string): string;
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

const THEME_TOKENS: Record<PaletteRole, ThemeColor> = {
	accent: "accent",
	primary: "text",
	muted: "muted",
	dim: "dim",
	ready: "thinkingLow",
	working: "warning",
	input: "thinkingLow",
	output: "thinkingHigh",
	cache: "syntaxType",
	cost: "mdHeading",
	context: "thinkingLow",
	menu: "accent",
	warning: "warning",
	error: "error",
};

const LEGACY_UNNAMED_THEME: Record<PaletteRole, ThemeColor> = {
	...THEME_TOKENS,
	working: "mdHeading",
	menu: "thinkingHigh",
};

const NO_COLOR: Record<PaletteRole, ThemeColor> = {
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

export const PI_THEME_COLOR_TOKENS = [
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"userMessageText",
	"customMessageText",
	"customMessageLabel",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"thinkingMax",
	"bashMode",
] as const satisfies readonly ThemeColor[];

const piThemeColorTokens = new Set<ThemeColor>(PI_THEME_COLOR_TOKENS);

/** Compile-time guard: Pi token additions must also enter the runtime JSON allowlist. */
type AssertNever<T extends never> = T;
type _MissingPiThemeColorTokens = AssertNever<Exclude<ThemeColor, (typeof PI_THEME_COLOR_TOKENS)[number]>>;

export interface AtelierPalette {
	paint(role: PaletteRole, text: string): string;
}

function rgb([red, green, blue]: Rgb, text: string): string {
	return `\u001b[38;2;${red};${green};${blue}m${text}\u001b[39m`;
}

function indexed(color: number, text: string): string {
	return `\u001b[38;5;${color}m${text}\u001b[39m`;
}

function defaultColor(text: string): string {
	return `\u001b[39m${text}\u001b[39m`;
}

function themeColor(theme: PaletteTheme, token: ThemeColor, text: string): string {
	return theme.fg(token, text);
}

/** A role override narrowed to exactly one way of painting, resolved once per palette. */
type ResolvedColor =
	| { readonly kind: "rgb"; readonly value: Rgb }
	| { readonly kind: "indexed"; readonly value: number }
	| { readonly kind: "token"; readonly value: ThemeColor }
	| { readonly kind: "default" };

const HEX_COLOR = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i;

export function normalizePaletteColorSpec(value: unknown): PaletteColorSpec | undefined {
	if (typeof value === "number")
		return Number.isInteger(value) && value >= 0 && value <= 255 ? value : undefined;
	if (typeof value !== "string") return undefined;
	if (value === "" || HEX_COLOR.test(value) || piThemeColorTokens.has(value as ThemeColor))
		return value as PaletteColorSpec;
	return undefined;
}

function isColorSchemeObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Malformed or runtime-invalid specs resolve to the terminal default. */
function resolveColorSpec(value: unknown): ResolvedColor {
	const spec = normalizePaletteColorSpec(value);
	if (spec === undefined) return { kind: "default" };
	if (typeof spec === "number") return { kind: "indexed", value: spec };
	if (spec === "") return { kind: "default" };
	const parsed = HEX_COLOR.exec(spec);
	if (parsed)
		return {
			kind: "rgb",
			value: [
				Number.parseInt(parsed[1]!, 16),
				Number.parseInt(parsed[2]!, 16),
				Number.parseInt(parsed[3]!, 16),
			],
		};
	return { kind: "token", value: spec as ThemeColor };
}

function resolveOverrides(colorScheme: unknown): ReadonlyMap<PaletteRole, ResolvedColor> {
	const overrides = new Map<PaletteRole, ResolvedColor>();
	if (!isColorSchemeObject(colorScheme)) return overrides;
	for (const role of PALETTE_ROLES) {
		if (!Object.hasOwn(colorScheme, role)) continue;
		const value = colorScheme[role];
		overrides.set(role, resolveColorSpec(value));
	}
	return overrides;
}

function paintResolved(theme: PaletteTheme, color: ResolvedColor, text: string): string {
	switch (color.kind) {
		case "rgb":
			return rgb(color.value, text);
		case "indexed":
			return indexed(color.value, text);
		case "token":
			return themeColor(theme, color.value, text);
		default:
			return defaultColor(text);
	}
}

function schemeBase(colorScheme: unknown): ColorSchemeBase {
	if (colorScheme === "inherit") return "inherit";
	if (!isColorSchemeObject(colorScheme)) return "atelier";
	return Object.hasOwn(colorScheme, "base") && colorScheme.base === "inherit" ? "inherit" : "atelier";
}

export function createPalette(
	theme: PaletteTheme,
	colorEnabled: boolean,
	colorScheme: AtelierColorScheme = "atelier",
): AtelierPalette {
	const overrides = resolveOverrides(colorScheme);
	const base = schemeBase(colorScheme);
	const paintBase = (role: PaletteRole, text: string): string => {
		if (base === "inherit") return themeColor(theme, THEME_TOKENS[role], text);
		if (!theme.name) return themeColor(theme, LEGACY_UNNAMED_THEME[role], text);
		return rgb(FIXED_DARK[role], text);
	};

	return {
		paint(role, text) {
			if (!colorEnabled) return themeColor(theme, NO_COLOR[role], text);
			const override = overrides.get(role);
			return override ? paintResolved(theme, override, text) : paintBase(role, text);
		},
	};
}

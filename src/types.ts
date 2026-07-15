export type PresetName = "editorial" | "minimal" | "classic";
export type ActivityState = "ready" | "working" | "warning" | "error";
export type SegmentId = "brand" | "activity" | "metrics" | "context" | "model" | "git" | "statuses" | "menu";
export type Density = "comfortable" | "compact";
export type Ornament = "none" | "restrained";

export interface AtelierConfig {
	preset: PresetName;
	shortcut: string;
	segments: SegmentId[];
	density: Density;
	ornament: Ornament;
	contextWarning: number;
	contextDanger: number;
	currencyDecimals: number;
	showExtensionStatuses: boolean;
	showSessionActions: boolean;
}

export interface AtelierMetrics {
	usageAvailable: boolean;
	costAvailable: boolean;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheHitPercent?: number;
	cost: number;
	subscription: boolean;
	contextTokens: number | null;
	contextWindow: number;
	contextPercent: number | null;
	autoCompact: boolean | null;
}

export interface AtelierState {
	activity: ActivityState;
	modelId?: string;
	provider?: string;
	thinkingLevel?: string;
	branch?: string;
	dirty: boolean;
	metrics: AtelierMetrics;
	extensionStatuses: readonly string[];
}

export const DEFAULT_CONFIG: AtelierConfig = {
	preset: "editorial",
	shortcut: "alt+a",
	segments: ["brand", "activity", "metrics", "context", "model", "git", "statuses", "menu"],
	density: "comfortable",
	ornament: "restrained",
	contextWarning: 70,
	contextDanger: 90,
	currencyDecimals: 3,
	showExtensionStatuses: true,
	showSessionActions: true,
};

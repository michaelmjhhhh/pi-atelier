import type { WorkspacePulseData } from "./workspace-pulse.js";

export type TemplateName = "editorial" | "minimal" | "classic";
export type PresetName = TemplateName | "custom";
export type ActivityState = "ready" | "working" | "warning" | "error";
export type SegmentId =
	| "brand"
	| "activity"
	| "metrics"
	| "performance"
	| "context"
	| "model"
	| "git"
	| "statuses"
	| "menu";
export type Density = "comfortable" | "compact";
/** Legacy menu vocabulary. Ornament is translated to Brand visibility. */
export type Ornament = "none" | "restrained";
export type ConfigurationSource = "product" | "user" | "project" | "session";

export interface SegmentLayoutEntry {
	id: SegmentId;
	visible: boolean;
}
export type SegmentLayout = SegmentLayoutEntry[];

export interface DisplaySettings {
	preset: PresetName;
	density: Density;
	segmentLayout: SegmentLayout;
}

export interface DisplayPatch {
	preset?: PresetName;
	density?: Density;
	segmentLayout?: SegmentLayout;
}

export interface DisplayProvenance {
	preset: ConfigurationSource;
	density: ConfigurationSource;
	order: ConfigurationSource;
	visibility: Record<SegmentId, ConfigurationSource>;
}

export interface DisplayLayerState {
	user?: Record<string, unknown>;
	project?: Record<string, unknown>;
	session?: Record<string, unknown>;
}

/** A detached copy of the raw Session Display layer. */
export type SessionDisplayOverride = DisplayPatch & {
	segments?: unknown;
	ornament?: unknown;
	showExtensionStatuses?: unknown;
};

export interface ResponsePerformance {
	ttftMs: number;
	tokensPerSecond?: number;
	estimated?: true;
}

export interface DisplayValue {
	text: string;
	available: boolean;
}

export interface AtelierConfig extends DisplaySettings {
	shortcut: string;
	contextWarning: number;
	contextDanger: number;
	currencyDecimals: number;
	showSessionActions: boolean;
	showSidebarToolNames: boolean;
	showSidebarAgent: boolean;
	completionNotifications: boolean;
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

export type WorkspacePulseState =
	| { status: "inspecting" }
	| { status: "clean" | "changed" | "conflict" | "stale"; data: WorkspacePulseData }
	| { status: "not-repo" | "unavailable" };

export interface AtelierState {
	activity: ActivityState;
	workingLabel?: string;
	modelId?: string;
	provider?: string;
	thinkingLevel?: string;
	branch?: string;
	dirty: boolean;
	workspacePulse: WorkspacePulseState;
	metrics: AtelierMetrics;
	extensionStatuses: readonly string[];
}

/** Footer render input: runtime state plus the live response metrics the runtime does not own. */
export interface FooterState extends AtelierState {
	performance?: ResponsePerformance;
}

export const DEFAULT_CONFIG: AtelierConfig = {
	preset: "editorial",
	shortcut: "alt+a",
	segmentLayout: [
		{ id: "brand", visible: false },
		{ id: "activity", visible: true },
		{ id: "metrics", visible: true },
		{ id: "performance", visible: false },
		{ id: "context", visible: true },
		{ id: "model", visible: true },
		{ id: "git", visible: true },
		{ id: "statuses", visible: true },
		{ id: "menu", visible: true },
	],
	density: "comfortable",
	contextWarning: 70,
	contextDanger: 90,
	currencyDecimals: 3,
	showSessionActions: true,
	showSidebarToolNames: false,
	showSidebarAgent: true,
	completionNotifications: true,
};

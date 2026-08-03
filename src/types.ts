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
export type BuiltinSidebarPanelId =
	| "agent"
	| "activity"
	| "alerts"
	| "todos"
	| "context"
	| "workspace"
	| "usage"
	| "tools";
/** Stable namespaced IDs are used by contributed panels. */
export type ContributedSidebarPanelId = `${string}:${string}`;
/** Configuration may retain built-ins and unavailable contributed panels. */
export type SidebarPanelId = BuiltinSidebarPanelId | ContributedSidebarPanelId;
export interface SidebarPanelLayoutEntry {
	id: SidebarPanelId;
	visible: boolean;
}
export type SidebarPanelLayout = SidebarPanelLayoutEntry[];
/** Legacy menu vocabulary. Ornament is translated to Brand visibility. */
export type Ornament = "none" | "restrained";
export type ConfigurationSource = "product" | "user" | "project" | "session";
export interface TodoItem {
	id: number;
	text: string;
	done: boolean;
}
export interface RpivTask {
	id: number;
	subject: string;
	status: string;
}
export interface NormalizedTodo {
	id: number;
	text: string;
	status: "pending" | "in_progress" | "completed";
}

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
	sidebarPanelLayout?: SidebarPanelLayout;
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
	showSidebarTodos: boolean;
	sidebarDisabled: boolean;
	sidebarPanelLayout: SidebarPanelLayout;
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
	showSidebarTodos: true,
	sidebarDisabled: false,
	sidebarPanelLayout: [
		{ id: "agent", visible: true },
		{ id: "activity", visible: true },
		{ id: "alerts", visible: true },
		{ id: "todos", visible: true },
		{ id: "context", visible: true },
		{ id: "workspace", visible: true },
		{ id: "usage", visible: true },
		{ id: "tools", visible: true },
	],
	completionNotifications: true,
};

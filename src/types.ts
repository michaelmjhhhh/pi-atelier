import type { DENSITIES, PRODUCT_SEGMENT_ORDER, TEMPLATE_NAMES } from "./display.js";
import type { BUILTIN_SIDEBAR_PANEL_IDS } from "./sidebar-panels.js";
import type { PrefillView } from "./prefill.js";
import type { SubagentUsageSnapshot } from "./subagent-usage.js";
import type { WorkspacePulseData } from "./workspace-pulse.js";

export type { PrefillView };
export type TemplateName = (typeof TEMPLATE_NAMES)[number];
export type PresetName = TemplateName | "custom";
export type ActivityState = "ready" | "working" | "error";
export type SegmentId = (typeof PRODUCT_SEGMENT_ORDER)[number];
export type Density = (typeof DENSITIES)[number];
export type BuiltinSidebarPanelId = (typeof BUILTIN_SIDEBAR_PANEL_IDS)[number];
/** Stable namespaced IDs are used by contributed panels. */
export type ContributedSidebarPanelId = `${string}:${string}`;
/** Configuration may retain built-ins and unavailable contributed panels. */
export type SidebarPanelId = BuiltinSidebarPanelId | ContributedSidebarPanelId;
export interface SidebarPanelLayoutEntry {
	id: SidebarPanelId;
	visible: boolean;
}
export type SidebarPanelLayout = SidebarPanelLayoutEntry[];
export type ConfigurationSource = "product" | "user" | "project" | "session";
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

/** A detached copy of the Session Display layer. */
export type SessionDisplayOverride = Omit<DisplayPatch, "sidebarPanelLayout">;

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
	nerdFont: boolean;
	shortcut: string;
	resizeShortcut: string;
	/** Optional key that toggles the sidebar directly; empty means no binding. */
	toggleShortcut: string;
	contextWarning: number;
	contextDanger: number;
	currencyDecimals: number;
	showSidebarToolNames: boolean;
	showSidebarOnStartup: boolean;
	/** Sidebar width in columns when a session starts. */
	sidebarWidth: number;
	sidebarPanelLayout: SidebarPanelLayout;
	completionNotifications: boolean;
	showFooter: boolean;
	prefillEnabled: boolean;
	/** Which prefill numbers the PREFILL panel shows; the bar itself is always drawn. */
	prefillViews: readonly PrefillView[];
	/** Providers allowed to have `return_progress` injected into their request body. */
	prefillProviders: readonly string[];
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
	subagentUsage?: SubagentUsageSnapshot;
	extensionStatuses: readonly string[];
}

/** Footer render input: runtime state plus the live response metrics the runtime does not own. */
export interface FooterState extends AtelierState {
	performance?: ResponsePerformance;
	workspaceLabel?: string;
}

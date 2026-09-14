import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	ConfigurationSource,
	ContributedSidebarPanelId,
	BuiltinSidebarPanelId,
	SidebarPanelId,
	SidebarPanelLayout,
	SidebarPanelLayoutEntry,
} from "./types.js";

/** The event channel used by the public sidebar contribution protocol. */
export const SIDEBAR_PANEL_EVENT_CHANNEL = "pi-atelier:sidebar-panels" as const;
export const SIDEBAR_PANEL_PROTOCOL_VERSION = 1 as const;

/** Capability advertised in discovery when the host supports contribution defaults. */
export const SIDEBAR_PANEL_DEFAULTS_CAPABILITY = "panel-defaults-v1" as const;

/** Maximum visible characters retained for a contributed panel title. */
export const SIDEBAR_PANEL_MAX_TITLE_CHARS = 48;
/** Maximum structured rows retained for one contributed panel. */
export const SIDEBAR_PANEL_MAX_ROWS = 24;
/** Maximum visible characters retained for one contributed row. */
export const SIDEBAR_PANEL_MAX_ROW_CHARS = 160;
/**
 * Maximum raw UTF-16 code units inspected for a contributed panel title.
 *
 * Raw input is bounded before ANSI/control sanitization and Unicode iteration;
 * the allowance above the visible limit covers modest formatting overhead.
 */
export const SIDEBAR_PANEL_MAX_RAW_TITLE_CODE_UNITS = SIDEBAR_PANEL_MAX_TITLE_CHARS * 8;
/** Maximum raw UTF-16 code units inspected for a contributed row string or row.text. */
export const SIDEBAR_PANEL_MAX_RAW_ROW_CODE_UNITS = SIDEBAR_PANEL_MAX_ROW_CHARS * 8;
/** Maximum characters accepted for a namespaced contributed panel ID. */
export const SIDEBAR_PANEL_MAX_ID_CHARS = 128;
/** Maximum raw UTF-16 code units accepted for a discovery correlation token. */
export const SIDEBAR_PANEL_MAX_RAW_REQUEST_ID_CODE_UNITS = 256;
/** Maximum characters accepted for a contributed panel source name. */
export const SIDEBAR_PANEL_MAX_SOURCE_CHARS = 128;
/** Maximum contributed panels retained by one registry. */
export const SIDEBAR_PANEL_MAX_PANELS = 64;
/** Maximum distinct event sources tracked by one registry. */
export const SIDEBAR_PANEL_MAX_TRACKED_SOURCES = SIDEBAR_PANEL_MAX_PANELS;

/** Built-in panels remain available even when their optional content is empty. */
export const BUILTIN_SIDEBAR_PANEL_IDS = [
	"agent",
	"activity",
	"alerts",
	"todos",
	"context",
	"workspace",
	"usage",
	"tools",
] as const;

export const DEFAULT_SIDEBAR_PANEL_LAYOUT: SidebarPanelLayout = BUILTIN_SIDEBAR_PANEL_IDS.map((id) => ({
	id,
	visible: true,
}));

const BUILTIN_IDS = new Set<string>(BUILTIN_SIDEBAR_PANEL_IDS);
// Use a strict end-of-input assertion; JavaScript's `$` also matches before a final line terminator.
const NAMESPACED_ID = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*(?![\s\S])/;
const PANEL_ROLES = new Set([
	"primary",
	"accent",
	"muted",
	"dim",
	"ready",
	"working",
	"warning",
	"error",
	"input",
	"output",
	"cache",
	"context",
]);

export type SidebarPanelRole =
	| "primary"
	| "accent"
	| "muted"
	| "dim"
	| "ready"
	| "working"
	| "warning"
	| "error"
	| "input"
	| "output"
	| "cache"
	| "context";

export interface SidebarPanelRow {
	text: string;
	role?: SidebarPanelRole;
}

/** Built-in panel an optional contribution default may anchor to. */
export type SidebarPanelAnchorId = BuiltinSidebarPanelId;

/** Capability-negotiated default visibility and placement for a contribution. */
export interface SidebarPanelDefaults {
	visible: boolean;
	/** Built-in panel the contribution is inserted after when absent from saved layout. */
	after?: SidebarPanelAnchorId;
}

/** Structured, presentation-only data accepted from another extension. */
export interface SidebarPanelContribution {
	id: ContributedSidebarPanelId;
	title: string;
	rows: readonly (string | SidebarPanelRow)[];
	role?: SidebarPanelRole;
	defaults?: SidebarPanelDefaults;
}

interface SanitizedSidebarPanelContribution {
	id: ContributedSidebarPanelId;
	title: string;
	rows: SidebarPanelRow[];
	role?: SidebarPanelRole;
	defaults?: SidebarPanelDefaults;
}

export interface SidebarPanelData extends Omit<SidebarPanelContribution, "rows"> {
	rows: readonly SidebarPanelRow[];
	available: true;
	source: string;
}

export type SidebarPanelLayoutSource = ConfigurationSource;
export type { SidebarPanelLayout, SidebarPanelLayoutEntry };

export interface SidebarPanelRegisterEvent {
	version: typeof SIDEBAR_PANEL_PROTOCOL_VERSION;
	type: "register";
	source: string;
	revision: number;
	panel: SidebarPanelContribution;
	/** Optional correlation token used by load-order discovery. */
	requestId?: string;
}

export interface SidebarPanelUnregisterEvent {
	version: typeof SIDEBAR_PANEL_PROTOCOL_VERSION;
	type: "unregister";
	source: string;
	revision: number;
	id: ContributedSidebarPanelId;
}

export interface SidebarPanelDiscoveryEvent {
	version: typeof SIDEBAR_PANEL_PROTOCOL_VERSION;
	type: "discover";
	requestId: string;
	/** Host capabilities so contributors can adopt optional protocol features. */
	capabilities?: readonly string[];
}

export type SidebarPanelEvent =
	| SidebarPanelRegisterEvent
	| SidebarPanelUnregisterEvent
	| SidebarPanelDiscoveryEvent;

export interface SidebarPanelEventTransport {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export interface SidebarPanelRegistry {
	register(panel: SidebarPanelContribution, source?: string): boolean;
	unregister(id: ContributedSidebarPanelId, source?: string): boolean;
	getAvailable(): readonly SidebarPanelData[];
	get(id: string): SidebarPanelData | undefined;
	/** Handle a public event directly; useful for runtime and public-seam tests. */
	handleEvent(data: unknown): void;
	requestDiscovery(): void;
	dispose(): void;
}

export interface SidebarPanelRegistryOptions {
	events?: SidebarPanelEventTransport;
	onChange?: () => void;
	/**
	 * Prefix used only in discovery request IDs; it does not identify this
	 * registry or filter contributor event sources.
	 */
	instanceId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSidebarPanelContributionId(value: unknown): value is ContributedSidebarPanelId {
	return typeof value === "string" && value.length <= SIDEBAR_PANEL_MAX_ID_CHARS && NAMESPACED_ID.test(value);
}

export function isSidebarPanelId(value: unknown): value is SidebarPanelId {
	return typeof value === "string" && (BUILTIN_IDS.has(value) || isSidebarPanelContributionId(value));
}

/** Validate the source name retained with a contributed panel and its events. */
export function isSidebarPanelSource(value: unknown): value is string {
	return typeof value === "string" && value.length <= SIDEBAR_PANEL_MAX_SOURCE_CHARS && value.trim() !== "";
}

/** Validate a discovery correlation token before it is echoed across the event bus. */
export function isSidebarPanelRequestId(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > SIDEBAR_PANEL_MAX_RAW_REQUEST_ID_CODE_UNITS ||
		value.trim() === ""
	)
		return false;
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit < 0x20 || (codeUnit >= 0x7f && codeUnit <= 0x9f)) return false;
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
			index += 1;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function isSafeRevision(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

export function isSidebarPanelRole(value: unknown): value is SidebarPanelRole {
	return typeof value === "string" && PANEL_ROLES.has(value);
}

export function cloneSidebarPanelLayout(layout: readonly SidebarPanelLayoutEntry[]): SidebarPanelLayout {
	return layout.map((entry) => ({ id: entry.id, visible: entry.visible }));
}

/**
 * Normalizes persisted layout while retaining valid namespaced IDs that are not
 * currently available. Built-ins omitted by an older config are appended in
 * product order; newly discovered contributed panels are intentionally not
 * appended here and therefore remain hidden until explicitly enabled.
 */
export function normalizeSidebarPanelLayout(
	entries: readonly SidebarPanelLayoutEntry[],
	warnings: string[] = [],
): SidebarPanelLayout {
	const normalized: SidebarPanelLayout = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (!entry || !isSidebarPanelId(entry.id)) {
			warnings.push(`Unknown sidebar panel: ${String(entry?.id)}`);
			continue;
		}
		if (seen.has(entry.id)) {
			warnings.push(`Ignoring duplicate sidebar panel: ${entry.id}`);
			continue;
		}
		seen.add(entry.id);
		normalized.push({ id: entry.id, visible: entry.visible === true });
	}
	for (const id of BUILTIN_SIDEBAR_PANEL_IDS) {
		if (!seen.has(id)) normalized.push({ id, visible: true });
	}
	if (!normalized.some((entry) => entry.visible)) {
		warnings.push("sidebarPanelLayout must include at least one visible panel; restoring agent");
		const first = normalized.find((entry) => entry.id === "agent");
		if (first) first.visible = true;
	}
	return normalized;
}

/**
 * Composes the effective runtime layout: saved entries keep their explicit
 * order and visibility, then capability-negotiated defaults fill in available
 * contributed panels that have no saved entry. Defaults never rewrite the
 * saved layout; each contribution appears at most once.
 */
export function resolveEffectiveSidebarPanelLayout(
	savedLayout: readonly SidebarPanelLayoutEntry[],
	availablePanels: readonly SidebarPanelData[],
): SidebarPanelLayout {
	const effective: SidebarPanelLayout = savedLayout.map((entry) => ({
		id: entry.id,
		visible: entry.visible,
	}));
	const configured = new Set(effective.map((entry) => entry.id));
	const pending: Array<{ id: ContributedSidebarPanelId; after: SidebarPanelAnchorId | undefined }> = [];
	for (const panel of availablePanels) {
		if (configured.has(panel.id) || panel.defaults?.visible !== true) continue;
		pending.push({ id: panel.id, after: panel.defaults.after });
	}
	pending.sort((first, second) => (first.id < second.id ? -1 : first.id > second.id ? 1 : 0));
	// Insert in reverse so same-anchor siblings keep their sorted order: the
	// last sorted item inserts first, and each earlier item lands directly
	// after the anchor, ahead of everything inserted before it.
	for (let index = pending.length - 1; index >= 0; index -= 1) {
		const item = pending[index] as { id: ContributedSidebarPanelId; after: SidebarPanelAnchorId | undefined };
		const anchorIndex = item.after ? effective.findIndex((entry) => entry.id === item.after) : -1;
		if (anchorIndex >= 0) {
			effective.splice(anchorIndex + 1, 0, { id: item.id, visible: true });
		} else {
			effective.push({ id: item.id, visible: true });
		}
	}
	return effective;
}

const ANSI_ESCAPE =
	/(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~])/g;

/** Cheap precondition used before any regex sanitization or Unicode iteration. */
export function isSidebarPanelTextWithinRawLimit(value: unknown, maxCodeUnits: number): value is string {
	return typeof value === "string" && value.length <= maxCodeUnits;
}

function rawCodeUnitLimitFor(maxChars: number): number {
	return maxChars <= SIDEBAR_PANEL_MAX_TITLE_CHARS
		? SIDEBAR_PANEL_MAX_RAW_TITLE_CODE_UNITS
		: SIDEBAR_PANEL_MAX_RAW_ROW_CODE_UNITS;
}

function boundedRawText(value: string, maxChars: number): string {
	const limit = rawCodeUnitLimitFor(maxChars);
	if (value.length <= limit) return value;
	const bounded = value.slice(0, limit);
	return /[\ud800-\udbff]$/.test(bounded) ? bounded.slice(0, -1) : bounded;
}

function cleanSidebarPanelText(value: string): string {
	return value
		.replace(ANSI_ESCAPE, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Defensively sanitize text before any Settings or Sidebar interpolation. */
export function sanitizeSidebarPanelText(value: string, maxChars = SIDEBAR_PANEL_MAX_ROW_CHARS): string {
	return Array.from(cleanSidebarPanelText(boundedRawText(value, maxChars)))
		.slice(0, maxChars)
		.join("");
}

function fitsSidebarPanelText(value: string, maxChars: number): boolean {
	return Array.from(cleanSidebarPanelText(value)).length <= maxChars;
}

function sanitizeContribution(value: unknown): SanitizedSidebarPanelContribution | undefined {
	if (
		!isRecord(value) ||
		!isSidebarPanelContributionId(value.id) ||
		typeof value.title !== "string" ||
		!isSidebarPanelTextWithinRawLimit(value.title, SIDEBAR_PANEL_MAX_RAW_TITLE_CODE_UNITS) ||
		!Array.isArray(value.rows) ||
		value.rows.length > SIDEBAR_PANEL_MAX_ROWS ||
		!fitsSidebarPanelText(value.title, SIDEBAR_PANEL_MAX_TITLE_CHARS)
	)
		return undefined;
	const rows: SidebarPanelRow[] = [];
	for (const row of value.rows) {
		const text =
			typeof row === "string" ? row : isRecord(row) && typeof row.text === "string" ? row.text : undefined;
		if (
			text === undefined ||
			!isSidebarPanelTextWithinRawLimit(text, SIDEBAR_PANEL_MAX_RAW_ROW_CODE_UNITS) ||
			!fitsSidebarPanelText(text, SIDEBAR_PANEL_MAX_ROW_CHARS)
		)
			return undefined;
		rows.push({
			text: sanitizeSidebarPanelText(text, SIDEBAR_PANEL_MAX_ROW_CHARS),
			...(isRecord(row) && isSidebarPanelRole(row.role) ? { role: row.role } : {}),
		});
	}
	const defaults = sanitizeSidebarPanelDefaults(value.defaults);
	return {
		id: value.id,
		title: sanitizeSidebarPanelText(value.title, SIDEBAR_PANEL_MAX_TITLE_CHARS),
		rows,
		...(isSidebarPanelRole(value.role) ? { role: value.role } : {}),
		...(defaults ? { defaults } : {}),
	};
}

/**
 * Validate capability-negotiated default metadata. Returns undefined when the
 * metadata is absent or malformed so an otherwise-valid panel stays
 * registerable but hidden until the user enables it.
 */
export function sanitizeSidebarPanelDefaults(value: unknown): SidebarPanelDefaults | undefined {
	if (!isRecord(value) || typeof value.visible !== "boolean") return undefined;
	if (value.after === undefined) return { visible: value.visible };
	if (typeof value.after !== "string") return undefined;
	const anchor = BUILTIN_SIDEBAR_PANEL_IDS.find((id) => id === value.after);
	return anchor ? { visible: value.visible, after: anchor } : undefined;
}

function sourceFor(id: string): string {
	return id.includes(":") ? id.slice(0, id.indexOf(":")) : "pi-atelier";
}

function isEvent(value: unknown): value is Record<string, unknown> {
	return (
		isRecord(value) && value.version === SIDEBAR_PANEL_PROTOCOL_VERSION && typeof value.type === "string"
	);
}

// Revision numbers are part of the event protocol's per-source ordering, not
// of an individual publisher. Keep the allocator scoped to each transport so
// separate Pi runtimes (and test buses) cannot affect one another, while the
// weak key avoids retaining an event bus after its runtime is gone.
//
// Source entries are bounded tombstones: disposed publishers keep their last
// revision so a later publisher reusing that source cannot reset to one and
// resurrect stale events. A new source beyond the cap becomes an inert
// publisher because this API cannot report allocation failure to its caller.
const sidebarPanelRevisionAllocators = new WeakMap<object, Map<string, number>>();

function nextSidebarPanelRevision(events: SidebarPanelEventTransport, source: string): number | undefined {
	if (!isSidebarPanelSource(source)) return undefined;
	let revisions = sidebarPanelRevisionAllocators.get(events);
	if (!revisions) {
		revisions = new Map<string, number>();
		sidebarPanelRevisionAllocators.set(events, revisions);
	}
	const previous = revisions.get(source);
	if (previous === undefined && revisions.size >= SIDEBAR_PANEL_MAX_TRACKED_SOURCES) return undefined;
	const next = (previous ?? 0) + 1;
	revisions.set(source, next);
	return next;
}

const DISCOVERY_REQUEST_SEPARATOR = "-";
const MAX_SAFE_SEQUENCE_CODE_UNITS = String(Number.MAX_SAFE_INTEGER).length;
const DEFAULT_DISCOVERY_PREFIX = "atelier";

function boundedRawCodeUnits(value: string, maxCodeUnits: number): string {
	const bounded = value.slice(0, maxCodeUnits);
	return /[\ud800-\udbff]$/.test(bounded) ? bounded.slice(0, -1) : bounded;
}

function discoveryPrefix(instanceId: unknown): string {
	const candidate = isSidebarPanelRequestId(instanceId) ? instanceId : DEFAULT_DISCOVERY_PREFIX;
	const maxPrefixCodeUnits =
		SIDEBAR_PANEL_MAX_RAW_REQUEST_ID_CODE_UNITS -
		DISCOVERY_REQUEST_SEPARATOR.length -
		MAX_SAFE_SEQUENCE_CODE_UNITS;
	const bounded = boundedRawCodeUnits(candidate, maxPrefixCodeUnits);
	return isSidebarPanelRequestId(bounded) ? bounded : DEFAULT_DISCOVERY_PREFIX;
}

function sidebarPanelDataEqual(first: SidebarPanelData, second: SidebarPanelData): boolean {
	return (
		first.id === second.id &&
		first.title === second.title &&
		first.role === second.role &&
		first.available === second.available &&
		first.source === second.source &&
		first.rows.length === second.rows.length &&
		first.rows.every(
			(row, index) => row.text === second.rows[index]?.text && row.role === second.rows[index]?.role,
		)
	);
}

/** Create a lifecycle-safe registry backed only by Pi's public event bus. */
export function createSidebarPanelRegistry(options: SidebarPanelRegistryOptions = {}): SidebarPanelRegistry {
	const panels = new Map<string, SidebarPanelData>();
	const owners = new Map<string, string>();
	const revisions = new Map<string, number>();
	let disposed = false;
	let requestSequence = 0;
	const requestPrefix = discoveryPrefix(options.instanceId);
	let unsubscribe: (() => void) | undefined;

	const changed = (): void => {
		try {
			options.onChange?.();
		} catch {
			// Rendering invalidation is best effort and must not break event handling.
		}
	};
	const canAcceptRevision = (source: string, revision: number): boolean => {
		const previous = revisions.get(source) ?? 0;
		return Number.isSafeInteger(revision) && revision > previous;
	};
	const trackRevision = (source: string, revision: number): void => {
		revisions.set(source, revision);
	};
	const canTrackSource = (source: string): boolean =>
		revisions.has(source) || revisions.size < SIDEBAR_PANEL_MAX_TRACKED_SOURCES;
	const canRegister = (panel: SidebarPanelContribution, source: string): boolean => {
		const owner = owners.get(panel.id);
		if (owner !== undefined && owner !== source) return false;
		return panels.has(panel.id) || panels.size < SIDEBAR_PANEL_MAX_PANELS;
	};
	const applyRegister = (safe: SanitizedSidebarPanelContribution, resolvedSource: string): boolean => {
		owners.set(safe.id, resolvedSource);
		const next: SidebarPanelData = {
			...safe,
			available: true,
			source: resolvedSource,
		};
		const previous = panels.get(safe.id);
		if (previous && sidebarPanelDataEqual(previous, next)) return false;
		panels.set(safe.id, next);
		changed();
		return true;
	};
	const register = (panel: SidebarPanelContribution, source?: string): boolean => {
		if (disposed) return false;
		const safe = sanitizeContribution(panel);
		if (!safe) return false;
		const resolvedSource = source ?? sourceFor(safe.id);
		if (!isSidebarPanelSource(resolvedSource) || !canRegister(safe, resolvedSource)) return false;
		return applyRegister(safe, resolvedSource);
	};
	const canUnregister = (id: ContributedSidebarPanelId, source: string): boolean => owners.get(id) === source;
	const applyUnregister = (id: ContributedSidebarPanelId): boolean => {
		owners.delete(id);
		const removed = panels.delete(id);
		changed();
		return removed;
	};
	const unregister = (id: ContributedSidebarPanelId, source?: string): boolean => {
		if (disposed || !isSidebarPanelContributionId(id)) return false;
		const resolvedSource = source ?? sourceFor(id);
		if (!isSidebarPanelSource(resolvedSource) || !canUnregister(id, resolvedSource)) return false;
		return applyUnregister(id);
	};
	const handleEvent = (data: unknown): void => {
		if (disposed || !isEvent(data)) return;
		if (data.type === "discover") return;
		if (
			!isSidebarPanelSource(data.source) ||
			!isSafeRevision(data.revision) ||
			(data.type === "register" && data.requestId !== undefined && !isSidebarPanelRequestId(data.requestId))
		)
			return;
		const source = data.source;
		const revision = data.revision;
		let panel: SanitizedSidebarPanelContribution | undefined;
		let id: ContributedSidebarPanelId | undefined;
		if (data.type === "register") {
			panel = sanitizeContribution(data.panel);
			if (!panel) return;
		} else {
			if (data.type !== "unregister" || !isSidebarPanelContributionId(data.id)) return;
			id = data.id;
		}
		if (!canTrackSource(source) || !canAcceptRevision(source, revision)) return;
		if (panel) {
			if (!canRegister(panel, source)) return;
			trackRevision(source, revision);
			applyRegister(panel, source);
		} else if (id !== undefined) {
			if (!canUnregister(id, source)) return;
			trackRevision(source, revision);
			applyUnregister(id);
		}
	};
	if (options.events) {
		unsubscribe = options.events.on(SIDEBAR_PANEL_EVENT_CHANNEL, handleEvent);
	}
	const requestDiscovery = (): void => {
		if (disposed || !options.events) return;
		// Keep the sequence in Number's safe-integer range. A wrapped ID is
		// preferable to emitting an imprecise correlation token after exhaustion.
		requestSequence = requestSequence === Number.MAX_SAFE_INTEGER ? 1 : requestSequence + 1;
		const requestId = `${requestPrefix}${DISCOVERY_REQUEST_SEPARATOR}${requestSequence}`;
		if (!isSidebarPanelRequestId(requestId)) return;
		options.events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
			version: SIDEBAR_PANEL_PROTOCOL_VERSION,
			type: "discover",
			requestId,
			capabilities: [SIDEBAR_PANEL_DEFAULTS_CAPABILITY],
		});
	};
	requestDiscovery();
	return {
		register,
		unregister,
		handleEvent,
		requestDiscovery,
		getAvailable: () =>
			[...panels.values()].map((panel) => ({
				...panel,
				rows: panel.rows.map((row) => ({ text: row.text, ...(row.role ? { role: row.role } : {}) })),
			})),
		get: (id) => {
			const panel = panels.get(id);
			return panel
				? {
						...panel,
						rows: panel.rows.map((row) => ({ text: row.text, ...(row.role ? { role: row.role } : {}) })),
					}
				: undefined;
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			unsubscribe?.();
			unsubscribe = undefined;
			panels.clear();
			owners.clear();
		},
	};
}

/**
 * Convenience publisher for contributing extensions. It replays registration
 * when Atelier asks for discovery, so loading either extension first works.
 */
export function registerSidebarPanel(
	pi: Pick<ExtensionAPI, "events">,
	panel: SidebarPanelContribution,
	options: { source?: string } = {},
): { update(panel: SidebarPanelContribution): void; dispose(): void } {
	const initial = sanitizeContribution(panel);
	const stableId: ContributedSidebarPanelId | undefined = initial?.id;
	const requestedSource = options.source ?? (stableId ? sourceFor(stableId) : undefined);
	const source =
		stableId && requestedSource !== undefined && isSidebarPanelSource(requestedSource)
			? requestedSource
			: undefined;
	let current = source && stableId && initial ? initial : undefined;
	let disposed = false;
	const emitRegister = (requestId?: string): void => {
		if (disposed || !source || !current || (requestId !== undefined && !isSidebarPanelRequestId(requestId)))
			return;
		const revision = nextSidebarPanelRevision(pi.events, source);
		if (revision === undefined) return;
		pi.events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
			version: SIDEBAR_PANEL_PROTOCOL_VERSION,
			type: "register",
			source,
			revision,
			panel: current,
			...(requestId ? { requestId } : {}),
		});
	};
	const unsubscribe = source
		? pi.events.on(SIDEBAR_PANEL_EVENT_CHANNEL, (data) => {
				if (!isEvent(data) || data.type !== "discover" || !isSidebarPanelRequestId(data.requestId)) return;
				emitRegister(data.requestId);
			})
		: () => undefined;
	if (current) emitRegister();
	return {
		update(next) {
			if (disposed || !source || !stableId) return;
			const safe = sanitizeContribution(next);
			// A publisher owns one stable ID for its whole lifetime. Ignore an
			// invalid payload, but preserve the historical behavior of treating
			// an attempted ID change as an update to that stable ID.
			if (!safe) return;
			current = { ...safe, id: stableId };
			emitRegister();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			if (!source || !current) return;
			const revision = nextSidebarPanelRevision(pi.events, source);
			if (revision === undefined) return;
			pi.events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
				version: SIDEBAR_PANEL_PROTOCOL_VERSION,
				type: "unregister",
				source,
				revision,
				id: current.id,
			});
		},
	};
}

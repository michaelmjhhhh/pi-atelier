import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	applyDisplayTemplate,
	cloneLayout,
	derivePresetIdentity,
	isDensity,
	isPresetName,
	isSegmentId,
	legacySegmentsToLayout,
	normalizeSegmentLayout,
	PRODUCT_SEGMENT_ORDER,
} from "./display.js";
import { DEFAULT_SIDEBAR_PANEL_LAYOUT, normalizeSidebarPanelLayout } from "./sidebar-panels.js";
import { errorMessage, isRecord } from "./text.js";
import type {
	AtelierConfig,
	ConfigurationSource,
	DisplayLayerState,
	DisplayProvenance,
	DisplaySettings,
	PresetName,
	SegmentId,
	SegmentLayout,
	SidebarPanelLayout,
} from "./types.js";

export const MAX_CURRENCY_DECIMALS = 6;

export const DEFAULT_CONFIG: AtelierConfig = {
	...applyDisplayTemplate("editorial"),
	nerdFont: true,
	shortcut: "f6",
	contextWarning: 70,
	contextDanger: 90,
	currencyDecimals: 3,
	showSidebarToolNames: false,
	showSidebarOnStartup: true,
	sidebarPanelLayout: cloneLayout(DEFAULT_SIDEBAR_PANEL_LAYOUT),
	completionNotifications: true,
};

export interface ConfigLoadResult {
	config: AtelierConfig;
	warnings: string[];
	displayLayers: DisplayLayerState;
	displayProvenance: DisplayProvenance;
}

export interface LoadConfigOptions {
	userPath: string;
	projectPath: string;
	projectTrusted: boolean;
	/** Session layer input; Pi does not persist one, so only direct callers supply it. */
	session?: unknown;
}

type Ornament = "none" | "restrained";
const isOrnament = (value: unknown): value is Ornament => value === "none" || value === "restrained";

/** Settings that only the global User layer may change. */
const USER_ONLY_KEYS: ReadonlySet<string> = new Set([
	"showSidebarOnStartup",
	"completionNotifications",
	"nerdFont",
]);

const isEnoent = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const invalidEnum = (name: string, value: unknown): string =>
	typeof value === "string" ? `Unknown ${name}: ${value}` : `${name} must be a string`;

function parseSidebarLayout(value: unknown, warnings: string[]): SidebarPanelLayout | undefined {
	if (!Array.isArray(value)) {
		warnings.push("sidebarPanelLayout must be an array");
		return undefined;
	}
	const entries: { id: unknown; visible: boolean }[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.id !== "string") {
			warnings.push("Ignoring malformed sidebarPanelLayout entry");
			continue;
		}
		if (typeof item.visible !== "boolean") {
			warnings.push(`sidebar panel visibility for ${item.id} must be boolean; using hidden`);
		}
		entries.push({ id: item.id, visible: item.visible === true });
	}
	return normalizeSidebarPanelLayout(entries, warnings);
}

function resolveSidebarLayout(layers: DisplayLayerState): { layout: SidebarPanelLayout; warnings: string[] } {
	const warnings: string[] = [];
	const user = layers.user;
	if (user && "sidebarPanelLayout" in user) {
		const parsed = parseSidebarLayout(user.sidebarPanelLayout, warnings);
		return { layout: parsed ?? cloneLayout(DEFAULT_CONFIG.sidebarPanelLayout), warnings };
	}
	const layout = cloneLayout(DEFAULT_CONFIG.sidebarPanelLayout);
	// Legacy Agent and TODOS visibility are global-user-only compatibility inputs.
	// Project/session values are intentionally ignored.
	for (const [key, id] of [
		["showSidebarAgent", "agent"],
		["showSidebarTodos", "todos"],
	] as const) {
		const visible = user?.[key];
		const entry = layout.find((item) => item.id === id);
		if (typeof visible === "boolean" && entry) entry.visible = visible;
	}
	return { layout, warnings };
}

function parsePersistedLayout(value: unknown, warnings: string[]): SegmentLayout | undefined {
	if (!Array.isArray(value)) {
		warnings.push("segmentLayout must be an array");
		return undefined;
	}
	const seen = new Set<SegmentId>();
	const entries: SegmentLayout = [];
	for (const item of value) {
		if (!isRecord(item) || !isSegmentId(item.id)) {
			warnings.push(
				isRecord(item) && "id" in item
					? `Unknown segmentLayout segment: ${String(item.id)}`
					: "Ignoring malformed segmentLayout entry",
			);
			continue;
		}
		if (seen.has(item.id)) {
			warnings.push(`Ignoring duplicate segmentLayout segment: ${item.id}`);
			continue;
		}
		seen.add(item.id);
		if (typeof item.visible !== "boolean") {
			warnings.push(`segmentLayout visibility for ${item.id} must be boolean; using hidden`);
		}
		entries.push({ id: item.id, visible: item.visible === true });
	}
	return normalizeSegmentLayout(entries);
}

function parseLegacySegments(value: unknown, warnings: string[]): SegmentLayout | undefined {
	if (!Array.isArray(value)) {
		warnings.push("segments must be an array");
		return undefined;
	}
	const valid = new Set<SegmentId>();
	for (const item of value) {
		if (!isSegmentId(item)) warnings.push(`Unknown segment: ${String(item)}`);
		else if (valid.has(item)) warnings.push(`Ignoring duplicate segment: ${item}`);
		else valid.add(item);
	}
	return legacySegmentsToLayout([...valid]);
}

/**
 * Legacy `segments`, `ornament`, and `showExtensionStatuses` inputs predate
 * `segmentLayout`. They are translated only while no authoritative layout exists.
 */
interface CompatibilityState {
	preset: PresetName;
	ornament: Ornament;
	brandListed: boolean;
	statusesListed: boolean;
	showStatuses: boolean;
}

export function resolveDisplayLayers(layers: DisplayLayerState): {
	display: DisplaySettings;
	provenance: DisplayProvenance;
	warnings: string[];
} {
	let display: DisplaySettings = {
		preset: DEFAULT_CONFIG.preset,
		density: DEFAULT_CONFIG.density,
		segmentLayout: cloneLayout(DEFAULT_CONFIG.segmentLayout),
	};
	const provenance: DisplayProvenance = {
		preset: "product",
		density: "product",
		order: "product",
		visibility: Object.fromEntries(PRODUCT_SEGMENT_ORDER.map((id) => [id, "product"])) as Record<
			SegmentId,
			ConfigurationSource
		>,
	};
	const compatibility: CompatibilityState = {
		preset: "editorial",
		ornament: "none",
		brandListed: true,
		statusesListed: true,
		showStatuses: true,
	};
	const warnings: string[] = [];
	const setVisibility = (id: SegmentId, visible: boolean): void => {
		const entry = display.segmentLayout.find((item) => item.id === id);
		if (entry) entry.visible = visible;
	};

	for (const [source, input] of [
		["user", layers.user],
		["project", layers.project],
		["session", layers.session],
	] as const) {
		if (!input) continue;
		const markAllVisibility = (): void => {
			for (const id of PRODUCT_SEGMENT_ORDER) provenance.visibility[id] = source;
		};
		const applyLayout = (layout: SegmentLayout): void => {
			display.segmentLayout = layout;
			provenance.order = source;
			markAllVisibility();
			compatibility.brandListed = layout.find((entry) => entry.id === "brand")?.visible ?? false;
			compatibility.statusesListed = layout.find((entry) => entry.id === "statuses")?.visible ?? false;
		};
		let changedTemplateField = false;
		let suppliedPreset = false;

		if ("preset" in input) {
			if (isPresetName(input.preset)) {
				compatibility.preset = input.preset;
				display.preset = input.preset;
				provenance.preset = source;
				suppliedPreset = true;
				if (input.preset !== "custom") {
					display = applyDisplayTemplate(input.preset);
					provenance.density = source;
					provenance.order = source;
					markAllVisibility();
					changedTemplateField = true;
				}
			} else warnings.push(invalidEnum("preset", input.preset));
		}
		if ("density" in input) {
			if (isDensity(input.density)) {
				display.density = input.density;
				provenance.density = source;
				changedTemplateField = true;
			} else warnings.push(invalidEnum("density", input.density));
		}

		const layout = "segmentLayout" in input ? parsePersistedLayout(input.segmentLayout, warnings) : undefined;
		if (layout) {
			applyLayout(layout);
			changedTemplateField = true;
		} else {
			let legacySegmentsApplied = false;
			if ("segments" in input) {
				const legacy = parseLegacySegments(input.segments, warnings);
				if (legacy) {
					applyLayout(legacy);
					changedTemplateField = true;
					legacySegmentsApplied = true;
				}
			}
			let brandChanged = suppliedPreset || legacySegmentsApplied;
			if ("ornament" in input) {
				if (isOrnament(input.ornament)) {
					compatibility.ornament = input.ornament;
					brandChanged = true;
				} else warnings.push(invalidEnum("ornament", input.ornament));
			}
			if (brandChanged) {
				setVisibility(
					"brand",
					compatibility.brandListed &&
						compatibility.preset !== "editorial" &&
						compatibility.ornament === "restrained",
				);
				provenance.visibility.brand = source;
				changedTemplateField = true;
			}
			let statusesChanged = legacySegmentsApplied;
			if ("showExtensionStatuses" in input) {
				if (typeof input.showExtensionStatuses === "boolean") {
					compatibility.showStatuses = input.showExtensionStatuses;
					statusesChanged = true;
				} else warnings.push("showExtensionStatuses must be boolean");
			}
			if (statusesChanged) {
				setVisibility("statuses", compatibility.statusesListed && compatibility.showStatuses);
				provenance.visibility.statuses = source;
				changedTemplateField = true;
			}
		}

		const identity = derivePresetIdentity(display);
		if (identity !== display.preset) {
			display.preset = identity;
			if (changedTemplateField) provenance.preset = source;
		}
	}
	return { display, provenance, warnings };
}

function applyNonDisplay(
	input: unknown,
	config: AtelierConfig,
	warnings: string[],
	userLayer: boolean,
): void {
	if (!isRecord(input)) {
		if (input !== undefined) warnings.push("Configuration must be a JSON object");
		return;
	}
	if (typeof input.shortcut === "string") {
		const shortcut = input.shortcut.trim();
		if (shortcut) {
			// Retire the former default even when an older config saved it explicitly.
			config.shortcut = shortcut.toLowerCase() === "alt+a" ? DEFAULT_CONFIG.shortcut : shortcut;
		} else warnings.push("Shortcut cannot be empty");
	} else if ("shortcut" in input) warnings.push("shortcut must be a string");

	applyContextThresholds(input, config, warnings);

	if (typeof input.currencyDecimals === "number") {
		if (
			Number.isInteger(input.currencyDecimals) &&
			input.currencyDecimals >= 0 &&
			input.currencyDecimals <= MAX_CURRENCY_DECIMALS
		)
			config.currencyDecimals = input.currencyDecimals;
		else warnings.push(`currencyDecimals must be an integer from 0 through ${MAX_CURRENCY_DECIMALS}`);
	}
	for (const key of [
		"showSidebarToolNames",
		"showSidebarOnStartup",
		"completionNotifications",
		"nerdFont",
	] as const) {
		const value = input[key];
		if (typeof value === "boolean") {
			if (userLayer || !USER_ONLY_KEYS.has(key)) config[key] = value;
		} else if (key in input) warnings.push(`${key} must be boolean`);
	}
	for (const key of ["showSidebarAgent", "showSidebarTodos"] as const) {
		if (key in input && typeof input[key] !== "boolean") warnings.push(`${key} must be boolean`);
	}
}

function applyContextThresholds(
	input: Record<string, unknown>,
	config: AtelierConfig,
	warnings: string[],
): void {
	const hasWarning = "contextWarning" in input;
	const hasDanger = "contextDanger" in input;
	if (!hasWarning && !hasDanger) return;
	if (
		(hasWarning && typeof input.contextWarning !== "number") ||
		(hasDanger && typeof input.contextDanger !== "number")
	) {
		warnings.push("context thresholds must be numbers");
		return;
	}
	const warning = typeof input.contextWarning === "number" ? input.contextWarning : config.contextWarning;
	const danger = typeof input.contextDanger === "number" ? input.contextDanger : config.contextDanger;
	if (warning >= 0 && warning < danger && danger <= 100) {
		config.contextWarning = warning;
		config.contextDanger = danger;
	} else warnings.push("Invalid context threshold ordering; expected 0 <= warning < danger <= 100");
}

/** Resolve both file-backed and direct configuration through the same layer rules. */
export function resolveConfig(input: {
	user?: unknown;
	project?: unknown;
	session?: unknown;
}): ConfigLoadResult {
	const config: AtelierConfig = {
		...DEFAULT_CONFIG,
		segmentLayout: cloneLayout(DEFAULT_CONFIG.segmentLayout),
		sidebarPanelLayout: cloneLayout(DEFAULT_CONFIG.sidebarPanelLayout),
	};
	const warnings: string[] = [];
	const displayLayers: DisplayLayerState = {};
	for (const source of ["user", "project", "session"] as const) {
		const layer = input[source];
		applyNonDisplay(layer, config, warnings, source === "user");
		if (isRecord(layer)) displayLayers[source] = layer;
	}
	const resolved = resolveDisplayLayers(displayLayers);
	const sidebar = resolveSidebarLayout(displayLayers);
	Object.assign(config, resolved.display, { sidebarPanelLayout: sidebar.layout });
	return {
		config,
		warnings: [...new Set([...warnings, ...resolved.warnings, ...sidebar.warnings])],
		displayLayers,
		displayProvenance: resolved.provenance,
	};
}

async function readJson(path: string): Promise<{ value?: unknown; warning?: string }> {
	try {
		return { value: JSON.parse(await readFile(path, "utf8")) };
	} catch (error) {
		if (isEnoent(error)) return {};
		return { warning: `Cannot load ${path}: ${errorMessage(error)}` };
	}
}

export async function loadConfig(options: LoadConfigOptions): Promise<ConfigLoadResult> {
	const user = await readJson(options.userPath);
	const project = options.projectTrusted ? await readJson(options.projectPath) : {};
	const resolved = resolveConfig({ user: user.value, project: project.value, session: options.session });
	const fileWarnings = [user.warning, project.warning].filter((item): item is string => item !== undefined);
	return { ...resolved, warnings: [...fileWarnings, ...resolved.warnings] };
}

export async function saveUserConfigPatch(path: string, patch: Partial<AtelierConfig>): Promise<void> {
	let current: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!isRecord(parsed)) throw new Error("User configuration must be a JSON object");
		current = parsed;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	await writeJsonAtomic(path, { ...current, ...patch });
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_CONFIG, type AtelierConfig, type SegmentId } from "./types.js";

export interface ConfigLoadResult {
	config: AtelierConfig;
	warnings: string[];
}

export interface LoadConfigOptions {
	userPath: string;
	projectPath: string;
	projectTrusted: boolean;
	session?: Partial<AtelierConfig>;
}

const presets = new Set(["editorial", "minimal", "classic"]);
const densities = new Set(["comfortable", "compact"]);
const ornaments = new Set(["none", "restrained"]);
const segmentIds = new Set<SegmentId>([
	"brand",
	"activity",
	"metrics",
	"context",
	"model",
	"git",
	"statuses",
	"menu",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function validateConfig(input: unknown, base: AtelierConfig = DEFAULT_CONFIG): ConfigLoadResult {
	const config: AtelierConfig = { ...base, segments: [...base.segments] };
	const warnings: string[] = [];
	if (!isRecord(input)) {
		if (input !== undefined) warnings.push("Configuration must be a JSON object");
		return { config, warnings };
	}

	if (typeof input.preset === "string") {
		if (presets.has(input.preset)) config.preset = input.preset as AtelierConfig["preset"];
		else warnings.push(`Unknown preset: ${input.preset}`);
	} else if ("preset" in input) warnings.push("preset must be a string");
	if (typeof input.shortcut === "string") {
		if (input.shortcut.trim()) config.shortcut = input.shortcut.trim();
		else warnings.push("Shortcut cannot be empty");
	} else if ("shortcut" in input) warnings.push("shortcut must be a string");
	if (typeof input.density === "string") {
		if (densities.has(input.density)) config.density = input.density as AtelierConfig["density"];
		else warnings.push(`Unknown density: ${input.density}`);
	} else if ("density" in input) warnings.push("density must be a string");
	if (typeof input.ornament === "string") {
		if (ornaments.has(input.ornament)) config.ornament = input.ornament as AtelierConfig["ornament"];
		else warnings.push(`Unknown ornament: ${input.ornament}`);
	} else if ("ornament" in input) warnings.push("ornament must be a string");

	if (Array.isArray(input.segments)) {
		const seen = new Set<string>();
		const valid: SegmentId[] = [];
		for (const value of input.segments) {
			if (typeof value !== "string" || !segmentIds.has(value as SegmentId)) {
				warnings.push(`Unknown segment: ${String(value)}`);
				continue;
			}
			if (seen.has(value)) {
				warnings.push(`Ignoring duplicate segment: ${value}`);
				continue;
			}
			seen.add(value);
			valid.push(value as SegmentId);
		}
		for (const required of ["metrics", "context"] as const) {
			if (!seen.has(required)) valid.push(required);
		}
		config.segments = valid;
	} else if ("segments" in input) warnings.push("segments must be an array");

	const invalidThresholdType =
		("contextWarning" in input && typeof input.contextWarning !== "number") ||
		("contextDanger" in input && typeof input.contextDanger !== "number");
	const warning = typeof input.contextWarning === "number" ? input.contextWarning : config.contextWarning;
	const danger = typeof input.contextDanger === "number" ? input.contextDanger : config.contextDanger;
	if (invalidThresholdType) {
		warnings.push("context thresholds must be numbers");
	} else if (warning >= 0 && warning < danger && danger <= 100) {
		config.contextWarning = warning;
		config.contextDanger = danger;
	} else if ("contextWarning" in input || "contextDanger" in input) {
		warnings.push("Invalid context threshold ordering; expected 0 <= warning < danger <= 100");
	}

	if (typeof input.currencyDecimals === "number") {
		if (
			Number.isInteger(input.currencyDecimals) &&
			input.currencyDecimals >= 0 &&
			input.currencyDecimals <= 6
		) {
			config.currencyDecimals = input.currencyDecimals;
		} else warnings.push("currencyDecimals must be an integer from 0 through 6");
	}
	for (const key of ["showExtensionStatuses", "showSessionActions", "showSidebarToolNames"] as const) {
		if (typeof input[key] === "boolean") config[key] = input[key];
		else if (key in input) warnings.push(`${key} must be boolean`);
	}
	return { config, warnings };
}

export function mergeConfig(...layers: unknown[]): ConfigLoadResult {
	let config = { ...DEFAULT_CONFIG, segments: [...DEFAULT_CONFIG.segments] };
	const warnings: string[] = [];
	for (const layer of layers) {
		if (layer === undefined) continue;
		const result = validateConfig(layer, config);
		config = result.config;
		warnings.push(...result.warnings);
	}
	return { config, warnings: [...new Set(warnings)] };
}

async function readJson(path: string): Promise<{ value?: unknown; warning?: string }> {
	try {
		return { value: JSON.parse(await readFile(path, "utf8")) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		return { warning: `Cannot load ${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export async function loadConfig(options: LoadConfigOptions): Promise<ConfigLoadResult> {
	const user = await readJson(options.userPath);
	const project = options.projectTrusted ? await readJson(options.projectPath) : {};
	const result = mergeConfig(user.value, project.value, options.session);
	return {
		config: result.config,
		warnings: [
			...new Set(
				[user.warning, project.warning, ...result.warnings].filter((item): item is string => !!item),
			),
		],
	};
}

export async function saveUserConfig(path: string, config: AtelierConfig): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

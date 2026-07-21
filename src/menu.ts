import {
	getSettingsListTheme,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { saveUserConfig } from "./config.js";
import type { AtelierRuntime } from "./state.js";
import { DEFAULT_CONFIG, type AtelierConfig, type PresetName, type SegmentId } from "./types.js";

export type SaveConfig = typeof saveUserConfig;

export interface SidebarControls {
	isVisible(): boolean;
	toggle(): void;
}

interface MenuTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export function renderMenuBorder(theme: MenuTheme, width: number): string {
	return theme.bold(theme.fg("borderAccent", "━".repeat(Math.max(1, width))));
}

export function renderMenuFrame(theme: MenuTheme, lines: string[], width: number): string[] {
	if (width <= 1) return [truncateToWidth(renderMenuBorder(theme, 1), Math.max(0, width), "")];
	const innerWidth = width - 2;
	const border = (text: string) => theme.bold(theme.fg("borderAccent", text));
	const framed = lines.map((line) => {
		const content = truncateToWidth(line, innerWidth, "");
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
		return `${border("┃")}${content}${padding}${border("┃")}`;
	});
	return [border(`┏${"━".repeat(innerWidth)}┓`), ...framed, border(`┗${"━".repeat(innerWidth)}┛`)];
}

const PRESET_CONFIG: Record<PresetName, Partial<AtelierConfig>> = {
	editorial: DEFAULT_CONFIG,
	minimal: {
		preset: "minimal",
		segments: ["activity", "metrics", "context", "model", "menu"],
		density: "compact",
		ornament: "none",
	},
	classic: {
		preset: "classic",
		segments: ["metrics", "context", "model", "git", "statuses"],
		density: "comfortable",
		ornament: "none",
	},
};

export function createMenuActions(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: Pick<AtelierRuntime, "getConfig" | "setConfig" | "refreshUsage">,
	userConfigPath: string,
	save: SaveConfig = saveUserConfig,
) {
	return {
		async selectModel(model: Parameters<ExtensionAPI["setModel"]>[0]): Promise<void> {
			const previous = ctx.model;
			try {
				if (!(await pi.setModel(model))) {
					ctx.ui.notify(`Model ${model.provider}/${model.id} has no available authentication`, "error");
					return;
				}
				runtime.refreshUsage();
			} catch (error) {
				if (previous) {
					try {
						await pi.setModel(previous);
					} catch {}
				}
				ctx.ui.notify(
					`Could not change model: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
		setThinkingLevel(level: Parameters<ExtensionAPI["setThinkingLevel"]>[0]): void {
			const previous = pi.getThinkingLevel();
			try {
				pi.setThinkingLevel(level);
				runtime.refreshUsage();
			} catch (error) {
				try {
					pi.setThinkingLevel(previous);
				} catch {}
				ctx.ui.notify(
					`Could not change thinking level: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
		setTools(names: string[]): void {
			const previous = pi.getActiveTools();
			try {
				const known = new Set(pi.getAllTools().map((tool) => tool.name));
				pi.setActiveTools([...new Set(names.filter((name) => known.has(name)))]);
			} catch (error) {
				try {
					pi.setActiveTools(previous);
				} catch {}
				ctx.ui.notify(
					`Could not change tools: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
		setPreset(preset: PresetName): void {
			runtime.setConfig({ ...runtime.getConfig(), ...PRESET_CONFIG[preset], preset });
		},
		setDensity(density: AtelierConfig["density"]): void {
			runtime.setConfig({ ...runtime.getConfig(), density });
		},
		setOrnament(ornament: AtelierConfig["ornament"]): void {
			runtime.setConfig({ ...runtime.getConfig(), ornament });
		},
		moveSegment(id: SegmentId, direction: "earlier" | "later"): void {
			const segments = [...runtime.getConfig().segments];
			const index = segments.indexOf(id);
			const target = direction === "earlier" ? index - 1 : index + 1;
			if (index < 0 || target < 0 || target >= segments.length) return;
			[segments[index], segments[target]] = [segments[target] as SegmentId, segments[index] as SegmentId];
			runtime.setConfig({ ...runtime.getConfig(), segments });
		},
		setSegments(segments: SegmentId[]): void {
			const required: SegmentId[] = [...segments, "metrics", "context"];
			runtime.setConfig({
				...runtime.getConfig(),
				segments: [...new Set<SegmentId>(required)],
			});
		},
		async saveDisplayDefaults(): Promise<void> {
			try {
				await save(userConfigPath, runtime.getConfig());
				ctx.ui.notify("Pi Atelier display defaults saved", "info");
			} catch (error) {
				ctx.ui.notify(
					`Could not save Atelier settings: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
		async renameSession(): Promise<void> {
			try {
				const name = (await ctx.ui.input("Session name", "Release prep"))?.trim();
				if (name) pi.setSessionName(name);
			} catch (error) {
				ctx.ui.notify(
					`Could not rename session: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
		async compactSession(): Promise<void> {
			try {
				if (!(await ctx.ui.confirm("Compact session", "Summarize older context now?"))) return;
				ctx.compact({
					onError: (error) => ctx.ui.notify(`Compaction failed: ${error.message}`, "error"),
					onComplete: () => ctx.ui.notify("Session compacted", "info"),
				});
			} catch (error) {
				ctx.ui.notify(
					`Could not compact session: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	};
}

async function showSelection(
	ctx: ExtensionContext,
	title: string,
	items: SelectItem[],
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>(
		(tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
			const list = new SelectList(items, Math.min(items.length, 12), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc back"), 1, 0));
			return {
				render: (width) => renderMenuFrame(theme, container.render(Math.max(1, width - 2)), width),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "70%", minWidth: 32, maxHeight: "80%", margin: 1 },
		},
	);
}

async function showToolSettings(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	setTools: (names: string[]) => void,
) {
	const tools = pi.getAllTools();
	const enabled = new Set(pi.getActiveTools());
	await ctx.ui.custom<void>(
		(tui, _theme, _keys, done) => {
			const items: SettingItem[] = tools.map((tool) => ({
				id: tool.name,
				label: tool.name,
				currentValue: enabled.has(tool.name) ? "enabled" : "disabled",
				values: ["enabled", "disabled"],
			}));
			const list = new SettingsList(
				items,
				Math.min(items.length + 2, 16),
				getSettingsListTheme(),
				(id, value) => {
					if (value === "enabled") enabled.add(id);
					else enabled.delete(id);
					if (enabled.size === 0) {
						enabled.add(id);
						ctx.ui.notify("At least one tool must remain active", "warning");
					}
					setTools([...enabled]);
				},
				() => done(undefined),
				{ enableSearch: true },
			);
			return {
				render: (width) => list.render(width),
				invalidate: () => list.invalidate(),
				handleInput: (data) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "70%", minWidth: 32, maxHeight: "80%", margin: 1 },
		},
	);
}

export async function openAtelierMenu(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: AtelierRuntime,
	userConfigPath: string,
	sidebar: SidebarControls,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Pi Atelier menu requires TUI mode", "warning");
		return;
	}
	const actions = createMenuActions(pi, ctx, runtime, userConfigPath);
	for (;;) {
		const sidebarVisible = sidebar.isVisible();
		const section = await showSelection(ctx, "◆ Pi Atelier", [
			{
				value: "sidebar",
				label: `Sidebar: ${sidebarVisible ? "On" : "Off"}`,
				description: sidebarVisible ? "Hide the live session sidecar" : "Show the live session sidecar",
			},
			{ value: "model", label: "Model", description: "Model and thinking level" },
			{ value: "tools", label: "Tools", description: "Search and toggle active tools" },
			{ value: "display", label: "Display", description: "Preset and footer segments" },
			{ value: "session", label: "Session", description: "Details, name, and compaction" },
			{ value: "close", label: "Close" },
		]);
		if (!section || section === "close") return;

		if (section === "sidebar") {
			sidebar.toggle();
			continue;
		}

		if (section === "model") {
			const action = await ctx.ui.select("Model controls", ["Choose model", "Thinking level", "Back"]);
			if (action === "Choose model") {
				const models = ctx.modelRegistry.getAvailable();
				const labels = models.map((model) => `${model.provider}/${model.id}`);
				const selected = await ctx.ui.select("Choose model", labels);
				const model = models[labels.indexOf(selected ?? "")];
				if (model) await actions.selectModel(model);
			} else if (action === "Thinking level") {
				const selected = await ctx.ui.select("Thinking level", [
					"off",
					"minimal",
					"low",
					"medium",
					"high",
					"xhigh",
					"max",
				]);
				if (selected) actions.setThinkingLevel(selected as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
			}
		} else if (section === "tools") {
			await showToolSettings(ctx, pi, actions.setTools);
		} else if (section === "display") {
			const action = await ctx.ui.select("Display controls", [
				"Editorial preset",
				"Minimal preset",
				"Classic preset",
				"Toggle segments",
				"Reorder segments",
				"Density",
				"Ornament",
				"Save as user default",
				"Back",
			]);
			if (action?.endsWith("preset")) actions.setPreset(action.split(" ")[0]?.toLowerCase() as PresetName);
			else if (action === "Toggle segments") {
				const current = runtime.getConfig().segments;
				const optional: SegmentId[] = ["brand", "activity", "model", "git", "statuses", "menu"];
				const labels = optional.map((id) => `${current.includes(id) ? "✓" : "○"} ${id}`);
				const selected = await ctx.ui.select("Toggle footer segment", labels);
				const id = optional[labels.indexOf(selected ?? "")];
				if (id)
					actions.setSegments(
						current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
					);
			} else if (action === "Reorder segments") {
				const current = runtime.getConfig().segments;
				const selected = await ctx.ui.select("Choose segment", current);
				if (selected) {
					const direction = await ctx.ui.select("Move segment", ["earlier", "later"]);
					if (direction) actions.moveSegment(selected as SegmentId, direction as "earlier" | "later");
				}
			} else if (action === "Density") {
				const density = await ctx.ui.select("Footer density", ["comfortable", "compact"]);
				if (density) actions.setDensity(density as AtelierConfig["density"]);
			} else if (action === "Ornament") {
				const ornament = await ctx.ui.select("Footer ornament", ["restrained", "none"]);
				if (ornament) actions.setOrnament(ornament as AtelierConfig["ornament"]);
			} else if (action === "Save as user default") await actions.saveDisplayDefaults();
		} else if (section === "session") {
			const options = runtime.getConfig().showSessionActions
				? ["Show details", "Rename session", "Compact session", "Back"]
				: ["Show details", "Back"];
			const action = await ctx.ui.select("Session controls", options);
			if (action === "Show details") {
				const file = ctx.sessionManager.getSessionFile();
				ctx.ui.notify(file ? `Session: ${file}` : "Ephemeral session", "info");
			} else if (action === "Rename session") await actions.renameSession();
			else if (action === "Compact session") await actions.compactSession();
		}
	}
}

import {
	DynamicBorder,
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
} from "@earendil-works/pi-tui";
import { saveUserConfig } from "./config.js";
import type { AtelierRuntime } from "./state.js";
import { DEFAULT_CONFIG, type AtelierConfig, type PresetName, type SegmentId } from "./types.js";

export type SaveConfig = typeof saveUserConfig;

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
			try {
				if (!(await pi.setModel(model))) {
					ctx.ui.notify(`Model ${model.provider}/${model.id} has no available authentication`, "error");
					return;
				}
				runtime.refreshUsage();
			} catch (error) {
				ctx.ui.notify(
					`Could not change model: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
		setThinkingLevel(level: Parameters<ExtensionAPI["setThinkingLevel"]>[0]): void {
			pi.setThinkingLevel(level);
			runtime.refreshUsage();
		},
		setTools(names: string[]): void {
			const known = new Set(pi.getAllTools().map((tool) => tool.name));
			pi.setActiveTools([...new Set(names.filter((name) => known.has(name)))]);
		},
		setPreset(preset: PresetName): void {
			runtime.setConfig({ ...runtime.getConfig(), ...PRESET_CONFIG[preset], preset });
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
			const name = (await ctx.ui.input("Session name", "Release prep"))?.trim();
			if (name) pi.setSessionName(name);
		},
		async compactSession(): Promise<void> {
			if (!(await ctx.ui.confirm("Compact session", "Summarize older context now?"))) return;
			ctx.compact({
				onError: (error) => ctx.ui.notify(`Compaction failed: ${error.message}`, "error"),
				onComplete: () => ctx.ui.notify("Session compacted", "info"),
			});
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
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
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
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			return {
				render: (width) => container.render(width),
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
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Pi Atelier menu requires TUI mode", "warning");
		return;
	}
	const actions = createMenuActions(pi, ctx, runtime, userConfigPath);
	for (;;) {
		const section = await showSelection(ctx, "◆ Pi Atelier", [
			{ value: "model", label: "Model", description: "Model and thinking level" },
			{ value: "tools", label: "Tools", description: "Search and toggle active tools" },
			{ value: "display", label: "Display", description: "Preset and footer segments" },
			{ value: "session", label: "Session", description: "Details, name, and compaction" },
			{ value: "close", label: "Close" },
		]);
		if (!section || section === "close") return;

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
				"Save as user default",
				"Back",
			]);
			if (action?.endsWith("preset")) actions.setPreset(action.split(" ")[0]?.toLowerCase() as PresetName);
			if (action === "Save as user default") await actions.saveDisplayDefaults();
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

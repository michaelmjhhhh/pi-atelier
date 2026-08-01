import {
	type ExtensionAPI,
	type ExtensionContext,
	getSettingsListTheme,
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
import { saveUserConfig, saveUserConfigPatch } from "./config.js";
import { applyDisplayTemplate, reorderSegment, toggleSegmentVisibility } from "./display.js";
import { createSettingsWorkspace } from "./settings-workspace.js";
import type { AtelierRuntime } from "./state.js";
import type { AtelierConfig, Ornament, SegmentId, TemplateName } from "./types.js";

export type SaveConfig = typeof saveUserConfig;
export type SaveConfigPatch = typeof saveUserConfigPatch;

export interface SidebarControls {
	isVisible(): boolean;
	toggle(): void;
	isToolListExpanded(): boolean;
	toggleToolList(): Promise<void>;
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

export function createMenuActions(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: Pick<
		AtelierRuntime,
		"getConfig" | "setConfig" | "getDisplaySettings" | "setSessionDisplayPatch" | "refreshUsage"
	>,
	userConfigPath: string,
	_save: SaveConfig = saveUserConfig,
	savePatch: SaveConfigPatch = saveUserConfigPatch,
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
		setPreset(preset: TemplateName): void {
			runtime.setSessionDisplayPatch(applyDisplayTemplate(preset));
		},
		setDensity(density: AtelierConfig["density"]): void {
			runtime.setSessionDisplayPatch({ density });
		},
		setOrnament(ornament: Ornament): void {
			runtime.setSessionDisplayPatch({
				segmentLayout: toggleSegmentVisibility(
					runtime.getDisplaySettings().segmentLayout,
					"brand",
					ornament === "restrained",
				),
			});
		},
		async setCompletionNotifications(enabled: boolean): Promise<void> {
			runtime.setConfig({ ...runtime.getConfig(), completionNotifications: enabled });
			try {
				await savePatch(userConfigPath, { completionNotifications: enabled });
				ctx.ui.notify(`Completion notifications ${enabled ? "enabled" : "disabled"}`, "info");
			} catch (error) {
				ctx.ui.notify(
					`Completion notifications changed for this session but could not be saved: ${
						error instanceof Error ? error.message : String(error)
					}`,
					"warning",
				);
			}
		},
		moveSegment(id: SegmentId, direction: "earlier" | "later"): void {
			runtime.setSessionDisplayPatch({
				segmentLayout: reorderSegment(runtime.getDisplaySettings().segmentLayout, id, direction),
			});
		},
		setSegments(segments: SegmentId[]): void {
			const selected = new Set(segments);
			let layout = runtime
				.getDisplaySettings()
				.segmentLayout.map((entry) => ({ ...entry, visible: selected.has(entry.id) }));
			layout = toggleSegmentVisibility(layout, "metrics", true);
			layout = toggleSegmentVisibility(layout, "context", true);
			runtime.setSessionDisplayPatch({ segmentLayout: layout });
		},
		toggleSegment(id: SegmentId): void {
			runtime.setSessionDisplayPatch({
				segmentLayout: toggleSegmentVisibility(runtime.getDisplaySettings().segmentLayout, id),
			});
		},
		async saveDisplayDefaults(): Promise<void> {
			try {
				const display = runtime.getDisplaySettings();
				await savePatch(userConfigPath, display);
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

export async function openDisplaySettingsWorkspace(
	ctx: ExtensionContext,
	runtime: Pick<
		AtelierRuntime,
		| "getConfig"
		| "getDisplaySettings"
		| "getDisplayProvenance"
		| "getSessionDisplayOverride"
		| "replaceSessionDisplayOverride"
		| "clearSessionDisplayOverride"
		| "applySavedUserDisplayPatch"
	>,
	userConfigPath: string,
	requestAllRenders: () => void,
	savePatch: SaveConfigPatch = saveUserConfigPatch,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Pi Atelier Display settings require TUI mode", "warning");
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, _keys, done) =>
			createSettingsWorkspace({
				getDisplaySettings: () => runtime.getDisplaySettings(),
				getDisplayProvenance: () => runtime.getDisplayProvenance(),
				getSessionDisplayOverride: () => runtime.getSessionDisplayOverride(),
				replaceSessionDisplayOverride: (value) => runtime.replaceSessionDisplayOverride(value),
				clearSessionDisplayOverride: () => runtime.clearSessionDisplayOverride(),
				persistUserDisplayPatch: (patch) => savePatch(userConfigPath, patch),
				applySavedUserDisplayPatch: (patch) => runtime.applySavedUserDisplayPatch(patch),
				getRenderConfig: () => runtime.getConfig(),
				theme,
				colorEnabled: !("NO_COLOR" in process.env),
				requestWorkspaceRender: () => tui.requestRender(),
				requestLiveRender: requestAllRenders,
				close: () => done(undefined),
				report: (message, kind) => {
					if (kind === "error") ctx.ui.notify(message, "error");
				},
			}),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "90%", minWidth: 36, maxHeight: "95%", margin: 1 },
		},
	);
}

export async function openAtelierControlCenter(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: AtelierRuntime,
	userConfigPath: string,
	sidebar: SidebarControls,
	requestAllRenders: () => void = () => undefined,
	savePatch: SaveConfigPatch = saveUserConfigPatch,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Pi Atelier Control Center requires TUI mode", "warning");
		return;
	}
	const actions = createMenuActions(pi, ctx, runtime, userConfigPath, saveUserConfig, savePatch);
	for (;;) {
		const category = await showSelection(ctx, "◆ Atelier Control Center", [
			{ value: "settings", label: "Settings", description: "Persisted defaults and Display workspace" },
			{
				value: "controls",
				label: "Controls",
				description: `Session controls · Sidebar: ${sidebar.isVisible() ? "On" : "Off"}`,
			},
			{ value: "actions", label: "Actions", description: "Session details, rename, and compaction" },
			{ value: "close", label: "Close" },
		]);
		if (!category || category === "close") return;
		if (category === "settings") {
			for (;;) {
				const choice = await showSelection(ctx, "Settings", [
					{
						value: "display",
						label: `Display: ${runtime.getDisplaySettings().preset}`,
						description: "Session overrides, preview, Undo, Revert, and Save",
					},
					{
						value: "notifications",
						label: `Completion notifications: ${runtime.getConfig().completionNotifications ? "On" : "Off"}`,
						description: "User preference",
					},
					{
						value: "sidebar-tools",
						label: `Sidebar tool list: ${sidebar.isToolListExpanded() ? "Expanded" : "Collapsed"}`,
						description: "User preference",
					},
					{ value: "back", label: "Back" },
				]);
				if (!choice || choice === "back") break;
				if (choice === "display")
					await openDisplaySettingsWorkspace(ctx, runtime, userConfigPath, requestAllRenders, savePatch);
				else if (choice === "notifications")
					await actions.setCompletionNotifications(!runtime.getConfig().completionNotifications);
				else await sidebar.toggleToolList();
			}
		} else if (category === "controls") {
			for (;;) {
				const choice = await showSelection(ctx, "Controls", [
					{
						value: "sidebar",
						label: `Sidebar: ${sidebar.isVisible() ? "On" : "Off"}`,
						description: "Session control; shown by default",
					},
					{
						value: "model",
						label: `Model / thinking: ${ctx.model?.id ?? "none"} / ${pi.getThinkingLevel()}`,
						description: "Session control",
					},
					{
						value: "tools",
						label: `Active tools: ${pi.getActiveTools().length}`,
						description: "Session control",
					},
					{ value: "back", label: "Back" },
				]);
				if (!choice || choice === "back") break;
				if (choice === "sidebar") sidebar.toggle();
				else if (choice === "tools") await showToolSettings(ctx, pi, actions.setTools);
				else {
					const selected = await ctx.ui.select("Model controls", ["Choose model", "Thinking level", "Back"]);
					if (selected === "Choose model") {
						const models = ctx.modelRegistry.getAvailable();
						const labels = models.map((model) => `${model.provider}/${model.id}`);
						const model = models[labels.indexOf((await ctx.ui.select("Choose model", labels)) ?? "")];
						if (model) await actions.selectModel(model);
					} else if (selected === "Thinking level") {
						const level = await ctx.ui.select("Thinking level", [
							"off",
							"minimal",
							"low",
							"medium",
							"high",
							"xhigh",
							"max",
						]);
						if (level) actions.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
					}
				}
			}
		} else {
			for (;;) {
				const choice = await showSelection(ctx, "Actions", [
					{
						value: "details",
						label: "Session details",
						description: ctx.sessionManager.getSessionFile() ?? "Ephemeral session",
					},
					...(runtime.getConfig().showSessionActions
						? [
								{ value: "rename", label: "Rename session" },
								{ value: "compact", label: "Compact session" },
							]
						: []),
					{ value: "back", label: "Back" },
				]);
				if (!choice || choice === "back") break;
				if (choice === "details")
					ctx.ui.notify(
						ctx.sessionManager.getSessionFile()
							? `Session: ${ctx.sessionManager.getSessionFile()}`
							: "Ephemeral session",
						"info",
					);
				else if (choice === "rename") await actions.renameSession();
				else await actions.compactSession();
			}
		}
	}
}

/** @deprecated Use openAtelierControlCenter. */
export async function openAtelierMenu(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: AtelierRuntime,
	userConfigPath: string,
	sidebar: SidebarControls,
	_save: SaveConfig = saveUserConfig,
	savePatch: SaveConfigPatch = saveUserConfigPatch,
): Promise<void> {
	await openAtelierControlCenter(pi, ctx, runtime, userConfigPath, sidebar, () => undefined, savePatch);
}

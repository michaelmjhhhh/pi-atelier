import {
	getSettingsListTheme,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	matchesKey,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { saveUserConfig, saveUserConfigPatch } from "./config.js";
import {
	DISPLAY_SETTINGS_OVERLAY_MARGIN,
	DISPLAY_SETTINGS_OVERLAY_MAX_HEIGHT,
	createSettingsWorkspace,
	getDisplaySettingsViewportHeight,
	type SidebarPanelSetting,
} from "./settings-workspace.js";
import { applyDisplayTemplate, reorderSegment, toggleSegmentVisibility } from "./display.js";
import {
	createLifecycleOverlayComponent,
	createOverlaySettlement,
	type OverlayLifetime,
	type OverlaySettlement,
	type RetirableLifecycleOverlayComponent,
} from "./overlay-lifecycle.js";
import type { AtelierRuntime } from "./state.js";
import type { AtelierConfig, Ornament, SegmentId, TemplateName } from "./types.js";

export type { OverlayLifetime } from "./overlay-lifecycle.js";
export type SaveConfig = typeof saveUserConfig;
export type SaveConfigPatch = typeof saveUserConfigPatch;

export interface DisplaySettingsWorkspaceOptions {
	/** Lifecycle options are intentionally trailing so the legacy callback positions stay unambiguous. */
	lifetime?: OverlayLifetime;
}

export interface ControlCenterOptions extends DisplaySettingsWorkspaceOptions {}
/** Lifecycle options are trailing so legacy action callback positions remain source-compatible. */
export interface MenuActionsOptions extends DisplaySettingsWorkspaceOptions {}

function isOverlayLifetimeActive(lifetime: OverlayLifetime | undefined): boolean {
	return lifetime?.isActive() ?? true;
}

function awaitOverlaySettlement<T>(
	hostPromise: PromiseLike<T>,
	settlement: OverlaySettlement<T>,
): Promise<T> {
	return Promise.race([hostPromise, settlement.promise]);
}

interface OverlayCompletion<T> {
	bind(component: RetirableLifecycleOverlayComponent): void;
	finish(value: T): void;
	retire(): void;
	release(): void;
}

/** Couples one host overlay completion to one centrally-owned lifecycle binding. */
function createOverlayCompletion<T>(
	settlement: OverlaySettlement<T>,
	done: (value: T) => void,
	retiredValue: T,
): OverlayCompletion<T> {
	let component: RetirableLifecycleOverlayComponent | undefined;
	let completed = false;
	const complete = (value: T): void => {
		if (completed) return;
		completed = true;
		// Extension-side callers must settle even if Pi cannot remove the host overlay.
		settlement.settle(value);
		try {
			done(value);
		} catch {
			// Host overlay removal is best-effort; the extension promise is already settled.
		}
	};
	return {
		bind(next) {
			component = next;
		},
		finish(value) {
			if (completed) return;
			component?.release();
			complete(value);
		},
		retire() {
			complete(retiredValue);
		},
		release() {
			component?.release();
		},
	};
}

export interface SidebarControls {
	isVisible(): boolean;
	toggle(): void;
	isToolListExpanded(): boolean;
	toggleToolList(): Promise<void>;
	getSidebarPanelSettings?(): readonly SidebarPanelSetting[];
}

interface MenuTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** @deprecated Kept for direct source consumers; renderMenuFrame handles its narrow border inline. */
export function renderMenuBorder(theme: MenuTheme, width: number): string {
	return theme.bold(theme.fg("borderAccent", "━".repeat(Math.max(1, width))));
}

export function renderMenuFrame(theme: MenuTheme, lines: string[], width: number): string[] {
	if (width <= 1) {
		const border = theme.bold(theme.fg("borderAccent", "━"));
		return [truncateToWidth(border, Math.max(0, width), "")];
	}
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
	/** @deprecated Retained as an unused positional slot for direct source compatibility. */
	_save: SaveConfig = saveUserConfig,
	savePatch: SaveConfigPatch = saveUserConfigPatch,
	options: MenuActionsOptions = {},
) {
	const lifetime = options.lifetime;
	const isActive = (): boolean => isOverlayLifetimeActive(lifetime);
	const notify = (message: string, kind: "info" | "warning" | "error"): void => {
		if (isActive()) ctx.ui.notify(message, kind);
	};
	return {
		async selectModel(model: Parameters<ExtensionAPI["setModel"]>[0]): Promise<void> {
			if (!isActive()) return;
			const previous = ctx.model;
			try {
				if (!(await pi.setModel(model))) {
					notify(`Model ${model.provider}/${model.id} has no available authentication`, "error");
					return;
				}
				if (!isActive()) return;
				runtime.refreshUsage();
			} catch (error) {
				if (!isActive()) return;
				if (previous) {
					try {
						await pi.setModel(previous);
					} catch {}
				}
				notify(`Could not change model: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
		setThinkingLevel(level: Parameters<ExtensionAPI["setThinkingLevel"]>[0]): void {
			if (!isActive()) return;
			const previous = pi.getThinkingLevel();
			try {
				pi.setThinkingLevel(level);
				if (!isActive()) return;
				runtime.refreshUsage();
			} catch (error) {
				if (!isActive()) return;
				try {
					pi.setThinkingLevel(previous);
				} catch {}
				notify(
					`Could not change thinking level: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
		setTools(names: string[]): void {
			if (!isActive()) return;
			const previous = pi.getActiveTools();
			try {
				const known = new Set(pi.getAllTools().map((tool) => tool.name));
				pi.setActiveTools([...new Set(names.filter((name) => known.has(name)))]);
			} catch (error) {
				if (!isActive()) return;
				try {
					pi.setActiveTools(previous);
				} catch {}
				notify(`Could not change tools: ${error instanceof Error ? error.message : String(error)}`, "error");
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
		async setShowSidebarOnStartup(enabled: boolean): Promise<void> {
			if (!isActive()) return;
			const previous = runtime.getConfig();
			runtime.setConfig({ ...previous, showSidebarOnStartup: enabled });
			try {
				await savePatch(userConfigPath, { showSidebarOnStartup: enabled });
				if (!isActive()) return;
				notify(`Sidebar will start ${enabled ? "shown" : "hidden"}`, "info");
			} catch (error) {
				if (!isActive()) return;
				runtime.setConfig(previous);
				notify(
					`Sidebar startup preference could not be saved: ${
						error instanceof Error ? error.message : String(error)
					}`,
					"warning",
				);
			}
		},
		async setCompletionNotifications(enabled: boolean): Promise<void> {
			if (!isActive()) return;
			runtime.setConfig({ ...runtime.getConfig(), completionNotifications: enabled });
			try {
				await savePatch(userConfigPath, { completionNotifications: enabled });
				if (!isActive()) return;
				notify(`Completion notifications ${enabled ? "enabled" : "disabled"}`, "info");
			} catch (error) {
				if (!isActive()) return;
				notify(
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
			if (!isActive()) return;
			try {
				const display = runtime.getDisplaySettings();
				await savePatch(userConfigPath, display);
				if (!isActive()) return;
				notify("Pi Atelier display defaults saved", "info");
			} catch (error) {
				if (!isActive()) return;
				notify(
					`Could not save Atelier settings: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
		async renameSession(): Promise<void> {
			if (!isActive()) return;
			try {
				const name = (await showTextInput(ctx, "Session name", "Release prep", lifetime))?.trim();
				if (!isActive() || !name) return;
				pi.setSessionName(name);
			} catch (error) {
				if (!isActive()) return;
				notify(
					`Could not rename session: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
		async compactSession(): Promise<void> {
			if (!isActive()) return;
			try {
				const confirmed = await showSelection(
					ctx,
					"Compact session",
					[
						{ value: "yes", label: "Compact", description: "Summarize older context now" },
						{ value: "no", label: "Cancel", description: "Leave the session unchanged" },
					],
					lifetime,
				);
				if (!isActive() || confirmed !== "yes") return;
				ctx.compact({
					onError: (error) => notify(`Compaction failed: ${error.message}`, "error"),
					onComplete: () => notify("Session compacted", "info"),
				});
			} catch (error) {
				if (!isActive()) return;
				notify(
					`Could not compact session: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	};
}

async function showTextInput(
	ctx: ExtensionContext,
	title: string,
	initialValue: string,
	lifetime?: OverlayLifetime,
): Promise<string | undefined> {
	if (!isOverlayLifetimeActive(lifetime)) return undefined;
	let value = initialValue;
	const settlement = createOverlaySettlement<string | undefined>();
	let completion: OverlayCompletion<string | undefined> | undefined;
	try {
		const hostPromise = ctx.ui.custom<string | undefined>(
			(tui, theme, _keybindings, done) => {
				completion = createOverlayCompletion(settlement, done, undefined);
				const finish = (next?: string): void => completion?.finish(next);
				if (!isOverlayLifetimeActive(lifetime)) finish(undefined);
				const component = createLifecycleOverlayComponent(
					lifetime,
					{
						render: (width) =>
							renderMenuFrame(
								theme,
								[
									theme.fg("accent", theme.bold(title)),
									` ${value || theme.fg("dim", "—")}`,
									theme.fg("dim", "Type name • enter save • esc cancel"),
								],
								width,
							),
						invalidate: () => undefined,
						handleInput: (data) => {
							if (!isOverlayLifetimeActive(lifetime)) {
								finish(undefined);
								return;
							}
							if (matchesKey(data, "escape")) finish(undefined);
							else if (matchesKey(data, "enter")) finish(value);
							else if (matchesKey(data, "backspace")) value = value.slice(0, -1);
							else if (!data.includes("\u001b")) value += data.replace(/[\u0000-\u001f\u007f]/g, "");
							tui.requestRender();
						},
					},
					() => completion?.retire(),
				);
				completion.bind(component);
				return component;
			},
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "70%", minWidth: 32, maxHeight: "80%", margin: 1 },
			},
		);
		const result = await awaitOverlaySettlement(hostPromise, settlement);
		return isOverlayLifetimeActive(lifetime) ? result : undefined;
	} finally {
		if (lifetime) completion?.release();
	}
}

async function showSelection(
	ctx: ExtensionContext,
	title: string,
	items: SelectItem[],
	lifetime?: OverlayLifetime,
): Promise<string | undefined> {
	if (!isOverlayLifetimeActive(lifetime)) return undefined;
	const settlement = createOverlaySettlement<string | undefined>();
	let completion: OverlayCompletion<string | undefined> | undefined;
	try {
		const hostPromise = ctx.ui.custom<string | undefined>(
			(tui, theme, _keybindings, done) => {
				completion = createOverlayCompletion(settlement, done, undefined);
				const finish = (value?: string): void => completion?.finish(value);
				if (!isOverlayLifetimeActive(lifetime)) finish(undefined);
				const container = new Container();
				container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
				const list = new SelectList(items, Math.min(items.length, 12), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});
				list.onSelect = (item) => finish(item.value);
				list.onCancel = () => finish(undefined);
				container.addChild(list);
				container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc back"), 1, 0));
				const component = createLifecycleOverlayComponent(
					lifetime,
					{
						render: (width) => renderMenuFrame(theme, container.render(Math.max(1, width - 2)), width),
						invalidate: () => container.invalidate(),
						handleInput: (data) => {
							if (!isOverlayLifetimeActive(lifetime)) {
								finish(undefined);
								return;
							}
							list.handleInput(data);
							tui.requestRender();
						},
					},
					() => completion?.retire(),
				);
				completion.bind(component);
				return component;
			},
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "70%", minWidth: 32, maxHeight: "80%", margin: 1 },
			},
		);
		const result = await awaitOverlaySettlement(hostPromise, settlement);
		return isOverlayLifetimeActive(lifetime) ? result : undefined;
	} finally {
		if (lifetime) completion?.release();
	}
}

async function showToolSettings(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	setTools: (names: string[]) => void,
	lifetime?: OverlayLifetime,
) {
	if (!isOverlayLifetimeActive(lifetime)) return;
	const tools = pi.getAllTools();
	const enabled = new Set(pi.getActiveTools());
	const settlement = createOverlaySettlement<void>();
	let completion: OverlayCompletion<void> | undefined;
	try {
		const hostPromise = ctx.ui.custom<void>(
			(tui, _theme, _keys, done) => {
				completion = createOverlayCompletion(settlement, done, undefined);
				const finish = (): void => completion?.finish(undefined);
				if (!isOverlayLifetimeActive(lifetime)) finish();
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
						if (!isOverlayLifetimeActive(lifetime)) return;
						if (value === "enabled") enabled.add(id);
						else enabled.delete(id);
						if (enabled.size === 0) {
							enabled.add(id);
							ctx.ui.notify("At least one tool must remain active", "warning");
						}
						setTools([...enabled]);
					},
					finish,
					{ enableSearch: true },
				);
				const component = createLifecycleOverlayComponent(
					lifetime,
					{
						render: (width) => list.render(width),
						invalidate: () => list.invalidate(),
						handleInput: (data) => {
							if (!isOverlayLifetimeActive(lifetime)) {
								finish();
								return;
							}
							list.handleInput(data);
							tui.requestRender();
						},
					},
					() => completion?.retire(),
				);
				completion.bind(component);
				return component;
			},
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "70%", minWidth: 32, maxHeight: "80%", margin: 1 },
			},
		);
		await awaitOverlaySettlement(hostPromise, settlement);
	} finally {
		if (lifetime) completion?.release();
	}
}

export interface DisplaySettingsRuntime {
	getConfig(): AtelierConfig;
	getSidebarPanelSettings(): readonly SidebarPanelSetting[];
	getDisplaySettings(): ReturnType<AtelierRuntime["getDisplaySettings"]>;
	getDisplayProvenance(): ReturnType<AtelierRuntime["getDisplayProvenance"]>;
	getSessionDisplayOverride(): ReturnType<AtelierRuntime["getSessionDisplayOverride"]>;
	replaceSessionDisplayOverride(value: Parameters<AtelierRuntime["replaceSessionDisplayOverride"]>[0]): void;
	clearSessionDisplayOverride(): void;
	applySavedUserDisplayPatch(patch: Parameters<AtelierRuntime["applySavedUserDisplayPatch"]>[0]): void;
}

export async function openDisplaySettingsWorkspace(
	ctx: ExtensionContext,
	runtime: DisplaySettingsRuntime,
	userConfigPath: string,
	requestAllRenders: () => void = () => undefined,
	savePatch: SaveConfigPatch = saveUserConfigPatch,
	options: DisplaySettingsWorkspaceOptions = {},
): Promise<void> {
	const lifetime = options.lifetime;
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Pi Atelier Display settings require TUI mode", "warning");
		return;
	}
	if (!isOverlayLifetimeActive(lifetime)) return;
	const settlement = createOverlaySettlement<void>();
	let completion: OverlayCompletion<void> | undefined;
	try {
		const hostPromise = ctx.ui.custom<void>(
			(tui, theme, _keys, done) => {
				completion = createOverlayCompletion(settlement, done, undefined);
				const finish = (): void => completion?.finish(undefined);
				const ensureActive = (): void => {
					if (!isOverlayLifetimeActive(lifetime)) throw new Error("Pi Atelier is not active in this session");
				};
				if (!isOverlayLifetimeActive(lifetime)) finish();
				const component = createLifecycleOverlayComponent(
					lifetime,
					createSettingsWorkspace({
						getDisplaySettings: () => runtime.getDisplaySettings(),
						getSidebarPanelLayout: runtime.getSidebarPanelSettings,
						getDisplayProvenance: () => runtime.getDisplayProvenance(),
						getSessionDisplayOverride: () => runtime.getSessionDisplayOverride(),
						replaceSessionDisplayOverride: (value) => {
							if (isOverlayLifetimeActive(lifetime)) runtime.replaceSessionDisplayOverride(value);
						},
						clearSessionDisplayOverride: () => {
							if (isOverlayLifetimeActive(lifetime)) runtime.clearSessionDisplayOverride();
						},
						persistUserDisplayPatch: async (patch) => {
							ensureActive();
							await savePatch(userConfigPath, patch);
							ensureActive();
						},
						applySavedUserDisplayPatch: (patch) => {
							if (isOverlayLifetimeActive(lifetime)) runtime.applySavedUserDisplayPatch(patch);
						},
						getRenderConfig: () => runtime.getConfig(),
						getViewportHeight: () => getDisplaySettingsViewportHeight(tui.terminal.rows),
						theme,
						colorEnabled: !("NO_COLOR" in process.env),
						requestWorkspaceRender: () => {
							if (isOverlayLifetimeActive(lifetime)) tui.requestRender();
						},
						requestLiveRender: () => {
							if (isOverlayLifetimeActive(lifetime)) requestAllRenders();
						},
						close: finish,
						report: (message, kind) => {
							if (kind === "error" && isOverlayLifetimeActive(lifetime)) ctx.ui.notify(message, "error");
						},
					}),
					() => completion?.retire(),
				);
				completion.bind(component);
				return component;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "90%",
					minWidth: 36,
					maxHeight: DISPLAY_SETTINGS_OVERLAY_MAX_HEIGHT,
					margin: DISPLAY_SETTINGS_OVERLAY_MARGIN,
				},
			},
		);
		await awaitOverlaySettlement(hostPromise, settlement);
	} finally {
		if (lifetime) completion?.release();
	}
}

export async function openAtelierControlCenter(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: AtelierRuntime,
	userConfigPath: string,
	sidebar: SidebarControls,
	requestAllRenders: () => void = () => undefined,
	savePatch: SaveConfigPatch = saveUserConfigPatch,
	options: ControlCenterOptions = {},
): Promise<void> {
	const lifetime = options.lifetime;
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Pi Atelier Control Center requires TUI mode", "warning");
		return;
	}
	if (!isOverlayLifetimeActive(lifetime)) return;
	const actions = createMenuActions(
		pi,
		ctx,
		runtime,
		userConfigPath,
		undefined,
		savePatch,
		lifetime ? { lifetime } : {},
	);
	for (;;) {
		if (!isOverlayLifetimeActive(lifetime)) return;
		const category = await showSelection(
			ctx,
			"◆ Atelier Control Center",
			[
				{ value: "settings", label: "Settings", description: "Persisted defaults and Display workspace" },
				{
					value: "controls",
					label: "Controls",
					description: `Session controls · Sidebar: ${sidebar.isVisible() ? "On" : "Off"}`,
				},
				{ value: "actions", label: "Actions", description: "Session details, rename, and compaction" },
				{ value: "close", label: "Close" },
			],
			lifetime,
		);
		if (!isOverlayLifetimeActive(lifetime) || !category || category === "close") return;
		if (category === "settings") {
			for (;;) {
				if (!isOverlayLifetimeActive(lifetime)) return;
				const choice = await showSelection(
					ctx,
					"Settings",
					[
						{
							value: "display",
							label: `Display: ${runtime.getDisplaySettings().preset}`,
							description: "Session overrides, preview, Undo, Revert, and Save",
						},
						{
							value: "sidebar-startup",
							label: `Sidebar on startup: ${runtime.getConfig().showSidebarOnStartup ? "On" : "Off"}`,
							description: "Global user preference",
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
					],
					lifetime,
				);
				if (!isOverlayLifetimeActive(lifetime)) return;
				if (!choice || choice === "back") break;
				if (choice === "display")
					await openDisplaySettingsWorkspace(
						ctx,
						{
							getConfig: () => runtime.getConfig(),
							getSidebarPanelSettings:
								sidebar.getSidebarPanelSettings ??
								(() =>
									(runtime.getSidebarPanelLayout?.() ?? runtime.getConfig().sidebarPanelLayout).map(
										(entry) => ({
											id: entry.id,
											title: entry.id,
											available: true,
											visible: entry.visible,
										}),
									)),
							getDisplaySettings: () => runtime.getDisplaySettings(),
							getDisplayProvenance: () => runtime.getDisplayProvenance(),
							getSessionDisplayOverride: () => runtime.getSessionDisplayOverride(),
							replaceSessionDisplayOverride: (value) => runtime.replaceSessionDisplayOverride(value),
							clearSessionDisplayOverride: () => runtime.clearSessionDisplayOverride(),
							applySavedUserDisplayPatch: (patch) => runtime.applySavedUserDisplayPatch(patch),
						},
						userConfigPath,
						requestAllRenders,
						savePatch,
						lifetime ? { lifetime } : {},
					);
				else if (choice === "sidebar-startup")
					await actions.setShowSidebarOnStartup(!runtime.getConfig().showSidebarOnStartup);
				else if (choice === "notifications")
					await actions.setCompletionNotifications(!runtime.getConfig().completionNotifications);
				else await sidebar.toggleToolList();
			}
		} else if (category === "controls") {
			for (;;) {
				if (!isOverlayLifetimeActive(lifetime)) return;
				const choice = await showSelection(
					ctx,
					"Controls",
					[
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
					],
					lifetime,
				);
				if (!isOverlayLifetimeActive(lifetime)) return;
				if (!choice || choice === "back") break;
				if (choice === "sidebar") sidebar.toggle();
				else if (choice === "tools") await showToolSettings(ctx, pi, actions.setTools, lifetime);
				else {
					const selected = await showSelection(
						ctx,
						"Model controls",
						[
							{ value: "model", label: "Choose model" },
							{ value: "thinking", label: "Thinking level" },
							{ value: "back", label: "Back" },
						],
						lifetime,
					);
					if (!isOverlayLifetimeActive(lifetime)) return;
					if (selected === "model") {
						const models = ctx.modelRegistry.getAvailable();
						const selectedModel = await showSelection(
							ctx,
							"Choose model",
							models.map((model, index) => ({
								value: String(index),
								label: `${model.provider}/${model.id}`,
							})),
							lifetime,
						);
						if (!isOverlayLifetimeActive(lifetime)) return;
						const model = models[Number(selectedModel)];
						if (model) await actions.selectModel(model);
					} else if (selected === "thinking") {
						const level = await showSelection(
							ctx,
							"Thinking level",
							["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({
								value,
								label: value,
							})),
							lifetime,
						);
						if (!isOverlayLifetimeActive(lifetime)) return;
						if (level) actions.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
					}
				}
			}
		} else {
			for (;;) {
				if (!isOverlayLifetimeActive(lifetime)) return;
				const choice = await showSelection(
					ctx,
					"Actions",
					[
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
					],
					lifetime,
				);
				if (!isOverlayLifetimeActive(lifetime)) return;
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

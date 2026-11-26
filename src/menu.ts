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
} from "@earendil-works/pi-tui";
import { saveUserConfigPatch } from "./config.js";
import { isLifetimeActive, openLifecycleOverlay, type OverlayLifetime } from "./overlay-lifecycle.js";
import type { ThemeLike } from "./palette.js";
import {
	createSettingsWorkspace,
	getSettingsViewportHeight,
	SETTINGS_OVERLAY_MARGIN,
	SETTINGS_OVERLAY_MAX_HEIGHT,
	type SettingsPage,
	type SettingsWorkspace,
	type SidebarPanelSetting,
} from "./settings-workspace.js";
import type { SidebarMode, SidebarStatus } from "./split-pane.js";
import type { AtelierRuntime } from "./state.js";
import { errorMessage, fitToWidth, isColorEnabled } from "./text.js";
import type { AtelierConfig, SidebarStyle } from "./types.js";

type SaveConfigPatch = typeof saveUserConfigPatch;
type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

export function sidebarStatusLabel(status: SidebarStatus): string {
	const label = status.mode === "auto" ? "Auto" : "Manual";
	if (!status.enabled) return `${label} · hidden`;
	return status.presentation === "auto-collapsed" || status.presentation === "too-narrow"
		? `${label} · hidden: narrow terminal`
		: label;
}

interface MenuOptions {
	lifetime?: OverlayLifetime;
	/** Install or remove the Atelier footer to match the current `showFooter` preference. */
	syncFooter?(): void;
	/** Where action messages go; Pi notifications by default. */
	notify?(message: string, kind: "info" | "warning" | "error"): void;
}

interface ControlCenterOptions extends MenuOptions {
	openUsage?(): Promise<void>;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface SidebarControls {
	getStatus(): SidebarStatus;
	setMode(mode: SidebarMode): void;
	toggle(): void;
	isToolListExpanded(): boolean;
	/** `notify` receives the confirmation; Pi notifications by default. */
	toggleToolList(notify?: (message: string, kind: "info" | "warning") => void): Promise<void>;
	getSidebarPanelSettings(): readonly SidebarPanelSetting[];
}

export function renderMenuFrame(theme: ThemeLike, lines: string[], width: number): string[] {
	const border = (text: string) => theme.bold(theme.fg("borderAccent", text));
	if (width <= 1) return [truncateToWidth(border("━"), Math.max(0, width), "")];
	const innerWidth = width - 2;
	return [
		border(`┏${"━".repeat(innerWidth)}┓`),
		...lines.map((line) => `${border("┃")}${fitToWidth(line, innerWidth)}${border("┃")}`),
		border(`┗${"━".repeat(innerWidth)}┛`),
	];
}

export function createMenuActions(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: Pick<AtelierRuntime, "getConfig" | "setConfig" | "refreshUsage">,
	userConfigPath: string,
	savePatch: SaveConfigPatch = saveUserConfigPatch,
	options: MenuOptions = {},
) {
	const isActive = (): boolean => isLifetimeActive(options.lifetime);
	const notify = (message: string, kind: "info" | "warning" | "error"): void => {
		if (!isActive()) return;
		if (options.notify) options.notify(message, kind);
		else ctx.ui.notify(message, kind);
	};
	/** Report a failed change, and say so when restoring the previous value also failed. */
	const reportFailure = (what: string, error: unknown, restored: boolean): void =>
		notify(
			`Could not change ${what}: ${errorMessage(error)}${restored ? "" : `; the previous ${what} could not be restored`}`,
			"error",
		);
	const attempt = (restore: () => void): boolean => {
		try {
			restore();
			return true;
		} catch {
			return false;
		}
	};
	/**
	 * Apply a user preference for this session, then persist it. `rollback` restores
	 * the session value when saving fails, for preferences with no in-session effect.
	 */
	const persistPreference = async (
		patch: Partial<
			Pick<
				AtelierConfig,
				| "showSidebarOnStartup"
				| "completionNotifications"
				| "nerdFont"
				| "showFooter"
				| "prefillEnabled"
				| "sidebarStyle"
				| "sessionRecap"
				| "sessionRecapModel"
			>
		>,
		messages: { saved: string; failed: string },
		rollback: boolean,
		apply: () => void = () => undefined,
	): Promise<void> => {
		if (!isActive()) return;
		const previous = runtime.getConfig();
		runtime.setConfig({ ...previous, ...patch });
		apply();
		try {
			await savePatch(userConfigPath, patch);
			notify(messages.saved, "info");
		} catch (error) {
			if (!isActive()) return;
			if (rollback) {
				runtime.setConfig(previous);
				apply();
			}
			notify(`${messages.failed}: ${errorMessage(error)}`, "warning");
		}
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
				if (isActive()) runtime.refreshUsage();
			} catch (error) {
				if (!isActive()) return;
				let restored = true;
				if (previous) {
					try {
						restored = await pi.setModel(previous);
					} catch {
						restored = false;
					}
				}
				reportFailure("model", error, restored);
			}
		},
		setThinkingLevel(level: ThinkingLevel): void {
			if (!isActive()) return;
			const previous = pi.getThinkingLevel();
			try {
				pi.setThinkingLevel(level);
				if (isActive()) runtime.refreshUsage();
			} catch (error) {
				if (isActive())
					reportFailure(
						"thinking level",
						error,
						attempt(() => pi.setThinkingLevel(previous)),
					);
			}
		},
		setTools(names: string[]): void {
			if (!isActive()) return;
			const previous = pi.getActiveTools();
			try {
				const known = new Set(pi.getAllTools().map((tool) => tool.name));
				pi.setActiveTools(names.filter((name) => known.has(name)));
			} catch (error) {
				if (isActive())
					reportFailure(
						"tools",
						error,
						attempt(() => pi.setActiveTools(previous)),
					);
			}
		},
		setShowSidebarOnStartup: (enabled: boolean): Promise<void> =>
			persistPreference(
				{ showSidebarOnStartup: enabled },
				{
					saved: `Sidebar will start ${enabled ? "shown" : "hidden"}`,
					failed: "Sidebar startup preference could not be saved",
				},
				true,
			),
		setCompletionNotifications: (enabled: boolean): Promise<void> =>
			persistPreference(
				{ completionNotifications: enabled },
				{
					saved: `Notifications ${enabled ? "on" : "off"}`,
					failed: "Notifications changed for this session but could not be saved",
				},
				false,
			),
		setPrefillEnabled: (enabled: boolean): Promise<void> =>
			persistPreference(
				{ prefillEnabled: enabled },
				{
					saved: `Prefill progress ${enabled ? "enabled" : "disabled"}`,
					failed: "Prefill progress changed for this session but could not be saved",
				},
				false,
			),
		setNerdFont: (enabled: boolean): Promise<void> =>
			persistPreference(
				{ nerdFont: enabled },
				{
					saved: `Font: ${enabled ? "Nerd Font" : "Plain text"}`,
					failed: "Font changed for this session but could not be saved",
				},
				false,
			),
		setSidebarStyle: (style: SidebarStyle): Promise<void> =>
			persistPreference(
				{ sidebarStyle: style },
				{
					saved: `Sidebar style: ${sidebarStyleLabel(style)}`,
					failed: "Sidebar style changed for this session but could not be saved",
				},
				false,
			),
		setSessionRecap: (enabled: boolean): Promise<void> =>
			persistPreference(
				{ sessionRecap: enabled },
				{
					saved: enabled
						? "Session recap on: while the Session panel is shown, a model writes its goal once and its status after each run"
						: "Session recap off: the Session panel uses /atelier goal, the session name, and the last reply",
					failed: "Session recap changed for this session but could not be saved",
				},
				false,
			),
		setSessionRecapModel: (model: string): Promise<void> =>
			persistPreference(
				{ sessionRecapModel: model },
				{
					saved: `Recap model: ${recapModelLabel(model)}`,
					failed: "Recap model changed for this session but could not be saved",
				},
				false,
			),
		setShowFooter: (enabled: boolean): Promise<void> =>
			persistPreference(
				{ showFooter: enabled },
				{
					saved: enabled
						? "Atelier footer on; it returns when Settings closes"
						: "Atelier footer off; Pi's footer returns when Settings closes",
					failed: "Atelier footer changed for this session but could not be saved",
				},
				false,
				() => options.syncFooter?.(),
			),
	};
}

const sidebarStyleLabel = (style: SidebarStyle): string => (style === "framed" ? "Framed" : "Minimal");
const recapModelLabel = (model: string): string => model || "Session model";

async function showSelection(
	ctx: ExtensionContext,
	title: string,
	items: SelectItem[],
	lifetime?: OverlayLifetime,
): Promise<string | undefined> {
	return openLifecycleOverlay<string>(
		ctx,
		(tui, theme, finish) => {
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
			list.onCancel = () => finish();
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
		lifetime,
	);
}

async function showToolSettings(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	setTools: (names: string[]) => void,
	lifetime?: OverlayLifetime,
) {
	await openLifecycleOverlay<void>(
		ctx,
		(tui, _theme, finish) => {
			const tools = pi.getAllTools();
			const enabled = new Set(pi.getActiveTools());
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
					if (!isLifetimeActive(lifetime)) return;
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
			return {
				render: (width) => list.render(width),
				invalidate: () => list.invalidate(),
				handleInput: (data) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		},
		lifetime,
	);
}

export type SettingsRuntime = Pick<
	AtelierRuntime,
	| "getConfig"
	| "setConfig"
	| "refreshUsage"
	| "getDisplaySettings"
	| "getDisplayProvenance"
	| "getSessionDisplayOverride"
	| "replaceSessionDisplayOverride"
	| "clearSessionDisplayOverride"
	| "applySavedUserDisplayPatch"
>;

/** Open the Settings workspace, on General unless another page is named. */
export async function openSettingsWorkspace(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: SettingsRuntime,
	userConfigPath: string,
	sidebar: Pick<SidebarControls, "isToolListExpanded" | "toggleToolList" | "getSidebarPanelSettings">,
	requestAllRenders: () => void = () => undefined,
	savePatch: SaveConfigPatch = saveUserConfigPatch,
	options: MenuOptions & { page?: SettingsPage } = {},
): Promise<void> {
	const { lifetime, page } = options;
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Pi Atelier Settings require TUI mode", "warning");
		return;
	}
	const isActive = (): boolean => isLifetimeActive(lifetime);
	const ensureActive = (): void => {
		if (!isActive()) throw new Error("Pi Atelier is not active in this session");
	};
	// Preference confirmations show inside the workspace while it is open.
	let workspace: SettingsWorkspace | undefined;
	// Pi focuses the editor it installs with the footer, which takes the keyboard from the
	// overlay, and the overlay would later hand focus back to the replaced editor. So the
	// footer follows the saved setting once the workspace has closed.
	let footerChanged = false;
	const actions = createMenuActions(pi, ctx, runtime, userConfigPath, savePatch, {
		...options,
		syncFooter: () => {
			footerChanged = true;
		},
		notify: (message, kind) =>
			workspace ? workspace.showMessage(message, kind) : ctx.ui.notify(message, kind),
	});
	try {
		await openLifecycleOverlay<void>(
			ctx,
			(tui, theme, finish) => {
				workspace = createSettingsWorkspace({
					getDisplaySettings: () => runtime.getDisplaySettings(),
					getSidebarPanelSettings: () => sidebar.getSidebarPanelSettings(),
					getDisplayProvenance: () => runtime.getDisplayProvenance(),
					getSessionDisplayOverride: () => runtime.getSessionDisplayOverride(),
					replaceSessionDisplayOverride: (value) => {
						if (isActive()) runtime.replaceSessionDisplayOverride(value);
					},
					clearSessionDisplayOverride: () => {
						if (isActive()) runtime.clearSessionDisplayOverride();
					},
					persistUserDisplayPatch: async (patch) => {
						ensureActive();
						await savePatch(userConfigPath, patch);
						ensureActive();
					},
					applySavedUserDisplayPatch: (patch) => {
						if (isActive()) runtime.applySavedUserDisplayPatch(patch);
					},
					getRenderConfig: () => runtime.getConfig(),
					preferences: {
						setNerdFont: actions.setNerdFont,
						setShowFooter: actions.setShowFooter,
						setCompletionNotifications: actions.setCompletionNotifications,
						setPrefillEnabled: actions.setPrefillEnabled,
						setSidebarStyle: actions.setSidebarStyle,
						setShowSidebarOnStartup: actions.setShowSidebarOnStartup,
						isToolListExpanded: () => sidebar.isToolListExpanded(),
						toggleToolList: () =>
							sidebar.toggleToolList((message, kind) => workspace?.showMessage(message, kind)),
						setSessionRecap: actions.setSessionRecap,
						setSessionRecapModel: actions.setSessionRecapModel,
						getRecapModels: () =>
							ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`),
					},
					...(page ? { initialPage: page } : {}),
					getViewportHeight: () => getSettingsViewportHeight(tui.terminal.rows),
					theme,
					colorEnabled: isColorEnabled(),
					requestWorkspaceRender: () => {
						if (isActive()) tui.requestRender();
					},
					requestLiveRender: () => {
						if (isActive()) requestAllRenders();
					},
					close: finish,
					report: (message, kind) => {
						if (kind === "error" && isActive()) ctx.ui.notify(message, "error");
					},
				});
				return workspace;
			},
			lifetime,
			{
				anchor: "center",
				width: "90%",
				minWidth: 36,
				maxHeight: SETTINGS_OVERLAY_MAX_HEIGHT,
				margin: SETTINGS_OVERLAY_MARGIN,
			},
		);
	} finally {
		workspace = undefined;
		if (footerChanged && isActive()) options.syncFooter?.();
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
	const { lifetime, openUsage } = options;
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Pi Atelier Control Center requires TUI mode", "warning");
		return;
	}
	const isActive = (): boolean => isLifetimeActive(lifetime);
	const actions = createMenuActions(pi, ctx, runtime, userConfigPath, savePatch, options);
	// Each menu returns undefined once the session retires, which closes every level.
	const choose = async (title: string, items: SelectItem[]): Promise<string | undefined> => {
		if (!isActive()) return undefined;
		const choice = await showSelection(ctx, title, items, lifetime);
		return isActive() ? choice : undefined;
	};

	const modelMenu = async (): Promise<void> => {
		const selected = await choose("Model controls", [
			{ value: "model", label: "Choose model" },
			{ value: "thinking", label: "Thinking level" },
			{ value: "back", label: "Back" },
		]);
		if (selected === "model") {
			const models = new Map(
				ctx.modelRegistry.getAvailable().map((model) => [`${model.provider}/${model.id}`, model]),
			);
			const choice = await choose(
				"Choose model",
				[...models.keys()].map((label) => ({ value: label, label })),
			);
			const model = choice === undefined ? undefined : models.get(choice);
			if (model) await actions.selectModel(model);
		} else if (selected === "thinking") {
			const level = await choose(
				"Thinking level",
				THINKING_LEVELS.map((value) => ({ value, label: value })),
			);
			const thinkingLevel = THINKING_LEVELS.find((value) => value === level);
			if (thinkingLevel) actions.setThinkingLevel(thinkingLevel);
		}
	};

	const sidebarMenu = async (): Promise<void> => {
		const mode = await choose("Sidebar mode", [
			{ value: "auto", label: "Auto", description: "Show when there is comfortable reading space" },
			{
				value: "manual",
				label: "Manual",
				description: "Adjust width manually; hide only when too narrow to fit",
			},
			{
				value: "toggle",
				label: sidebar.getStatus().enabled ? "Hide sidebar" : "Show sidebar",
				description: "Keep the current mode",
			},
			{ value: "back", label: "Back" },
		]);
		if (mode === "auto" || mode === "manual") sidebar.setMode(mode);
		else if (mode === "toggle") sidebar.toggle();
	};

	const controlsMenu = async (): Promise<void> => {
		for (;;) {
			const choice = await choose("Controls", [
				{
					value: "sidebar",
					label: `Sidebar: ${sidebarStatusLabel(sidebar.getStatus())}`,
					description: "Choose Auto or Manual; show or hide independently",
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
			switch (choice) {
				case "sidebar":
					await sidebarMenu();
					break;
				case "model":
					await modelMenu();
					break;
				case "tools":
					await showToolSettings(ctx, pi, actions.setTools, lifetime);
					break;
				default:
					return;
			}
		}
	};

	for (;;) {
		const category = await choose("◆ Atelier Control Center", [
			{
				value: "settings",
				label: "Settings",
				description: "Font, status rail, sidebar panels, and session recap",
			},
			{
				value: "controls",
				label: "Controls",
				description: `Session controls · Sidebar: ${sidebarStatusLabel(sidebar.getStatus())}`,
			},
			...(openUsage
				? [{ value: "usage", label: "Subagent usage", description: "Cost curves and individual reply costs" }]
				: []),
			{ value: "close", label: "Close" },
		]);
		if (category === "usage") await openUsage?.();
		else if (category === "settings")
			await openSettingsWorkspace(
				pi,
				ctx,
				runtime,
				userConfigPath,
				sidebar,
				requestAllRenders,
				savePatch,
				options,
			);
		else if (category === "controls") await controlsMenu();
		else return;
		if (!isActive()) return;
	}
}

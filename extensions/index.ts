import { basename, join } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	estimateTokens,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import {
	type CompletionNotification,
	type CompletionNotifier,
	createCompletionNotifier,
	type SpawnNotificationProcess,
} from "../src/completion-notifier.js";
import { loadConfig, saveUserConfig, saveUserConfigPatch } from "../src/config.js";
import { createFooterComponent, type ThemeLike } from "../src/footer.js";
import {
	type DisplaySettingsRuntime,
	openAtelierControlCenter,
	openDisplaySettingsWorkspace,
} from "../src/menu.js";
import { createRunActivityTracker, type RunActivityTracker } from "../src/run-activity.js";
import type { SidebarPanelSetting } from "../src/settings-workspace.js";
import {
	buildSidebarSnapshot,
	createSidebarController,
	type SidebarController,
	type SidebarSnapshot,
} from "../src/sidebar.js";
import {
	BUILTIN_SIDEBAR_PANEL_IDS,
	createSidebarPanelRegistry,
	isSidebarPanelContributionId,
	type SidebarPanelRegistry,
} from "../src/sidebar-panels.js";
import { AtelierRuntime } from "../src/state.js";
import type { AtelierState, FooterState, NormalizedTodo, RpivTask, TodoItem } from "../src/types.js";

export type {
	SidebarPanelContribution,
	SidebarPanelData,
	SidebarPanelDiscoveryEvent,
	SidebarPanelEvent,
	SidebarPanelEventTransport,
	SidebarPanelRegisterEvent,
	SidebarPanelRegistry,
	SidebarPanelRegistryOptions,
	SidebarPanelRole,
	SidebarPanelRow,
	SidebarPanelUnregisterEvent,
} from "../src/sidebar-panels.js";
export const PI_ATELIER_SESSION_CONFIG_ENTRY_TYPE = "pi-atelier:config";

export {
	BUILTIN_SIDEBAR_PANEL_IDS,
	createSidebarPanelRegistry,
	DEFAULT_SIDEBAR_PANEL_LAYOUT,
	isSidebarPanelContributionId,
	isSidebarPanelId,
	isSidebarPanelRequestId,
	isSidebarPanelRole,
	isSidebarPanelSource,
	isSidebarPanelTextWithinRawLimit,
	normalizeSidebarPanelLayout,
	registerSidebarPanel,
	SIDEBAR_PANEL_EVENT_CHANNEL,
	SIDEBAR_PANEL_MAX_ID_CHARS,
	SIDEBAR_PANEL_MAX_PANELS,
	SIDEBAR_PANEL_MAX_RAW_REQUEST_ID_CODE_UNITS,
	SIDEBAR_PANEL_MAX_RAW_ROW_CODE_UNITS,
	SIDEBAR_PANEL_MAX_RAW_TITLE_CODE_UNITS,
	SIDEBAR_PANEL_MAX_ROW_CHARS,
	SIDEBAR_PANEL_MAX_ROWS,
	SIDEBAR_PANEL_MAX_SOURCE_CHARS,
	SIDEBAR_PANEL_MAX_TITLE_CHARS,
	SIDEBAR_PANEL_MAX_TRACKED_SOURCES,
	SIDEBAR_PANEL_PROTOCOL_VERSION,
} from "../src/sidebar-panels.js";
export type {
	BuiltinSidebarPanelId,
	ContributedSidebarPanelId,
	SidebarPanelId,
	SidebarPanelLayout,
	SidebarPanelLayoutEntry,
} from "../src/types.js";

export interface AtelierExtensionDependencies {
	saveConfig?: typeof saveUserConfig;
	saveConfigPatch?: typeof saveUserConfigPatch;
	notificationPlatform?: NodeJS.Platform;
	spawnNotificationProcess?: SpawnNotificationProcess;
}

export default function atelierExtension(
	pi: ExtensionAPI,
	dependencies: AtelierExtensionDependencies = {},
): void {
	const _saveConfig = dependencies.saveConfig ?? saveUserConfig;
	const saveConfigPatch = dependencies.saveConfigPatch ?? saveUserConfigPatch;
	let runtime: AtelierRuntime | undefined;
	let currentContext: ExtensionContext | undefined;
	let currentSessionManager: ExtensionContext["sessionManager"] | undefined;
	let requestRender: () => void = () => undefined;
	let sidebar: SidebarController | undefined;
	let panelRegistry: SidebarPanelRegistry | undefined;
	let runActivity: RunActivityTracker | undefined;
	let completionNotifier: CompletionNotifier | undefined;
	let unsubscribeAskUserBlocked: (() => void) | undefined;
	let askUserBlocked = false;
	let inputRequestSequence = 0;
	let cachedTodos: NormalizedTodo[] = [];
	let cachedTodosSessionManager: ExtensionContext["sessionManager"] | undefined;
	let extensionStatuses: readonly string[] = [];
	let enabled = true;
	let shortcutRegistered = false;
	let resizeShortcutRegistered = false;
	let lifecycleGeneration = 0;

	const requestAllRenders = (): void => {
		requestRender();
		sidebar?.requestRender();
	};
	const lifecycleGuardedSavePatch =
		(targetRuntime: AtelierRuntime): typeof saveUserConfigPatch =>
		async (path, patch) => {
			if (runtime !== targetRuntime) throw new Error("Pi Atelier is not active in this session");
			await saveConfigPatch(path, patch);
		};

	function readSessionConfig(ctx: ExtensionContext): unknown {
		let sessionConfig: unknown;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === PI_ATELIER_SESSION_CONFIG_ENTRY_TYPE)
				sessionConfig = entry.data;
		}
		return sessionConfig;
	}

	function updateExtensionStatuses(next: readonly string[]): void {
		if (
			next.length === extensionStatuses.length &&
			next.every((status, index) => status === extensionStatuses[index])
		) {
			return;
		}
		extensionStatuses = [...next];
		sidebar?.requestRender();
	}

	const VALID_TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);

	interface OldTodoDetails {
		todos: TodoItem[];
		nextId: number;
	}
	interface NewTaskDetails {
		tasks: RpivTask[];
		nextId: number;
	}

	function isOldTodoDetails(details: unknown): details is OldTodoDetails {
		if (typeof details !== "object" || details === null) return false;
		if (!("todos" in details)) return false;
		const todos = (details as OldTodoDetails).todos;
		if (!Array.isArray(todos)) return false;
		return todos.every(
			(item) =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as TodoItem).id === "number" &&
				typeof (item as TodoItem).text === "string" &&
				typeof (item as TodoItem).done === "boolean",
		);
	}

	function isNewTaskDetails(details: unknown): details is NewTaskDetails {
		if (typeof details !== "object" || details === null) return false;
		if (!("tasks" in details)) return false;
		const tasks = (details as NewTaskDetails).tasks;
		if (!Array.isArray(tasks)) return false;
		return tasks.every(
			(item) =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as RpivTask).id === "number" &&
				typeof (item as RpivTask).subject === "string" &&
				typeof (item as RpivTask).status === "string",
		);
	}

	function normalizeTodo(item: TodoItem | RpivTask): NormalizedTodo | undefined {
		if ("done" in item) {
			return { id: item.id, text: item.text, status: item.done ? "completed" : "pending" };
		}
		const status = item.status;
		if (!VALID_TODO_STATUSES.has(status)) return undefined;
		return { id: item.id, text: item.subject, status: status as NormalizedTodo["status"] };
	}

	function reconstructTodos(ctx: ExtensionContext): NormalizedTodo[] {
		let allItems: (TodoItem | RpivTask)[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo" || msg.isError) continue;
			const details = msg.details;
			if (isOldTodoDetails(details)) allItems = details.todos;
			else if (isNewTaskDetails(details)) allItems = details.tasks;
		}
		return allItems.map(normalizeTodo).filter((item): item is NormalizedTodo => item !== undefined);
	}
	function getSidebarSnapshot(
		ctx: ExtensionContext,
		targetRuntime: AtelierRuntime,
		targetRunActivity: RunActivityTracker | undefined,
		targetPanelRegistry: SidebarPanelRegistry | undefined = panelRegistry,
	): SidebarSnapshot {
		const sessionName = ctx.sessionManager.getSessionName();
		const sessionFile = ctx.sessionManager.getSessionFile();
		const activeTools = pi.getActiveTools();
		return buildSidebarSnapshot({
			state: targetRuntime.getState(),
			cwd: ctx.cwd,
			...(sessionName ? { sessionName } : {}),
			...(sessionFile ? { sessionFile } : {}),
			branchEntryCount: ctx.sessionManager.getBranch().length,
			activeToolCount: activeTools.length,
			availableToolCount: pi.getAllTools().length,
			activeToolNames: activeTools,
			extensionStatuses,
			...(targetRunActivity ? { runActivity: targetRunActivity.getSnapshot() } : {}),
			todos: cachedTodos,
			sidebarPanels: targetPanelRegistry?.getAvailable() ?? [],
		});
	}

	function getCurrentContextState(ctx: ExtensionContext | undefined):
		| {
				ctx: ExtensionContext;
				runtime: AtelierRuntime | undefined;
				sidebar: SidebarController | undefined;
				runActivity: RunActivityTracker | undefined;
		  }
		| undefined {
		if (ctx === undefined || currentContext === undefined || currentSessionManager === undefined)
			return undefined;
		try {
			if (ctx.sessionManager !== currentSessionManager) return undefined;
		} catch {
			return undefined;
		}
		return { ctx: currentContext, runtime, sidebar, runActivity };
	}

	async function setSidebarToolNames(
		ctx: ExtensionContext,
		visible?: boolean,
		targetRuntime = runtime,
		targetSidebar = sidebar,
	): Promise<void> {
		if (!targetRuntime || !targetSidebar || runtime !== targetRuntime || sidebar !== targetSidebar) {
			ctx.ui.notify("Pi Atelier is not active in this session", "warning");
			return;
		}
		const next = visible ?? !targetRuntime.getConfig().showSidebarToolNames;
		if (targetRuntime.getConfig().showSidebarToolNames !== next) {
			targetRuntime.setConfig({ ...targetRuntime.getConfig(), showSidebarToolNames: next });
		}
		try {
			await saveConfigPatch(join(getAgentDir(), "pi-atelier.json"), { showSidebarToolNames: next });
			ctx.ui.notify(`Sidebar tool list ${next ? "expanded" : "collapsed"}`, "info");
		} catch (error) {
			ctx.ui.notify(
				`Sidebar tool list changed for this session but could not be saved: ${
					error instanceof Error ? error.message : String(error)
				}`,
				"warning",
			);
		}
	}

	function completionNotification(
		ctx: ExtensionContext,
		kind: CompletionNotification["kind"],
		snapshot = runActivity?.getSnapshot(),
	): CompletionNotification {
		const sessionName = ctx.sessionManager.getSessionName();
		return {
			kind,
			projectName: basename(ctx.cwd),
			...(sessionName ? { sessionName } : {}),
			...(snapshot === undefined ? {} : { completedToolCount: snapshot.completedCount }),
			...(snapshot === undefined ? {} : { failedToolCount: snapshot.failedCount }),
		};
	}

	function getSidebarPanelSettings(targetRuntime: AtelierRuntime): readonly SidebarPanelSetting[] {
		const configured = targetRuntime.getSidebarPanelLayout();
		const available = new Map((panelRegistry?.getAvailable() ?? []).map((panel) => [panel.id, panel]));
		const configuredIds = new Set(configured.map((entry) => entry.id));
		return [
			...configured.map((entry) => {
				const contributed = isSidebarPanelContributionId(entry.id) ? available.get(entry.id) : undefined;
				return {
					id: entry.id,
					title: contributed?.title ?? entry.id,
					available:
						BUILTIN_SIDEBAR_PANEL_IDS.includes(entry.id as (typeof BUILTIN_SIDEBAR_PANEL_IDS)[number]) ||
						contributed !== undefined,
					visible: entry.visible,
				};
			}),
			...Array.from(available.values())
				.filter((panel) => !configuredIds.has(panel.id))
				.map((panel) => ({
					id: panel.id,
					title: panel.title,
					available: true,
					visible: false,
				})),
		];
	}

	async function openMenu(ctx: ExtensionContext): Promise<void> {
		const current = getCurrentContextState(ctx);
		if (!current?.runtime || !current.sidebar) {
			ctx.ui.notify("Pi Atelier is not active in this session", "warning");
			return;
		}
		const targetRuntime = current.runtime;
		const targetSidebar = current.sidebar;
		await openAtelierControlCenter(
			pi,
			ctx,
			targetRuntime,
			join(getAgentDir(), "pi-atelier.json"),
			{
				isVisible: () => targetSidebar.isVisible(),
				toggle: () => targetSidebar.toggle(),
				isToolListExpanded: () => targetRuntime.getConfig().showSidebarToolNames,
				toggleToolList: async () => setSidebarToolNames(ctx, undefined, targetRuntime, targetSidebar),
				getSidebarPanelSettings: () => getSidebarPanelSettings(targetRuntime),
			},
			requestAllRenders,
			lifecycleGuardedSavePatch(targetRuntime),
		);
	}

	async function openDisplay(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Pi Atelier Display settings require TUI mode", "warning");
			return;
		}
		const current = getCurrentContextState(ctx);
		if (!current?.runtime) {
			ctx.ui.notify("Pi Atelier is not active in this session", "warning");
			return;
		}
		const targetRuntime = current.runtime;
		const displayRuntime: DisplaySettingsRuntime = {
			getConfig: () => targetRuntime.getConfig(),
			getSidebarPanelSettings: () => getSidebarPanelSettings(targetRuntime),
			getDisplaySettings: () => targetRuntime.getDisplaySettings(),
			getDisplayProvenance: () => targetRuntime.getDisplayProvenance(),
			getSessionDisplayOverride: () => targetRuntime.getSessionDisplayOverride(),
			replaceSessionDisplayOverride: (value) => {
				if (runtime === targetRuntime) targetRuntime.replaceSessionDisplayOverride(value);
			},
			clearSessionDisplayOverride: () => {
				if (runtime === targetRuntime) targetRuntime.clearSessionDisplayOverride();
			},
			applySavedUserDisplayPatch: (patch) => {
				if (runtime === targetRuntime) targetRuntime.applySavedUserDisplayPatch(patch);
			},
		};
		await openDisplaySettingsWorkspace(
			ctx,
			displayRuntime,
			join(getAgentDir(), "pi-atelier.json"),
			requestAllRenders,
			lifecycleGuardedSavePatch(targetRuntime),
		);
	}

	function installFooter(
		ctx: ExtensionContext,
		targetRuntime: AtelierRuntime,
		targetRunActivity: RunActivityTracker | undefined,
		generation = lifecycleGeneration,
	): void {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			const isCurrentFooter = (): boolean => generation === lifecycleGeneration && runtime === targetRuntime;
			const footerRequestRender = (): void => {
				if (isCurrentFooter()) tui.requestRender();
			};
			if (isCurrentFooter()) requestRender = footerRequestRender;
			return createFooterComponent({
				getState: (): FooterState => {
					const state = targetRuntime.getState();
					const branch = footerData.getGitBranch();
					if (isCurrentFooter()) {
						updateExtensionStatuses(Array.from(footerData.getExtensionStatuses().values()));
					}
					const performance = targetRunActivity?.getSnapshot().performance;
					return {
						...state,
						...(branch ? { branch } : {}),
						...(performance ? { performance } : {}),
						extensionStatuses,
					};
				},
				getConfig: () => targetRuntime.getConfig(),
				colorEnabled: !("NO_COLOR" in process.env),
				requestRender: footerRequestRender,
				onBranchChange: (callback) =>
					footerData.onBranchChange(() => {
						void targetRuntime.refreshGitState();
						callback();
					}),
				theme: theme as unknown as ThemeLike,
			});
		});
	}

	pi.registerCommand("atelier", {
		description: "Open or control the Pi Atelier status menu",
		handler: async (args, ctx) => {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const [action, sidebarAction, ...extra] = parts;
			if (action === "display") {
				if (sidebarAction !== undefined || extra.length > 0) {
					ctx.ui.notify("Usage: /atelier display", "warning");
					return;
				}
				await openDisplay(ctx);
				return;
			}
			if (action === "sidebar") {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("Pi Atelier sidebar requires TUI mode", "warning");
					return;
				}
				if (!runtime || !sidebar) {
					ctx.ui.notify("Pi Atelier is not active in this session", "warning");
					return;
				}
				if (sidebarAction === "tools") {
					const [toolAction, ...toolExtra] = extra;
					if (
						toolExtra.length > 0 ||
						(toolAction !== undefined && toolAction !== "on" && toolAction !== "off")
					) {
						ctx.ui.notify("Usage: /atelier sidebar tools [on|off]", "warning");
						return;
					}
					await setSidebarToolNames(ctx, toolAction === undefined ? undefined : toolAction === "on");
					return;
				}
				if (
					extra.length > 0 ||
					(sidebarAction !== undefined && sidebarAction !== "on" && sidebarAction !== "off")
				) {
					ctx.ui.notify("Usage: /atelier sidebar [on|off]", "warning");
					return;
				}
				if (sidebarAction === "on") sidebar.show();
				else if (sidebarAction === "off") sidebar.hide();
				else sidebar.toggle();
				return;
			}
			if (action === "disable") {
				enabled = false;
				sidebar?.hide();
				updateExtensionStatuses([]);
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Pi Atelier disabled", "info");
				return;
			}
			if (action === "enable") {
				enabled = true;
				if (runtime) installFooter(ctx, runtime, runActivity);
				ctx.ui.notify("Pi Atelier enabled", "info");
				return;
			}
			await openMenu(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const initializationGeneration = ++lifecycleGeneration;
		const initializationContext = ctx;
		if (initializationContext.mode !== "tui") return;

		let localRuntime: AtelierRuntime | undefined;
		let localSidebar: SidebarController | undefined;
		let localPanelRegistry: SidebarPanelRegistry | undefined;
		let localCompletionNotifier: CompletionNotifier | undefined;
		const isFresh = (): boolean => initializationGeneration === lifecycleGeneration;
		const localRunActivity = createRunActivityTracker({
			cwd: initializationContext.cwd,
			onChange: () => {
				if (isFresh() && runActivity === localRunActivity) requestAllRenders();
			},
		});
		try {
			const userPath = join(getAgentDir(), "pi-atelier.json");
			const projectPath = join(initializationContext.cwd, CONFIG_DIR_NAME, "pi-atelier.json");
			const loaded = await loadConfig({
				userPath,
				projectPath,
				projectTrusted: initializationContext.isProjectTrusted(),
				session: readSessionConfig(initializationContext),
			});
			if (!isFresh()) return;
			for (const warning of loaded.warnings) initializationContext.ui.notify(warning, "warning");
			let autoCompact: boolean | null = null;
			try {
				autoCompact = SettingsManager.create(
					initializationContext.isProjectTrusted() ? initializationContext.cwd : getAgentDir(),
				).getCompactionSettings().enabled;
			} catch {
				initializationContext.ui.notify(
					"Could not read Pi compaction settings; compaction mode is unavailable",
					"warning",
				);
			}
			const candidateRuntime = new AtelierRuntime({
				pi,
				ctx: initializationContext,
				config: loaded.config,
				displayLayers: loaded.displayLayers,
				displayProvenance: loaded.displayProvenance,
				autoCompact,
				requestRender: () => {
					if (isFresh() && runtime === localRuntime) requestAllRenders();
				},
			});
			localRuntime = candidateRuntime;
			localPanelRegistry = createSidebarPanelRegistry({
				events: pi.events,
				instanceId: `atelier-${initializationGeneration}`,
				onChange: () => {
					if (isFresh() && panelRegistry === localPanelRegistry) requestAllRenders();
				},
			});
			const candidateCompletionNotifier = createCompletionNotifier({
				isEnabled: () =>
					enabled && runtime === candidateRuntime && candidateRuntime.getConfig().completionNotifications,
				...(dependencies.notificationPlatform === undefined
					? {}
					: { platform: dependencies.notificationPlatform }),
				...(dependencies.spawnNotificationProcess === undefined
					? {}
					: { spawn: dependencies.spawnNotificationProcess }),
			});
			localCompletionNotifier = candidateCompletionNotifier;
			localSidebar = createSidebarController({
				ctx: initializationContext,
				getSnapshot: () =>
					getSidebarSnapshot(initializationContext, candidateRuntime, localRunActivity, localPanelRegistry),
				getConfig: () => candidateRuntime.getConfig(),
				colorEnabled: !("NO_COLOR" in process.env),
				shouldAnimate: () => runActivity?.isRunning() ?? false,
				onWarning: (message) => initializationContext.ui.notify(message, "warning"),
				onError: (error) =>
					initializationContext.ui.notify(
						`Pi Atelier sidebar failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					),
			});
			if (!isFresh()) {
				localSidebar.dispose();
				localPanelRegistry?.dispose();
				localRunActivity.reset();
				candidateCompletionNotifier.reset();
				candidateRuntime.dispose();
				return;
			}

			const previousSidebar = sidebar;
			const previousRuntime = runtime;
			const previousRunActivity = runActivity;
			const previousPanelRegistry = panelRegistry;
			const previousCompletionNotifier = completionNotifier;
			const previousUnsubscribeAskUserBlocked = unsubscribeAskUserBlocked;
			runtime = candidateRuntime;
			sidebar = localSidebar;
			runActivity = localRunActivity;
			panelRegistry = localPanelRegistry;
			completionNotifier = candidateCompletionNotifier;
			currentContext = initializationContext;
			currentSessionManager = initializationContext.sessionManager;
			cachedTodosSessionManager = initializationContext.sessionManager;
			cachedTodos = reconstructTodos(initializationContext);
			askUserBlocked = false;
			inputRequestSequence = 0;
			unsubscribeAskUserBlocked = pi.events.on("rpiv:ask-user:blocked", (data) => {
				if (runtime !== candidateRuntime || completionNotifier !== candidateCompletionNotifier) return;
				if (typeof data !== "object" || data === null || !("active" in data)) return;
				const active = (data as { active?: unknown }).active;
				if (active === false) {
					askUserBlocked = false;
					return;
				}
				if (active !== true || askUserBlocked) return;
				askUserBlocked = true;
				inputRequestSequence += 1;
				candidateCompletionNotifier.inputRequested(
					`blocked-${inputRequestSequence}`,
					completionNotification(initializationContext, "input-requested", localRunActivity.getSnapshot()),
				);
			});
			extensionStatuses = [];
			previousSidebar?.dispose();
			previousPanelRegistry?.dispose();
			previousRuntime?.dispose();
			previousRunActivity?.reset();
			previousCompletionNotifier?.reset();
			previousUnsubscribeAskUserBlocked?.();

			if (isFresh() && !shortcutRegistered) {
				try {
					pi.registerShortcut(loaded.config.shortcut as KeyId, {
						description: "Open Pi Atelier",
						handler: async (shortcutContext) => openMenu(shortcutContext),
					});
				} catch {
					pi.registerShortcut("alt+a" as KeyId, {
						description: "Open Pi Atelier",
						handler: async (shortcutContext) => openMenu(shortcutContext),
					});
					initializationContext.ui.notify(
						`Invalid Atelier shortcut "${loaded.config.shortcut}"; using alt+a`,
						"warning",
					);
				}
				shortcutRegistered = true;
			}
			if (isFresh() && !resizeShortcutRegistered) {
				pi.registerShortcut("ctrl+shift+r" as KeyId, {
					description: "Resize Pi Atelier sidebar",
					handler: (shortcutContext) => {
						const current = getCurrentContextState(shortcutContext);
						if (!current?.sidebar || !current.sidebar.isVisible()) {
							shortcutContext.ui.notify("Show the Pi Atelier sidebar before resizing it", "warning");
							return;
						}
						current.sidebar.beginResize();
					},
				});
				resizeShortcutRegistered = true;
			}
			if (enabled && isFresh()) {
				installFooter(initializationContext, candidateRuntime, localRunActivity, initializationGeneration);
				localSidebar.show();
			}
			void candidateRuntime.refreshWorkspacePulse();
		} catch (error) {
			localSidebar?.dispose();
			localPanelRegistry?.dispose();
			localRunActivity.reset();
			localCompletionNotifier?.reset();
			localRuntime?.dispose();
			if (!isFresh()) return;
			sidebar?.dispose();
			sidebar = undefined;
			panelRegistry?.dispose();
			panelRegistry = undefined;
			runtime?.dispose();
			runtime = undefined;
			const previousRunActivity = runActivity;
			runActivity = undefined;
			previousRunActivity?.reset();
			const previousCompletionNotifier = completionNotifier;
			completionNotifier = undefined;
			previousCompletionNotifier?.reset();
			const unsubscribe = unsubscribeAskUserBlocked;
			unsubscribeAskUserBlocked = undefined;
			unsubscribe?.();
			askUserBlocked = false;
			currentContext = undefined;
			currentSessionManager = undefined;
			updateExtensionStatuses([]);
			initializationContext.ui.setFooter(undefined);
			initializationContext.ui.notify(
				`Pi Atelier could not start: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		const current = getCurrentContextState(ctx);
		if (!current?.runtime) return;
		cachedTodosSessionManager = ctx.sessionManager;
		cachedTodos = reconstructTodos(ctx);
		requestAllRenders();
	});

	pi.on("agent_start", (_event, ctx) => {
		const current = getCurrentContextState(ctx);
		if (!current?.runActivity || !current.runtime) return;
		current.runActivity.startRun();
		completionNotifier?.runStarted();
		current.runtime.setActivity("working");
	});
	pi.on("turn_start", (event, ctx) => {
		const current = getCurrentContextState(ctx);
		if (!current?.runActivity) return;
		current.runActivity.startTurn(event.turnIndex);
		completionNotifier?.runStarted();
		void current.runtime?.refreshWorkspacePulse();
	});
	pi.on("before_provider_request", (_event, ctx) => {
		getCurrentContextState(ctx)?.runActivity?.startResponse();
	});
	pi.on("message_update", (event, ctx) => {
		const estimatedOutputTokens = estimateTokens(event.message);
		if (estimatedOutputTokens <= 0) return;
		getCurrentContextState(ctx)?.runActivity?.updateResponseEstimate(estimatedOutputTokens);
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		getCurrentContextState(ctx)?.runActivity?.finishResponse(event.message.usage.output);
	});
	pi.on("tool_execution_start", (event, ctx) => {
		const current = getCurrentContextState(ctx);
		if (!current?.runActivity) return;
		current.runActivity.startTool(event);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const current = getCurrentContextState(ctx);
		if (!current?.runActivity) return;
		current.runActivity.finishTool(event);
		current.runtime?.scheduleWorkspacePulseRefresh();
	});
	// Collapse todo tool output when sidebar shows todos
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "todo") return;
		const current = getCurrentContextState(ctx);
		if (!current?.runtime) return;
		if (event.isError) return;

		const details = event.details;
		let rawItems: (TodoItem | RpivTask)[];
		if (isOldTodoDetails(details)) {
			rawItems = details.todos;
		} else if (isNewTaskDetails(details)) {
			rawItems = details.tasks;
		} else {
			return;
		}
		const todoList = rawItems.map(normalizeTodo).filter((item): item is NormalizedTodo => item !== undefined);
		// Keep state updates independent from whether the TODO panel is currently presented.
		if (ctx.sessionManager === cachedTodosSessionManager) cachedTodos = todoList;
		const sidebarVisible = current.sidebar?.isVisible() ?? false;
		if (sidebarVisible) current.sidebar?.requestRender();
		const sidebarTodoLayout = current.runtime
			.getConfig()
			.sidebarPanelLayout.find((entry) => entry.id === "todos");
		if (
			!current.runtime.getConfig().showSidebarTodos ||
			sidebarTodoLayout?.visible === false ||
			!sidebarVisible ||
			todoList.length === 0
		)
			return;
		const done = todoList.filter((t) => t.status === "completed").length;
		return {
			content: [{ type: "text", text: `${done}/${todoList.length} done · see sidebar` }],
		};
	});
	pi.on("agent_settled", (_event, ctx) => {
		const current = getCurrentContextState(ctx);
		if (!current?.runActivity || !current.runtime || !ctx.isIdle()) return;
		current.runActivity.settle();
		current.runtime.setActivity("ready");
		current.sidebar?.requestRender();
		completionNotifier?.turnSettled(
			completionNotification(current.ctx, "turn-settled", current.runActivity.getSnapshot()),
		);
	});
	pi.on("turn_end", async (_event, ctx) => {
		const current = getCurrentContextState(ctx);
		if (!current?.runtime) return;
		current.runtime.refreshUsage();
		await current.runtime.refreshGitState();
	});
	pi.on("model_select", (_event, ctx) => getCurrentContextState(ctx)?.runtime?.refreshUsage());
	pi.on("thinking_level_select", (_event, ctx) => getCurrentContextState(ctx)?.runtime?.refreshUsage());
	pi.on("session_compact", (_event, ctx) => getCurrentContextState(ctx)?.runtime?.refreshUsage());
	pi.on("session_info_changed", (_event, ctx) => getCurrentContextState(ctx)?.runtime?.refreshUsage());
	pi.on("session_shutdown", (_event, ctx) => {
		const current = getCurrentContextState(ctx);
		if (!current && currentContext !== undefined) return;
		lifecycleGeneration += 1;
		(current?.sidebar ?? sidebar)?.dispose();
		sidebar = undefined;
		panelRegistry?.dispose();
		panelRegistry = undefined;
		(current?.runtime ?? runtime)?.dispose();
		runtime = undefined;
		const previousRunActivity = current?.runActivity ?? runActivity;
		runActivity = undefined;
		previousRunActivity?.reset();
		const previousCompletionNotifier = completionNotifier;
		completionNotifier = undefined;
		previousCompletionNotifier?.reset();
		const unsubscribe = unsubscribeAskUserBlocked;
		unsubscribeAskUserBlocked = undefined;
		unsubscribe?.();
		askUserBlocked = false;
		current?.ctx.ui.setFooter(undefined);
		currentContext = undefined;
		cachedTodos = [];
		cachedTodosSessionManager = undefined;
		currentSessionManager = undefined;
		requestRender = () => undefined;
		extensionStatuses = [];
	});
}

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
import { loadConfig, type saveUserConfig, saveUserConfigPatch } from "../src/config.js";
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
	/** @deprecated Retained for source compatibility; Atelier no longer performs full config writes. */
	saveConfig?: typeof saveUserConfig;
	loadConfig?: typeof loadConfig;
	saveConfigPatch?: typeof saveUserConfigPatch;
	notificationPlatform?: NodeJS.Platform;
	spawnNotificationProcess?: SpawnNotificationProcess;
}

interface ActiveSession {
	readonly ctx: ExtensionContext;
	readonly sessionManager: ExtensionContext["sessionManager"];
	readonly runtime: AtelierRuntime;
	readonly sidebar: SidebarController;
	readonly panelRegistry: SidebarPanelRegistry;
	readonly runActivity: RunActivityTracker;
	readonly completionNotifier: CompletionNotifier;
	unsubscribeAskUserBlocked: (() => void) | undefined;
	askUserBlocked: boolean;
	inputRequestSequence: number;
	todos: NormalizedTodo[];
	requestFooterRender: () => void;
	extensionStatuses: readonly string[];
}

interface LifecycleToken {
	readonly id: number;
	initializingSessionManager: ExtensionContext["sessionManager"] | undefined;
}

export default function atelierExtension(
	pi: ExtensionAPI,
	dependencies: AtelierExtensionDependencies = {},
): void {
	const _loadConfig = dependencies.loadConfig ?? loadConfig;
	const saveConfigPatch = dependencies.saveConfigPatch ?? saveUserConfigPatch;
	const noopRender = (): void => undefined;
	let activeSession: ActiveSession | undefined;
	let enabled = true;
	let shortcutRegistered = false;
	let resizeShortcutRegistered = false;
	let lifecycleToken: LifecycleToken = { id: 0, initializingSessionManager: undefined };

	/** Retires the current lifecycle and records which initialization, if any, is now in flight. */
	function startLifecycleGeneration(
		sessionManagerClaim: ExtensionContext["sessionManager"] | undefined,
	): LifecycleToken {
		lifecycleToken = {
			id: lifecycleToken.id + 1,
			initializingSessionManager: sessionManagerClaim,
		};
		return lifecycleToken;
	}

	const requestAllRenders = (targetSession: ActiveSession): void => {
		if (activeSession !== targetSession) return;
		targetSession.requestFooterRender();
		targetSession.sidebar.requestRender();
	};
	const lifecycleGuardedSavePatch =
		(targetSession: ActiveSession): typeof saveUserConfigPatch =>
		async (path, patch) => {
			if (activeSession !== targetSession) throw new Error("Pi Atelier is not active in this session");
			await saveConfigPatch(path, patch);
		};

	function updateExtensionStatuses(targetSession: ActiveSession, next: readonly string[]): void {
		if (activeSession !== targetSession) return;
		if (
			next.length === targetSession.extensionStatuses.length &&
			next.every((status, index) => status === targetSession.extensionStatuses[index])
		) {
			return;
		}
		targetSession.extensionStatuses = [...next];
		targetSession.sidebar.requestRender();
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
	function getSidebarSnapshot(targetSession: ActiveSession): SidebarSnapshot {
		const { ctx, panelRegistry, runActivity, runtime } = targetSession;
		const sessionName = ctx.sessionManager.getSessionName();
		const sessionFile = ctx.sessionManager.getSessionFile();
		const activeTools = pi.getActiveTools();
		return buildSidebarSnapshot({
			state: runtime.getState(),
			cwd: ctx.cwd,
			...(sessionName ? { sessionName } : {}),
			...(sessionFile ? { sessionFile } : {}),
			branchEntryCount: ctx.sessionManager.getBranch().length,
			activeToolCount: activeTools.length,
			availableToolCount: pi.getAllTools().length,
			activeToolNames: activeTools,
			extensionStatuses: targetSession.extensionStatuses,
			runActivity: runActivity.getSnapshot(),
			todos: targetSession.todos,
			sidebarPanels: panelRegistry.getAvailable(),
		});
	}

	function contextUsesSessionManager(
		ctx: ExtensionContext | undefined,
		sessionManager: ExtensionContext["sessionManager"],
	): boolean {
		if (!ctx) return false;
		try {
			return ctx.sessionManager === sessionManager;
		} catch {
			return false;
		}
	}

	function getActiveSession(ctx: ExtensionContext | undefined): ActiveSession | undefined {
		const current = activeSession;
		return current && contextUsesSessionManager(ctx, current.sessionManager) ? current : undefined;
	}

	/**
	 * Retirement is decided by session identity, so a retired session's own fields are never read
	 * again; only the resources it owns outside this module need releasing.
	 */
	function disposeSession(session: ActiveSession, options: { clearFooter?: boolean } = {}): void {
		try {
			if (options.clearFooter) session.ctx.ui.setFooter(undefined);
		} catch {
			// Footer cleanup must not interrupt the rest of lifecycle disposal.
		}
		session.sidebar.dispose();
		session.panelRegistry.dispose();
		session.runtime.dispose();
		session.runActivity.reset();
		session.completionNotifier.reset();
		const unsubscribe = session.unsubscribeAskUserBlocked;
		session.unsubscribeAskUserBlocked = undefined;
		unsubscribe?.();
	}

	function teardownActiveSession(ctx?: ExtensionContext): void {
		const retiredSession = activeSession;
		activeSession = undefined;
		if (retiredSession) disposeSession(retiredSession, { clearFooter: true });
		else ctx?.ui.setFooter(undefined);
	}

	async function setSidebarToolNames(
		ctx: ExtensionContext,
		visible: boolean | undefined,
		targetSession: ActiveSession,
	): Promise<void> {
		const { runtime: targetRuntime } = targetSession;
		const next = visible ?? !targetRuntime.getConfig().showSidebarToolNames;
		if (targetRuntime.getConfig().showSidebarToolNames !== next) {
			targetRuntime.setConfig({ ...targetRuntime.getConfig(), showSidebarToolNames: next });
		}
		try {
			await lifecycleGuardedSavePatch(targetSession)(join(getAgentDir(), "pi-atelier.json"), {
				showSidebarToolNames: next,
			});
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
		snapshot = activeSession?.runActivity.getSnapshot(),
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

	function getSidebarPanelSettings(targetSession: ActiveSession): readonly SidebarPanelSetting[] {
		const configured = targetSession.runtime.getSidebarPanelLayout();
		const available = new Map(targetSession.panelRegistry.getAvailable().map((panel) => [panel.id, panel]));
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
		const current = getActiveSession(ctx);
		if (!current) {
			ctx.ui.notify("Pi Atelier is not active in this session", "warning");
			return;
		}
		const { runtime: targetRuntime, sidebar: targetSidebar } = current;
		await openAtelierControlCenter(
			pi,
			ctx,
			targetRuntime,
			join(getAgentDir(), "pi-atelier.json"),
			{
				isVisible: () => targetSidebar.isVisible(),
				toggle: () => targetSidebar.toggle(),
				isToolListExpanded: () => targetRuntime.getConfig().showSidebarToolNames,
				toggleToolList: async () => setSidebarToolNames(ctx, undefined, current),
				getSidebarPanelSettings: () => getSidebarPanelSettings(current),
			},
			() => requestAllRenders(current),
			lifecycleGuardedSavePatch(current),
		);
	}

	async function openDisplay(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Pi Atelier Display settings require TUI mode", "warning");
			return;
		}
		const current = getActiveSession(ctx);
		if (!current) {
			ctx.ui.notify("Pi Atelier is not active in this session", "warning");
			return;
		}
		const targetRuntime = current.runtime;
		const displayRuntime: DisplaySettingsRuntime = {
			getConfig: () => targetRuntime.getConfig(),
			getSidebarPanelSettings: () => getSidebarPanelSettings(current),
			getDisplaySettings: () => targetRuntime.getDisplaySettings(),
			getDisplayProvenance: () => targetRuntime.getDisplayProvenance(),
			getSessionDisplayOverride: () => targetRuntime.getSessionDisplayOverride(),
			replaceSessionDisplayOverride: (value) => {
				if (activeSession === current) targetRuntime.replaceSessionDisplayOverride(value);
			},
			clearSessionDisplayOverride: () => {
				if (activeSession === current) targetRuntime.clearSessionDisplayOverride();
			},
			applySavedUserDisplayPatch: (patch) => {
				if (activeSession === current) targetRuntime.applySavedUserDisplayPatch(patch);
			},
		};
		await openDisplaySettingsWorkspace(
			ctx,
			displayRuntime,
			join(getAgentDir(), "pi-atelier.json"),
			() => requestAllRenders(current),
			lifecycleGuardedSavePatch(current),
		);
	}

	function installFooter(targetSession: ActiveSession): void {
		const { ctx, runActivity, runtime: targetRuntime } = targetSession;
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			const isCurrentFooter = (): boolean => activeSession === targetSession;
			const footerRequestRender = (): void => {
				if (isCurrentFooter()) tui.requestRender();
			};
			if (isCurrentFooter()) targetSession.requestFooterRender = footerRequestRender;
			return createFooterComponent({
				getState: (): FooterState => {
					// A footer outliving its `setFooter(undefined)` reports the disposed runtime's inert state.
					if (!isCurrentFooter()) return targetRuntime.getState();
					const branch = footerData.getGitBranch();
					updateExtensionStatuses(targetSession, Array.from(footerData.getExtensionStatuses().values()));
					const performance = runActivity.getSnapshot().performance;
					return {
						...targetRuntime.getState(),
						...(branch ? { branch } : {}),
						...(performance ? { performance } : {}),
						extensionStatuses: targetSession.extensionStatuses,
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
				const current = getActiveSession(ctx);
				if (!current) {
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
					await setSidebarToolNames(ctx, toolAction === undefined ? undefined : toolAction === "on", current);
					return;
				}
				if (
					extra.length > 0 ||
					(sidebarAction !== undefined && sidebarAction !== "on" && sidebarAction !== "off")
				) {
					ctx.ui.notify("Usage: /atelier sidebar [on|off]", "warning");
					return;
				}
				if (sidebarAction === "on") current.sidebar.show();
				else if (sidebarAction === "off") current.sidebar.hide();
				else current.sidebar.toggle();
				return;
			}
			if (action === "disable") {
				const current = getActiveSession(ctx);
				if (!current) {
					ctx.ui.notify("Pi Atelier is not active in this session", "warning");
					return;
				}
				enabled = false;
				current.sidebar.hide();
				updateExtensionStatuses(current, []);
				// The footer is installed on the session's own context, so it must be cleared there.
				current.ctx.ui.setFooter(undefined);
				ctx.ui.notify("Pi Atelier disabled", "info");
				return;
			}
			if (action === "enable") {
				const current = getActiveSession(ctx);
				if (!current) {
					ctx.ui.notify("Pi Atelier is not active in this session", "warning");
					return;
				}
				enabled = true;
				installFooter(current);
				ctx.ui.notify("Pi Atelier enabled", "info");
				return;
			}
			await openMenu(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const initializationContext = ctx;
		if (initializationContext.mode !== "tui") {
			startLifecycleGeneration(undefined);
			if (activeSession) teardownActiveSession();
			return;
		}
		const initializationSessionManager = initializationContext.sessionManager;
		const initializationToken = startLifecycleGeneration(initializationSessionManager);

		let localRuntime: AtelierRuntime | undefined;
		let localSidebar: SidebarController | undefined;
		let localPanelRegistry: SidebarPanelRegistry | undefined;
		let localCompletionNotifier: CompletionNotifier | undefined;
		let candidateSession: ActiveSession | undefined;
		let publishedSession: ActiveSession | undefined;
		const isFresh = (): boolean => initializationToken === lifecycleToken;
		const requestCandidateRenders = (): void => {
			if (candidateSession && activeSession === candidateSession) requestAllRenders(candidateSession);
		};
		const localRunActivity = createRunActivityTracker({
			cwd: initializationContext.cwd,
			onChange: requestCandidateRenders,
		});
		try {
			const userPath = join(getAgentDir(), "pi-atelier.json");
			const projectPath = join(initializationContext.cwd, CONFIG_DIR_NAME, "pi-atelier.json");
			const loaded = await _loadConfig({
				userPath,
				projectPath,
				projectTrusted: initializationContext.isProjectTrusted(),
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
				requestRender: requestCandidateRenders,
			});
			localRuntime = candidateRuntime;
			localPanelRegistry = createSidebarPanelRegistry({
				events: pi.events,
				instanceId: `atelier-${initializationToken.id}`,
				onChange: requestCandidateRenders,
			});
			const candidateCompletionNotifier = createCompletionNotifier({
				isEnabled: () =>
					enabled &&
					candidateSession !== undefined &&
					activeSession === candidateSession &&
					candidateRuntime.getConfig().completionNotifications,
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
				getSnapshot: () => {
					if (!candidateSession) throw new Error("Pi Atelier session is not published");
					return getSidebarSnapshot(candidateSession);
				},
				getConfig: () => candidateRuntime.getConfig(),
				colorEnabled: !("NO_COLOR" in process.env),
				shouldAnimate: () =>
					candidateSession !== undefined &&
					activeSession === candidateSession &&
					localRunActivity.isRunning(),
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

			const nextSession: ActiveSession = {
				ctx: initializationContext,
				sessionManager: initializationContext.sessionManager,
				runtime: candidateRuntime,
				sidebar: localSidebar,
				panelRegistry: localPanelRegistry,
				runActivity: localRunActivity,
				completionNotifier: candidateCompletionNotifier,
				unsubscribeAskUserBlocked: undefined,
				askUserBlocked: false,
				inputRequestSequence: 0,
				todos: reconstructTodos(initializationContext),
				requestFooterRender: noopRender,
				extensionStatuses: [],
			};
			candidateSession = nextSession;
			nextSession.unsubscribeAskUserBlocked = pi.events.on("rpiv:ask-user:blocked", (data) => {
				if (activeSession !== nextSession) return;
				if (typeof data !== "object" || data === null || !("active" in data)) return;
				const active = (data as { active?: unknown }).active;
				if (active === false) {
					nextSession.askUserBlocked = false;
					return;
				}
				if (active !== true || nextSession.askUserBlocked) return;
				nextSession.askUserBlocked = true;
				nextSession.inputRequestSequence += 1;
				nextSession.completionNotifier.inputRequested(
					`blocked-${nextSession.inputRequestSequence}`,
					completionNotification(nextSession.ctx, "input-requested", nextSession.runActivity.getSnapshot()),
				);
			});
			if (!isFresh()) {
				disposeSession(nextSession);
				return;
			}
			const previousSession = activeSession;
			activeSession = nextSession;
			publishedSession = nextSession;
			if (previousSession) disposeSession(previousSession, { clearFooter: true });

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
						const current = getActiveSession(shortcutContext);
						if (!current?.sidebar.isVisible()) {
							shortcutContext.ui.notify("Show the Pi Atelier sidebar before resizing it", "warning");
							return;
						}
						current.sidebar.beginResize();
					},
				});
				resizeShortcutRegistered = true;
			}
			if (enabled && isFresh() && activeSession === nextSession) {
				installFooter(nextSession);
				if (loaded.config.showSidebarOnStartup) nextSession.sidebar.show();
			}
			void candidateRuntime.refreshWorkspacePulse();
		} catch (error) {
			if (!publishedSession) {
				// Candidate-local cleanup: this session never became active, so no active-session teardown applies.
				if (candidateSession) disposeSession(candidateSession);
				else {
					localSidebar?.dispose();
					localPanelRegistry?.dispose();
					localRunActivity.reset();
					localCompletionNotifier?.reset();
					localRuntime?.dispose();
				}
			}
			if (!isFresh()) return;
			if (publishedSession && activeSession !== publishedSession) return;
			// Pi has already replaced the previous session, so a pre-publish failure retires it too.
			teardownActiveSession(initializationContext);
			initializationContext.ui.notify(
				`Pi Atelier could not start: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		} finally {
			if (lifecycleToken === initializationToken) lifecycleToken.initializingSessionManager = undefined;
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		current.todos = reconstructTodos(ctx);
		requestAllRenders(current);
	});

	pi.on("agent_start", (_event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		current.runActivity.startRun();
		current.completionNotifier.runStarted();
		current.runtime.setActivity("working");
	});
	pi.on("turn_start", (event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		current.runActivity.startTurn(event.turnIndex);
		current.completionNotifier.runStarted();
		void current.runtime.refreshWorkspacePulse();
	});
	pi.on("before_provider_request", (_event, ctx) => {
		getActiveSession(ctx)?.runActivity.startResponse();
	});
	pi.on("message_update", (event, ctx) => {
		const estimatedOutputTokens = estimateTokens(event.message);
		if (estimatedOutputTokens <= 0) return;
		getActiveSession(ctx)?.runActivity.updateResponseEstimate(estimatedOutputTokens);
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		getActiveSession(ctx)?.runActivity.finishResponse(event.message.usage.output);
	});
	pi.on("tool_execution_start", (event, ctx) => {
		getActiveSession(ctx)?.runActivity.startTool(event);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		current.runActivity.finishTool(event);
		current.runtime.scheduleWorkspacePulseRefresh();
	});
	// Collapse todo tool output when sidebar shows todos
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "todo") return;
		const current = getActiveSession(ctx);
		if (!current || event.isError) return;

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
		current.todos = todoList;
		const sidebarVisible = current.sidebar.isVisible();
		if (sidebarVisible) current.sidebar.requestRender();
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
		const current = getActiveSession(ctx);
		if (!current || !ctx.isIdle()) return;
		current.runActivity.settle();
		current.runtime.setActivity("ready");
		current.sidebar.requestRender();
		current.completionNotifier.turnSettled(
			completionNotification(current.ctx, "turn-settled", current.runActivity.getSnapshot()),
		);
	});
	pi.on("turn_end", async (_event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		current.runtime.refreshUsage();
		await current.runtime.refreshGitState();
	});
	pi.on("model_select", (_event, ctx) => getActiveSession(ctx)?.runtime.refreshUsage());
	pi.on("thinking_level_select", (_event, ctx) => getActiveSession(ctx)?.runtime.refreshUsage());
	pi.on("session_compact", (_event, ctx) => getActiveSession(ctx)?.runtime.refreshUsage());
	pi.on("session_info_changed", (_event, ctx) => getActiveSession(ctx)?.runtime.refreshUsage());
	pi.on("session_shutdown", (_event, ctx) => {
		const current = getActiveSession(ctx);
		const initializing = lifecycleToken.initializingSessionManager;
		const cancelsInitialization = initializing !== undefined && contextUsesSessionManager(ctx, initializing);
		if (initializing && !cancelsInitialization) {
			// An unrelated session is shutting down; retire it but leave the newer initializer authoritative.
			if (current) teardownActiveSession();
			return;
		}
		if (!current && activeSession !== undefined && !cancelsInitialization) return;
		startLifecycleGeneration(undefined);
		if (current) teardownActiveSession();
	});
}

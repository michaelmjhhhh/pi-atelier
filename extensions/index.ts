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
import { openAtelierControlCenter, openDisplaySettingsWorkspace } from "../src/menu.js";
import { createRunActivityTracker, type RunActivityTracker } from "../src/run-activity.js";
import {
	buildSidebarSnapshot,
	createSidebarController,
	type SidebarController,
	type SidebarSnapshot,
} from "../src/sidebar.js";
import { AtelierRuntime } from "../src/state.js";
import type { CurrentGoal, FooterState } from "../src/types.js";

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
	let runActivity: RunActivityTracker | undefined;
	let completionNotifier: CompletionNotifier | undefined;
	let unsubscribeAskUserBlocked: (() => void) | undefined;
	let unsubscribeGoalState: (() => void) | undefined;
	let askUserBlocked = false;
	let inputRequestSequence = 0;
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

	// ─── Goal state ──────────────────────────────────────────────────────────────

	const GOAL_CUSTOM_ENTRY_TYPE = "goal-state";

	interface GoalStateEntryData {
		goal: { id?: string; text?: string; status?: string } | null;
	}

	/** Reconstruct the current goal from session custom entries (session start / branch switch). */
	function reconstructCurrentGoal(ctx: ExtensionContext): CurrentGoal | undefined {
		const entries = ctx.sessionManager.getBranch();
		const goalEntries = entries.filter(
			(entry) => entry.type === "custom" && entry.customType === GOAL_CUSTOM_ENTRY_TYPE,
		);
		const lastEntry = goalEntries.pop();
		if (!lastEntry || lastEntry.type !== "custom") return undefined;
		const data = lastEntry.data as GoalStateEntryData | undefined;
		if (data === undefined) return undefined;
		if (data.goal === undefined || data.goal === null) return undefined;
		const g = data.goal;
		if (!g.id || !g.text || !g.status) return undefined;
		if (g.status === "complete") return undefined;
		return { goalId: g.id, text: g.text, status: g.status };
	}

	function getSidebarSnapshot(
		ctx: ExtensionContext,
		targetRuntime: AtelierRuntime,
		targetRunActivity: RunActivityTracker | undefined,
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
		await openDisplaySettingsWorkspace(
			ctx,
			{
				getConfig: () => targetRuntime.getConfig(),
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
			},
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
				getSnapshot: () => getSidebarSnapshot(initializationContext, candidateRuntime, localRunActivity),
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
				localRunActivity.reset();
				candidateCompletionNotifier.reset();
				candidateRuntime.dispose();
				return;
			}

			const previousSidebar = sidebar;
			const previousRuntime = runtime;
			const previousRunActivity = runActivity;
			const previousCompletionNotifier = completionNotifier;
			const previousUnsubscribeAskUserBlocked = unsubscribeAskUserBlocked;
			const previousUnsubscribeGoalState = unsubscribeGoalState;
			runtime = candidateRuntime;
			sidebar = localSidebar;
			runActivity = localRunActivity;
			completionNotifier = candidateCompletionNotifier;
			currentContext = initializationContext;
			currentSessionManager = initializationContext.sessionManager;
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

			// Subscribe to pi-goal state events for sidebar goal panel
			unsubscribeGoalState = pi.events.on("pi-goal:state", (data) => {
				if (runtime !== candidateRuntime) return;
				if (typeof data !== "object" || data === null) return;
				const payload = data as { goalId?: unknown; text?: unknown; status?: unknown };
				const goalId = typeof payload.goalId === "string" ? payload.goalId : undefined;
				const text = typeof payload.text === "string" ? payload.text : undefined;
				const status = typeof payload.status === "string" ? payload.status : undefined;

				if (status === "cleared") {
					// Only clear if the event goalId matches current goal (prevents stale clears)
					if (goalId && candidateRuntime.getState().currentGoal?.goalId !== goalId) return;
					candidateRuntime.setCurrentGoal(undefined);
					return;
				}

				if (goalId && status) {
					// Update only if goalId matches current or we have no current goal
					const existing = candidateRuntime.getState().currentGoal;
					if (existing && existing.goalId !== goalId) return;
					const goalText = text ?? existing?.text;
					if (!goalText) return;
					candidateRuntime.setCurrentGoal({ goalId, text: goalText, status });
					return;
				}

				// Fallback: reconstruct from session entries if payload incomplete
				if (!currentContext) return;
				const currentGoal = reconstructCurrentGoal(currentContext);
				candidateRuntime.setCurrentGoal(currentGoal);
			});

			// Set initial goal state from session entries
			const initialGoal = reconstructCurrentGoal(initializationContext);
			candidateRuntime.setCurrentGoal(initialGoal);

			extensionStatuses = [];
			previousSidebar?.dispose();
			previousRuntime?.dispose();
			previousRunActivity?.reset();
			previousCompletionNotifier?.reset();
			previousUnsubscribeAskUserBlocked?.();
			previousUnsubscribeGoalState?.();

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
			localRunActivity.reset();
			localCompletionNotifier?.reset();
			localRuntime?.dispose();
			if (!isFresh()) return;
			sidebar?.dispose();
			sidebar = undefined;
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
			const unsubscribeGoal = unsubscribeGoalState;
			unsubscribeGoalState = undefined;
			unsubscribeGoal?.();
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
		const unsubscribeGoal = unsubscribeGoalState;
		unsubscribeGoalState = undefined;
		unsubscribeGoal?.();
		askUserBlocked = false;
		current?.ctx.ui.setFooter(undefined);
		currentContext = undefined;
		currentSessionManager = undefined;
		requestRender = () => undefined;
		extensionStatuses = [];
	});
}

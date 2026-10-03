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
import { DEFAULT_CONFIG, loadConfig, saveUserConfigPatch } from "../src/config.js";
import { AtelierEditor } from "../src/editor.js";
import { type AtelierFooterComponent, createFooterComponent } from "../src/footer.js";
import { createImageCompositorBinding } from "../src/image-compositor.js";
import { openAtelierControlCenter, openDisplaySettingsWorkspace, sidebarStatusLabel } from "../src/menu.js";
import type { OverlayLifetime } from "../src/overlay-lifecycle.js";
import { createRunActivityTracker, type RunActivityTracker } from "../src/run-activity.js";
import type { SidebarPanelSetting } from "../src/settings-workspace.js";
import {
	buildSidebarSnapshot,
	createSidebarController,
	type SidebarController,
	type SidebarSnapshot,
} from "../src/sidebar.js";
import {
	createSidebarPanelRegistry,
	isBuiltinSidebarPanelId,
	type SidebarPanelData,
	type SidebarPanelRegistry,
} from "../src/sidebar-panels.js";
import { AtelierRuntime, createInertAtelierState } from "../src/state.js";
import { emptySubagentUsage } from "../src/subagent-usage.js";
import { openSubagentUsage } from "../src/subagent-usage-view.js";
import { errorMessage, isColorEnabled, isRecord } from "../src/text.js";
import { reconstructTodos, todosFromDetails } from "../src/todos.js";
import type { AtelierConfig, AtelierState, FooterState, NormalizedTodo } from "../src/types.js";

// Public sidebar contribution protocol for other extensions.
export type {
	SidebarPanelContribution,
	SidebarPanelDiscoveryEvent,
	SidebarPanelEvent,
	SidebarPanelEventTransport,
	SidebarPanelRegisterEvent,
	SidebarPanelRole,
	SidebarPanelRow,
	SidebarPanelUnregisterEvent,
} from "../src/sidebar-panels.js";
export {
	BUILTIN_SIDEBAR_PANEL_IDS,
	isSidebarPanelContributionId,
	isSidebarPanelId,
	isSidebarPanelRequestId,
	isSidebarPanelRole,
	isSidebarPanelSource,
	isSidebarPanelTextWithinRawLimit,
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
	loadConfig?: typeof loadConfig;
	saveConfigPatch?: typeof saveUserConfigPatch;
	notificationPlatform?: NodeJS.Platform;
	spawnNotificationProcess?: SpawnNotificationProcess;
}

interface ActiveSession {
	readonly ctx: ExtensionContext;
	readonly sessionManager: ExtensionContext["sessionManager"];
	readonly token: LifecycleToken;
	readonly runtime: AtelierRuntime;
	readonly sidebar: SidebarController;
	readonly panelRegistry: SidebarPanelRegistry;
	readonly runActivity: RunActivityTracker;
	readonly completionNotifier: CompletionNotifier;
	readonly retiredState: AtelierState;
	readonly retiredConfig: AtelierConfig;
	readonly retiredCwd: string;
	readonly overlayCancellations: Set<() => void>;
	readonly overlayLifetime: OverlayLifetime;
	footerDisposer: (() => void) | undefined;
	footerGeneration: number;
	unsubscribeAskUserBlocked: (() => void) | undefined;
	askUserBlocked: boolean;
	inputRequestSequence: number;
	todos: NormalizedTodo[];
	requestFooterRender: () => void;
	extensionStatuses: readonly string[];
}

interface LifecycleToken {
	readonly id: number;
}

const NOT_ACTIVE = "Pi Atelier is not active in this session";
const RESIZE_SHORTCUT = "ctrl+shift+r";

const userConfigPath = (): string => join(getAgentDir(), "pi-atelier.json");

/** Run every cleanup step even when one throws; teardown must not mask the original failure. */
function attempt(action: () => void): void {
	try {
		action();
	} catch {
		// Best effort: later resources still get a release attempt.
	}
}

/** Restore Pi's own footer and composer. */
function resetHostUi(ctx: ExtensionContext | undefined): void {
	attempt(() => ctx?.ui.setFooter(undefined));
	attempt(() => ctx?.ui.setEditorComponent(undefined));
}

export default function atelierExtension(
	pi: ExtensionAPI,
	dependencies: AtelierExtensionDependencies = {},
): void {
	const loadAtelierConfig = dependencies.loadConfig ?? loadConfig;
	const saveConfigPatch = dependencies.saveConfigPatch ?? saveUserConfigPatch;
	const noopRender = (): void => undefined;
	let activeSession: ActiveSession | undefined;
	let enabled = true;
	let customShortcutRegistered = false;
	let lifecycleToken: LifecycleToken = { id: 0 };
	let initializingSessionManager: ExtensionContext["sessionManager"] | undefined;

	/** Retires the current lifecycle and records which initialization, if any, is now in flight. */
	function startLifecycleGeneration(
		sessionManagerClaim: ExtensionContext["sessionManager"] | undefined,
	): LifecycleToken {
		lifecycleToken = { id: lifecycleToken.id + 1 };
		initializingSessionManager = sessionManagerClaim;
		return lifecycleToken;
	}

	const requestAllRenders = (targetSession: ActiveSession): void => {
		if (!enabled || activeSession !== targetSession) return;
		targetSession.requestFooterRender();
		targetSession.sidebar.requestRender();
	};
	const lifecycleGuardedSavePatch =
		(targetSession: ActiveSession): typeof saveUserConfigPatch =>
		async (path, patch) => {
			if (activeSession !== targetSession) throw new Error(NOT_ACTIVE);
			await saveConfigPatch(path, patch);
			if (activeSession !== targetSession) throw new Error(NOT_ACTIVE);
		};

	function createOverlayLifetime(token: LifecycleToken, cancellations: Set<() => void>): OverlayLifetime {
		return {
			isActive: () => activeSession?.token === token,
			register(cancel) {
				if (activeSession?.token !== token) {
					attempt(cancel);
					return () => undefined;
				}
				cancellations.add(cancel);
				return () => cancellations.delete(cancel);
			},
		};
	}

	function updateExtensionStatuses(targetSession: ActiveSession, next: readonly string[]): void {
		if (activeSession !== targetSession) return;
		const current = targetSession.extensionStatuses;
		if (next.length === current.length && next.every((status, index) => status === current[index])) return;
		targetSession.extensionStatuses = [...next];
		targetSession.sidebar.requestRender();
	}

	function getSidebarSnapshot(targetSession: ActiveSession): SidebarSnapshot {
		if (!enabled || activeSession !== targetSession) {
			return buildSidebarSnapshot({
				state: targetSession.retiredState,
				cwd: targetSession.retiredCwd,
				branchEntryCount: 0,
				activeToolCount: 0,
				availableToolCount: 0,
			});
		}
		const { ctx, panelRegistry, runActivity, runtime } = targetSession;
		const sessionName = ctx.sessionManager.getSessionName();
		const sessionFile = ctx.sessionManager.getSessionFile();
		const activeTools = pi.getActiveTools();
		return buildSidebarSnapshot({
			state: { ...runtime.getState(), extensionStatuses: targetSession.extensionStatuses },
			cwd: ctx.cwd,
			...(sessionName ? { sessionName } : {}),
			...(sessionFile ? { sessionFile } : {}),
			branchEntryCount: ctx.sessionManager.getBranch().length,
			activeToolCount: activeTools.length,
			availableToolCount: pi.getAllTools().length,
			activeToolNames: activeTools,
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

	/** The active session for `ctx`, or undefined after telling the user there is none. */
	function requireActiveSession(ctx: ExtensionContext): ActiveSession | undefined {
		const current = getActiveSession(ctx);
		if (!current) ctx.ui.notify(NOT_ACTIVE, "warning");
		return current;
	}

	function clearFooter(session: ActiveSession, restoreHostUi: boolean): void {
		// Invalidate callbacks before touching Pi so a failed removal cannot leave a live footer.
		session.footerGeneration += 1;
		const footerDisposer = session.footerDisposer;
		session.footerDisposer = undefined;
		// Pi may retain the old footer when removal fails; it is disposed below regardless.
		if (restoreHostUi) resetHostUi(session.ctx);
		if (footerDisposer) attempt(footerDisposer);
	}

	/**
	 * Retirement is decided by session identity, so cleanup is best-effort: every owned
	 * resource gets a release attempt even if another disposer throws.
	 */
	function disposeSession(session: ActiveSession, options: { clearFooter?: boolean } = {}): void {
		session.todos = [];
		session.extensionStatuses = [];
		session.askUserBlocked = false;
		session.inputRequestSequence = 0;
		session.requestFooterRender = noopRender;
		clearFooter(session, options.clearFooter === true);
		for (const cancel of Array.from(session.overlayCancellations)) attempt(cancel);
		session.overlayCancellations.clear();
		attempt(() => session.sidebar.dispose());
		attempt(() => session.panelRegistry.dispose());
		attempt(() => session.runtime.dispose());
		attempt(() => session.runActivity.reset());
		attempt(() => session.completionNotifier.reset());
		const unsubscribe = session.unsubscribeAskUserBlocked;
		session.unsubscribeAskUserBlocked = undefined;
		if (unsubscribe) attempt(unsubscribe);
	}

	function teardownActiveSession(ctx?: ExtensionContext): void {
		const retiredSession = activeSession;
		activeSession = undefined;
		if (retiredSession) disposeSession(retiredSession, { clearFooter: true });
		else resetHostUi(ctx);
	}

	async function setSidebarToolNames(
		ctx: ExtensionContext,
		visible: boolean | undefined,
		targetSession: ActiveSession,
	): Promise<void> {
		const { runtime } = targetSession;
		const next = visible ?? !runtime.getConfig().showSidebarToolNames;
		if (runtime.getConfig().showSidebarToolNames !== next) {
			runtime.setConfig({ ...runtime.getConfig(), showSidebarToolNames: next });
		}
		try {
			await lifecycleGuardedSavePatch(targetSession)(userConfigPath(), { showSidebarToolNames: next });
			if (activeSession !== targetSession) return;
			ctx.ui.notify(`Sidebar tool list ${next ? "expanded" : "collapsed"}`, "info");
		} catch (error) {
			if (activeSession !== targetSession) return;
			ctx.ui.notify(
				`Sidebar tool list changed for this session but could not be saved: ${errorMessage(error)}`,
				"warning",
			);
		}
	}

	function completionNotification(session: ActiveSession): CompletionNotification {
		const sessionName = session.ctx.sessionManager.getSessionName();
		const { completedCount, failedCount } = session.runActivity.getSnapshot();
		return {
			projectName: basename(session.ctx.cwd),
			...(sessionName ? { sessionName } : {}),
			completedToolCount: completedCount,
			failedToolCount: failedCount,
		};
	}

	function getSidebarPanelSettings(targetSession: ActiveSession): readonly SidebarPanelSetting[] {
		const configured = targetSession.runtime.getConfig().sidebarPanelLayout;
		const available = new Map<string, SidebarPanelData>(
			targetSession.panelRegistry.getAvailable().map((panel) => [panel.id, panel]),
		);
		const configuredIds = new Set(configured.map((entry) => entry.id));
		return [
			...configured.map((entry) => {
				const contributed = available.get(entry.id);
				return {
					id: entry.id,
					title: contributed?.title ?? entry.id,
					available: isBuiltinSidebarPanelId(entry.id) || contributed !== undefined,
					visible: entry.visible,
				};
			}),
			...[...available.values()]
				.filter((panel) => !configuredIds.has(panel.id))
				.map((panel) => ({ id: panel.id, title: panel.title, available: true, visible: false })),
		];
	}

	async function openUsage(ctx: ExtensionContext, expected?: ActiveSession): Promise<void> {
		const current = getActiveSession(ctx);
		if (ctx.mode !== "tui" || !current || !enabled || (expected && current !== expected)) {
			ctx.ui.notify("Enable Pi Atelier in a TUI session to view usage", "info");
			return;
		}
		if (!ctx.isProjectTrusted()) {
			ctx.ui.notify("Subagent metadata requires a trusted project", "info");
			return;
		}
		await current.runtime.refreshSubagentUsage();
		if (activeSession !== current || !enabled || !ctx.isProjectTrusted()) return;
		await openSubagentUsage(
			ctx,
			current.runtime.getState().subagentUsage ?? emptySubagentUsage(),
			current.runtime.getConfig().currencyDecimals,
			current.overlayLifetime,
		);
	}

	async function openMenu(ctx: ExtensionContext): Promise<void> {
		const current = requireActiveSession(ctx);
		if (!current) return;
		const { runtime, sidebar } = current;
		const isCurrent = (): boolean => activeSession === current;
		await openAtelierControlCenter(
			pi,
			ctx,
			runtime,
			userConfigPath(),
			{
				getStatus: () => sidebar.getStatus(),
				setMode: (mode) => {
					if (enabled && isCurrent()) sidebar.setMode(mode);
				},
				toggle: () => {
					if (enabled && isCurrent()) sidebar.toggle();
				},
				isToolListExpanded: () => isCurrent() && runtime.getConfig().showSidebarToolNames,
				toggleToolList: async () => {
					if (isCurrent()) await setSidebarToolNames(ctx, undefined, current);
				},
				getSidebarPanelSettings: () => (isCurrent() ? getSidebarPanelSettings(current) : []),
			},
			() => requestAllRenders(current),
			lifecycleGuardedSavePatch(current),
			{ lifetime: current.overlayLifetime, openUsage: () => openUsage(ctx, current) },
		);
	}

	async function openDisplay(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Pi Atelier Display settings require TUI mode", "warning");
			return;
		}
		const current = requireActiveSession(ctx);
		if (!current) return;
		await openDisplaySettingsWorkspace(
			ctx,
			current.runtime,
			() => getSidebarPanelSettings(current),
			userConfigPath(),
			() => requestAllRenders(current),
			lifecycleGuardedSavePatch(current),
			{ lifetime: current.overlayLifetime },
		);
	}

	function installFooter(targetSession: ActiveSession): void {
		const { ctx, token, retiredState, retiredConfig } = targetSession;
		const generation = ++targetSession.footerGeneration;
		let editor: AtelierEditor | undefined;
		let footer: AtelierFooterComponent | undefined;
		let headerRendered = false;
		let editorInstalled = false;
		const detachEditor = (): void => {
			if (editor) editor.renderStatusLine = undefined;
			editor = undefined;
			editorInstalled = false;
		};
		const getCurrentSession = (): ActiveSession | undefined => {
			const current = activeSession;
			return enabled && current?.token === token && current.footerGeneration === generation
				? current
				: undefined;
		};
		ctx.ui.setFooter((tui, theme, footerData) => {
			const footerRequestRender = (): void => {
				if (getCurrentSession()) tui.requestRender();
			};
			const current = getCurrentSession();
			if (current) current.requestFooterRender = footerRequestRender;
			const component = createFooterComponent({
				getState: (): FooterState => {
					// A footer outliving its `setFooter(undefined)` reports detached inert state.
					const currentSession = getCurrentSession();
					if (!currentSession) return retiredState;
					const branch = footerData.getGitBranch();
					updateExtensionStatuses(currentSession, Array.from(footerData.getExtensionStatuses().values()));
					const performance = currentSession.runActivity.getSnapshot().performance;
					return {
						...currentSession.runtime.getState(),
						workspaceLabel: basename(currentSession.ctx.cwd),
						...(branch ? { branch } : {}),
						...(performance ? { performance } : {}),
						extensionStatuses: currentSession.extensionStatuses,
					};
				},
				getConfig: () => getCurrentSession()?.runtime.getConfig() ?? retiredConfig,
				colorEnabled: isColorEnabled(),
				requestRender: footerRequestRender,
				onBranchChange: (callback) =>
					footerData.onBranchChange(() => {
						const currentSession = getCurrentSession();
						if (!currentSession) return;
						void currentSession.runtime.flushWorkspacePulseRefresh();
						callback();
					}),
				theme,
			});
			footer = component;
			const imageCompositor = createImageCompositorBinding(tui);
			const mounted: AtelierFooterComponent = {
				...component,
				render(width) {
					imageCompositor.sync();
					// Selectors can temporarily replace the editor without disposing it.
					const promptVisible = editorInstalled && headerRendered && editor?.statusLineVisible;
					headerRendered = false;
					return promptVisible ? component.renderTelemetry(width) : component.render(width);
				},
				dispose() {
					try {
						detachEditor();
						component.dispose();
					} finally {
						imageCompositor.dispose();
					}
				},
			};
			const session = getCurrentSession();
			if (session) session.footerDisposer = mounted.dispose;
			else mounted.dispose();
			return mounted;
		});
		try {
			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				const next = new AtelierEditor(tui, theme, keybindings);
				next.renderStatusLine = (width) => {
					// Fullscreen Pi crops the top of a tall draft after editor rendering.
					// Keep essential state in the bottom footer on short terminals.
					const line =
						getCurrentSession() && tui.terminal.rows >= 12 ? (footer?.renderHeader(width) ?? "") : "";
					headerRendered = Boolean(line);
					return line;
				};
				editor = next;
				return next;
			});
			editorInstalled = true;
		} catch {
			// Composer framing is optional; the Status Rail should still install.
			detachEditor();
			// Pi may also reject restoration; leave the complete footer available.
			attempt(() => ctx.ui.setEditorComponent(undefined));
		}
	}

	type CommandHandler = (ctx: ExtensionContext, args: readonly string[]) => Promise<void> | void;
	const usage = (ctx: ExtensionContext, syntax: string): void =>
		ctx.ui.notify(`Usage: /atelier ${syntax}`, "warning");
	const isOnOff = (value: string | undefined): boolean =>
		value === undefined || value === "on" || value === "off";

	const commands = new Map<string, CommandHandler>(
		Object.entries({
			usage: async (ctx, args) => {
				if (args.length > 0) usage(ctx, "usage");
				else await openUsage(ctx);
			},
			display: async (ctx, args) => {
				if (args.length > 0) usage(ctx, "display");
				else await openDisplay(ctx);
			},
			sidebar: async (ctx, [sidebarAction, ...extra]) => {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("Pi Atelier sidebar requires TUI mode", "warning");
					return;
				}
				const current = requireActiveSession(ctx);
				if (!current) return;
				if (!enabled && sidebarAction !== "off") {
					ctx.ui.notify("Enable Pi Atelier with /atelier enable before showing its sidebar", "info");
					return;
				}
				if (sidebarAction === "tools") {
					const [toolAction, ...toolExtra] = extra;
					if (toolExtra.length > 0 || !isOnOff(toolAction)) usage(ctx, "sidebar tools [on|off]");
					else
						await setSidebarToolNames(
							ctx,
							toolAction === undefined ? undefined : toolAction === "on",
							current,
						);
					return;
				}
				if (
					extra.length > 0 ||
					(!isOnOff(sidebarAction) && sidebarAction !== "auto" && sidebarAction !== "manual")
				) {
					usage(ctx, "sidebar [auto|manual|on|off]");
					return;
				}
				if (sidebarAction === "auto" || sidebarAction === "manual") current.sidebar.setMode(sidebarAction);
				else if (sidebarAction === "on") current.sidebar.show();
				else if (sidebarAction === "off") current.sidebar.hide();
				else current.sidebar.toggle();
				ctx.ui.notify(`Sidebar: ${sidebarStatusLabel(current.sidebar.getStatus())}`, "info");
			},
			disable: (ctx) => {
				const current = requireActiveSession(ctx);
				if (!current) return;
				enabled = false;
				current.runtime.setEnabled(false);
				current.runActivity.resetResponse();
				current.completionNotifier.reset();
				current.todos = [];
				current.sidebar.hide();
				updateExtensionStatuses(current, []);
				clearFooter(current, true);
				ctx.ui.notify("Pi Atelier disabled", "info");
			},
			enable: (ctx) => {
				const current = requireActiveSession(ctx);
				if (!current) return;
				if (!enabled) {
					enabled = true;
					current.todos = reconstructTodos(current.ctx);
					current.runtime.setEnabled(true);
					installFooter(current);
				}
				ctx.ui.notify("Pi Atelier enabled", "info");
			},
		} satisfies Record<string, CommandHandler>),
	);

	pi.registerCommand("atelier", {
		description: "Open or control the Pi Atelier status menu",
		handler: async (args, ctx) => {
			const [action, ...rest] = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const command = action === undefined ? undefined : commands.get(action);
			if (command) await command(ctx, rest);
			else await openMenu(ctx);
		},
	});

	pi.registerShortcut(DEFAULT_CONFIG.shortcut as KeyId, {
		description: "Open Pi Atelier",
		handler: async (shortcutContext) => openMenu(shortcutContext),
	});
	pi.registerShortcut(RESIZE_SHORTCUT, {
		description: "Resize Pi Atelier sidebar",
		handler: (shortcutContext) => {
			const current = getActiveSession(shortcutContext);
			if (!current?.sidebar.getStatus().enabled) {
				shortcutContext.ui.notify("Show the Pi Atelier sidebar before resizing it", "warning");
				return;
			}
			current.sidebar.beginResize();
		},
	});

	/** A configured shortcut is read from the first loaded config; Pi cannot unregister shortcuts. */
	function registerCustomShortcut(ctx: ExtensionContext, shortcut: string): void {
		if (customShortcutRegistered) return;
		customShortcutRegistered = true;
		if (shortcut.toLowerCase() === DEFAULT_CONFIG.shortcut) return;
		try {
			pi.registerShortcut(shortcut as KeyId, {
				description: "Open Pi Atelier",
				handler: async (shortcutContext) => openMenu(shortcutContext),
			});
		} catch {
			ctx.ui.notify(
				`Cannot register Atelier shortcut "${shortcut}"; ${DEFAULT_CONFIG.shortcut} remains available`,
				"warning",
			);
		}
	}

	/** Builds a session from loaded config; nothing here awaits, so the caller's token stays fresh. */
	function createSession(
		ctx: ExtensionContext,
		token: LifecycleToken,
		config: AtelierConfig,
		loaded: Awaited<ReturnType<typeof loadConfig>>,
		cleanup: (() => void)[],
	): ActiveSession {
		const isPublished = (): boolean => activeSession?.token === token;
		const requestRenders = (): void => {
			const current = activeSession;
			if (current?.token === token) requestAllRenders(current);
		};
		const runActivity = createRunActivityTracker({ cwd: ctx.cwd, onChange: requestRenders });
		cleanup.push(() => runActivity.reset());
		let autoCompact: boolean | null = null;
		try {
			autoCompact = SettingsManager.create(
				ctx.isProjectTrusted() ? ctx.cwd : getAgentDir(),
			).getCompactionSettings().enabled;
		} catch {
			ctx.ui.notify("Could not read Pi compaction settings; compaction mode is unavailable", "warning");
		}
		const runtime = new AtelierRuntime({
			pi,
			ctx,
			config,
			displayLayers: loaded.displayLayers,
			displayProvenance: loaded.displayProvenance,
			autoCompact,
			enabled,
			requestRender: requestRenders,
		});
		cleanup.push(() => runtime.dispose());
		const panelRegistry = createSidebarPanelRegistry({
			events: pi.events,
			instanceId: `atelier-${token.id}`,
			onChange: requestRenders,
		});
		cleanup.push(() => panelRegistry.dispose());
		const completionNotifier = createCompletionNotifier({
			isEnabled: () => enabled && isPublished() && runtime.getConfig().completionNotifications,
			...(dependencies.notificationPlatform === undefined
				? {}
				: { platform: dependencies.notificationPlatform }),
			...(dependencies.spawnNotificationProcess === undefined
				? {}
				: { spawn: dependencies.spawnNotificationProcess }),
		});
		cleanup.push(() => completionNotifier.reset());
		const sidebar = createSidebarController({
			ctx,
			getSnapshot: () => {
				const current = activeSession;
				if (!current || current.token !== token) throw new Error("Pi Atelier session is not published");
				return getSidebarSnapshot(current);
			},
			getConfig: () => (isPublished() ? runtime.getConfig() : config),
			colorEnabled: isColorEnabled(),
			shouldAnimate: () => enabled && isPublished() && runActivity.isRunning(),
			onWarning: (message) => ctx.ui.notify(message, "warning"),
			onError: (error) => ctx.ui.notify(`Pi Atelier sidebar failed: ${errorMessage(error)}`, "error"),
		});
		cleanup.push(() => sidebar.dispose());
		const overlayCancellations = new Set<() => void>();
		return {
			ctx,
			sessionManager: ctx.sessionManager,
			token,
			runtime,
			sidebar,
			panelRegistry,
			runActivity,
			completionNotifier,
			retiredState: createInertAtelierState(autoCompact),
			retiredConfig: structuredClone(config),
			retiredCwd: ctx.cwd,
			overlayCancellations,
			overlayLifetime: createOverlayLifetime(token, overlayCancellations),
			footerDisposer: undefined,
			footerGeneration: 0,
			unsubscribeAskUserBlocked: undefined,
			askUserBlocked: false,
			inputRequestSequence: 0,
			todos: enabled ? reconstructTodos(ctx) : [],
			requestFooterRender: noopRender,
			extensionStatuses: [],
		};
	}

	/** rpiv's ask-user tool blocks on the user; notify once per blocking request. */
	function subscribeAskUserBlocked(session: ActiveSession): () => void {
		return pi.events.on("rpiv:ask-user:blocked", (data) => {
			const current = activeSession;
			if (current?.token !== session.token || !isRecord(data) || !("active" in data)) return;
			if (data.active === false) {
				current.askUserBlocked = false;
				return;
			}
			if (data.active !== true || current.askUserBlocked) return;
			current.askUserBlocked = true;
			current.inputRequestSequence += 1;
			if (!enabled || !current.runtime.getConfig().completionNotifications) return;
			current.completionNotifier.inputRequested(
				`blocked-${current.inputRequestSequence}`,
				completionNotification(current),
			);
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") {
			startLifecycleGeneration(undefined);
			if (activeSession) teardownActiveSession();
			return;
		}
		const token = startLifecycleGeneration(ctx.sessionManager);
		const isFresh = (): boolean => token === lifecycleToken;
		// Resources of a session that never became active; released if initialization fails.
		const candidateCleanup: (() => void)[] = [];
		let published: ActiveSession | undefined;
		try {
			const loaded = await loadAtelierConfig({
				userPath: userConfigPath(),
				projectPath: join(ctx.cwd, CONFIG_DIR_NAME, "pi-atelier.json"),
				projectTrusted: ctx.isProjectTrusted(),
			});
			// The only await: a newer lifecycle may have started meanwhile.
			if (!isFresh()) return;
			for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
			const session = createSession(ctx, token, loaded.config, loaded, candidateCleanup);
			candidateCleanup.length = 0;
			candidateCleanup.push(() => disposeSession(session));
			session.unsubscribeAskUserBlocked = subscribeAskUserBlocked(session);

			const previousSession = activeSession;
			activeSession = session;
			published = session;
			if (previousSession) disposeSession(previousSession, { clearFooter: true });
			registerCustomShortcut(ctx, loaded.config.shortcut);
			session.sidebar.setMode("manual");
			if (enabled) {
				installFooter(session);
				if (loaded.config.showSidebarOnStartup) session.sidebar.show();
			}
			void session.runtime.flushWorkspacePulseRefresh();
		} catch (error) {
			if (!published) {
				// This session never became active, so only its own resources are released.
				for (const cleanup of candidateCleanup.reverse()) attempt(cleanup);
			} else if (activeSession === published) {
				teardownActiveSession(ctx);
			} else return;
			if (isFresh()) ctx.ui.notify(`Pi Atelier could not start: ${errorMessage(error)}`, "error");
		} finally {
			if (lifecycleToken === token) initializingSessionManager = undefined;
		}
	});

	// Run lifecycle events are tracked while disabled so re-enabling mid-run shows an
	// accurate phase; content (tool arguments, response estimates, todos) is not.
	pi.on("session_tree", (_event, ctx) => {
		const current = getActiveSession(ctx);
		if (!enabled || !current) return;
		current.todos = reconstructTodos(ctx);
		void current.runtime.refreshSubagentUsage();
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
		current.runtime.scheduleWorkspacePulseRefresh();
	});
	pi.on("before_provider_request", (_event, ctx) => {
		if (enabled) getActiveSession(ctx)?.runActivity.startResponse();
	});
	pi.on("message_update", (event, ctx) => {
		const current = getActiveSession(ctx);
		if (!enabled || !current) return;
		const estimatedOutputTokens = estimateTokens(event.message);
		if (estimatedOutputTokens > 0) current.runActivity.updateResponseEstimate(estimatedOutputTokens);
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "custom" && event.message.customType === "subagent-slash-result") {
			getActiveSession(ctx)?.runtime.observeSubagentMetadata(event.message.details);
		}
		if (event.message.role !== "assistant") return;
		getActiveSession(ctx)?.runActivity.finishResponse(event.message.usage.output);
	});
	pi.on("tool_execution_start", (event, ctx) => {
		getActiveSession(ctx)?.runActivity.startTool(enabled ? event : { ...event, args: undefined });
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		current.runActivity.finishTool(event);
		current.runtime.scheduleWorkspacePulseRefresh();
	});
	pi.on("tool_result", (event, ctx) => {
		if (!enabled || event.toolName !== "todo") return;
		const current = getActiveSession(ctx);
		if (!current || event.isError) return;
		const todos = todosFromDetails(event.details);
		if (!todos) return;
		// Keep state updates independent from whether the TODO panel is currently presented.
		current.todos = todos;
		const sidebarVisible = current.sidebar.isVisible();
		current.sidebar.requestRender();
		const todoPanelVisible = current.runtime
			.getConfig()
			.sidebarPanelLayout.some((entry) => entry.id === "todos" && entry.visible);
		// The sidebar shows the list, so collapse the tool output to a summary.
		if (!todoPanelVisible || !sidebarVisible || todos.length === 0) return;
		const done = todos.filter((todo) => todo.status === "completed").length;
		return { content: [{ type: "text", text: `${done}/${todos.length} done · see sidebar` }] };
	});
	pi.on("agent_settled", (_event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current || !ctx.isIdle()) return;
		current.runActivity.settle();
		current.runtime.setActivity("ready");
		if (!enabled) return;
		current.sidebar.requestRender();
		if (current.runtime.getConfig().completionNotifications) {
			current.completionNotifier.turnSettled(completionNotification(current));
		}
	});
	pi.on("turn_end", async (_event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		current.runtime.refreshUsage();
		await current.runtime.flushWorkspacePulseRefresh();
	});
	const refreshUsage = (_event: unknown, ctx: ExtensionContext): void =>
		getActiveSession(ctx)?.runtime.refreshUsage();
	pi.on("model_select", refreshUsage);
	pi.on("thinking_level_select", refreshUsage);
	pi.on("session_compact", refreshUsage);
	pi.on("session_info_changed", refreshUsage);
	pi.on("session_shutdown", (_event, ctx) => {
		const current = getActiveSession(ctx);
		const initializing = initializingSessionManager;
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

import { basename, join } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	estimateTokens,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { isViewportTUI, matchesKey, type KeyId } from "@earendil-works/pi-tui";
import {
	type CompletionNotification,
	type CompletionNotifier,
	createCompletionNotifier,
	type SpawnNotificationProcess,
} from "../src/completion-notifier.js";
import { DEFAULT_CONFIG, loadConfig, saveUserConfigPatch } from "../src/config.js";
import { t } from "../src/i18n.js";
import { createRailBar, railBarLines, type RailBarComponent } from "../src/rail-bar.js";
import { AtelierEditor } from "../src/editor.js";
import { type AtelierFooterComponent, createFooterComponent } from "../src/footer.js";
import { createImageCompositorBinding } from "../src/image-compositor.js";
import { openAtelierControlCenter, openDisplaySettingsWorkspace, sidebarStatusLabel } from "../src/menu.js";
import type { OverlayLifetime } from "../src/overlay-lifecycle.js";
import type { ThemeLike } from "../src/palette.js";
import {
	createPrefillThrottle,
	createPrefillTracker,
	OPENAI_COMPLETIONS_API,
	type PrefillThrottle,
	type PrefillTracker,
} from "../src/prefill.js";
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
	isBuiltinSidebarPanelId,
	type SidebarPanelData,
	type SidebarPanelRegistry,
} from "../src/sidebar-panels.js";
import { AtelierRuntime, createInertAtelierState } from "../src/state.js";
import { isSectionExpanded, toggleSection } from "../src/rail-sections.js";
import { emptySubagentUsage } from "../src/subagent-usage.js";
import { openSubagentUsage } from "../src/subagent-usage-view.js";
import { errorMessage, isColorEnabled, isRecord } from "../src/text.js";
import { reconstructTodos, todosFromDetails } from "../src/todos.js";
import { clampTodoOffset, scrollTodoOffset, todoActionFromArgs } from "../src/todo-window.js";
import type { AtelierConfig, AtelierState, FooterState, NormalizedTodo } from "../src/types.js";

// Public sidebar contribution protocol for other extensions.
export type {
	SidebarPanelContribution,
	SidebarPanelDiscoveryEvent,
	SidebarPanelEvent,
	SidebarPanelEventTransport,
	SidebarPanelKeyValueRow,
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

/**
 * `provider_stream_event` only exists from Pi 0.99, while the pinned devDependency is older, so
 * registration goes through a narrow local shape. On a Pi that never emits the event the handler
 * simply stays inert. Pi emits it as `{ type, provider, api, model, data }`, where `data` is the
 * raw parsed stream chunk — for `openai-completions` that is the chunk object itself, carrying
 * `prompt_progress` when the request asked for it. Pi 0.99 also returns an unsubscribe from `on`,
 * which the pinned types do not declare.
 */
interface ProviderStreamEventLike {
	readonly api?: string;
	readonly data: unknown;
}

/** Start listening for provider stream chunks and return the way to stop. */
function registerProviderStreamHandler(
	pi: ExtensionAPI,
	handler: (event: ProviderStreamEventLike, ctx: ExtensionContext) => void,
): () => void {
	const capable = pi as ExtensionAPI & {
		on(
			event: "provider_stream_event",
			handler: (event: ProviderStreamEventLike, ctx: ExtensionContext) => void,
		): (() => void) | void;
	};
	const unsubscribe = capable.on("provider_stream_event", handler);
	return typeof unsubscribe === "function" ? unsubscribe : (): void => undefined;
}

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
	/** Live prefill progress for the current provider request, plus the render coalescing it needs. */
	readonly prefill: PrefillTracker;
	readonly prefillThrottle: PrefillThrottle;
	readonly completionNotifier: CompletionNotifier;
	readonly retiredState: AtelierState;
	readonly retiredConfig: AtelierConfig;
	readonly retiredCwd: string;
	readonly overlayCancellations: Set<() => void>;
	readonly overlayLifetime: OverlayLifetime;
	footerDisposer: (() => void) | undefined;
	footerGeneration: number;
	/** Whether Atelier owns Pi's footer and composer; when false, they belong to Pi or another extension. */
	footerInstalled: boolean;
	unsubscribeAskUserBlocked: (() => void) | undefined;
	askUserBlocked: boolean;
	inputRequestSequence: number;
	todos: NormalizedTodo[];
	/** Whether the latest Turn ended in a provider error that the user did not abort. */
	providerFailed: boolean;
	todoOffset: number;
	requestFooterRender: () => void;
	extensionStatuses: readonly string[];
	railBar: RailBarComponent | undefined;
}

interface LifecycleToken {
	readonly id: number;
}

const NOT_ACTIVE = "Pi Atelier is not active in this session";
const RESIZE_SHORTCUT = "ctrl+shift+r";

/** Pi matches modifiers in any order, so `shift+ctrl+r` and `ctrl+shift+r` are the same key. */
const keyIdentity = (key: string): string => {
	const parts = key.toLowerCase().split("+");
	const last = parts.pop() ?? "";
	return [...parts.sort(), last].join("+");
};

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
	/** Set while a prefill-annotated request is in flight; `on` gives the unsubscribe on Pi 0.99. */
	let prefillStreamOff: (() => void) | undefined;
	let customShortcutsRegistered = false;
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
		const { ctx, panelRegistry, prefill, runActivity, runtime } = targetSession;
		const sessionName = ctx.sessionManager.getSessionName();
		const sessionFile = ctx.sessionManager.getSessionFile();
		const activeTools = pi.getActiveTools();
		const prefillProgress = prefill.getSnapshot();
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
			...(prefillProgress ? { prefill: prefillProgress } : {}),
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
		const installed = session.footerInstalled;
		session.footerInstalled = false;
		// Pi may retain the old footer when removal fails; it is disposed below regardless.
		// Never reset a footer or composer that Atelier does not own.
		if (restoreHostUi && installed) resetHostUi(session.ctx);
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
			ctx.ui.notify(
				`${t(runtime.getConfig().language, "toolList")} ${t(runtime.getConfig().language, next ? "expanded" : "collapsed")}`,
				"info",
			);
		} catch (error) {
			if (activeSession !== targetSession) return;
			ctx.ui.notify(
				`${t(runtime.getConfig().language, "toolListChangedNotSaved")}: ${errorMessage(error)}`,
				"warning",
			);
		}
	}

	/** A confirmed resize becomes the starting width for future sessions. */
	async function saveSidebarWidth(
		ctx: ExtensionContext,
		width: number,
		targetSession: ActiveSession,
	): Promise<void> {
		targetSession.runtime.setConfig({ ...targetSession.runtime.getConfig(), sidebarWidth: width });
		try {
			await lifecycleGuardedSavePatch(targetSession)(userConfigPath(), { sidebarWidth: width });
			if (activeSession !== targetSession) return;
			ctx.ui.notify(`Sidebar width saved: ${width} columns`, "info");
		} catch (error) {
			if (activeSession !== targetSession) return;
			ctx.ui.notify(`Sidebar width could not be saved: ${errorMessage(error)}`, "warning");
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

	/** Install or remove the Atelier footer to match the `showFooter` preference. */
	function syncFooter(targetSession: ActiveSession): void {
		if (!enabled || activeSession !== targetSession) return;
		const wanted = targetSession.runtime.getConfig().showFooter;
		if (wanted === targetSession.footerInstalled) return;
		if (wanted) installFooter(targetSession);
		else clearFooter(targetSession, true);
	}

	async function openUsage(ctx: ExtensionContext, expected?: ActiveSession): Promise<void> {
		const current = getActiveSession(ctx);
		if (ctx.mode !== "tui" || !current || !enabled || (expected && current !== expected)) {
			ctx.ui.notify(t(current?.runtime.getConfig().language ?? "en", "usageNeedsTui"), "info");
			return;
		}
		if (!ctx.isProjectTrusted()) {
			ctx.ui.notify(t(current.runtime.getConfig().language, "usageNeedsTrust"), "info");
			return;
		}
		await current.runtime.refreshSubagentUsage();
		if (activeSession !== current || !enabled || !ctx.isProjectTrusted()) return;
		await openSubagentUsage(
			ctx,
			current.runtime.getState().subagentUsage ?? emptySubagentUsage(),
			current.runtime.getConfig().currencyDecimals,
			current.runtime.getConfig().language,
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
					if (!enabled || !isCurrent()) return;
					if (runtime.getConfig().panelPlacement === "top") sidebar.hide();
					else sidebar.toggle();
				},
				isToolListExpanded: () => isCurrent() && runtime.getConfig().showSidebarToolNames,
				toggleToolList: async () => {
					if (isCurrent()) await setSidebarToolNames(ctx, undefined, current);
				},
				getSidebarPanelSettings: () => (isCurrent() ? getSidebarPanelSettings(current) : []),
			},
			() => requestAllRenders(current),
			lifecycleGuardedSavePatch(current),
			{
				lifetime: current.overlayLifetime,
				openUsage: () => openUsage(ctx, current),
				syncFooter: () => syncFooter(current),
			},
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
		targetSession.footerInstalled = true;
		let editor: AtelierEditor | undefined;
		let footer: AtelierFooterComponent | undefined;
		let headerTheme: ThemeLike | undefined;
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
			headerTheme = theme;
			const footerRequestRender = (): void => {
				if (getCurrentSession()) tui.requestRender();
			};
			const current = getCurrentSession();
			if (current) {
				current.requestFooterRender = footerRequestRender;
				current.railBar = createRailBar(
					(width, rows) => {
						const session = getCurrentSession();
						if (!session) return [];
						const config = session.runtime.getConfig();
						return railBarLines(
							getSidebarSnapshot(session),
							config,
							theme,
							width,
							rows,
							config.sectionExpansion,
						);
					},
					(id) => toggleRailSection(ctx, id),
				);
				current.sidebar.setTopBar(
					current.runtime.getConfig().panelPlacement === "top" ? current.railBar : undefined,
				);
			}
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
				getRows: () => tui.terminal?.rows ?? Number.POSITIVE_INFINITY,
				getWidth: () => tui.terminal?.columns || undefined,
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
				next.renderAbove = (width) => {
					const current = getCurrentSession();
					if (!current || !headerTheme || isViewportTUI(tui)) return [];
					const config = current.runtime.getConfig();
					if (config.panelPlacement !== "top" || !current.railBar) return [];
					current.railBar.setRows(tui.terminal.rows);
					return current.railBar.render(width);
				};
				next.renderStatusLine = (width) => {
					// Fullscreen Pi crops the top of a tall draft after editor rendering.
					// Keep essential state in the bottom footer on short terminals.
					const current = getCurrentSession();
					if (!current || !footer || !headerTheme) {
						headerRendered = false;
						return "";
					}
					const line =
						tui.terminal.columns >= 76 && tui.terminal.rows >= 20 ? footer.renderHeader(width) : "";
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
	const usage = (ctx: ExtensionContext, syntax: string): void => {
		const language = activeSession?.runtime.getConfig().language ?? "en";
		ctx.ui.notify(`${t(language, "usageCommand")} ${syntax}`, "warning");
	};
	const isOnOff = (value: string | undefined): boolean =>
		value === undefined || value === "on" || value === "off";
	const setPanelPlacement = (ctx: ExtensionContext, placement: "right" | "top"): void => {
		const current = requireActiveSession(ctx);
		if (!current) return;
		current.runtime.replaceSessionDisplayOverride({
			...current.runtime.getSessionDisplayOverride(),
			sourcePanelPlacement: placement,
		});
		current.sidebar.setTopBar(placement === "top" ? current.railBar : undefined);
		if (enabled && placement === "right") current.sidebar.show();
		else current.sidebar.hide();
		requestAllRenders(current);
		ctx.ui.notify(
			`${t(current.runtime.getConfig().language, "placement")}: ${t(current.runtime.getConfig().language, placement)}`,
			"info",
		);
	};
	const toggleRailSection = (ctx: ExtensionContext, id: string): void => {
		const current = requireActiveSession(ctx);
		if (!current) return;
		if (!isBuiltinSidebarPanelId(id)) {
			usage(ctx, `section <${BUILTIN_SIDEBAR_PANEL_IDS.join("|")}>`);
			return;
		}
		const config = current.runtime.getConfig();
		const sectionExpansion = toggleSection(config.sectionExpansion, id);
		current.runtime.replaceSessionDisplayOverride({
			...current.runtime.getSessionDisplayOverride(),
			sectionExpansion,
		});
		requestAllRenders(current);
		ctx.ui.notify(
			`${t(config.language, id)} ${t(config.language, isSectionExpanded(sectionExpansion, id) ? "expanded" : "collapsed")}`,
			"info",
		);
	};

	const visibleTodoCount = (current: ActiveSession): number =>
		current.runActivity.getSnapshot().phase === "running"
			? current.todos.filter((todo) => todo.status === "in_progress").length
			: current.todos.length;
	const scrollTodos = (
		current: ActiveSession,
		action: "top" | "next" | "prev" | "page-up" | "page-down",
	): void => {
		current.todoOffset = scrollTodoOffset(current.todoOffset, visibleTodoCount(current), action);
		current.sidebar.requestRender();
	};
	const commands = new Map<string, CommandHandler>(
		Object.entries({
			placement: (ctx, [placement, ...extra]) => {
				if ((placement !== "right" && placement !== "top") || extra.length > 0) {
					usage(ctx, "placement right|top");
					return;
				}
				setPanelPlacement(ctx, placement);
			},
			section: (ctx, [id, ...extra]) => {
				if (!id || extra.length > 0) {
					usage(ctx, `section <${BUILTIN_SIDEBAR_PANEL_IDS.join("|")}>`);
					return;
				}
				toggleRailSection(ctx, id);
			},
			todos: (ctx, args) => {
				const current = requireActiveSession(ctx);
				if (!current) return;
				const action = todoActionFromArgs(args);
				if (action === null) {
					usage(ctx, "todos [top|next|prev|page-up|page-down]");
					return;
				}
				scrollTodos(current, action);
				ctx.ui.notify(
					`${t(current.runtime.getConfig().language, "todosLabel")} ${current.todos.length === 0 ? 0 : current.todoOffset + 1}/${current.todos.length}`,
					"info",
				);
			},
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
					ctx.ui.notify(t(activeSession?.runtime.getConfig().language ?? "en", "sidebarNeedsTui"), "warning");
					return;
				}
				const current = requireActiveSession(ctx);
				if (!current) return;
				if (current.runtime.getConfig().panelPlacement === "top") {
					ctx.ui.notify(t(current.runtime.getConfig().language, "sidebarHiddenPlacement"), "info");
					return;
				}
				if (!enabled && sidebarAction !== "off") {
					ctx.ui.notify(t(current.runtime.getConfig().language, "enableBeforeShowing"), "info");
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
				ctx.ui.notify(
					`${t(current.runtime.getConfig().language, "sidebar")}: ${sidebarStatusLabel(current.sidebar.getStatus(), true, current.runtime.getConfig().language)}`,
					"info",
				);
			},
			disable: (ctx) => {
				const current = requireActiveSession(ctx);
				if (!current) return;
				enabled = false;
				current.runtime.setEnabled(false);
				current.runActivity.resetResponse();
				current.completionNotifier.reset();
				current.todos = [];
				current.todoOffset = 0;
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
					current.todoOffset = 0;
					current.runtime.setEnabled(true);
					syncFooter(current);
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

	/** Configured shortcuts are read from the first loaded config; Pi cannot unregister shortcuts. */
	function registerCustomShortcuts(ctx: ExtensionContext, config: AtelierConfig): void {
		if (customShortcutsRegistered) return;
		customShortcutsRegistered = true;
		const { shortcut, toggleShortcut } = config;
		if (shortcut.toLowerCase() !== DEFAULT_CONFIG.shortcut) {
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
		if (!toggleShortcut) return;
		const reservedKeys = [DEFAULT_CONFIG.shortcut, shortcut, RESIZE_SHORTCUT].map(keyIdentity);
		if (reservedKeys.includes(keyIdentity(toggleShortcut))) {
			ctx.ui.notify(`toggleShortcut "${toggleShortcut}" is already an Atelier shortcut`, "warning");
			return;
		}
		try {
			pi.registerShortcut(toggleShortcut as KeyId, {
				description: "Toggle Pi Atelier sidebar",
				handler: async (shortcutContext) => commands.get("sidebar")?.(shortcutContext, []),
			});
		} catch {
			ctx.ui.notify(`Cannot register Atelier toggleShortcut "${toggleShortcut}"`, "warning");
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
		const prefill = createPrefillTracker({ providers: config.prefillProviders });
		const prefillThrottle = createPrefillThrottle({
			requestRender: () => {
				const current = activeSession;
				if (current?.token === token) current.sidebar.requestRender();
			},
			schedule: (delayMs, run) => {
				const timer = setTimeout(run, delayMs);
				return () => clearTimeout(timer);
			},
		});
		cleanup.push(() => prefillThrottle.cancel());
		cleanup.push(() => stopListeningForPrefillChunks());
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
			getNerdFont: () => runtime.getConfig().nerdFont,
			getLanguage: () => runtime.getConfig().language,
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
			getTodoOffset: () => (activeSession?.token === token ? activeSession.todoOffset : 0),
			handleTodoInput: (data) => {
				const current = getActiveSession(ctx);
				if (
					!current ||
					!current.sidebar.isVisible() ||
					!current.runtime.getConfig().sidebarPanelLayout.some(({ id, visible }) => id === "todos" && visible)
				)
					return false;
				const action = (
					[
						["ctrl+p", "prev"],
						["ctrl+n", "next"],
						["ctrl+u", "page-up"],
						["ctrl+d", "page-down"],
					] as const
				).find(([key]) => matchesKey(data, key as KeyId))?.[1];
				if (!action) return false;
				scrollTodos(current, action);
				return true;
			},
			getSnapshot: () => {
				const current = activeSession;
				if (!current || current.token !== token) throw new Error("Pi Atelier session is not published");
				return getSidebarSnapshot(current);
			},
			getConfig: () => (isPublished() ? runtime.getConfig() : config),
			colorEnabled: isColorEnabled(),
			shouldAnimate: () => enabled && isPublished() && runActivity.isRunning(),
			initialWidth: config.sidebarWidth,
			onResizeCommit: (width) => {
				const current = activeSession;
				if (current?.token === token) void saveSidebarWidth(ctx, width, current);
			},
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
			prefill,
			prefillThrottle,
			completionNotifier,
			retiredState: createInertAtelierState(autoCompact),
			retiredConfig: structuredClone(config),
			retiredCwd: ctx.cwd,
			overlayCancellations,
			overlayLifetime: createOverlayLifetime(token, overlayCancellations),
			footerDisposer: undefined,
			footerGeneration: 0,
			footerInstalled: false,
			unsubscribeAskUserBlocked: undefined,
			askUserBlocked: false,
			inputRequestSequence: 0,
			todos: enabled ? reconstructTodos(ctx) : [],
			providerFailed: false,
			todoOffset: 0,
			requestFooterRender: noopRender,
			extensionStatuses: [],
			railBar: undefined,
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
			registerCustomShortcuts(ctx, loaded.config);
			session.sidebar.setMode("manual");
			if (enabled) {
				syncFooter(session);
				if (loaded.config.showSidebarOnStartup && loaded.config.panelPlacement === "right")
					session.sidebar.show();
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
		current.todoOffset = clampTodoOffset(current.todoOffset, visibleTodoCount(current));
		void current.runtime.refreshSubagentUsage();
		requestAllRenders(current);
	});
	pi.on("agent_start", (_event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		current.runActivity.startRun();
		current.completionNotifier.runStarted();
		current.providerFailed = false;
		current.runtime.setActivity("working");
	});
	pi.on("turn_start", (event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		current.runActivity.startTurn(event.turnIndex);
		current.completionNotifier.runStarted();
		current.runtime.scheduleWorkspacePulseRefresh();
	});
	/** Pi awaits a per-chunk emit for every registered handler, so the chunk listener exists only
	 *  while a request that asked for progress is in flight. */
	function listenForPrefillChunks(): void {
		if (prefillStreamOff) return;
		prefillStreamOff = registerProviderStreamHandler(pi, (event, ctx) => {
			const current = getActiveSession(ctx);
			if (!enabled || !current || event.api !== OPENAI_COMPLETIONS_API) return;
			const wasShowing = current.prefill.getSnapshot() !== undefined;
			if (current.prefill.noteChunk(event.data)) {
				current.prefillThrottle.note();
				return;
			}
			// Generation started: the transient panel is gone, so redraw once to drop it.
			if (wasShowing) {
				current.prefillThrottle.cancel();
				current.sidebar.requestRender();
			}
		});
	}

	function stopListeningForPrefillChunks(): void {
		prefillStreamOff?.();
		prefillStreamOff = undefined;
	}

	pi.on("before_provider_request", (event, ctx) => {
		const current = getActiveSession(ctx);
		if (!enabled || !current) return;
		current.runActivity.startResponse();
		const config = current.runtime.getConfig();
		if (!config.prefillEnabled || config.prefillProviders.length === 0) {
			stopListeningForPrefillChunks();
			return;
		}
		if (!current.prefill.noteRequest(ctx.model, event.payload)) {
			stopListeningForPrefillChunks();
			return;
		}
		// The provider is allow-listed and streams: ask it to report prefill progress.
		listenForPrefillChunks();
		return { ...(event.payload as Record<string, unknown>), return_progress: true };
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
		// Leave the result content untouched: it is what the model reads, including task ids.
		current.todos = todos;
		current.todoOffset = clampTodoOffset(current.todoOffset, visibleTodoCount(current));
		current.sidebar.requestRender();
	});
	pi.on("agent_settled", (_event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current || !ctx.isIdle()) return;
		current.runActivity.settle();
		current.prefill.clear();
		current.prefillThrottle.cancel();
		current.runtime.setActivity(current.providerFailed ? "error" : "ready");
		if (!enabled) return;
		current.sidebar.requestRender();
		if (current.runtime.getConfig().completionNotifications) {
			current.completionNotifier.turnSettled(completionNotification(current));
		}
	});
	pi.on("turn_end", async (event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		// Pi can record a user abort as `stopReason: "error"`, so the run signal decides.
		current.providerFailed =
			event.message?.role === "assistant" && event.message.stopReason === "error" && !ctx.signal?.aborted;
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

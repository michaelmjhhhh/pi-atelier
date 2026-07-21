import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { loadConfig } from "../src/config.js";
import { createFooterComponent, type ThemeLike } from "../src/footer.js";
import { openAtelierMenu } from "../src/menu.js";
import { buildSidebarSnapshot, openAtelierSidebar, type SidebarSnapshot } from "../src/sidebar.js";
import { AtelierRuntime } from "../src/state.js";
import type { AtelierState } from "../src/types.js";

export default function atelierExtension(pi: ExtensionAPI): void {
	let runtime: AtelierRuntime | undefined;
	let currentContext: ExtensionContext | undefined;
	let requestRender: () => void = () => undefined;
	let sidebarRequestRender: () => void = () => undefined;
	let sidebarOpen = false;
	let extensionStatuses: readonly string[] = [];
	let enabled = true;
	let shortcutRegistered = false;

	const requestAllRenders = (): void => {
		requestRender();
		sidebarRequestRender();
	};

	function updateExtensionStatuses(next: readonly string[]): void {
		if (
			next.length === extensionStatuses.length &&
			next.every((status, index) => status === extensionStatuses[index])
		) {
			return;
		}
		extensionStatuses = [...next];
		sidebarRequestRender();
	}

	function getSidebarSnapshot(ctx: ExtensionContext): SidebarSnapshot {
		if (!runtime) throw new Error("Pi Atelier runtime unavailable");
		const sessionName = ctx.sessionManager.getSessionName();
		const sessionFile = ctx.sessionManager.getSessionFile();
		return buildSidebarSnapshot({
			state: runtime.getState(),
			cwd: ctx.cwd,
			...(sessionName ? { sessionName } : {}),
			...(sessionFile ? { sessionFile } : {}),
			branchEntryCount: ctx.sessionManager.getBranch().length,
			activeToolCount: pi.getActiveTools().length,
			availableToolCount: pi.getAllTools().length,
			extensionStatuses,
		});
	}

	async function openMenu(ctx: ExtensionContext): Promise<void> {
		if (!runtime) {
			ctx.ui.notify("Pi Atelier is not active in this session", "warning");
			return;
		}
		await openAtelierMenu(pi, ctx, runtime, join(getAgentDir(), "pi-atelier.json"));
	}

	function installFooter(ctx: ExtensionContext): void {
		if (!runtime || ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			return createFooterComponent({
				getState: (): AtelierState => {
					const state = runtime?.getState();
					if (!state) throw new Error("Pi Atelier runtime unavailable");
					const branch = footerData.getGitBranch();
					updateExtensionStatuses(Array.from(footerData.getExtensionStatuses().values()));
					return {
						...state,
						...(branch ? { branch } : {}),
						extensionStatuses,
					};
				},
				getConfig: () =>
					runtime?.getConfig() ??
					(() => {
						throw new Error("Pi Atelier config unavailable");
					})(),
				colorEnabled: !("NO_COLOR" in process.env),
				requestRender,
				onBranchChange: (callback) =>
					footerData.onBranchChange(() => {
						void runtime?.refreshGitState();
						callback();
					}),
				theme: theme as unknown as ThemeLike,
			});
		});
	}

	pi.registerCommand("atelier", {
		description: "Open or control the Pi Atelier status menu",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "sidebar") {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("Pi Atelier sidebar requires TUI mode", "warning");
					return;
				}
				if (!runtime) {
					ctx.ui.notify("Pi Atelier is not active in this session", "warning");
					return;
				}
				if (sidebarOpen) {
					ctx.ui.notify("Pi Atelier sidebar is already open", "info");
					return;
				}
				sidebarOpen = true;
				try {
					await openAtelierSidebar({
						ctx,
						getSnapshot: () => getSidebarSnapshot(ctx),
						getConfig: () => {
							if (!runtime) throw new Error("Pi Atelier runtime unavailable");
							return runtime.getConfig();
						},
						onRequestRender: (request) => {
							sidebarRequestRender = request;
						},
						onClosed: () => {
							sidebarRequestRender = () => undefined;
						},
					});
				} finally {
					sidebarOpen = false;
					sidebarRequestRender = () => undefined;
				}
				return;
			}
			if (action === "disable") {
				enabled = false;
				updateExtensionStatuses([]);
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Pi Atelier disabled", "info");
				return;
			}
			if (action === "enable") {
				enabled = true;
				installFooter(ctx);
				ctx.ui.notify("Pi Atelier enabled", "info");
				return;
			}
			await openMenu(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		currentContext = ctx;
		updateExtensionStatuses([]);
		try {
			const userPath = join(getAgentDir(), "pi-atelier.json");
			const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "pi-atelier.json");
			const loaded = await loadConfig({
				userPath,
				projectPath,
				projectTrusted: ctx.isProjectTrusted(),
			});
			for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
			let autoCompact: boolean | null = null;
			try {
				autoCompact = SettingsManager.create(
					ctx.isProjectTrusted() ? ctx.cwd : getAgentDir(),
				).getCompactionSettings().enabled;
			} catch {
				ctx.ui.notify("Could not read Pi compaction settings; compaction mode is unavailable", "warning");
			}
			runtime?.dispose();
			runtime = new AtelierRuntime({
				pi,
				ctx,
				config: loaded.config,
				autoCompact,
				requestRender: requestAllRenders,
			});
			await runtime.refreshGitState();
			if (!shortcutRegistered) {
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
					ctx.ui.notify(`Invalid Atelier shortcut "${loaded.config.shortcut}"; using alt+a`, "warning");
				}
				shortcutRegistered = true;
			}
			if (enabled) installFooter(ctx);
		} catch (error) {
			runtime?.dispose();
			runtime = undefined;
			updateExtensionStatuses([]);
			ctx.ui.setFooter(undefined);
			ctx.ui.notify(
				`Pi Atelier could not start: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	});

	pi.on("agent_start", () => runtime?.setActivity("working"));
	pi.on("agent_settled", () => runtime?.setActivity("ready"));
	pi.on("turn_end", async () => {
		runtime?.refreshUsage();
		await runtime?.refreshGitState();
	});
	pi.on("model_select", () => runtime?.refreshUsage());
	pi.on("thinking_level_select", () => runtime?.refreshUsage());
	pi.on("session_compact", () => runtime?.refreshUsage());
	pi.on("session_info_changed", () => runtime?.refreshUsage());
	pi.on("session_shutdown", () => {
		runtime?.dispose();
		runtime = undefined;
		currentContext?.ui.setFooter(undefined);
		currentContext = undefined;
		requestRender = () => undefined;
		sidebarOpen = false;
		sidebarRequestRender = () => undefined;
		extensionStatuses = [];
	});
}

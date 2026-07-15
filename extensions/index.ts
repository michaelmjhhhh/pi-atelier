import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { loadConfig } from "../src/config.js";
import { createFooterComponent, type ThemeLike } from "../src/footer.js";
import { AtelierRuntime } from "../src/state.js";
import type { AtelierState } from "../src/types.js";

export default function atelierExtension(pi: ExtensionAPI): void {
	let runtime: AtelierRuntime | undefined;
	let currentContext: ExtensionContext | undefined;
	let requestRender: () => void = () => undefined;
	let enabled = true;
	let shortcutRegistered = false;

	function installFooter(ctx: ExtensionContext): void {
		if (!runtime || ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			return createFooterComponent({
				getState: (): AtelierState => {
					const state = runtime?.getState();
					if (!state) throw new Error("Pi Atelier runtime unavailable");
					const branch = footerData.getGitBranch();
					return {
						...state,
						...(branch ? { branch } : {}),
						extensionStatuses: Array.from(footerData.getExtensionStatuses().values()),
					};
				},
				getConfig: () =>
					runtime?.getConfig() ??
					(() => {
						throw new Error("Pi Atelier config unavailable");
					})(),
				requestRender,
				onBranchChange: (callback) => footerData.onBranchChange(callback),
				theme: theme as unknown as ThemeLike,
			});
		});
	}

	pi.registerCommand("atelier", {
		description: "Open or control the Pi Atelier status menu",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "disable") {
				enabled = false;
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
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Pi Atelier menu requires TUI mode", "warning");
				return;
			}
			ctx.ui.notify("Pi Atelier menu is loading", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		currentContext = ctx;
		try {
			const userPath = join(getAgentDir(), "pi-atelier.json");
			const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "pi-atelier.json");
			const loaded = await loadConfig({
				userPath,
				projectPath,
				projectTrusted: ctx.isProjectTrusted(),
			});
			for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
			let autoCompact = true;
			try {
				autoCompact = SettingsManager.create(
					ctx.isProjectTrusted() ? ctx.cwd : getAgentDir(),
				).getCompactionSettings().enabled;
			} catch {
				ctx.ui.notify("Could not read Pi compaction settings; assuming automatic compaction", "warning");
			}
			runtime?.dispose();
			runtime = new AtelierRuntime({
				pi,
				ctx,
				config: loaded.config,
				autoCompact,
				requestRender: () => requestRender(),
			});
			await runtime.refreshGitDirty();
			if (!shortcutRegistered) {
				try {
					pi.registerShortcut(loaded.config.shortcut as KeyId, {
						description: "Open Pi Atelier",
						handler: async (shortcutContext) => {
							await pi.getCommands().find((command) => command.name === "atelier");
							shortcutContext.ui.notify("Use /atelier to open the menu", "info");
						},
					});
				} catch {
					pi.registerShortcut("alt+a" as KeyId, {
						description: "Open Pi Atelier",
						handler: async (shortcutContext) =>
							shortcutContext.ui.notify("Use /atelier to open the menu", "info"),
					});
					ctx.ui.notify(`Invalid Atelier shortcut "${loaded.config.shortcut}"; using alt+a`, "warning");
				}
				shortcutRegistered = true;
			}
			if (enabled) installFooter(ctx);
		} catch (error) {
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
		await runtime?.refreshGitDirty();
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
	});
}

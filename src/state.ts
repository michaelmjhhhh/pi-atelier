import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectWorkingPhrase } from "./activity.js";
import { resolveDisplayLayers } from "./config.js";
import { aggregateMetrics, type UsageMessage } from "./metrics.js";
import type {
	ActivityState,
	AtelierConfig,
	AtelierState,
	DisplayLayerState,
	DisplayPatch,
	DisplayProvenance,
	DisplaySettings,
	SessionDisplayOverride,
} from "./types.js";
import {
	inspectWorkspacePulse,
	type WorkspacePulseData,
	type WorkspacePulseInspection,
} from "./workspace-pulse.js";

const WORKSPACE_REFRESH_DEBOUNCE_MS = 250;
const SESSION_DISPLAY_OVERRIDE_KEYS = [
	"preset",
	"density",
	"segmentLayout",
	"segments",
	"ornament",
	"showExtensionStatuses",
] as const;

export interface RuntimeDependencies {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	config: AtelierConfig;
	displayLayers?: DisplayLayerState;
	displayProvenance?: DisplayProvenance;
	autoCompact: boolean | null;
	random?: () => number;
	requestRender(): void;
	inspectWorkspace?(): Promise<WorkspacePulseInspection>;
}

export class AtelierRuntime {
	readonly #pi: ExtensionAPI;
	readonly #ctx: ExtensionContext;
	readonly #autoCompact: boolean | null;
	readonly #random: () => number;
	readonly #requestRender: () => void;
	readonly #inspectWorkspace: () => Promise<WorkspacePulseInspection>;
	#config: AtelierConfig;
	#displayLayers: DisplayLayerState;
	#displayProvenance: DisplayProvenance;
	#disposed = false;
	#workspaceRefreshGeneration = 0;
	#workspaceRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	#lastWorkspaceData: WorkspacePulseData | undefined;
	#state: AtelierState;

	constructor(dependencies: RuntimeDependencies) {
		this.#pi = dependencies.pi;
		this.#ctx = dependencies.ctx;
		this.#config = dependencies.config;
		this.#displayLayers = dependencies.displayLayers ?? {};
		this.#displayProvenance =
			dependencies.displayProvenance ?? resolveDisplayLayers(this.#displayLayers).provenance;
		this.#autoCompact = dependencies.autoCompact;
		this.#random = dependencies.random ?? Math.random;
		this.#requestRender = dependencies.requestRender;
		this.#inspectWorkspace =
			dependencies.inspectWorkspace ??
			(() => inspectWorkspacePulse({ exec: this.#pi.exec.bind(this.#pi), cwd: this.#ctx.cwd }));
		this.#state = this.#inertState(this.#ctx.getContextUsage());
		this.refreshUsage();
	}

	/** State with no branch, workspace data, or usage history; context is included only when explicit. */
	#inertState(context: ReturnType<ExtensionContext["getContextUsage"]> = undefined): AtelierState {
		return {
			activity: "ready",
			dirty: false,
			workspacePulse: { status: "inspecting" },
			metrics: aggregateMetrics([], {
				subscription: false,
				autoCompact: this.#autoCompact,
				...(context ? { context } : {}),
			}),
			extensionStatuses: [],
		};
	}

	getState(): AtelierState {
		return this.#state;
	}

	getConfig(): AtelierConfig {
		return this.#config;
	}

	getSidebarPanelLayout(): AtelierConfig["sidebarPanelLayout"] {
		return this.#config.sidebarPanelLayout.map((entry) => ({ ...entry }));
	}

	getDisplaySettings(): DisplaySettings {
		return {
			preset: this.#config.preset,
			density: this.#config.density,
			segmentLayout: this.#config.segmentLayout.map((entry) => ({ ...entry })),
		};
	}

	getDisplayProvenance(): DisplayProvenance {
		return { ...this.#displayProvenance, visibility: { ...this.#displayProvenance.visibility } };
	}

	getSessionDisplayOverride(): SessionDisplayOverride | undefined {
		const session = this.#displayLayers.session;
		if (!session) return undefined;
		const result: SessionDisplayOverride = {};
		for (const key of SESSION_DISPLAY_OVERRIDE_KEYS) {
			if (!(key in session)) continue;
			const value = session[key];
			(result as Record<string, unknown>)[key] =
				key === "segmentLayout" && Array.isArray(value)
					? value.map((entry) => (typeof entry === "object" && entry !== null ? { ...entry } : entry))
					: Array.isArray(value)
						? [...value]
						: value;
		}
		return Object.keys(result).length > 0 ? result : undefined;
	}

	replaceSessionDisplayOverride(override: SessionDisplayOverride | undefined): void {
		const session = { ...this.#displayLayers.session };
		for (const key of SESSION_DISPLAY_OVERRIDE_KEYS) delete session[key];
		if (override) Object.assign(session, structuredClone(override));
		const { session: _oldSession, ...lower } = this.#displayLayers;
		this.#displayLayers = Object.keys(session).length > 0 ? { ...lower, session } : lower;
		this.#resolveDisplay();
	}

	clearSessionDisplayOverride(): void {
		this.replaceSessionDisplayOverride(undefined);
	}

	setSessionDisplayPatch(patch: DisplayPatch | undefined): void {
		if (!patch) {
			this.clearSessionDisplayOverride();
			return;
		}
		this.replaceSessionDisplayOverride({ ...this.getSessionDisplayOverride(), ...structuredClone(patch) });
	}

	/** Applies a successfully persisted User patch, then safely drops redundant Session fields. */
	applySavedUserDisplayPatch(patch: DisplayPatch, canonicalizeSession = true): void {
		this.#displayLayers = {
			...this.#displayLayers,
			user: { ...this.#displayLayers.user, ...structuredClone(patch) },
		};
		if (patch.sidebarPanelLayout) {
			const sidebarPanelLayout = patch.sidebarPanelLayout.map((entry) => ({ ...entry }));
			this.#config = {
				...this.#config,
				sidebarPanelLayout,
				showSidebarAgent:
					sidebarPanelLayout.find((entry) => entry.id === "agent")?.visible ?? this.#config.showSidebarAgent,
				showSidebarTodos:
					sidebarPanelLayout.find((entry) => entry.id === "todos")?.visible ?? this.#config.showSidebarTodos,
			};
		}
		if (canonicalizeSession) {
			const target = resolveDisplayLayers(this.#displayLayers).display;
			let session = { ...this.#displayLayers.session };
			for (const key of ["preset", "density", "segmentLayout"] as const) {
				if (!(key in session)) continue;
				const candidate = { ...session };
				delete candidate[key];
				const { session: _oldSession, ...lower } = this.#displayLayers;
				const layers: DisplayLayerState =
					Object.keys(candidate).length > 0 ? { ...lower, session: candidate } : lower;
				if (isDeepStrictEqual(resolveDisplayLayers(layers).display, target)) session = candidate;
			}
			const { session: _oldSession, ...lower } = this.#displayLayers;
			this.#displayLayers = Object.keys(session).length > 0 ? { ...lower, session } : lower;
		}
		this.#resolveDisplay();
	}

	#resolveDisplay(): void {
		const resolved = resolveDisplayLayers(this.#displayLayers);
		this.#displayProvenance = resolved.provenance;
		this.#config = { ...this.#config, ...resolved.display };
		this.#invalidate();
	}

	setConfig(config: AtelierConfig): void {
		this.#config = config;
		this.#invalidate();
	}

	setActivity(activity: ActivityState): void {
		if (this.#state.activity === activity) return;
		this.#state =
			activity === "working"
				? { ...this.#state, activity, workingLabel: selectWorkingPhrase(this.#random()) }
				: { ...this.#state, activity };
		this.#invalidate();
	}

	refreshUsage(): void {
		if (this.#disposed) return;
		const messages: UsageMessage[] = [];
		for (const entry of this.#ctx.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				messages.push(entry.message as UsageMessage);
			}
		}
		const model = this.#ctx.model;
		const context = this.#ctx.getContextUsage();
		const subscription = model ? this.#ctx.modelRegistry.isUsingOAuth(model) : false;
		const { modelId: _modelId, provider: _provider, ...stateWithoutModel } = this.#state;
		this.#state = {
			...stateWithoutModel,
			...(model ? { modelId: model.id, provider: model.provider } : {}),
			thinkingLevel: this.#pi.getThinkingLevel?.(),
			metrics: aggregateMetrics(messages, {
				subscription,
				autoCompact: this.#autoCompact,
				...(context ? { context } : {}),
			}),
		};
		this.#invalidate();
	}

	scheduleWorkspacePulseRefresh(delayMs = WORKSPACE_REFRESH_DEBOUNCE_MS): void {
		if (this.#disposed) return;
		if (this.#workspaceRefreshTimer) clearTimeout(this.#workspaceRefreshTimer);
		this.#workspaceRefreshTimer = setTimeout(
			() => {
				this.#workspaceRefreshTimer = undefined;
				void this.refreshWorkspacePulse();
			},
			Math.max(0, Math.trunc(delayMs)),
		);
		this.#workspaceRefreshTimer.unref?.();
	}

	async refreshWorkspacePulse(): Promise<void> {
		if (this.#disposed) return;
		if (this.#workspaceRefreshTimer) {
			clearTimeout(this.#workspaceRefreshTimer);
			this.#workspaceRefreshTimer = undefined;
		}
		const generation = ++this.#workspaceRefreshGeneration;
		const inspection = await this.#inspectWorkspace();
		if (this.#disposed || generation !== this.#workspaceRefreshGeneration) return;

		if (inspection.kind === "available") {
			const { kind: _kind, ...data } = inspection;
			this.#lastWorkspaceData = data;
			const { snapshot } = data;
			const dirty = snapshot.trackedFiles > 0;
			const pulseChanged = dirty || snapshot.untrackedFiles > 0;
			const status = snapshot.conflicts > 0 ? "conflict" : pulseChanged ? "changed" : "clean";
			const { branch: _branch, ...withoutBranch } = this.#state;
			this.#replaceState({
				...withoutBranch,
				...(data.branch ? { branch: data.branch } : {}),
				dirty,
				workspacePulse: { status, data },
			});
			return;
		}

		if (inspection.kind === "not-repo") {
			this.#lastWorkspaceData = undefined;
			const { branch: _branch, ...withoutBranch } = this.#state;
			this.#replaceState({
				...withoutBranch,
				dirty: false,
				workspacePulse: { status: "not-repo" },
			});
			return;
		}

		this.#replaceState({
			...this.#state,
			workspacePulse: this.#lastWorkspaceData
				? { status: "stale", data: this.#lastWorkspaceData }
				: { status: "unavailable" },
		});
	}

	async refreshGitState(): Promise<void> {
		await this.refreshWorkspacePulse();
	}

	async refreshGitDirty(): Promise<void> {
		await this.refreshWorkspacePulse();
	}

	/**
	 * Stops scheduled work and resets to inert state, so a footer that outlives its
	 * `setFooter(undefined)` cannot keep reporting the retired session's branch, usage, or activity.
	 */
	dispose(): void {
		this.#disposed = true;
		this.#workspaceRefreshGeneration += 1;
		if (this.#workspaceRefreshTimer) clearTimeout(this.#workspaceRefreshTimer);
		this.#workspaceRefreshTimer = undefined;
		this.#lastWorkspaceData = undefined;
		this.#state = { ...this.#inertState(), workspacePulse: { status: "unavailable" } };
	}

	#replaceState(next: AtelierState): void {
		if (isDeepStrictEqual(this.#state, next)) return;
		this.#state = next;
		this.#invalidate();
	}

	#invalidate(): void {
		if (!this.#disposed) this.#requestRender();
	}
}

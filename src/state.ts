import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectWorkingPhrase } from "./activity.js";
import { resolveDisplayLayers } from "./config.js";
import { aggregateMetrics, type UsageMessage } from "./metrics.js";
import {
	emptySubagentUsage,
	isSubagentUsageEventForSession,
	readSubagentUsage,
	subagentMetadataReferences,
	SUBAGENT_METADATA_ENTRY,
} from "./subagent-usage.js";
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
	createWorkspacePulseRefresh,
	inspectWorkspacePulse,
	type WorkspacePulseData,
	type WorkspacePulseInspection,
	type WorkspacePulseRefresh,
} from "./workspace-pulse.js";

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
	enabled?: boolean;
	random?: () => number;
	requestRender(): void;
	inspectWorkspace?(signal: AbortSignal): Promise<WorkspacePulseInspection>;
}

export function createInertAtelierState(autoCompact: boolean | null = null): AtelierState {
	return {
		activity: "ready",
		dirty: false,
		workspacePulse: { status: "unavailable" },
		metrics: aggregateMetrics([], { subscription: false, autoCompact }),
		extensionStatuses: [],
	};
}

export class AtelierRuntime {
	readonly #pi: ExtensionAPI;
	readonly #ctx: ExtensionContext;
	readonly #autoCompact: boolean | null;
	readonly #random: () => number;
	readonly #requestRender: () => void;
	readonly #workspacePulseRefresh: WorkspacePulseRefresh;
	#config: AtelierConfig;
	#displayLayers: DisplayLayerState;
	#displayProvenance: DisplayProvenance;
	#disposed = false;
	#enabled: boolean;
	#lastWorkspaceData: WorkspacePulseData | undefined;
	#state: AtelierState;
	#subagentRefresh: Promise<void> | undefined;
	#subagentRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	#subagentDirty = false;
	#subagentEntries: readonly unknown[] = [];
	#subagentAbort = new AbortController();
	#subagentUnsubscribe: (() => void) | undefined;

	constructor(dependencies: RuntimeDependencies) {
		this.#pi = dependencies.pi;
		this.#ctx = dependencies.ctx;
		this.#config = dependencies.config;
		this.#displayLayers = dependencies.displayLayers ?? {};
		this.#displayProvenance =
			dependencies.displayProvenance ?? resolveDisplayLayers(this.#displayLayers).provenance;
		this.#autoCompact = dependencies.autoCompact;
		this.#enabled = dependencies.enabled ?? true;
		this.#random = dependencies.random ?? Math.random;
		this.#requestRender = dependencies.requestRender;
		const inspectWorkspace = async (signal: AbortSignal): Promise<WorkspacePulseInspection> => {
			if (!this.#canInspectWorkspace()) return { kind: "unavailable" };
			return dependencies.inspectWorkspace
				? dependencies.inspectWorkspace(signal)
				: inspectWorkspacePulse({
						exec: async (command, args, options) =>
							this.#canInspectWorkspace()
								? this.#pi.exec(command, args, options)
								: { stdout: "", stderr: "", code: 1, killed: true },
						cwd: this.#ctx.cwd,
						signal,
					});
		};
		this.#workspacePulseRefresh = createWorkspacePulseRefresh({
			inspect: inspectWorkspace,
			publish: (inspection) => this.#applyWorkspacePulseInspection(inspection),
		});
		this.#workspacePulseRefresh.setEnabled(this.#enabled);
		this.#state = this.#inertState();
		if (!this.#ctx.isProjectTrusted()) {
			this.#state = { ...this.#state, workspacePulse: { status: "unavailable" } };
		}
		this.refreshUsage();
		const unsubscribe = ["subagent:async-complete", "subagent:async-started", "subagent:child-status"].map(
			(channel) =>
				this.#pi.events?.on(channel, (data: unknown) => {
					if (!this.#canInspectWorkspace()) return;
					if (
						!isSubagentUsageEventForSession(
							data,
							this.#ctx.sessionManager.getEntries(),
							this.#subagentSessionIdentity(),
						)
					)
						return;
					if ((data as { sessionId?: unknown }).sessionId === undefined) this.#scheduleSubagentRefresh();
					else this.observeSubagentMetadata(data);
				}),
		);
		this.#subagentUnsubscribe = () => {
			for (const off of unsubscribe) off?.();
		};
	}

	/** Save only pointers; totals and curves are read from the producer's own accounting records. */
	observeSubagentMetadata(data: unknown): void {
		if (!this.#canInspectWorkspace()) return;
		const refs = subagentMetadataReferences(data);
		if (!refs.runIds.length) return;
		const entries = this.#ctx.sessionManager.getEntries();
		const serialized = JSON.stringify(refs);
		if (
			!entries.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === SUBAGENT_METADATA_ENTRY &&
					JSON.stringify(entry.data) === serialized,
			)
		) {
			try {
				this.#pi.appendEntry(SUBAGENT_METADATA_ENTRY, refs);
			} catch {
				return;
			}
		}
		this.#scheduleSubagentRefresh();
	}

	#scheduleSubagentRefresh(delay = 100): void {
		if (!this.#subagentRefreshTimer) {
			this.#subagentRefreshTimer = setTimeout(() => {
				this.#subagentRefreshTimer = undefined;
				void this.refreshSubagentUsage();
			}, delay);
			this.#subagentRefreshTimer.unref();
		}
	}

	/** Suspend producers without losing the session's small activity/configuration state. */
	setEnabled(enabled: boolean): void {
		if (this.#disposed || this.#enabled === enabled) return;
		this.#enabled = enabled;
		this.#workspacePulseRefresh.setEnabled(enabled);
		if (!enabled) {
			this.#subagentAbort.abort();
			clearTimeout(this.#subagentRefreshTimer);
			this.#subagentRefreshTimer = undefined;
			return;
		}
		this.#subagentAbort = new AbortController();
		this.#state = {
			...this.#state,
			workspacePulse: !this.#ctx.isProjectTrusted()
				? { status: "unavailable" }
				: this.#lastWorkspaceData
					? { status: "stale", data: this.#lastWorkspaceData }
					: { status: "inspecting" },
		};
		this.refreshUsage();
		void this.flushWorkspacePulseRefresh();
	}

	/** State with no branch, workspace data, context, or usage history. */
	#inertState(): AtelierState {
		return {
			...createInertAtelierState(this.#autoCompact),
			workspacePulse: { status: "inspecting" },
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

	/** Applies a successfully persisted User patch, then safely drops redundant Session fields. */
	applySavedUserDisplayPatch(patch: DisplayPatch): void {
		this.#displayLayers = {
			...this.#displayLayers,
			user: { ...this.#displayLayers.user, ...structuredClone(patch) },
		};
		if (patch.sidebarPanelLayout) {
			const sidebarPanelLayout = patch.sidebarPanelLayout.map((entry) => ({ ...entry }));
			this.#config = { ...this.#config, sidebarPanelLayout };
		}
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
		if (this.#disposed || !this.#enabled) return;
		const messages: UsageMessage[] = [];
		const entries = this.#ctx.sessionManager.getEntries();
		for (const entry of entries) {
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
		void this.refreshSubagentUsage(entries);
	}

	#subagentSessionIdentity(): { sessionFile?: string; sessionId?: string } {
		const sessionFile = this.#ctx.sessionManager.getSessionFile?.();
		const sessionId = this.#ctx.sessionManager.getSessionId?.();
		return { ...(sessionFile ? { sessionFile } : {}), ...(sessionId ? { sessionId } : {}) };
	}

	/** Serialized accounting reads; active background work refreshes until it settles. */
	async refreshSubagentUsage(entries?: readonly unknown[]): Promise<void> {
		if (!this.#canInspectWorkspace()) return;
		clearTimeout(this.#subagentRefreshTimer);
		this.#subagentRefreshTimer = undefined;
		this.#subagentEntries = entries ?? this.#ctx.sessionManager.getEntries();
		this.#subagentDirty = true;
		if (this.#subagentRefresh) return this.#subagentRefresh;
		this.#subagentRefresh = (async () => {
			while (this.#subagentDirty && this.#canInspectWorkspace()) {
				this.#subagentDirty = false;
				const signal = this.#subagentAbort.signal;
				const session = this.#subagentSessionIdentity();
				try {
					const subagentUsage = await readSubagentUsage({
						entries: this.#subagentEntries,
						cwd: this.#ctx.cwd,
						...session,
						signal,
					});
					if (!signal.aborted && this.#canInspectWorkspace())
						this.#replaceState({ ...this.#state, subagentUsage });
				} catch {
					if (!signal.aborted && this.#canInspectWorkspace())
						this.#replaceState({
							...this.#state,
							subagentUsage: { ...emptySubagentUsage(), unavailable: 1 },
						});
				}
			}
		})().finally(() => {
			this.#subagentRefresh = undefined;
			if (this.#canInspectWorkspace() && this.#state.subagentUsage?.pending)
				this.#scheduleSubagentRefresh(1500);
		});
		return this.#subagentRefresh;
	}

	#canInspectWorkspace(): boolean {
		return !this.#disposed && this.#enabled && this.#ctx.isProjectTrusted();
	}

	scheduleWorkspacePulseRefresh(): void {
		if (this.#canInspectWorkspace()) this.#workspacePulseRefresh.request();
	}

	async flushWorkspacePulseRefresh(): Promise<void> {
		if (this.#canInspectWorkspace()) await this.#workspacePulseRefresh.flush();
	}

	#applyWorkspacePulseInspection(inspection: WorkspacePulseInspection): void {
		if (this.#disposed || !this.#enabled) return;
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

	/**
	 * Stops scheduled work and resets to inert state, so a footer that outlives its
	 * `setFooter(undefined)` cannot keep reporting the retired session's branch, usage, or activity.
	 */
	dispose(): void {
		this.#disposed = true;
		this.#subagentAbort.abort();
		clearTimeout(this.#subagentRefreshTimer);
		this.#subagentRefreshTimer = undefined;
		this.#subagentUnsubscribe?.();
		this.#workspacePulseRefresh.dispose();
		this.#lastWorkspaceData = undefined;
		this.#state = { ...this.#inertState(), workspacePulse: { status: "unavailable" } };
	}

	#replaceState(next: AtelierState): void {
		if (isDeepStrictEqual(this.#state, next)) return;
		this.#state = next;
		this.#invalidate();
	}

	#invalidate(): void {
		if (!this.#disposed && this.#enabled) this.#requestRender();
	}
}

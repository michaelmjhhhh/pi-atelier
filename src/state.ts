import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectWorkingPhrase } from "./activity.js";
import { resolveDisplayLayers } from "./config.js";
import { cloneLayout } from "./display.js";
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
	SKIPPED_EXEC_RESULT,
	type WorkspacePulseData,
	type WorkspacePulseInspection,
	type WorkspacePulseRefresh,
} from "./workspace-pulse.js";

const SESSION_DISPLAY_OVERRIDE_KEYS = ["preset", "density", "segmentLayout"] as const;

export interface RuntimeDependencies {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	config: AtelierConfig;
	displayLayers: DisplayLayerState;
	displayProvenance: DisplayProvenance;
	autoCompact: boolean | null;
	enabled?: boolean;
	random?: () => number;
	requestRender(): void;
	inspectWorkspace?(signal: AbortSignal): Promise<WorkspacePulseInspection>;
}

/** State with no branch, workspace data, context, or usage history. */
export function createInertAtelierState(
	autoCompact: boolean | null,
	workspacePulse: AtelierState["workspacePulse"] = { status: "unavailable" },
): AtelierState {
	return {
		activity: "ready",
		dirty: false,
		workspacePulse,
		metrics: aggregateMetrics([], { subscription: false, autoCompact }),
		extensionStatuses: [],
	};
}

/** Replace the Session layer, dropping it entirely when it has no keys left. */
function withSessionLayer(layers: DisplayLayerState, session: Record<string, unknown>): DisplayLayerState {
	const { session: _previous, ...lower } = layers;
	return Object.keys(session).length > 0 ? { ...lower, session } : lower;
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
		this.#displayLayers = dependencies.displayLayers;
		this.#displayProvenance = dependencies.displayProvenance;
		this.#autoCompact = dependencies.autoCompact;
		this.#enabled = dependencies.enabled ?? true;
		this.#random = dependencies.random ?? Math.random;
		this.#requestRender = dependencies.requestRender;
		const inspectWorkspace = async (signal: AbortSignal): Promise<WorkspacePulseInspection> => {
			if (!this.#isLiveAndTrusted()) return { kind: "unavailable" };
			return dependencies.inspectWorkspace
				? dependencies.inspectWorkspace(signal)
				: inspectWorkspacePulse({
						exec: async (command, args, options) =>
							this.#isLiveAndTrusted() ? this.#pi.exec(command, args, options) : SKIPPED_EXEC_RESULT,
						cwd: this.#ctx.cwd,
						signal,
					});
		};
		this.#workspacePulseRefresh = createWorkspacePulseRefresh({
			inspect: inspectWorkspace,
			publish: (inspection) => this.#applyWorkspacePulseInspection(inspection),
		});
		this.#workspacePulseRefresh.setEnabled(this.#enabled);
		this.#state = createInertAtelierState(
			this.#autoCompact,
			this.#ctx.isProjectTrusted() ? { status: "inspecting" } : { status: "unavailable" },
		);
		this.refreshUsage();
		const unsubscribe = ["subagent:async-complete", "subagent:async-started", "subagent:child-status"].map(
			(channel) =>
				this.#pi.events.on(channel, (data: unknown) => {
					if (!this.#isLiveAndTrusted()) return;
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
			for (const off of unsubscribe) off();
		};
	}

	/** Save only pointers; totals and curves are read from the producer's own accounting records. */
	observeSubagentMetadata(data: unknown): void {
		if (!this.#isLiveAndTrusted()) return;
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

	getState(): AtelierState {
		return this.#state;
	}

	getConfig(): AtelierConfig {
		return this.#config;
	}

	getDisplaySettings(): DisplaySettings {
		const { preset, density, segmentLayout } = this.#config;
		return { preset, density, segmentLayout };
	}

	getDisplayProvenance(): DisplayProvenance {
		return this.#displayProvenance;
	}

	/** A detached copy of the Session layer's Display keys. */
	getSessionDisplayOverride(): SessionDisplayOverride | undefined {
		const session = this.#displayLayers.session;
		if (!session) return undefined;
		const keys = SESSION_DISPLAY_OVERRIDE_KEYS.filter((key) => key in session);
		if (keys.length === 0) return undefined;
		return structuredClone(
			Object.fromEntries(keys.map((key) => [key, session[key]])),
		) as SessionDisplayOverride;
	}

	replaceSessionDisplayOverride(override: SessionDisplayOverride | undefined): void {
		const session = { ...this.#displayLayers.session };
		for (const key of SESSION_DISPLAY_OVERRIDE_KEYS) delete session[key];
		if (override) Object.assign(session, structuredClone(override));
		this.#displayLayers = withSessionLayer(this.#displayLayers, session);
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
			this.#config = { ...this.#config, sidebarPanelLayout: cloneLayout(patch.sidebarPanelLayout) };
		}
		// Drop each Session key whose removal no longer changes the effective Display.
		const target = resolveDisplayLayers(this.#displayLayers).display;
		let session = { ...this.#displayLayers.session };
		for (const key of SESSION_DISPLAY_OVERRIDE_KEYS) {
			if (!(key in session)) continue;
			const { [key]: _removed, ...candidate } = session;
			const resolved = resolveDisplayLayers(withSessionLayer(this.#displayLayers, candidate)).display;
			if (isDeepStrictEqual(resolved, target)) session = candidate;
		}
		this.#displayLayers = withSessionLayer(this.#displayLayers, session);
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
			thinkingLevel: this.#pi.getThinkingLevel(),
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
		const sessionFile = this.#ctx.sessionManager.getSessionFile();
		const sessionId = this.#ctx.sessionManager.getSessionId();
		return { ...(sessionFile ? { sessionFile } : {}), ...(sessionId ? { sessionId } : {}) };
	}

	/** Serialized accounting reads; active background work refreshes until it settles. */
	async refreshSubagentUsage(entries?: readonly unknown[]): Promise<void> {
		if (!this.#isLiveAndTrusted()) return;
		clearTimeout(this.#subagentRefreshTimer);
		this.#subagentRefreshTimer = undefined;
		this.#subagentEntries = entries ?? this.#ctx.sessionManager.getEntries();
		this.#subagentDirty = true;
		if (this.#subagentRefresh) return this.#subagentRefresh;
		this.#subagentRefresh = (async () => {
			while (this.#subagentDirty && this.#isLiveAndTrusted()) {
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
					if (!signal.aborted && this.#isLiveAndTrusted())
						this.#replaceState({ ...this.#state, subagentUsage });
				} catch {
					if (!signal.aborted && this.#isLiveAndTrusted())
						this.#replaceState({
							...this.#state,
							subagentUsage: { ...emptySubagentUsage(), unavailable: 1 },
						});
				}
			}
		})().finally(() => {
			this.#subagentRefresh = undefined;
			if (this.#isLiveAndTrusted() && this.#state.subagentUsage?.pending) this.#scheduleSubagentRefresh(1500);
		});
		return this.#subagentRefresh;
	}

	/** Workspace and subagent inspection run only for a live, enabled, trusted session. */
	#isLiveAndTrusted(): boolean {
		return !this.#disposed && this.#enabled && this.#ctx.isProjectTrusted();
	}

	scheduleWorkspacePulseRefresh(): void {
		if (this.#isLiveAndTrusted()) this.#workspacePulseRefresh.request();
	}

	async flushWorkspacePulseRefresh(): Promise<void> {
		if (this.#isLiveAndTrusted()) await this.#workspacePulseRefresh.flush();
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
		this.#state = createInertAtelierState(this.#autoCompact);
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

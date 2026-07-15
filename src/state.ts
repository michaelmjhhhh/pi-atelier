import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { aggregateMetrics, type UsageMessage } from "./metrics.js";
import type { ActivityState, AtelierConfig, AtelierState } from "./types.js";

export interface RuntimeDependencies {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	config: AtelierConfig;
	autoCompact: boolean | null;
	requestRender(): void;
}

export class AtelierRuntime {
	readonly #pi: ExtensionAPI;
	readonly #ctx: ExtensionContext;
	readonly #autoCompact: boolean | null;
	readonly #requestRender: () => void;
	#config: AtelierConfig;
	#disposed = false;
	#state: AtelierState;

	constructor(dependencies: RuntimeDependencies) {
		this.#pi = dependencies.pi;
		this.#ctx = dependencies.ctx;
		this.#config = dependencies.config;
		this.#autoCompact = dependencies.autoCompact;
		this.#requestRender = dependencies.requestRender;
		const context = this.#ctx.getContextUsage();
		this.#state = {
			activity: "ready",
			dirty: false,
			metrics: aggregateMetrics([], {
				subscription: false,
				autoCompact: this.#autoCompact,
				...(context ? { context } : {}),
			}),
			extensionStatuses: [],
		};
		this.refreshUsage();
	}

	getState(): AtelierState {
		return this.#state;
	}

	getConfig(): AtelierConfig {
		return this.#config;
	}

	setConfig(config: AtelierConfig): void {
		this.#config = config;
		this.#invalidate();
	}

	setActivity(activity: ActivityState): void {
		if (this.#state.activity === activity) return;
		this.#state = { ...this.#state, activity };
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

	async refreshGitDirty(): Promise<void> {
		if (this.#disposed) return;
		let dirty = false;
		try {
			const result = await this.#pi.exec("git", ["status", "--porcelain", "--untracked-files=no"], {
				timeout: 2_000,
			});
			dirty = result.code === 0 && result.stdout.trim().length > 0;
		} catch {
			dirty = false;
		}
		if (this.#state.dirty !== dirty) {
			this.#state = { ...this.#state, dirty };
			this.#invalidate();
		}
	}

	dispose(): void {
		this.#disposed = true;
	}

	#invalidate(): void {
		if (!this.#disposed) this.#requestRender();
	}
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectWorkingPhrase } from "./activity.js";
import { aggregateMetrics, type UsageMessage } from "./metrics.js";
import type { ActivityState, AtelierConfig, AtelierState } from "./types.js";

export function parseGitStatus(output: string): { branch?: string; dirty: boolean } {
	const lines = output.split(/\r?\n/).filter(Boolean);
	const header = lines[0]?.startsWith("## ") ? lines[0].slice(3).trim() : "";
	const rawBranch = header.split("...")[0]?.trim() ?? "";
	const unbornBranch = rawBranch.match(/^No commits yet on (.+)$/)?.[1]?.trim();
	const branch = rawBranch === "HEAD (no branch)" ? "detached" : (unbornBranch ?? rawBranch);
	return {
		...(branch ? { branch } : {}),
		dirty: lines.some((line) => !line.startsWith("## ")),
	};
}

export interface RuntimeDependencies {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	config: AtelierConfig;
	autoCompact: boolean | null;
	random?: () => number;
	requestRender(): void;
}

export class AtelierRuntime {
	readonly #pi: ExtensionAPI;
	readonly #ctx: ExtensionContext;
	readonly #autoCompact: boolean | null;
	readonly #random: () => number;
	readonly #requestRender: () => void;
	#config: AtelierConfig;
	#disposed = false;
	#state: AtelierState;

	constructor(dependencies: RuntimeDependencies) {
		this.#pi = dependencies.pi;
		this.#ctx = dependencies.ctx;
		this.#config = dependencies.config;
		this.#autoCompact = dependencies.autoCompact;
		this.#random = dependencies.random ?? Math.random;
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

	async refreshGitState(): Promise<void> {
		if (this.#disposed) return;
		let next: { branch?: string; dirty: boolean } = { dirty: false };
		try {
			const result = await this.#pi.exec("git", ["status", "--short", "--branch", "--untracked-files=no"], {
				timeout: 2_000,
			});
			if (result.code === 0) next = parseGitStatus(result.stdout);
		} catch {
			next = { dirty: false };
		}
		const sameBranch = this.#state.branch === next.branch;
		if (sameBranch && this.#state.dirty === next.dirty) return;
		const { branch: _branch, ...withoutBranch } = this.#state;
		this.#state = { ...withoutBranch, ...next };
		this.#invalidate();
	}

	async refreshGitDirty(): Promise<void> {
		await this.refreshGitState();
	}

	dispose(): void {
		this.#disposed = true;
	}

	#invalidate(): void {
		if (!this.#disposed) this.#requestRender();
	}
}

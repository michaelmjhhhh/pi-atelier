import { convertToLlm, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type BranchEntryLike,
	formatRecapCost,
	goalStateFromBranch,
	latestReply,
	recapFromBranch,
	type StoredRecap,
} from "./session-recap.js";
import {
	type GoalRequest,
	parseRecapReply,
	recapRequest,
	recapTranscript,
	recapTranscriptMessage,
	recapTranscriptSystem,
} from "./session-summarizer.js";
import { errorMessage, isRecord } from "./text.js";

type ModelRegistry = ExtensionContext["modelRegistry"];
type Model = NonNullable<ExtensionContext["model"]>;
type CompleteContext = Parameters<ModelRegistry["complete"]>[1];
type AssistantReply = Awaited<ReturnType<ModelRegistry["complete"]>>;

/**
 * Pi 1.6 surfaces the runner needs for a warm-cache recap. The pinned Pi types predate them,
 * so they are reached through a narrow local shape and detected at runtime.
 */
interface WarmCapableSessionManager {
	buildSessionProjection?: () => { messages: unknown[] };
}
interface StreamCapableRegistry {
	streamSimple?: (
		model: Model,
		context: CompleteContext,
		options: Record<string, unknown>,
	) => { result(): Promise<AssistantReply> };
}

/** What a recap cost, as the provider reported it. */
export interface RecapUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface StoredRecapEntry extends Omit<StoredRecap, "cost"> {
	/** `warm` replayed the session's cached conversation; `transcript` sent an excerpt to a model. */
	mode: "warm" | "transcript";
	usage?: RecapUsage;
}

export interface RecapRunRequest {
	ctx: ExtensionContext;
	/** `provider/model` from `sessionRecapModel`; empty uses the session's model. */
	modelSetting: string;
	/** The session's thinking level, replayed on a warm recap so the cached prefix still matches. */
	thinkingLevel: string;
	/** Pi's `blockImages` setting: the agent then sends images as text, which a replay cannot reproduce. */
	blockImages: boolean;
}

export interface RecapRunnerOptions {
	/** Persist the recap; called only while the run is still current. */
	save(entry: StoredRecapEntry): void;
	/** Whether the run that started this recap is still the current one. */
	isCurrent(): boolean;
	onStateChange(): void;
	onWarning(message: string): void;
}

export interface RecapRunner {
	/** Write a recap for the latest reply, unless one is already current or being written. */
	request(input: RecapRunRequest): void;
	cancel(): void;
	isRunning(): boolean;
}

/** Whether the branch has a finished reply that no recap describes yet. */
export function needsRecap(branch: readonly BranchEntryLike[]): boolean {
	let last: { stopReason?: unknown } | undefined;
	for (let index = branch.length - 1; index >= 0 && !last; index--) {
		const message = branch[index]?.message;
		if (branch[index]?.type === "message" && isAssistantMessage(message)) last = message;
	}
	// A run that failed or was stopped did not end where a recap could say it stopped.
	if (!last || last.stopReason === "error" || last.stopReason === "aborted") return false;
	const reply = latestReply(branch);
	if (!reply) return false;
	const recap = recapFromBranch(branch);
	return recap === undefined || recap.index < reply.index;
}

/** The goal is written once: asked for until a recap writes one, unless the user set their own. */
export function goalRequestFor(branch: readonly BranchEntryLike[]): GoalRequest {
	const goals = goalStateFromBranch(branch);
	if (goals.manual || goals.generated) return { kind: "none" };
	return goals.discarded ? { kind: "regenerate", previous: goals.discarded } : { kind: "initial" };
}

const isAssistantMessage = (message: unknown): message is { role: "assistant"; stopReason?: unknown } =>
	isRecord(message) && message.role === "assistant";

function resolveModel(ctx: ExtensionContext, setting: string): Model | undefined {
	if (!setting) return ctx.model;
	const slash = setting.indexOf("/");
	return ctx.modelRegistry.find(setting.slice(0, slash), setting.slice(slash + 1)) as Model | undefined;
}

const modelLabel = (model: Model): string => `${model.provider}/${model.id}`;

/**
 * APIs whose server-side continuation is keyed on the session id and ignores
 * `disableContinuation`: a replay would replace the conversation's baseline.
 */
const CONTINUATION_KEYED_APIS: ReadonlySet<string> = new Set(["openai-codex-responses"]);

/**
 * OpenAI keeps the cached prefix when tools are switched off with `tool_choice`; Anthropic does
 * not. Only OpenAI's own Responses APIs qualify: `openai-completions` also fronts gateways that
 * may route to Anthropic.
 */
const TOOLS_OFF_KEEPS_CACHE_APIS: ReadonlySet<string> = new Set([
	"openai-responses",
	"azure-openai-responses",
]);
const keepsCacheWithoutTools = (model: Model): boolean => TOOLS_OFF_KEEPS_CACHE_APIS.has(model.api);

/** Prompts below this size are not cached by any supported provider, so a miss says nothing. */
const CACHE_MISS_MIN_TOKENS = 4_096;

/** Whether a warm recap paid for most of its prompt instead of reading it from the cache. */
function missedCache(usage: RecapUsage | undefined): boolean {
	if (!usage) return false;
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	return prompt >= CACHE_MISS_MIN_TOKENS && usage.cacheRead < prompt / 2;
}

/**
 * Output budget for an excerpt recap: two short lines, with room for a model that reasons before
 * answering even when asked not to. Too small a budget ends the reply before it says anything.
 */
const EXCERPT_MAX_TOKENS = 1_024;

function usageOf(reply: AssistantReply): RecapUsage | undefined {
	const usage = (reply as { usage?: unknown }).usage;
	if (!isRecord(usage)) return undefined;
	const number = (value: unknown): number =>
		typeof value === "number" && Number.isFinite(value) ? value : 0;
	return {
		input: number(usage.input),
		output: number(usage.output),
		cacheRead: number(usage.cacheRead),
		cacheWrite: number(usage.cacheWrite),
		cost: isRecord(usage.cost) ? number(usage.cost.total) : 0,
	};
}

/** Longest provider error kept in a warning; the rest is in Pi's own logs. */
const ERROR_MAX_CHARS = 160;

/** The innermost `message` of a provider error, which often nests JSON inside JSON strings, and its code. */
function innermostError(value: unknown, depth = 0): { message?: string; code?: number } {
	if (depth > 6) return {};
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.startsWith("{")) {
			try {
				return innermostError(JSON.parse(trimmed), depth + 1);
			} catch {
				// Not JSON after all: the string is the message.
			}
		}
		return trimmed ? { message: trimmed } : {};
	}
	if (!isRecord(value)) return {};
	const nested = innermostError(value.error ?? value.message, depth + 1);
	const code = typeof value.code === "number" ? value.code : undefined;
	return { ...nested, ...(nested.code === undefined && code !== undefined ? { code } : {}) };
}

/**
 * A provider error as one readable line: the innermost message and its status code, not the raw
 * JSON body some providers return.
 */
export function readableError(raw: string): string {
	const { message, code } = innermostError(raw);
	const line = (message ?? raw).replace(/\s+/g, " ").trim();
	const clipped = line.length <= ERROR_MAX_CHARS ? line : `${line.slice(0, ERROR_MAX_CHARS - 1)}…`;
	return code === undefined || clipped.includes(String(code)) ? clipped : `${clipped} (${code})`;
}

/** Whether the model bills a subscription plan, where a dollar figure is an estimate, not a charge. */
function isUsingSubscription(ctx: ExtensionContext, model: Model): boolean {
	try {
		return ctx.modelRegistry.isUsingOAuth(model);
	} catch {
		return false;
	}
}

function replyText(reply: AssistantReply): string {
	return reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

export function createRecapRunner(options: RecapRunnerOptions): RecapRunner {
	let controller: AbortController | undefined;
	/** One warning per problem per session: a recap failing after every run should not nag. */
	const warned = new Set<string>();
	const warnOnce = (key: string, message: string): void => {
		if (warned.has(key)) return;
		warned.add(key);
		options.onWarning(message);
	};

	async function run(input: RecapRunRequest, signal: AbortSignal): Promise<StoredRecapEntry | undefined> {
		const { ctx } = input;
		const model = resolveModel(ctx, input.modelSetting);
		if (!model) {
			warnOnce(
				`model:${input.modelSetting}`,
				input.modelSetting
					? `Session recap model ${input.modelSetting} was not found`
					: "Session recap needs a selected model",
			);
			return undefined;
		}
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
			warnOnce(`auth:${modelLabel(model)}`, `Session recap model ${modelLabel(model)} has no authentication`);
			return undefined;
		}
		const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & WarmCapableSessionManager;
		const registry = ctx.modelRegistry as ModelRegistry & StreamCapableRegistry;
		const sameModel =
			!input.modelSetting || (ctx.model !== undefined && modelLabel(ctx.model) === modelLabel(model));
		const warm =
			sameModel &&
			!input.blockImages &&
			!CONTINUATION_KEYED_APIS.has(model.api) &&
			typeof sessionManager.buildSessionProjection === "function" &&
			typeof registry.streamSimple === "function";
		const goal = goalRequestFor(ctx.sessionManager.getBranch());
		let reply: AssistantReply;
		if (warm && registry.streamSimple && sessionManager.buildSessionProjection) {
			// Replay the conversation exactly as the agent sends it, plus one request, so the provider
			// reads the prefix from its prompt cache. Pi 1.6 keeps the prompt and tool declarations in
			// the transcript's system messages, so the projection carries them too.
			const messages = convertToLlm(sessionManager.buildSessionProjection().messages as never);
			reply = await registry
				.streamSimple(
					model,
					{ messages: [...messages, { role: "user", content: recapRequest(goal), timestamp: Date.now() }] },
					{
						// Reasoning and, on Anthropic, tool choice are part of the cached prefix: both stay as the
						// agent sends them. A reply that calls a tool anyway is discarded below.
						...(input.thinkingLevel === "off" ? {} : { reasoning: input.thinkingLevel }),
						...(keepsCacheWithoutTools(model) ? { toolChoice: "none" } : {}),
						// Not `maxTokens`: budget-based thinking derives its budget from it.
						sessionId: ctx.sessionManager.getSessionId(),
						// A side request must not replace the conversation's server-side continuation state.
						disableContinuation: true,
						maxRetries: 0,
						signal,
					},
				)
				.result();
		} else {
			const transcript = recapTranscript(
				ctx.sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
			);
			if (!transcript) return undefined;
			const context = {
				systemPrompt: recapTranscriptSystem(goal),
				messages: [{ role: "user", content: recapTranscriptMessage(transcript), timestamp: Date.now() }],
			} as CompleteContext;
			// A one-off prompt: nothing to gain from writing it to the cache.
			const options = { cacheRetention: "none", maxTokens: EXCERPT_MAX_TOKENS, maxRetries: 0, signal };
			// Labelling two lines needs no reasoning; leaving `reasoning` out turns it off where the
			// provider-neutral call is available. `complete` keeps each provider's own default.
			reply = registry.streamSimple
				? await registry.streamSimple(model, context, options).result()
				: await ctx.modelRegistry.complete(
						model,
						context,
						options as Parameters<ModelRegistry["complete"]>[2],
					);
		}
		if (signal.aborted) return undefined;
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			warnOnce(
				`reply:${modelLabel(model)}`,
				`Session recap failed (${modelLabel(model)}): ${readableError(reply.errorMessage ?? String(reply.stopReason))}`,
			);
			return undefined;
		}
		const usage = usageOf(reply);
		if (warm && missedCache(usage) && usage) {
			warnOnce(
				`cache:${modelLabel(model)}`,
				`Session recap missed the prompt cache and cost ${formatRecapCost(usage.cost)}. Another extension may change ` +
					"what the agent sends; choose a smaller Recap model in Settings to cap the cost.",
			);
		}
		const parsed = parseRecapReply(replyText(reply));
		if (!parsed) {
			// A tool call (the replay keeps the agent's tools), a cut-off reply, or the wrong format.
			warnOnce(
				`unreadable:${modelLabel(model)}`,
				reply.stopReason === "toolUse"
					? `Session recap: ${modelLabel(model)} called a tool instead of answering`
					: `Session recap: ${modelLabel(model)} did not answer in the expected format`,
			);
			return undefined;
		}
		const subscription = isUsingSubscription(ctx, model);
		return {
			// A goal the recap was not asked for is ignored: it is written once.
			about: goal.kind === "none" ? "" : parsed.about,
			status: parsed.status,
			model: modelLabel(model),
			mode: warm ? "warm" : "transcript",
			...(usage ? { usage } : {}),
			...(subscription ? { subscription: true } : {}),
		};
	}

	return {
		request(input) {
			if (controller) return;
			if (!needsRecap(input.ctx.sessionManager.getBranch())) return;
			const current = new AbortController();
			controller = current;
			options.onStateChange();
			void run(input, current.signal)
				.then((entry) => {
					if (entry && !current.signal.aborted && options.isCurrent()) options.save(entry);
				})
				.catch((error: unknown) => {
					if (!current.signal.aborted)
						warnOnce(
							`error:${errorMessage(error)}`,
							`Session recap failed: ${readableError(errorMessage(error))}`,
						);
				})
				.finally(() => {
					if (controller !== current) return;
					controller = undefined;
					options.onStateChange();
				});
		},
		cancel() {
			const current = controller;
			controller = undefined;
			if (!current) return;
			current.abort();
			options.onStateChange();
		},
		isRunning: () => controller !== undefined,
	};
}

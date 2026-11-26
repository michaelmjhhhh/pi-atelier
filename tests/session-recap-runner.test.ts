import { describe, expect, it, vi } from "vitest";

import { SESSION_RECAP_ENTRY } from "../src/session-recap.js";
import { createRecapRunner, needsRecap, type StoredRecapEntry } from "../src/session-recap-runner.js";
import { parseRecapReply, RECAP_REQUEST, recapTranscript } from "../src/session-summarizer.js";
import { settleMicrotasks } from "./helpers/async.js";

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason: "stop",
	timestamp: 1,
	...extra,
});
const message = (msg: unknown) => ({ type: "message", message: msg });
const recapEntry = { type: "custom", customType: SESSION_RECAP_ENTRY, data: { about: "a", status: "b" } };

const modelReply = (text: string, extra: Record<string, unknown> = {}) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason: "stop",
	usage: { input: 10, output: 5, cacheRead: 40_000, cacheWrite: 30, cost: { total: 0.012 } },
	...extra,
});

describe("parseRecapReply", () => {
	it("reads both lines, tolerating Markdown emphasis and list markers", () => {
		expect(parseRecapReply("**About:** Session panel for Atelier\n- Stopped: tests pass, PR next")).toEqual({
			about: "Session panel for Atelier",
			status: "tests pass, PR next",
		});
	});

	it("rejects a reply with neither line", () => {
		expect(parseRecapReply("I will call a tool now.")).toBeUndefined();
	});
});

describe("recapTranscript", () => {
	it("keeps the opening request, drops tool output, and names tool calls", () => {
		const messages = [
			{ role: "user", content: "Build the Session panel" },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] },
			{ role: "toolResult", content: [{ type: "text", text: "SECRET FILE CONTENT" }] },
			assistant("Panel renders."),
		];
		const transcript = recapTranscript(messages);
		expect(transcript).toContain("User: Build the Session panel");
		expect(transcript).toContain("Assistant used: read");
		expect(transcript).toContain("Assistant: Panel renders.");
		expect(transcript).not.toContain("SECRET");
	});

	it("keeps the tail within the budget and marks the gap", () => {
		const messages = [
			{ role: "user", content: "Opening goal" },
			...Array.from({ length: 50 }, (_, index) => assistant(`Step ${index} ${"x".repeat(200)}`)),
		];
		const transcript = recapTranscript(messages, 2_000);
		expect(transcript.length).toBeLessThanOrEqual(2_000);
		expect(transcript.startsWith("User: Opening goal")).toBe(true);
		expect(transcript).toContain("[…]");
		expect(transcript).toContain("Step 49");
	});
});

describe("needsRecap", () => {
	it("is true for a finished reply no recap describes", () => {
		expect(needsRecap([message(assistant("Done the thing."))])).toBe(true);
		expect(needsRecap([message(assistant("Done the thing.")), recapEntry])).toBe(false);
		expect(needsRecap([recapEntry, message(assistant("Next thing."))])).toBe(true);
	});

	it("is false when the last reply failed or there is none", () => {
		expect(needsRecap([message(assistant("partial", { stopReason: "aborted" }))])).toBe(false);
		expect(needsRecap([])).toBe(false);
	});
});

function fakeContext(options: {
	warm: boolean;
	branch?: unknown[];
	reply?: unknown;
	model?: { provider: string; id: string; api: string };
}) {
	const model = options.model ?? { provider: "anthropic", id: "claude", api: "anthropic-messages" };
	const reply = options.reply ?? modelReply("About: Session panel\nStopped: Tests pass");
	const streamSimple = vi.fn((_model: unknown, _context: unknown, _options: Record<string, unknown>) => ({
		result: async () => reply,
	}));
	const complete = vi.fn(async () => reply);
	const branch = options.branch ?? [message({ role: "user", content: "go" }), message(assistant("Did it."))];
	const ctx = {
		model,
		modelRegistry: {
			find: vi.fn(() => ({ provider: "openai", id: "mini", api: "openai-responses" })),
			hasConfiguredAuth: vi.fn(() => true),
			complete,
			...(options.warm ? { streamSimple } : {}),
		},
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => "session-1",
			...(options.warm
				? {
						buildSessionProjection: () => ({
							messages: [{ role: "user", content: "go", timestamp: 1 }, assistant("Did it.")],
						}),
					}
				: {}),
		},
	};
	return { ctx: ctx as never, streamSimple, complete };
}

function runner() {
	const saved: StoredRecapEntry[] = [];
	const warnings: string[] = [];
	const instance = createRecapRunner({
		save: (entry) => saved.push(entry),
		isCurrent: () => true,
		onStateChange: () => undefined,
		onWarning: (warning) => warnings.push(warning),
	});
	return { instance, saved, warnings };
}

describe("createRecapRunner", () => {
	it("replays the conversation with the recap request on the session model", async () => {
		const { ctx, streamSimple, complete } = fakeContext({ warm: true });
		const { instance, saved } = runner();
		instance.request({ ctx, modelSetting: "", thinkingLevel: "medium", blockImages: false });
		expect(instance.isRunning()).toBe(true);
		await settleMicrotasks();
		expect(complete).not.toHaveBeenCalled();
		const [, context, options] = streamSimple.mock.calls[0] as unknown as [
			unknown,
			{ messages: { role: string; content: unknown }[] },
			Record<string, unknown>,
		];
		expect(context.messages.at(-1)).toMatchObject({ role: "user", content: RECAP_REQUEST });
		expect(context.messages).toHaveLength(3);
		expect(options).toMatchObject({ reasoning: "medium", sessionId: "session-1", disableContinuation: true });
		expect(saved).toEqual([
			{
				about: "Session panel",
				status: "Tests pass",
				model: "anthropic/claude",
				mode: "warm",
				usage: { input: 10, output: 5, cacheRead: 40_000, cacheWrite: 30, cost: 0.012 },
			},
		]);
		expect(instance.isRunning()).toBe(false);
	});

	it("sends a transcript excerpt to a separate model without caching it", async () => {
		const { ctx, streamSimple, complete } = fakeContext({ warm: true });
		const { instance, saved } = runner();
		instance.request({ ctx, modelSetting: "openai/mini", thinkingLevel: "high", blockImages: false });
		await settleMicrotasks();
		expect(streamSimple).not.toHaveBeenCalled();
		const [, context, options] = complete.mock.calls[0] as unknown as [
			unknown,
			{ systemPrompt: string; messages: { content: string }[] },
			Record<string, unknown>,
		];
		expect(context.messages[0]?.content).toContain("Assistant: Did it.");
		expect(options).toMatchObject({ cacheRetention: "none" });
		expect(saved[0]).toMatchObject({ model: "openai/mini", mode: "transcript" });
	});

	it("falls back to a transcript on a Pi without session projection", async () => {
		const { ctx, complete } = fakeContext({ warm: false });
		const { instance, saved } = runner();
		instance.request({ ctx, modelSetting: "", thinkingLevel: "off", blockImages: false });
		await settleMicrotasks();
		expect(complete).toHaveBeenCalledOnce();
		expect(saved[0]?.mode).toBe("transcript");
	});

	it("discards a cancelled recap", async () => {
		const { ctx } = fakeContext({ warm: true });
		const { instance, saved } = runner();
		instance.request({ ctx, modelSetting: "", thinkingLevel: "off", blockImages: false });
		instance.cancel();
		await settleMicrotasks();
		expect(saved).toEqual([]);
		expect(instance.isRunning()).toBe(false);
	});

	it("skips a branch whose recap is current and warns once about a failed reply", async () => {
		const current = fakeContext({ warm: true, branch: [message(assistant("Did it.")), recapEntry] });
		const { instance, saved, warnings } = runner();
		instance.request({ ctx: current.ctx, modelSetting: "", thinkingLevel: "off", blockImages: false });
		expect(instance.isRunning()).toBe(false);

		const failing = fakeContext({
			warm: true,
			reply: modelReply("", { stopReason: "error", errorMessage: "overloaded" }),
		});
		instance.request({ ctx: failing.ctx, modelSetting: "", thinkingLevel: "off", blockImages: false });
		await settleMicrotasks();
		instance.request({ ctx: failing.ctx, modelSetting: "", thinkingLevel: "off", blockImages: false });
		await settleMicrotasks();
		expect(saved).toEqual([]);
		expect(warnings).toEqual(["Session recap failed: overloaded"]);
	});

	it.each([
		[
			"Codex, whose continuation ignores disableContinuation",
			{ provider: "openai-codex", id: "gpt", api: "openai-codex-responses" },
			false,
		],
		["blocked images, which a replay cannot reproduce", undefined, true],
	])("sends a transcript instead of a replay for %s", async (_name, model, blockImages) => {
		const { ctx, streamSimple, complete } = fakeContext({ warm: true, ...(model ? { model } : {}) });
		const { instance, saved } = runner();
		instance.request({ ctx, modelSetting: "", thinkingLevel: "high", blockImages });
		await settleMicrotasks();
		expect(streamSimple).not.toHaveBeenCalled();
		expect(complete).toHaveBeenCalledOnce();
		expect(saved[0]?.mode).toBe("transcript");
	});

	it("switches tools off only where that keeps the cache", async () => {
		const openai = fakeContext({
			warm: true,
			model: { provider: "openai", id: "gpt", api: "openai-responses" },
		});
		const { instance } = runner();
		instance.request({ ctx: openai.ctx, modelSetting: "", thinkingLevel: "off", blockImages: false });
		await settleMicrotasks();
		expect(openai.streamSimple.mock.calls[0]?.[2]).toMatchObject({ toolChoice: "none" });
		expect(openai.streamSimple.mock.calls[0]?.[2]).not.toHaveProperty("reasoning");

		const anthropic = fakeContext({ warm: true });
		instance.request({ ctx: anthropic.ctx, modelSetting: "", thinkingLevel: "off", blockImages: false });
		await settleMicrotasks();
		expect(anthropic.streamSimple.mock.calls[0]?.[2]).not.toHaveProperty("toolChoice");
	});

	it("warns once when a warm recap misses the cache", async () => {
		const cold = modelReply("About: a\nStopped: b", {
			usage: { input: 50_000, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.127 } },
		});
		const { ctx } = fakeContext({ warm: true, reply: cold });
		const { instance, saved, warnings } = runner();
		instance.request({ ctx, modelSetting: "", thinkingLevel: "off", blockImages: false });
		await settleMicrotasks();
		expect(saved).toHaveLength(1);
		expect(warnings).toEqual([
			"Session recap missed the prompt cache and cost $0.127. Another extension may change what the agent sends; choose a smaller Recap model in Settings to cap the cost.",
		]);
	});
});

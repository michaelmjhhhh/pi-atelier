import { isRecord, sanitizeInline } from "./text.js";
import type { NormalizedTodo } from "./types.js";

/** Custom session entry holding the goal set with `/atelier goal`; `text: null` clears it. */
export const SESSION_GOAL_ENTRY = "pi-atelier:goal";

/** Longest goal or status kept, in characters; the panel truncates further to its width. */
export const SESSION_TEXT_MAX_CHARS = 160;

/** The minimal entry shape read from `sessionManager.getBranch()`. */
export interface BranchEntryLike {
	readonly type: string;
	readonly id?: string;
	readonly customType?: string;
	readonly data?: unknown;
	readonly timestamp?: string;
	readonly message?: unknown;
}

export type GoalSource = "goal" | "name";
export type StatusSource = "todo" | "reply";

/** What the Session panel shows. */
export interface SessionRecapView {
	goal?: { text: string; source: GoalSource };
	status?: { text: string; source: StatusSource };
	/** When the latest run on this branch ended, in epoch milliseconds. */
	lastRunAt?: number;
}

const clip = (text: string): string => {
	const line = sanitizeInline(text);
	const chars = [...line];
	return chars.length <= SESSION_TEXT_MAX_CHARS
		? line
		: `${chars.slice(0, SESSION_TEXT_MAX_CHARS - 1).join("")}…`;
};

/** A goal argument, cleaned to one bounded line; empty clears the goal. */
export const normalizeGoal = (text: string): string | undefined => clip(text) || undefined;

/** The goal set on this branch, or undefined when none is set or the last one was cleared. */
export function goalFromBranch(branch: readonly BranchEntryLike[]): string | undefined {
	let goal: string | undefined;
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== SESSION_GOAL_ENTRY || !isRecord(entry.data)) continue;
		const { text } = entry.data;
		if (text === null) goal = undefined;
		else if (typeof text === "string") goal = normalizeGoal(text);
	}
	return goal;
}

/**
 * Names Pi or another tool generated rather than a person: anything carrying a UUID or a long
 * hex or numeric id, and `subagent-…` names.
 */
const GENERATED_NAME =
	/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{16,}\b|\d{10,}|^subagent[-_\s]/i;

/** A session name made readable (`issue-42-43` → `issue 42 43`), or undefined for a generated one. */
export function readableSessionName(name: string | undefined): string | undefined {
	if (!name) return undefined;
	const line = sanitizeInline(name);
	if (!line || GENERATED_NAME.test(line)) return undefined;
	// Only slug-like names are rewritten; a name with spaces is shown as written.
	const readable = line.includes(" ") ? line : line.replace(/[-_]+/g, " ").trim();
	return readable ? clip(readable) : undefined;
}

/** Replies that say nothing about where the session stands. */
const ACKNOWLEDGEMENT =
	/^(?:ok(?:ay)?|sure|done|got it|great|thanks?|thank you|perfect|understood|alright|yes|no|right|noted|will do|on it|sounds good)[.!]*$/i;

/** One Markdown line reduced to its prose, or empty when it carries none. */
function proseOf(line: string): string {
	const trimmed = line.trim();
	// Headings, rules, tables, and quoted or fenced blocks are structure, not a status.
	if (/^(?:#{1,6}\s|[-*_]{3,}$|\||>|```|~~~)/.test(trimmed)) return "";
	return trimmed
		.replace(/^(?:[-*+]|\d+[.)])\s+/, "")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__|\*|_|`)(.+?)\1/g, "$2")
		.trim();
}

/** Words whose trailing period does not end a sentence. */
const ABBREVIATION = /(?:^|\s)(?:e\.g|i\.e|etc|vs|cf|approx|incl|resp|[A-Za-z])\.$/i;

/** The first sentence of `text`, keeping abbreviations like `e.g.` and versions like `0.21.0` intact. */
function firstSentence(text: string): string {
	const end = /[.!?。！？](?=\s|$)/gu;
	for (let match = end.exec(text); match; match = end.exec(text)) {
		const sentence = text.slice(0, match.index + match[0].length);
		if (match[0] === "." && ABBREVIATION.test(sentence)) continue;
		return sentence.trim();
	}
	return text.trim();
}

/**
 * The first meaningful sentence of an assistant reply: code, headings, and one-word
 * acknowledgements are skipped, and a lead-in that only introduces a list (`Changes:`) is
 * passed over for the line after it.
 */
export function statusFromReply(text: string): string | undefined {
	let fenced = false;
	for (const raw of text.split(/\r?\n/)) {
		if (/^\s*(?:```|~~~)/.test(raw)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		const prose = proseOf(raw);
		if (!prose || ACKNOWLEDGEMENT.test(prose)) continue;
		const sentence = firstSentence(prose);
		if (ACKNOWLEDGEMENT.test(sentence)) {
			const rest = prose.slice(sentence.length).trim();
			if (!rest) continue;
			return clip(firstSentence(rest));
		}
		if (/:$/.test(sentence) && [...sentence].length < 40) continue;
		return clip(sentence);
	}
	return undefined;
}

interface AssistantLike {
	role: "assistant";
	content: unknown;
	stopReason?: unknown;
	timestamp?: unknown;
}

const isAssistant = (message: unknown): message is AssistantLike =>
	isRecord(message) && message.role === "assistant";

/** Text blocks of an assistant message joined; thinking and tool calls are left out. */
export function assistantText(message: unknown): string {
	if (!isAssistant(message) || !Array.isArray(message.content)) return "";
	return message.content
		.filter(
			(block): block is { type: "text"; text: string } =>
				isRecord(block) && block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

/** The latest finished assistant reply on the branch that says something, and when it ended. */
export function latestReply(branch: readonly BranchEntryLike[]): { text: string; at?: number } | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "message" || !isAssistant(entry.message)) continue;
		if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") continue;
		const text = assistantText(entry.message);
		if (!text.trim()) continue;
		const at =
			typeof entry.message.timestamp === "number"
				? entry.message.timestamp
				: Date.parse(entry.timestamp ?? "");
		return { text, ...(Number.isFinite(at) ? { at } : {}) };
	}
	return undefined;
}

/**
 * The Session panel as the branch describes it.
 * Goal: the goal set by the user, else the readable session name.
 * Status: the first meaningful sentence of the last reply.
 */
export function recapFromSession(branch: readonly BranchEntryLike[], sessionName?: string): SessionRecapView {
	const reply = latestReply(branch);
	const setGoal = goalFromBranch(branch);
	const name = setGoal ? undefined : readableSessionName(sessionName);
	const goal = setGoal
		? { text: setGoal, source: "goal" as const }
		: name
			? { text: name, source: "name" as const }
			: undefined;
	const statusText = reply ? statusFromReply(reply.text) : undefined;
	return {
		...(goal ? { goal } : {}),
		...(statusText ? { status: { text: statusText, source: "reply" as const } } : {}),
		...(reply?.at === undefined ? {} : { lastRunAt: reply.at }),
	};
}

/** The todo in progress, when there is one, is the most current status of all. */
export function withActiveTodo(view: SessionRecapView, todos: readonly NormalizedTodo[]): SessionRecapView {
	const active = todos.find((todo) => todo.status === "in_progress");
	const text = active ? clip(active.text) : "";
	return text ? { ...view, status: { text, source: "todo" } } : view;
}

/** How long ago something happened, in the largest whole unit: `just now`, `12m ago`, `3h ago`, `2d ago`. */
export function formatAge(elapsedMs: number): string {
	const minutes = Math.floor(Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

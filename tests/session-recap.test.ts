import { describe, expect, it } from "vitest";

import {
	formatAge,
	goalFromBranch,
	readableSessionName,
	recapFromSession,
	SESSION_GOAL_ENTRY,
	SESSION_RECAP_ENTRY,
	statusFromReply,
	withActiveTodo,
} from "../src/session-recap.js";

const reply = (text: string, extra: Record<string, unknown> = {}) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1_000, ...extra },
});
const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const goal = (text: string | null) => ({ type: "custom", customType: SESSION_GOAL_ENTRY, data: { text } });
const recap = (about: string, status: string) => ({
	type: "custom",
	customType: SESSION_RECAP_ENTRY,
	data: { about, status },
});

describe("readableSessionName", () => {
	it.each([
		["issue-42-43", "issue 42 43"],
		["fix_sidebar_widths", "fix sidebar widths"],
		["Refactor auth module", "Refactor auth module"],
	])("makes %s readable", (name, expected) => {
		expect(readableSessionName(name)).toBe(expected);
	});

	it.each([
		"subagent-reviewer-0f8c2a1e-3b4d-4c5e-9f60-1a2b3c4d5e6f",
		"0f8c2a1e-3b4d-4c5e-9f60-1a2b3c4d5e6f",
		"run-1795661376680",
		"deadbeefcafebabe1234",
		"",
		undefined,
	])("hides generated name %s", (name) => {
		expect(readableSessionName(name)).toBeUndefined();
	});
});

describe("statusFromReply", () => {
	it("skips headings, code, and acknowledgements", () => {
		expect(
			statusFromReply(
				["## Summary", "", "Done.", "```ts", "const x = 1;", "```", "Tests pass after the fix. More."].join(
					"\n",
				),
			),
		).toBe("Tests pass after the fix.");
	});

	it("keeps the sentence after a leading acknowledgement", () => {
		expect(statusFromReply("Done. The sidebar now wraps long goals.")).toBe(
			"The sidebar now wraps long goals.",
		);
	});

	it("passes over a short lead-in for the list after it", () => {
		expect(statusFromReply("Changes:\n- **Added** the `session` panel\n- Fixed widths")).toBe(
			"Added the session panel",
		);
	});

	it("keeps versions and abbreviations whole", () => {
		expect(statusFromReply("Released 0.21.0 to npm, e.g. for testing.")).toBe(
			"Released 0.21.0 to npm, e.g. for testing.",
		);
	});

	it("returns undefined for a reply with no prose", () => {
		expect(statusFromReply("OK\n```\nls\n```")).toBeUndefined();
	});
});

describe("goalFromBranch", () => {
	it("keeps the latest goal and honours a clear", () => {
		expect(goalFromBranch([goal("First"), goal("  Second  goal ")])).toBe("Second goal");
		expect(goalFromBranch([goal("First"), goal(null)])).toBeUndefined();
	});
});

describe("recapFromSession", () => {
	it("prefers the set goal, then the recap, then the session name", () => {
		expect(recapFromSession([recap("Recap topic", "x"), goal("Set goal")], "named").goal).toEqual({
			text: "Set goal",
			source: "goal",
		});
		expect(recapFromSession([recap("Recap topic", "x")], "named").goal).toEqual({
			text: "Recap topic",
			source: "summary",
		});
		expect(recapFromSession([], "issue-42").goal).toEqual({ text: "issue 42", source: "name" });
		expect(recapFromSession([], undefined).goal).toBeUndefined();
	});

	it("uses the recap status only while no reply came after it", () => {
		const current = recapFromSession([user("go"), reply("Old reply."), recap("Topic", "Waiting on review")]);
		expect(current.status).toEqual({ text: "Waiting on review", source: "summary" });
		const stale = recapFromSession([reply("Old reply."), recap("Topic", "Waiting"), reply("Merged the PR.")]);
		expect(stale.status).toEqual({ text: "Merged the PR.", source: "reply" });
		expect(stale.goal?.text).toBe("Topic");
	});

	it("skips failed replies and reports when the last good one ended", () => {
		const view = recapFromSession([
			reply("Built it.", { timestamp: 5_000 }),
			reply("partial", { stopReason: "aborted" }),
		]);
		expect(view.status?.text).toBe("Built it.");
		expect(view.lastRunAt).toBe(5_000);
	});

	it("names the model and cost behind recap lines it shows", () => {
		const withUsage = {
			type: "custom",
			customType: SESSION_RECAP_ENTRY,
			data: { about: "Topic", status: "Next", model: "anthropic/claude", usage: { cost: 0.0066 } },
		};
		expect(recapFromSession([reply("Old."), withUsage]).recapBy).toEqual({
			model: "anthropic/claude",
			cost: 0.0066,
		});
		// A goal set by the user and a newer reply leave nothing of the recap on screen.
		expect(recapFromSession([withUsage, goal("Mine"), reply("Newer.")]).recapBy).toBeUndefined();
	});

	it("keeps the first generated goal and lets /atelier goal auto replace it", () => {
		const first = recapFromSession([recap("First goal", "a"), recap("Later goal", "b")]);
		expect(first.goal).toEqual({ text: "First goal", source: "summary" });
		const regenerated = recapFromSession([
			recap("First goal", "a"),
			{ type: "custom", customType: SESSION_GOAL_ENTRY, data: { text: null, regenerate: true } },
			recap("Second goal", "b"),
		]);
		expect(regenerated.goal?.text).toBe("Second goal");
		expect(recapFromSession([recap("", "a")], "issue-42").goal).toEqual({ text: "issue 42", source: "name" });
	});

	it("lets the todo in progress override the status", () => {
		const view = withActiveTodo(recapFromSession([reply("Reply.")]), [
			{ id: 1, text: "Done one", status: "completed" },
			{ id: 2, text: "Write docs", status: "in_progress" },
		]);
		expect(view.status).toEqual({ text: "Write docs", source: "todo" });
	});
});

describe("formatAge", () => {
	it.each([
		[0, "just now"],
		[59_000, "just now"],
		[12 * 60_000, "12m ago"],
		[3 * 3_600_000, "3h ago"],
		[50 * 3_600_000, "2d ago"],
	])("formats %d ms", (elapsed, expected) => {
		expect(formatAge(elapsed)).toBe(expected);
	});
});

import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { resolveLanguage, t } from "../src/i18n.js";
import { footerCoreSelection, hasTopStripSurface } from "../src/surface-gates.js";
import { scrollTodoOffset, todoActionFromArgs, todoWindow, todoWindowSummary } from "../src/todo-window.js";

const todos = Array.from({ length: 12 }, (_, index) => `task-${index + 1}`);

describe("TODO window logic", () => {
	it("shows six of twelve items with positional counter and hidden indicators", () => {
		const window = todoWindow(todos, 0);
		expect(window.items).toEqual(todos.slice(0, 6));
		expect(todoWindowSummary(2, todos.length, window)).toBe("2/12 · 1/12 ↓");
		expect(window.hiddenAbove).toBe(false);
		expect(window.hiddenBelow).toBe(true);
	});

	it("clamps scrolling at both ends and exposes indicators only for hidden items", () => {
		expect(scrollTodoOffset(0, todos.length, "prev")).toBe(0);
		expect(scrollTodoOffset(0, todos.length, "page-up")).toBe(0);
		const end = scrollTodoOffset(0, todos.length, "page-down");
		expect(end).toBe(6);
		const window = todoWindow(todos, end);
		expect(window.items).toEqual(todos.slice(6));
		expect(todoWindowSummary(2, todos.length, window)).toBe("2/12 · ↑ 7/12");
		expect(window.hiddenAbove).toBe(true);
		expect(window.hiddenBelow).toBe(false);
	});

	it("clamps a stale offset after the list shrinks without producing an empty window", () => {
		const window = todoWindow(todos.slice(0, 3), 11);
		expect(window.items).toEqual(["task-3"]);
		expect(window.start).toBe(2);
		expect(window.hiddenAbove).toBe(true);
		expect(window.hiddenBelow).toBe(false);
	});

	it.each([
		[[], "top"],
		[["top"], "top"],
		[["next"], "next"],
		[["prev"], "prev"],
		[["page-up"], "page-up"],
		[["page-down"], "page-down"],
	] as const)("maps /atelier todos args %j to %s", (args, action) => {
		expect(todoActionFromArgs(args)).toBe(action);
	});

	it.each([["invalid"], ["next", "extra"]])("rejects unsupported /atelier todos args %j", (...args) => {
		expect(todoActionFromArgs(args)).toBeNull();
	});
});

describe("language resolution", () => {
	it.each([
		["it_IT", "it", "COMPITI"],
		["en_US", "en", "TODOS"],
		["de_DE", "en", "TODOS"],
	] as const)("resolves auto locale %s to %s dictionary", (locale, language, todosLabel) => {
		expect(resolveLanguage("auto", { LANG: locale })).toBe(language);
		expect(t(language, "todos")).toBe(todosLabel);
	});

	it("defaults to English for an empty environment and unsupported explicit locale", () => {
		expect(resolveLanguage("auto", {})).toBe("en");
		expect(t(resolveLanguage("auto", {}), "todos")).toBe("TODOS");
	});

	it.each([
		["en", "TODOS"],
		["it", "COMPITI"],
	] as const)("keeps explicit %s dictionary selection", (language, todosLabel) => {
		expect(t(language, "todos")).toBe(todosLabel);
	});

	it("warns on an invalid configured language and keeps English", () => {
		const result = resolveConfig({ user: { language: "fr" } });
		expect(result.config.language).toBe("en");
		expect(result.warnings).toContain("Unknown language: fr");
		expect(t(result.config.language, "todos")).toBe("TODOS");
	});
});

describe("responsive surface gates", () => {
	it.each([
		[63, 20, false],
		[64, 20, true],
		[64, 19, false],
	] as const)("top strip at %i columns and %i rows: %s", (width, rows, expected) => {
		expect(hasTopStripSurface(width, rows)).toBe(expected);
	});

	it("selects only Activity and Context for the footer core profile below 76 columns", () => {
		expect(footerCoreSelection(75, 20)).toEqual(["activity", "context"]);
		expect(footerCoreSelection(76, 20)).toBeUndefined();
		expect(footerCoreSelection(76, 6)).toEqual(["activity", "context"]);
	});
});

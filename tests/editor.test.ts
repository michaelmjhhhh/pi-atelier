import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { AtelierEditor, EDITOR_FRAME_MIN_WIDTH, frameEditorLines, isEditorRuleText } from "../src/editor.js";

const paint = (text: string) => `\u001b[38;2;102;102;102m${text}\u001b[39m`;

describe("editor frame helpers", () => {
	it("recognizes plain and scroll editor rules", () => {
		expect(isEditorRuleText("─".repeat(20))).toBe(true);
		expect(isEditorRuleText(`─── ↑ 3 more ${"─".repeat(8)}`)).toBe(true);
		expect(isEditorRuleText(`─── ↓ 12 more ${"─".repeat(6)}`)).toBe(true);
		expect(isEditorRuleText("prompt text")).toBe(false);
		expect(isEditorRuleText("")).toBe(false);
	});

	it("frames content with rounded corners, side rails, and inner padding", () => {
		const innerWidth = 12;
		const inner = ["─".repeat(innerWidth), "hello", "─".repeat(innerWidth)];
		const framed = frameEditorLines(inner, innerWidth + 4, paint);

		const top = stripTerminalSequences(framed[0] ?? "");
		const content = stripTerminalSequences(framed[1] ?? "");
		const bottom = stripTerminalSequences(framed[2] ?? "");
		expect(top).toBe(`╭${"─".repeat(innerWidth + 2)}╮`);
		expect(content.startsWith("│ ")).toBe(true);
		expect(content.endsWith(" │")).toBe(true);
		expect(content).toContain("hello");
		expect(visibleWidth(content)).toBe(innerWidth + 4);
		expect(bottom).toBe(`╰${"─".repeat(innerWidth + 2)}╯`);
		expect(framed).toHaveLength(3);
		for (const line of framed) expect(visibleWidth(line)).toBe(innerWidth + 4);
		expect(framed[0]).toContain("\u001b[38;2;102;102;102m╭");
		expect(framed[1]).toContain("\u001b[38;2;102;102;102m│\u001b[39m");
	});

	it("keeps autocomplete inside the frame and preserves scroll indicators", () => {
		const innerWidth = 16;
		const inner = [`─── ↑ 2 more ${"─".repeat(3)}`, "draft", `─── ↓ 4 more ${"─".repeat(3)}`, "/atelier"];
		const framed = frameEditorLines(inner, innerWidth + 4, (text) => text);

		expect(framed[0]).toContain("╭─── ↑ 2 more");
		expect(framed[0]?.endsWith("╮")).toBe(true);
		expect(framed[1]?.startsWith("│ ")).toBe(true);
		expect(framed[1]).toContain("draft");
		expect(framed[2]).toContain("/atelier");
		expect(framed[3]).toContain("╰─── ↓ 4 more");
		expect(framed[3]?.endsWith("╯")).toBe(true);
		expect(framed).toHaveLength(4);
		for (const line of framed) expect(visibleWidth(line)).toBe(innerWidth + 4);
	});

	it("does not frame below the minimum width", () => {
		const inner = ["────────", "text", "────────"];
		const framed = frameEditorLines(inner, EDITOR_FRAME_MIN_WIDTH - 1, paint);
		expect(framed.some((line) => line.includes("╭") || line.includes("╰"))).toBe(false);
		expect(framed[1]).toBe("text");
		for (const line of framed) expect(visibleWidth(line)).toBeLessThanOrEqual(EDITOR_FRAME_MIN_WIDTH - 1);
	});
});

describe("AtelierEditor", () => {
	it("renders an empty composer inside a rounded frame", () => {
		const editor = new AtelierEditor(
			{ requestRender: vi.fn(), terminal: { rows: 24, columns: 48 } } as never,
			{ borderColor: (text: string) => text, selectList: {} } as never,
			{ matches: () => false } as never,
		);

		const lines = editor.render(40);
		expect(lines[0]).toMatch(/^╭─+╮$/);
		expect(lines.at(-1)).toMatch(/^╰─+╯$/);
		expect(lines.some((line) => line.startsWith("│ ") && line.endsWith(" │"))).toBe(true);
		for (const line of lines) expect(visibleWidth(line)).toBe(40);
	});
});

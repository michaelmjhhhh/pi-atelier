import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fitToWidth } from "./text.js";

/** Width taken by the frame: a border and one column of padding on each side. */
const EDITOR_FRAME_CHROME = 4;
export const EDITOR_FRAME_MIN_WIDTH = 6;
const EDITOR_STATUS_MIN_WIDTH = 12;

const RULE_PATTERN = /^─+(?: [↑↓] \d+ more ─*)?\.{0,3}$/;

export function isEditorRuleText(plain: string): boolean {
	return plain.length > 0 && RULE_PATTERN.test(plain);
}

function expandRule(line: string, width: number): string {
	const plain = stripTerminalSequences(line);
	const body = isEditorRuleText(plain) ? plain : "─".repeat(visibleWidth(plain));
	if (visibleWidth(body) >= width) return fitToWidth(body, width);
	return `${body}${"─".repeat(width - visibleWidth(body))}`;
}

function findBottomRuleIndex(lines: readonly string[], innerWidth: number): number {
	for (let index = lines.length - 1; index >= 1; index -= 1) {
		const line = lines[index];
		if (!line) continue;
		const plain = stripTerminalSequences(line);
		if (visibleWidth(plain) === innerWidth && isEditorRuleText(plain)) return index;
	}
	return Math.max(0, lines.length - 1);
}

function framedRule(
	innerRule: string,
	outerBodyWidth: number,
	leftCap: string,
	rightCap: string,
	borderColor: (text: string) => string,
): string {
	return borderColor(`${leftCap}${expandRule(innerRule, outerBodyWidth)}${rightCap}`);
}

function framedRow(line: string, innerWidth: number, borderColor: (text: string) => string): string {
	return `${borderColor("│")} ${fitToWidth(line, innerWidth)} ${borderColor("│")}`;
}

function fitsStatusLine(status: string, width: number): boolean {
	return stripTerminalSequences(status).trim().length > 0 && visibleWidth(status) <= width;
}

function framedStatusRule(
	innerRule: string,
	outerBodyWidth: number,
	borderColor: (text: string) => string,
	renderStatusLine?: (width: number) => string,
): string {
	const normalRule = () => framedRule(innerRule, outerBodyWidth, "╭", "╮", borderColor);
	if (!renderStatusLine) return normalRule();

	const scrollIndicator = stripTerminalSequences(innerRule).match(/↑ \d+ more/)?.[0];
	const scrollSuffix = scrollIndicator ? ` ${scrollIndicator} ─` : "";
	// Reserve "─ " before the status, plus " ─" after it.
	const statusWidth = outerBodyWidth - 4 - visibleWidth(scrollSuffix);
	if (statusWidth < EDITOR_STATUS_MIN_WIDTH) return normalRule();

	const status = renderStatusLine(statusWidth);
	if (!fitsStatusLine(status, statusWidth)) return normalRule();

	const remainingRule = "─".repeat(statusWidth - visibleWidth(status) + 1);
	return `${borderColor("╭─ ")}${status}${borderColor(` ${remainingRule}${scrollSuffix}╮`)}`;
}

/** Wrap Pi editor lines in a rounded frame with one column of inner padding. */
export function frameEditorLines(
	inner: readonly string[],
	width: number,
	borderColor: (text: string) => string,
	renderStatusLine?: (width: number) => string,
): string[] {
	const safeWidth = Math.max(0, Math.trunc(width));
	const [topRule, ...rest] = inner;
	if (safeWidth < EDITOR_FRAME_MIN_WIDTH || topRule === undefined) {
		return inner.map((line) => truncateToWidth(line, safeWidth, ""));
	}

	const innerWidth = safeWidth - EDITOR_FRAME_CHROME;
	const outerBodyWidth = safeWidth - 2;
	const bottom = findBottomRuleIndex(inner, innerWidth);
	const body = rest.filter((_, index) => index + 1 !== bottom);
	return [
		framedStatusRule(topRule, outerBodyWidth, borderColor, renderStatusLine),
		...body.map((line) => framedRow(line, innerWidth, borderColor)),
		framedRule(inner[bottom] ?? topRule, outerBodyWidth, "╰", "╯", borderColor),
	].map((line) => truncateToWidth(line, safeWidth, ""));
}

/** Pi composer with Atelier's rounded frame. Preserves thinking-level borderColor. */
export class AtelierEditor extends CustomEditor {
	/** Optional ANSI status content for the top frame; receives its available column width. */
	renderStatusLine: ((width: number) => string) | undefined;
	/** Whether the most recent render included the status line in its top frame. */
	statusLineVisible = false;

	override render(width: number): string[] {
		this.statusLineVisible = false;
		const safeWidth = Math.max(0, Math.trunc(width));
		if (safeWidth < EDITOR_FRAME_MIN_WIDTH) return super.render(safeWidth);
		const renderStatusLine = this.renderStatusLine;
		return frameEditorLines(
			super.render(safeWidth - EDITOR_FRAME_CHROME),
			safeWidth,
			this.borderColor,
			renderStatusLine
				? (availableWidth) => {
						const status = renderStatusLine(availableWidth);
						this.statusLineVisible = fitsStatusLine(status, availableWidth);
						return status;
					}
				: undefined,
		);
	}
}

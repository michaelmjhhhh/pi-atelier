import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** │ + padding on each side. */
export const EDITOR_FRAME_CHROME = 4;
export const EDITOR_FRAME_MIN_WIDTH = 6;
export const EDITOR_STATUS_MIN_WIDTH = 12;

const RULE_PATTERN = /^─+(?: [↑↓] \d+ more ─*)?(?:\.{0,3})?$/;

export function isEditorRuleText(plain: string): boolean {
	return plain.length > 0 && RULE_PATTERN.test(plain);
}

function padToVisible(text: string, width: number): string {
	const current = visibleWidth(text);
	if (current === width) return text;
	if (current > width) return truncateToWidth(text, width, "");
	return `${text}${" ".repeat(width - current)}`;
}

function expandRule(line: string, width: number): string {
	const plain = stripTerminalSequences(line);
	const body = isEditorRuleText(plain) ? plain : "─".repeat(Math.max(0, visibleWidth(plain)));
	if (visibleWidth(body) >= width) return padToVisible(body, width);
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
	return `${borderColor("│")} ${padToVisible(line, innerWidth)} ${borderColor("│")}`;
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
	// Reserve the leading rule and space, plus a trailing space and at least one rule.
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
	if (safeWidth < EDITOR_FRAME_MIN_WIDTH || inner.length === 0) {
		return inner.map((line) => truncateToWidth(line, safeWidth, ""));
	}

	const innerWidth = safeWidth - EDITOR_FRAME_CHROME;
	const outerBodyWidth = safeWidth - 2;
	const bottom = findBottomRuleIndex(inner, innerWidth);
	const topRule = inner[0] ?? "─".repeat(innerWidth);
	const bottomRule = inner[bottom] ?? "─".repeat(innerWidth);
	const framed: string[] = [framedStatusRule(topRule, outerBodyWidth, borderColor, renderStatusLine)];

	for (let index = 1; index < bottom; index += 1) {
		framed.push(framedRow(inner[index] ?? "", innerWidth, borderColor));
	}
	for (let index = bottom + 1; index < inner.length; index += 1) {
		framed.push(framedRow(inner[index] ?? "", innerWidth, borderColor));
	}

	framed.push(framedRule(bottomRule, outerBodyWidth, "╰", "╯", borderColor));
	return framed.map((line) => truncateToWidth(line, safeWidth, ""));
}

/** Pi composer with Atelier's rounded frame. Preserves thinking-level borderColor. */
export class AtelierEditor extends CustomEditor {
	/** Optional ANSI status content for the top frame; receives its available column width. */
	renderStatusLine?: (width: number) => string;
	private renderedStatusLine = false;

	/** Whether the most recent render included the status line in its top frame. */
	get statusLineVisible(): boolean {
		return this.renderedStatusLine;
	}

	override render(width: number): string[] {
		this.renderedStatusLine = false;
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
						this.renderedStatusLine = fitsStatusLine(status, availableWidth);
						return status;
					}
				: undefined,
		);
	}
}

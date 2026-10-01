import { truncateToWidth } from "@earendil-works/pi-tui";

// OSC (hyperlinks, titles), CSI (colors, cursor), C1 CSI, and two-byte ESC sequences.
const TERMINAL_SEQUENCE =
	/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;

/** Strip terminal sequences and control characters, collapsing the text to one trimmed line. */
export const sanitizeInline = (text: string): string =>
	text
		.replace(TERMINAL_SEQUENCE, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

/** Truncate and pad to exactly `width` visible columns. */
export const fitToWidth = (text: string, width: number): string =>
	truncateToWidth(text, Math.max(0, Math.trunc(width)), "", true);

export const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** https://no-color.org: any non-empty NO_COLOR disables color. */
export const isColorEnabled = (): boolean => !process.env.NO_COLOR;

export const clamp = (value: number, minimum: number, maximum: number): number =>
	Math.min(maximum, Math.max(minimum, value));

/** Placeholder for a value that is not available yet. */
export const PLACEHOLDER = "—";

/** Formats a filesystem path for stable, cross-platform UI display. */
export function toDisplayPath(value: string, separator: "/" | "\\"): string {
	return separator === "/" ? value : value.replaceAll(separator, "/");
}

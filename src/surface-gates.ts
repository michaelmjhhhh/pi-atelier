export function hasTopStripSurface(width: number, rows: number): boolean {
	return Math.max(0, Math.trunc(width)) >= 64 && rows >= 20;
}

export function footerCoreSelection(
	width: number,
	rows: number,
): readonly ["activity", "context"] | undefined {
	return width < 76 || rows < 20 ? ["activity", "context"] : undefined;
}

/**
 * The host contract for the four Pi TUI names a host may not serve.
 *
 * A host owns the `@earendil-works/pi-tui` specifier, and a host that serves a
 * subset (omp serves a compatibility surface built from its own TUI) makes a
 * named import of a missing export fail while the module graph links — before
 * any of this extension's code runs — which takes the whole extension down.
 * These tests pin both halves of the fix: the host's own implementation wins
 * whenever the host serves one, and each fallback behaves like Pi's when it does
 * not. The last test keeps the import list honest, because a host import of one
 * of these names is exactly what broke loading before.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

/** The names omp's bundled surface does not serve today. */
const OMITTED = ["compositeTuiLine", "isViewportTUI", "allocateImageId", "HStack"] as const;
const OMITTED_SET = new Set<string>(OMITTED);

const SOURCE_DIR = fileURLToPath(new URL("../src", import.meta.url));
const HOST_SPECIFIER = "@earendil-works/pi-tui";

const actualPiTui = async (): Promise<Record<string, unknown>> =>
	await vi.importActual<Record<string, unknown>>(HOST_SPECIFIER);

/** A host surface that serves everything except `omit`, shaped like a real subset. */
async function surfaceWithout(omit: readonly string[]): Promise<Record<string, unknown>> {
	const surface = { ...(await actualPiTui()) };
	// A real host namespace reports a name it does not serve as `undefined`, and
	// `??` cannot tell that from one the host publishes as nothing. A test mock
	// refuses the absent key outright, so the surface publishes it instead.
	for (const name of omit) surface[name] = undefined;
	return surface;
}

/**
 * Load the module against a host that serves `omit` and nothing less. Every call
 * resets the registry, so the module reads the host surface as it would on a
 * fresh start.
 */
async function loadWithHost(omit: readonly string[]) {
	vi.resetModules();
	const surface = await surfaceWithout(omit);
	vi.doMock(HOST_SPECIFIER, () => surface);
	return await import("../src/pi-tui-host.js");
}

/** Names a source file takes out of `specifier`, whether by `import` or re-export. */
const namesTakenFrom = (source: string, specifier: string): string[] => {
	const names = new Set<string>();
	const marker = `from "${specifier}"`;
	for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
		const open = source.lastIndexOf("{", at);
		const head = source.slice(
			Math.max(source.lastIndexOf("import", open), source.lastIndexOf("export", open)),
			open,
		);
		if (head.includes("(") || head.includes("=")) continue;
		for (const raw of source.slice(open + 1, at).split(",")) {
			const name = raw.trim();
			if (name.length === 0 || name.startsWith("type ")) continue;
			names.add((name.split(" as ")[0] ?? name).trim());
		}
	}
	return [...names];
};

/** Classified by brand alone, so a probe need not satisfy the whole TUI shape. */
const anyTui = (value: unknown): TUI => value as TUI;

describe("Pi TUI host surface", () => {
	it("uses the host's own implementation when the host serves the whole surface", async () => {
		const host = await loadWithHost([]);
		const actual = await actualPiTui();
		expect(host.compositeTuiLine).toBe(actual.compositeTuiLine);
		expect(host.isViewportTUI).toBe(actual.isViewportTUI);
		expect(host.allocateImageId).toBe(actual.allocateImageId);
		expect(host.HStack).toBe(actual.HStack);
	});

	it("composites a row exactly as Pi does when the host serves no compositor", async () => {
		const host = await loadWithHost(OMITTED);
		const actual = (await actualPiTui()).compositeTuiLine as (
			base: string,
			overlay: string,
			startCol: number,
			overlayWidth: number,
			totalWidth: number,
		) => string;
		expect(host.compositeTuiLine).not.toBe(actual);

		const rows: [string, string, string, number, number, number][] = [
			["plain row", "abcdefghij", "XY", 0, 6, 10],
			["overlay in the middle", "abcdefghij", "XY", 4, 2, 10],
			["overlay flush right", "abcdefghij", "XY", 8, 2, 10],
			["overlay wider than the tail", "abcdefghij", "0123456789", 7, 6, 10],
			["overlay starting past the row", "abc", "XY", 5, 2, 8],
			["empty base row", "", "XY", 0, 2, 4],
			["styled seam", "\u001b[31mabcdefghij\u001b[0m", "\u001b[32mXY\u001b[0m", 2, 4, 10],
			["hyperlink seam", "\u001b]8;;https://example.com\u0007abc\u001b]8;;\u0007", "XY", 1, 3, 6],
			["wide characters", "日本語abcde", "XY", 1, 3, 12],
			["image row is left alone", "\u001b_Gf=100;AAAA\u001b\\", "XY", 0, 2, 6],
		];
		for (const [label, base, overlay, startCol, overlayWidth, totalWidth] of rows) {
			expect([label, host.compositeTuiLine(base, overlay, startCol, overlayWidth, totalWidth)]).toEqual([
				label,
				actual(base, overlay, startCol, overlayWidth, totalWidth),
			]);
		}
	});

	it("keeps a host's slicer inside the row for the arguments Pi passes through", async () => {
		const host = await loadWithHost(OMITTED);

		// A negative column is the crash this fallback exists to make unreachable: a
		// host binding that reads it as unsigned would size a multi-gigabyte
		// allocation. Clamped, it is the row Pi would have composited anyway.
		expect(host.compositeTuiLine("abcdefghij", "XY", -3, 4, 10)).toBe(
			host.compositeTuiLine("abcdefghij", "XY", 0, 4, 10),
		);
		expect(visibleWidth(host.compositeTuiLine("abcdefghij", "XY", -3, 4, 10))).toBe(10);
		expect(visibleWidth(host.compositeTuiLine("abcdefghij", "XY", 1e12, 1e12, 10))).toBe(10);
		expect(visibleWidth(host.compositeTuiLine("abcdefghij", "XY", Number.NaN, Number.NaN, Number.NaN))).toBe(
			0,
		);
	});

	it("answers the viewport brand the way Pi does when the host serves no predicate", async () => {
		const host = await loadWithHost(OMITTED);
		const brand = Symbol.for("@earendil-works/pi-tui/viewport");
		expect(host.isViewportTUI(anyTui({ [brand]: true }))).toBe(true);
		expect(host.isViewportTUI(anyTui({ mode: "regular" }))).toBe(false);
		// A TUI that reports fullscreen without carrying the brand is not a viewport:
		// nothing replaces its root, so its visible children stay authoritative.
		expect(host.isViewportTUI(anyTui({ mode: "fullscreen" }))).toBe(false);
		expect(host.isViewportTUI(anyTui(undefined))).toBe(false);
	});

	it("allocates a Kitty graphics id in Pi's range when the host serves no allocator", async () => {
		const host = await loadWithHost(OMITTED);
		const ids = new Set<number>();
		for (let draw = 0; draw < 200; draw++) {
			const id = host.allocateImageId();
			expect(Number.isInteger(id)).toBe(true);
			expect(id).toBeGreaterThanOrEqual(1);
			expect(id).toBeLessThanOrEqual(0xfffffffe);
			ids.add(id);
		}
		expect(ids.size).toBeGreaterThan(150);
	});

	it("reports the missing viewport layout instead of rendering one", async () => {
		const host = await loadWithHost(OMITTED);
		expect(() => new host.HStack()).toThrow(/HStack is unavailable/);
	});

	it("never takes an omitted name from the host specifier", () => {
		const offenders: string[] = [];
		for (const entry of readdirSync(SOURCE_DIR)) {
			if (!entry.endsWith(".ts")) continue;
			const source = readFileSync(`${SOURCE_DIR}/${entry}`, "utf8");
			for (const name of namesTakenFrom(source, HOST_SPECIFIER)) {
				if (OMITTED_SET.has(name)) offenders.push(`${entry}: ${name}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

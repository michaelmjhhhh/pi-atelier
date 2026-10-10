import { readFileSync } from "node:fs";
import { disposeAfterTest } from "./helpers/cleanup.js";
import { describe, expect, it } from "vitest";
import {
	createSidebarPanelRegistry,
	sanitizeSidebarPanelRich,
	SIDEBAR_PANEL_MAX_RICH_NODES,
	SIDEBAR_PANEL_MAX_RICH_SEGMENTS,
	SIDEBAR_PANEL_MAX_RICH_SPANS,
	SIDEBAR_PANEL_MAX_ROW_CHARS,
	type SidebarPanelContribution,
	type SidebarPanelData,
	type SidebarPanelRegistry,
} from "../src/sidebar-panels.js";

const BASE = { id: "vendor:rich", title: "Rich", rows: [{ text: "row" }] } as const;

/** Register through the public registry seam and return the stored (sanitized) panel. */
function stored(rich: unknown, registry?: SidebarPanelRegistry): SidebarPanelData | undefined {
	const target = registry ?? disposeAfterTest(createSidebarPanelRegistry({}));
	const contribution = {
		...BASE,
		...(rich !== undefined ? { rich } : {}),
	} as unknown as SidebarPanelContribution;
	if (!target.register(contribution, "vendor")) throw new Error("contribution was rejected");
	return target.get("vendor:rich");
}

describe("rich contribution sanitization (REQ-ATELIER-002/003/004)", () => {
	it("stores sanitized rich content, cleans text and drops invalid optional fields", () => {
		const data = stored({
			version: 1,
			expanded: [
				{ kind: "text", text: "  hello \u001b[31mred\u0007 world  " },
				{ kind: "spans", spans: [{ text: "x", color: "#ABCDEF" }] },
				{ kind: "keyValue", label: "L", value: "V", valueColor: "#abcdef", labelRole: "nonsense" },
			],
			compact: [{ kind: "text", text: "short" }],
			collapsible: "yes",
		});
		expect(data?.rich?.version).toBe(1);
		expect(data?.rich?.expanded).toEqual([
			{ kind: "text", text: "hello red world" },
			{ kind: "spans", spans: [{ text: "x", color: "#ABCDEF" }] },
			{ kind: "keyValue", label: "L", value: "V", valueColor: "#abcdef" },
		]);
		expect(data?.rich?.compact).toEqual([{ kind: "text", text: "short" }]);
		// Invalid collapsible type is dropped; the rest of the object survives.
		expect(data?.rich?.collapsible).toBeUndefined();
		expect(JSON.stringify(data?.rich)).not.toContain("\u001b");
		expect(data?.rows).toEqual([{ text: "row" }]);
	});

	it("keeps the panel and its mandatory rows while dropping invalid rich entirely", () => {
		const rejectionCases: Array<[string, unknown]> = [
			["wrong version", { version: 2, expanded: [{ kind: "text", text: "ok" }] }],
			["non-array expanded", { version: 1, expanded: "nope" }],
			["unknown node kind", { version: 1, expanded: [{ kind: "iframe", src: "x" }] }],
			["missing text", { version: 1, expanded: [{ kind: "text" }] }],
			["text over 160 chars", { version: 1, expanded: [{ kind: "text", text: "x".repeat(161) }] }],
			[
				"invalid literal color",
				{ version: 1, expanded: [{ kind: "spans", spans: [{ text: "x", color: "red" }] }] },
			],
			[
				"short hex color",
				{ version: 1, expanded: [{ kind: "keyValue", label: "l", value: "v", valueColor: "#12345" }] },
			],
			[
				"escape-sequence color",
				{ version: 1, expanded: [{ kind: "bar", segments: [{ key: "k", value: 1, color: "\u001b[31m" }] }] },
			],
			[
				"NaN segment value",
				{ version: 1, expanded: [{ kind: "bar", segments: [{ key: "k", value: Number.NaN }] }] },
			],
			[
				"negative segment value",
				{ version: 1, expanded: [{ kind: "bar", segments: [{ key: "k", value: -1 }] }] },
			],
			["empty bar", { version: 1, expanded: [{ kind: "bar", segments: [] }] }],
			["negative progress", { version: 1, expanded: [{ kind: "progress", label: "p", current: -5 }] }],
			[
				"infinite progress total",
				{
					version: 1,
					expanded: [{ kind: "progress", label: "p", current: 1, total: Number.POSITIVE_INFINITY }],
				},
			],
			[
				"oversized node list",
				{
					version: 1,
					expanded: Array.from({ length: SIDEBAR_PANEL_MAX_RICH_NODES + 1 }, () => ({ kind: "spacer" })),
				},
			],
			[
				"too many spans",
				{
					version: 1,
					expanded: [
						{
							kind: "spans",
							spans: Array.from({ length: SIDEBAR_PANEL_MAX_RICH_SPANS + 1 }, () => ({ text: "x" })),
						},
					],
				},
			],
			[
				"too many segments",
				{
					version: 1,
					expanded: [
						{
							kind: "bar",
							segments: Array.from({ length: SIDEBAR_PANEL_MAX_RICH_SEGMENTS + 1 }, () => ({
								key: "k",
								value: 1,
							})),
						},
					],
				},
			],
			["missing expanded", { version: 1 }],
		];
		for (const [name, rich] of rejectionCases) {
			const data = stored(rich);
			expect(data, name).toBeDefined();
			expect(data?.rich, name).toBeUndefined();
			expect(data?.rows, name).toEqual([{ text: "row" }]);
		}
	});

	it("drops only the optional compact representation when compact is invalid", () => {
		const data = stored({
			version: 1,
			expanded: [{ kind: "text", text: "ok" }],
			compact: [{ kind: "bar", segments: [] }],
		});
		expect(data?.rich?.expanded).toEqual([{ kind: "text", text: "ok" }]);
		expect(data?.rich?.compact).toBeUndefined();
	});

	it("leaves row-only contributions untouched (rich key absent)", () => {
		const data = stored(undefined);
		expect(data).toBeDefined();
		expect(data && "rich" in data).toBe(false);
	});

	it("ignores unknown node fields instead of recursing into them", () => {
		const data = stored({
			version: 1,
			expanded: [
				{
					kind: "text",
					text: "flat",
					child: { kind: "text", text: "never rendered" },
					expanded: [{ kind: "text", text: "never rendered" }],
				},
			],
		});
		expect(data?.rich?.expanded).toEqual([{ kind: "text", text: "flat" }]);
	});

	it("bounds rich text at the row limit", () => {
		expect(SIDEBAR_PANEL_MAX_ROW_CHARS).toBe(160);
		const exact = stored({ version: 1, expanded: [{ kind: "text", text: "x".repeat(160) }] });
		expect(exact?.rich?.expanded).toHaveLength(1);
		const raw = stored({ version: 1, expanded: [{ kind: "text", text: "x".repeat(8 * 161) }] });
		expect(raw?.rich).toBeUndefined();
	});

	it("exposes stable rich bounds and a direct sanitizer", () => {
		expect(SIDEBAR_PANEL_MAX_RICH_NODES).toBe(48);
		expect(SIDEBAR_PANEL_MAX_RICH_SPANS).toBe(16);
		expect(SIDEBAR_PANEL_MAX_RICH_SEGMENTS).toBe(16);
		expect(sanitizeSidebarPanelRich({ version: 1, expanded: [] })).toEqual({ version: 1, expanded: [] });
		expect(sanitizeSidebarPanelRich({ version: 1 })).toBeUndefined();
		expect(sanitizeSidebarPanelRich("nope")).toBeUndefined();
	});
});

describe("rich registry lifecycle (REQ-ATELIER-002/006)", () => {
	it("returns deep clones so callers cannot mutate registry state", () => {
		const registry = disposeAfterTest(createSidebarPanelRegistry({}));
		const input = { version: 1, expanded: [{ kind: "text", text: "original" }] };
		stored(input, registry);
		// Mutating the producer input after registration changes nothing.
		(input.expanded[0] as { text: string }).text = "changed";
		expect(registry.get("vendor:rich")?.rich?.expanded[0]).toEqual({ kind: "text", text: "original" });
		// Mutating a returned clone changes nothing either.
		const first = registry.get("vendor:rich");
		(first?.rich?.expanded[0] as { text: string }).text = "mutated";
		expect(registry.get("vendor:rich")?.rich?.expanded[0]).toEqual({ kind: "text", text: "original" });
	});

	it("folds rich content into the change-equality gate", () => {
		const registry = disposeAfterTest(createSidebarPanelRegistry({}));
		expect(stored({ version: 1, expanded: [{ kind: "text", text: "a" }] }, registry)).toBeDefined();
		// Identical rich must be treated as unchanged.
		expect(
			registry.register({ ...BASE, rich: { version: 1, expanded: [{ kind: "text", text: "a" }] } }, "vendor"),
		).toBe(false);
		// Changed rich must register as an update.
		expect(
			registry.register({ ...BASE, rich: { version: 1, expanded: [{ kind: "text", text: "b" }] } }, "vendor"),
		).toBe(true);
		expect(registry.get("vendor:rich")?.rich?.expanded[0]).toEqual({ kind: "text", text: "b" });
	});
});

describe("old/new compatibility (VAL-016)", () => {
	it("rich+rows through the old V1 sanitizer keeps rows and discards rich", () => {
		// The pre-IMPL-007 (protocol-v1) sanitizer read only the known fields
		// id/title/rows/role and ignored everything else; reproduce that
		// contract as the old-Atelier fixture.
		const v1Only = (value: Record<string, unknown>): Record<string, unknown> => ({
			id: value.id,
			title: value.title,
			rows: (value.rows as Array<string | { text: string }>).map((row) => ({
				text: typeof row === "string" ? row : row.text,
			})),
			...(typeof value.role === "string" ? { role: value.role } : {}),
		});
		const contribution = {
			id: "vendor:rich",
			title: "Rich",
			rows: ["kept"],
			role: "ready",
			rich: { version: 1, expanded: [{ kind: "text", text: "x" }] },
		};
		const old = v1Only(contribution);
		expect(old.rows).toEqual([{ text: "kept" }]);
		expect("rich" in old).toBe(false);
		// The new Atelier keeps both representations for the same payload.
		const registry = disposeAfterTest(createSidebarPanelRegistry({}));
		expect(registry.register(contribution as unknown as SidebarPanelContribution, "vendor")).toBe(true);
		const data = registry.get("vendor:rich");
		expect(data?.rows).toEqual([{ text: "kept" }]);
		expect(data?.rich?.expanded).toEqual([{ kind: "text", text: "x" }]);
	});
});

describe("public surface", () => {
	it("exports no CortexKit/AFT/Magic Context concepts from Atelier public modules", () => {
		const exported: string[] = [];
		for (const file of ["src/sidebar-panels.ts", "src/types.ts", "src/palette.ts"]) {
			const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
			for (const match of source.matchAll(
				/export\s+(?:type|interface|function|const|enum)\s+([A-Za-z0-9_]+)/g,
			)) {
				exported.push(match[1] as string);
			}
		}
		expect(exported.length).toBeGreaterThan(20);
		const offenders = exported.filter((name) =>
			/\b(cortex|cortexkit|aft|magic[-_ ]?context|magiccontext)\b/i.test(name),
		);
		expect(offenders).toEqual([]);
	});
});

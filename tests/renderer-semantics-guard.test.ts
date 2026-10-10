/**
 * Renderer semantics guard ("Magic Context owns the sidebar semantics").
 *
 * The bridge-side half of this guard lives in `omp-sidepanel-bridge`, and the
 * vocabulary both halves defend is defined once in `sidepanel-semantics/src`.
 * This repo cannot reach either of those: it is its own repository, and
 * cloning it must not require the monorepo. So it defends against the portable
 * copy — `tests/fixtures/sidepanel-semantics.json` — which the bridge
 * regenerates (`npm run update:semantics`) and verifies is byte-identical to
 * the module it came from.
 *
 * The rule it enforces here is narrow and specific to a renderer: Atelier draws
 * what it is given, so the moment it *authors* a word Magic Context chose — a
 * fallback label, a default section title, a placeholder for a missing value —
 * the two hosts can disagree while every other test still passes. That is the
 * failure this file exists to make impossible.
 *
 * Words, but not marks. The snapshot separates the producer's words from the
 * glyphs it draws with, because putting a glyph on a screen is precisely this
 * layer's job — the first run of this guard found three of its own (`█` `░`
 * `✓`) and was right to. The bridge, which only chooses primitives, bans both.
 *
 * Only the renderer surface is scanned. Atelier's own vocabulary ("Tokens",
 * node kinds, role names) is not producer vocabulary, and none of it is in the
 * banned list.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const SNAPSHOT = fileURLToPath(new URL("./fixtures/sidepanel-semantics.json", import.meta.url));
const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** The files that turn a contributed panel into pixels and text. */
const RENDERER_SOURCES = ["sidebar.ts", "sidebar-panels.ts"];

interface SemanticsSnapshot {
	$comment: string;
	producer: { path: string; sha256: string };
	producerOwned: string[];
	/** Producer words a host may legitimately reuse, each with a stated reason. */
	producerLiteralsAHostMayReuse: string[];
	producerGlyphs: string[];
	contractEnum: string[];
	nonDisplay: string[];
	hostOwned: string[];
	snapshotFields: string[];
	sectionKeys: string[];
	requiredViewFields: string[];
	/** Straight from the producer's declarations: the generated half. */
	viewContractDeclared: Record<string, string[]>;
	/** Generated minus acknowledged: the effective half. */
	viewContract: Record<string, string[]>;
	/** What consumers deliberately drop, and why. */
	acknowledged: Record<string, string>;
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as SemanticsSnapshot;

const reusable = new Set(snapshot.producerLiteralsAHostMayReuse ?? []);

/**
 * Every string literal in the source, unquoted, including the static parts of
 * template literals.
 *
 * A local copy of the bridge's scanner, on purpose: sharing the scanner would
 * mean importing across a repository boundary, which is the exact coupling
 * this vendored copy exists to avoid. What actually drifts is the vocabulary,
 * and that is shared.
 */
function stringLiterals(code: string): string[] {
	const source = ts.createSourceFile("scanned.ts", code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	const found: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			found.push(node.text);
		} else if (ts.isTemplateExpression(node)) {
			found.push(node.head.text);
			for (const span of node.templateSpans) found.push(span.literal.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

/** Producer-owned WORDS present in the source, trimmed on both sides. */
function producerWordsAuthored(code: string): string[] {
	const authored = new Set(stringLiterals(code).map((literal) => literal.trim()));
	// A word the producer owns AND the host may reuse is not a violation: the
	// shared contract records why, and `producerLiteralsAHostMayReuse` is that
	// record. Both hosts really can own the same plain-English phrase.
	return snapshot.producerOwned.filter((literal) => authored.has(literal) && !reusable.has(literal));
}

describe("renderer semantics guard: Atelier draws, it does not narrate", () => {
	it("authors none of Magic Context's labels, titles, statuses or phases", () => {
		for (const name of RENDERER_SOURCES) {
			expect(
				producerWordsAuthored(readFileSync(join(SRC, name), "utf8")),
				`src/${name} displays text Magic Context never chose — render what you are given, ` +
					`or leave the element out`,
			).toEqual([]);
		}
	});

	it("would catch a producer word planted in the renderer", () => {
		// A guard nobody has watched go off is indistinguishable from no guard.
		const planted = 'const fallback = { label: "Archived compartments" };';
		expect(producerWordsAuthored(planted)).toEqual(["Archived compartments"]);
		// ...including when it is assembled rather than quoted.
		const composed = "const caption = `${pct}% · native compaction`;";
		expect(producerWordsAuthored(composed)).toEqual(["% · native compaction"]);
	});

	it("does not fire on the host's own vocabulary", () => {
		// Guards the guard against becoming so broad that the only way to satisfy
		// it is to delete the renderer.
		const own = 'nodes.push({ kind: "keyValue", label: "Tokens" });';
		expect(producerWordsAuthored(own)).toEqual([]);
	});

	it("carves the drawer's own glyphs out explicitly", () => {
		// The split between "words the producer chose" and "marks the drawer
		// draws" is the reason this guard can exist at all, so it is asserted
		// rather than assumed: no glyph may be both excused here and banned in
		// the bridge.
		expect(snapshot.producerGlyphs.length).toBeGreaterThan(0);
		expect(snapshot.producerOwned.filter((literal) => snapshot.producerGlyphs.includes(literal))).toEqual([]);
	});

	it("vendors a structurally sound contract", () => {
		// Everything the Atelier guard can verify without the monorepo. The rest
		// — that these entries match Magic Context's real source — is verified in
		// the bridge, which can see both sides.
		for (const [name, values] of Object.entries(snapshot)) {
			if (!Array.isArray(values)) continue;
			expect(values, `${name} must not be empty`).not.toEqual([]);
			for (const value of values) {
				expect(value, `${name} has a blank entry`).not.toBe("");
				expect(value, `${name} entry "${value}" is not trimmed`).toBe(value.trim());
			}
			expect(new Set(values).size, `${name} has duplicates`).toBe(values.length);
		}

		// Deliberately NOT `producerLiteralsAHostMayReuse`: overlap with
		// producerOwned is that list's entire meaning -- a word the producer
		// owns that the host may also say. The lists below are words the
		// producer never owns, so an overlap there really would be a
		// contradiction.
		const excused = [...snapshot.contractEnum, ...snapshot.nonDisplay, ...snapshot.hostOwned];
		expect(
			snapshot.producerOwned.filter((literal) => excused.includes(literal)),
			"a value cannot be both banned and excused",
		).toEqual([]);
	});

	it("keeps the acknowledgement ledger honest", () => {
		// The ledger is the only hand-written part of the view contract, so it
		// is the part that can rot. Both checks below are possible offline:
		// every acknowledgement must point at something the generated shape
		// declares, and none of them may still be offered to consumers.
		expect(Object.keys(snapshot.acknowledged).length).toBeGreaterThan(0);

		for (const [path, reason] of Object.entries(snapshot.acknowledged)) {
			expect(reason.trim(), `${path} is acknowledged with no reason`).not.toBe("");
			const [owner = "", ...rest] = path.split(".");
			expect(
				snapshot.viewContractDeclared[owner] ?? [],
				`${path} is acknowledged, but the recorded producer shape does not declare it`,
			).toContain(rest.join("."));
		}

		const stillOffered = Object.entries(snapshot.viewContract).flatMap(([owner, fields]) =>
			fields
				.filter((field) =>
					Object.keys(snapshot.acknowledged).some(
						(acknowledged) =>
							acknowledged === `${owner}.${field}` || `${owner}.${field}`.startsWith(`${acknowledged}.`),
					),
				)
				.map((field) => `${owner}.${field}`),
		);
		expect(stillOffered, "an acknowledged field is still offered to consumers").toEqual([]);
	});

	it("records which producer revision the vocabulary came from", () => {
		// Not verifiable here — that is the point. It travels with the file so a
		// reader can tell how old the contract is without running the bridge.
		expect(snapshot.producer.path).toBe("magic-context/packages/plugin/src/shared/sidebar-view.ts");
		expect(snapshot.producer.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(Object.keys(snapshot.viewContract).length).toBeGreaterThan(0);
		// The generated half must be a superset of the effective half, or the
		// snapshot was hand-edited.
		for (const [owner, fields] of Object.entries(snapshot.viewContract)) {
			for (const field of fields) {
				expect(snapshot.viewContractDeclared[owner] ?? []).toContain(field);
			}
		}
	});
});

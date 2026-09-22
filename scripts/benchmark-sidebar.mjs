// Opt-in timing probe, not a TUI correctness test. Run from any directory:
// node scripts/benchmark-sidebar.mjs
// node scripts/benchmark-sidebar.mjs --ref <baseline-commit>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--ref")) {
	throw new Error("Usage: node scripts/benchmark-sidebar.mjs [--ref <baseline-commit>]");
}
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trimEnd();
const revision = args[1] ? git("rev-parse", "--verify", `${args[1]}^{commit}`) : undefined;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-sidebar-bench-"));
const load = (file) => import(pathToFileURL(path.join(directory, "src", file)).href);
const round = (number) => Number(number.toFixed(4));

try {
	fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
	fs.symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
	fs.mkdirSync(path.join(directory, "src"));
	const files = revision
		? git("ls-tree", "--name-only", `${revision}:src`).split("\n")
		: fs.readdirSync(path.join(root, "src"));
	for (const file of files.filter((file) => file.endsWith(".ts"))) {
		const source = revision
			? git("show", `${revision}:src/${file}`)
			: fs.readFileSync(path.join(root, "src", file), "utf8");
		fs.writeFileSync(
			path.join(directory, "src", file.replace(/\.ts$/, ".js")),
			ts.transpileModule(source, {
				compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
			}).outputText,
		);
	}
	const { buildSidebarSnapshot, renderSidebarLines } = await load("sidebar.js");
	const { createInertAtelierState } = await load("state.js");
	const { DEFAULT_CONFIG } = await load("types.js");
	const theme = { name: "dark", fg: (_role, text) => text, bold: (text) => text, italic: (text) => text };
	const results = {
		source: revision ?? "working-tree",
		node: process.version,
		platform: `${process.platform}/${process.arch}`,
		width: 40,
		height: 40,
		warmups: 3,
		samples: 10,
		rendering: [],
	};
	for (const count of [0, 8, 64]) {
		const panels = Array.from({ length: count }, (_, index) => ({
			id: `bench:p${index}`,
			title: `Panel ${index}`,
			available: true,
			source: "bench",
			rows: Array.from({ length: 24 }, (_, row) => ({ text: `row ${row} ${"x".repeat(140)}` })),
		}));
		const snapshot = buildSidebarSnapshot({
			state: createInertAtelierState(),
			cwd: "/repo",
			branchEntryCount: 1_000,
			activeToolCount: 5,
			availableToolCount: 5,
			extensionStatuses: [],
			sidebarPanels: panels,
		});
		const config = {
			...DEFAULT_CONFIG,
			sidebarPanelLayout: [
				...DEFAULT_CONFIG.sidebarPanelLayout,
				...panels.map((panel) => ({ id: panel.id, visible: true })),
			],
		};
		const render = () =>
			renderSidebarLines(snapshot, config, theme, results.width, results.height, false, 1_000);
		for (let index = 0; index < results.warmups; index++) render();
		const samples = [];
		for (let index = 0; index < results.samples; index++) {
			const start = performance.now();
			render();
			samples.push(performance.now() - start);
		}
		const sorted = [...samples].sort((a, b) => a - b);
		results.rendering.push({
			panels: count,
			medianMs: round((sorted[4] + sorted[5]) / 2),
			minMs: round(sorted[0]),
			maxMs: round(sorted.at(-1)),
			samplesMs: samples.map(round),
		});
	}
	console.log(JSON.stringify(results, null, 2));
} finally {
	fs.rmSync(directory, { recursive: true, force: true });
}

// Opt-in timing probe, not a TUI correctness test. Run from any directory:
// npm run bench:sidebar
// npm run bench:sidebar -- --ref <baseline-commit>
import { performance } from "node:perf_hooks";
import { createSourceSandbox, parseRefArgument, round, stats } from "./lib/source-sandbox.mjs";

const revision = parseRefArgument("node scripts/benchmark-sidebar.mjs [--ref <baseline-commit>]");
const WARMUPS = 3;
const SAMPLES = 10;
const sandbox = createSourceSandbox("atelier-sidebar-bench-", revision);

try {
	const { buildSidebarSnapshot, renderSidebarLines } = await sandbox.load("sidebar.js");
	const { createInertAtelierState } = await sandbox.load("state.js");
	// Older revisions kept DEFAULT_CONFIG in types.ts and took positional render options.
	const currentApi = (await sandbox.load("config.js")).DEFAULT_CONFIG !== undefined;
	const { DEFAULT_CONFIG } = await sandbox.load(currentApi ? "config.js" : "types.js");
	const theme = { name: "dark", fg: (_role, text) => text, bold: (text) => text, italic: (text) => text };
	const results = {
		source: revision ?? "working-tree",
		node: process.version,
		platform: `${process.platform}/${process.arch}`,
		width: 40,
		height: 40,
		warmups: WARMUPS,
		samples: SAMPLES,
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
			state: createInertAtelierState(null),
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
		const render = currentApi
			? () =>
					renderSidebarLines(snapshot, config, theme, results.width, results.height, {
						colorEnabled: false,
						now: 1_000,
					})
			: () => renderSidebarLines(snapshot, config, theme, results.width, results.height, false, 1_000);
		for (let index = 0; index < WARMUPS; index++) render();
		const samples = [];
		for (let index = 0; index < SAMPLES; index++) {
			const start = performance.now();
			render();
			samples.push(performance.now() - start);
		}
		results.rendering.push({ panels: count, ...stats(samples), samplesMs: samples.map(round) });
	}
	console.log(JSON.stringify(results, null, 2));
} finally {
	sandbox.dispose();
}

// THROWAWAY: browser comparison of actual terminal-renderer output, or isolated live Pi.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv[2] === "--live") {
	const result = spawnSync(
		path.join(root, "node_modules/.bin/pi"),
		["--no-session", "--no-extensions", "-e", path.join(root, "extensions/index.ts")],
		{
			stdio: "inherit",
			cwd: root,
			env: { ...process.env, PI_ATELIER_SIDEBAR_DESIGN: process.argv[3] ?? "A" },
		},
	);
	process.exit(result.status ?? 1);
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-sidebar-prototype-"));
fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
fs.symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
fs.mkdirSync(path.join(directory, "src"));
for (const file of fs.readdirSync(path.join(root, "src")).filter((file) => file.endsWith(".ts"))) {
	fs.writeFileSync(
		path.join(directory, "src", file.replace(/\.ts$/, ".js")),
		ts.transpileModule(fs.readFileSync(path.join(root, "src", file), "utf8"), {
			compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
		}).outputText,
	);
}
const load = (file) => import(pathToFileURL(path.join(directory, "src", file)).href);
const { buildSidebarSnapshot, renderSidebarLines } = await load("sidebar.js");
const { createInertAtelierState } = await load("state.js");
const { DEFAULT_CONFIG } = await load("types.js");
const theme = {
	name: "dark",
	fg: (_role, text) => text,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
	italic: (text) => text,
};
const escape = (text) =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
function ansiHtml(text) {
	let color = "inherit";
	let bold = false;
	let html = "";
	for (const part of text.split(/(\x1b\[[0-9;]*m)/)) {
		if (part.startsWith("\x1b[")) {
			const code = part.slice(2, -1);
			if (code.startsWith("38;2;")) color = `rgb(${code.slice(5).replaceAll(";", ",")})`;
			if (code === "39" || code === "0") color = "inherit";
			if (code === "1") bold = true;
			if (code === "22" || code === "0") bold = false;
		} else html += `<span style="color:${color};font-weight:${bold ? 600 : 400}">${escape(part)}</span>`;
	}
	return html;
}
function fixture(stateName) {
	const active = stateName === "active" || stateName === "warning";
	const low = stateName === "low";
	const warning = stateName === "warning";
	const state = createInertAtelierState();
	Object.assign(state, {
		activity: active ? "working" : "ready",
		modelId: "gpt-5.6-sol",
		provider: "openai-codex",
		thinkingLevel: "off",
		branch: "main",
		workspacePulse: {
			status: warning ? "conflict" : "changed",
			data: {
				root: "/repo/pi-atelier",
				relativeCwd: "",
				branch: "main",
				snapshot: {
					trackedFiles: 1,
					untrackedFiles: 5,
					linesAdded: 0,
					linesRemoved: 4,
					binaryFiles: 0,
					submodules: 0,
					conflicts: warning ? 1 : 0,
				},
			},
		},
	});
	Object.assign(state.metrics, {
		subscription: true,
		contextTokens: warning ? 250240 : active ? 48320 : low ? 3536 : 0,
		contextWindow: 272000,
		contextPercent: warning ? 92 : active ? 17.8 : low ? 1.3 : 0,
		usageAvailable: active,
		input: 1820,
		output: 864,
		cacheRead: 46500,
		cacheHitPercent: 96.2,
	});
	return buildSidebarSnapshot({
		state,
		cwd: "/repo/pi-atelier",
		sessionFile: "/fixture/session.jsonl",
		branchEntryCount: active ? 24 : 2,
		activeToolCount: 16,
		availableToolCount: 20,
		activeToolNames: ["bash", "read", "edit", "write"],
		extensionStatuses: warning ? ["Provider degraded"] : [],
		...(active
			? {
					runActivity: {
						phase: "running",
						turnNumber: 3,
						startedAt: 1000,
						performance: { ttftMs: 820, tokensPerSecond: 48.2, estimated: true },
						activeTools: [
							{ id: "one", name: "read", summary: "src/sidebar.ts", status: "running", startedAt: 31000 },
						],
						recentTools: [],
						completedCount: 3,
						failedCount: 0,
					},
				}
			: {}),
	});
}
const page = fs.readFileSync(path.join(root, "src/sidebar-design-prototype.html"), "utf8");
const server = http.createServer((request, response) => {
	const url = new URL(request.url, "http://localhost");
	if (url.pathname === "/render") {
		const design = url.searchParams.get("variant") ?? "A";
		process.env.PI_ATELIER_SIDEBAR_DESIGN = ["A", "B", "C", "original"].includes(design) ? design : "A";
		const width = Math.min(60, Math.max(26, Number(url.searchParams.get("width")) || 32));
		const height = Math.min(70, Math.max(18, Number(url.searchParams.get("height")) || 48));
		const lines = renderSidebarLines(
			fixture(url.searchParams.get("state") ?? "idle"),
			DEFAULT_CONFIG,
			theme,
			width,
			height,
			true,
			34000,
		);
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(ansiHtml(lines.join("\n")));
	} else {
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(page);
	}
});
server.listen(4319, "127.0.0.1", () =>
	console.log(
		"Sidebar prototype: http://127.0.0.1:4319/?variant=A\nCtrl-C to stop. Live Pi: npm run prototype:sidebar -- --live A",
	),
);
function cleanup() {
	fs.rmSync(directory, { recursive: true, force: true });
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
	server.close();
	process.exit(0);
});
process.on("SIGTERM", () => {
	server.close();
	process.exit(0);
});

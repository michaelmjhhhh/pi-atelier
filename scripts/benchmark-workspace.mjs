import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
// Opt-in Git inspection benchmark; fixtures live only in a temporary directory.
// Run from the repository root; --ref compares an earlier source revision.
const root = process.cwd();
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--ref"))
	throw Error("Usage: node scripts/benchmark-workspace.mjs [--ref <commit>]");
const ref = args[1];
const ts = (await import(pathToFileURL(path.join(root, "node_modules/typescript/lib/typescript.js"))))
	.default;
const run = promisify(execFile);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-git-profile-"));
const git = (cwd, args) => run("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const median = (a) => {
	const s = [...a].sort((a, b) => a - b);
	return (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2;
};
const stats = (a) => ({ medianMs: median(a), minMs: Math.min(...a), maxMs: Math.max(...a) });
try {
	fs.writeFileSync(path.join(temp, "package.json"), '{"type":"module"}');
	fs.symlinkSync(path.join(root, "node_modules"), path.join(temp, "node_modules"), "dir");
	fs.mkdirSync(path.join(temp, "src"));
	for (const file of fs.readdirSync(path.join(root, "src")).filter((x) => x.endsWith(".ts"))) {
		fs.writeFileSync(
			path.join(temp, "src", file.replace(/\.ts$/, ".js")),
			ts.transpileModule(
				ref
					? (await git(root, ["show", `${ref}:src/${file}`])).stdout
					: fs.readFileSync(path.join(root, "src", file), "utf8"),
				{ compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } },
			).outputText,
		);
	}
	const { inspectWorkspacePulse } = await import(pathToFileURL(path.join(temp, "src/workspace-pulse.js")));
	const results = {
		source: ref ?? "working-tree",
		revision: (await git(root, ["rev-parse", ref ?? "HEAD"])).stdout.trim(),
		node: process.version,
		platform: `${process.platform}/${process.arch}`,
		git: (await git(root, ["--version"])).stdout.trim(),
		warmups: 3,
		samples: 15,
		cases: [],
	};
	async function profile(name, cwd) {
		const samples = [];
		for (let n = -3; n < 15; n++) {
			const commands = [];
			const start = performance.now();
			const result = await inspectWorkspacePulse({
				cwd,
				exec: async (command, args, options) => {
					const begin = performance.now();
					let out;
					try {
						out = {
							...(await run(command, args, { ...options, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })),
							code: 0,
							killed: false,
						};
					} catch (e) {
						out = {
							stdout: e.stdout ?? "",
							stderr: e.stderr ?? "",
							code: typeof e.code === "number" ? e.code : 1,
							killed: Boolean(e.killed),
						};
					}
					commands.push({ args, ms: performance.now() - begin });
					return out;
				},
			});
			if (result.kind !== "available") throw Error(`${name}: ${result.kind}`);
			if (n >= 0) samples.push({ totalMs: performance.now() - start, commands });
		}
		results.cases.push({
			name,
			total: stats(samples.map((s) => s.totalMs)),
			commandCount: samples[0].commands.length,
			commands: ["discovery", "status", "head", "diff"]
				.slice(0, samples[0].commands.length)
				.map((name, i) => ({ name, ...stats(samples.map((s) => s.commands[i].ms)) })),
			samples,
		});
	}
	await profile("current-checkout", root);
	const fixture = path.join(temp, "fixture");
	fs.mkdirSync(fixture);
	await git(fixture, ["init", "-q"]);
	const content = "baseline line\n".repeat(100);
	for (let i = 0; i < 10000; i++) fs.writeFileSync(path.join(fixture, `tracked-${i}.txt`), content);
	await git(fixture, ["add", "."]);
	await git(fixture, [
		"-c",
		"user.name=Benchmark",
		"-c",
		"user.email=benchmark@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		"fixture",
	]);
	await profile("10000-tracked-clean", fixture);
	for (let i = 0; i < 100; i++)
		fs.appendFileSync(path.join(fixture, `tracked-${i}.txt`), "added line\n".repeat(100));
	await profile("10000-tracked-100-modified", fixture);
	for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(fixture, `tracked-${i}.txt`), content);
	for (let i = 0; i < 5000; i++) fs.writeFileSync(path.join(fixture, `untracked-${i}.txt`), "untracked\n");
	await profile("10000-tracked-5000-untracked", fixture);
	console.log(JSON.stringify(results, null, 2));
} finally {
	fs.rmSync(temp, { recursive: true, force: true });
}

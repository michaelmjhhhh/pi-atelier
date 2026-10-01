// Opt-in Git inspection benchmark; fixtures live only in a temporary directory.
// npm run bench:workspace
// npm run bench:workspace -- --ref <baseline-commit>
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { createSourceSandbox, git, parseRefArgument, repositoryRoot, stats } from "./lib/source-sandbox.mjs";

const revision = parseRefArgument("node scripts/benchmark-workspace.mjs [--ref <baseline-commit>]");
const WARMUPS = 3;
const SAMPLES = 15;
const COMMAND_NAMES = ["discovery", "status", "head", "diff"];
const MAX_BUFFER = 16 * 1024 * 1024;
const run = promisify(execFile);
const sandbox = createSourceSandbox("atelier-git-profile-", revision);
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-git-fixture-"));

/** Pi's exec contract: resolve with the exit code instead of rejecting. */
async function exec(command, args, options) {
	try {
		return {
			...(await run(command, args, { ...options, encoding: "utf8", maxBuffer: MAX_BUFFER })),
			code: 0,
			killed: false,
		};
	} catch (error) {
		return {
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? "",
			code: typeof error.code === "number" ? error.code : 1,
			killed: Boolean(error.killed),
		};
	}
}

try {
	const { inspectWorkspacePulse } = await sandbox.load("workspace-pulse.js");
	const results = {
		source: revision ?? "working-tree",
		revision: revision ?? git(repositoryRoot, "rev-parse", "HEAD"),
		node: process.version,
		platform: `${process.platform}/${process.arch}`,
		git: git(repositoryRoot, "--version"),
		warmups: WARMUPS,
		samples: SAMPLES,
		cases: [],
	};
	async function profile(name, cwd) {
		const samples = [];
		for (let iteration = 0; iteration < WARMUPS + SAMPLES; iteration++) {
			const commands = [];
			const start = performance.now();
			const result = await inspectWorkspacePulse({
				cwd,
				exec: async (command, args, options) => {
					const begin = performance.now();
					const output = await exec(command, args, options);
					commands.push(performance.now() - begin);
					return output;
				},
			});
			if (result.kind !== "available") throw new Error(`${name}: ${result.kind}`);
			if (iteration >= WARMUPS) samples.push({ totalMs: performance.now() - start, commands });
		}
		results.cases.push({
			name,
			total: stats(samples.map((sample) => sample.totalMs)),
			commands: samples[0].commands.map((_, index) => ({
				name: COMMAND_NAMES[index] ?? `command-${index}`,
				...stats(samples.map((sample) => sample.commands[index])),
			})),
		});
	}

	await profile("current-checkout", repositoryRoot);
	const fixture = path.join(fixtureRoot, "repository");
	fs.mkdirSync(fixture);
	git(fixture, "init", "-q");
	const content = "baseline line\n".repeat(100);
	for (let index = 0; index < 10_000; index++)
		fs.writeFileSync(path.join(fixture, `tracked-${index}.txt`), content);
	git(fixture, "add", ".");
	git(
		fixture,
		"-c",
		"user.name=Benchmark",
		"-c",
		"user.email=benchmark@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		"fixture",
	);
	await profile("10000-tracked-clean", fixture);
	for (let index = 0; index < 100; index++)
		fs.appendFileSync(path.join(fixture, `tracked-${index}.txt`), "added line\n".repeat(100));
	await profile("10000-tracked-100-modified", fixture);
	for (let index = 0; index < 100; index++)
		fs.writeFileSync(path.join(fixture, `tracked-${index}.txt`), content);
	for (let index = 0; index < 5_000; index++)
		fs.writeFileSync(path.join(fixture, `untracked-${index}.txt`), "untracked\n");
	await profile("10000-tracked-5000-untracked", fixture);
	console.log(JSON.stringify(results, null, 2));
} finally {
	sandbox.dispose();
	fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

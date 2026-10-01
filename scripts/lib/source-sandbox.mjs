// Shared harness for the opt-in benchmarks: transpile src/ from the working tree
// or a Git revision into a temporary module directory that can be imported.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export const git = (cwd, ...args) =>
	execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trimEnd();

/** `--ref <commit>` is the only accepted argument; returns the resolved revision, if any. */
export function parseRefArgument(usage) {
	const args = process.argv.slice(2);
	if (args.length !== 0 && (args.length !== 2 || args[0] !== "--ref")) throw new Error(`Usage: ${usage}`);
	return args[1] ? git(repositoryRoot, "rev-parse", "--verify", `${args[1]}^{commit}`) : undefined;
}

/** Transpiles every src/*.ts at `revision` (or the working tree) into a temporary directory. */
export function createSourceSandbox(prefix, revision) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
	fs.symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(directory, "node_modules"), "dir");
	fs.mkdirSync(path.join(directory, "src"));
	const files = revision
		? git(repositoryRoot, "ls-tree", "--name-only", `${revision}:src`).split("\n")
		: fs.readdirSync(path.join(repositoryRoot, "src"));
	for (const file of files.filter((name) => name.endsWith(".ts"))) {
		const source = revision
			? git(repositoryRoot, "show", `${revision}:src/${file}`)
			: fs.readFileSync(path.join(repositoryRoot, "src", file), "utf8");
		fs.writeFileSync(
			path.join(directory, "src", file.replace(/\.ts$/, ".js")),
			ts.transpileModule(source, {
				compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
			}).outputText,
		);
	}
	return {
		directory,
		has: (file) => fs.existsSync(path.join(directory, "src", file)),
		load: (file) => import(pathToFileURL(path.join(directory, "src", file)).href),
		dispose: () => fs.rmSync(directory, { recursive: true, force: true }),
	};
}

export const round = (value) => Number(value.toFixed(4));

export function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}

export const stats = (values) => ({
	medianMs: round(median(values)),
	minMs: round(Math.min(...values)),
	maxMs: round(Math.max(...values)),
});

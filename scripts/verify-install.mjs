import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
const tempDir = mkdtempSync(join(tmpdir(), "pi-atelier-install-"));

function npm(args, cwd) {
	const result = spawnSync("npm", args, { cwd, encoding: "utf8" });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`npm ${args.join(" ")} failed (${result.signal ?? result.status})\n${result.stdout}${result.stderr}`,
		);
	}
	return result.stdout;
}

try {
	const [packed] = JSON.parse(npm(["pack", "--json", "--pack-destination", tempDir], repoDir));
	const consumerDir = join(tempDir, "consumer");
	mkdirSync(consumerDir);
	writeFileSync(
		join(consumerDir, "package.json"),
		JSON.stringify({ name: "pi-atelier-install-check", private: true }),
	);
	npm(
		["install", "--legacy-peer-deps=false", "--include=peer", "--no-fund", join(tempDir, packed.filename)],
		consumerDir,
	);
	const lock = JSON.parse(readFileSync(join(consumerDir, "package-lock.json"), "utf8"));
	const unexpected = Object.keys(lock.packages).filter(
		(path) => path !== "" && path !== "node_modules/pi-atelier",
	);
	assert.equal(
		unexpected.length,
		0,
		`Installation pulled in ${unexpected.length} unexpected dependencies: ${unexpected.slice(0, 10).join(", ")}`,
	);
	assert.ok(lock.packages["node_modules/pi-atelier"], "Packed pi-atelier was not installed");
	npm(["audit", "--audit-level=low"], consumerDir);

	process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
	const { loadExtensions } = await import(
		"../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"
	);
	const packageDir = join(consumerDir, "node_modules", "pi-atelier");
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	const entries = manifest.pi.extensions.map((path) => join(packageDir, path));
	const result = await loadExtensions(entries, consumerDir);
	assert.deepEqual(result.errors, [], "Packed extension failed to load with host-provided Pi dependencies");
	assert.equal(result.extensions.length, entries.length);
	assert.ok(
		result.extensions.some((extension) => extension.commands.has("atelier")),
		"Atelier did not initialize",
	);
	console.log(
		"Package install verified (no transitive dependencies, audit clean, host loader initialized Atelier)",
	);
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}

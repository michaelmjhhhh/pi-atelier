// The packed file set must be exactly the tracked files named by package.json `files`.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const result = spawnSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
if (result.status !== 0) {
	process.stderr.write(result.stderr);
	process.exit(result.status ?? 1);
}
const packed = new Set(JSON.parse(result.stdout)[0].files.map((file) => file.path));
const tracked = execFileSync("git", ["ls-files", "--", ...pkg.files], { encoding: "utf8" })
	.split("\n")
	.filter(Boolean);
const expected = new Set(["package.json", ...tracked]);
const missing = [...expected].filter((path) => !packed.has(path));
const unexpected = [...packed].filter((path) => !expected.has(path));
if (missing.length > 0 || unexpected.length > 0) {
	throw new Error(
		`Package contents differ from package.json files.\nMissing: ${missing.join(", ") || "none"}\nUnexpected: ${unexpected.join(", ") || "none"}`,
	);
}
console.log(`Package contents verified (${packed.size} files)`);

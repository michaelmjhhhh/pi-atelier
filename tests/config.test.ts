import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, saveUserConfig, validateConfig } from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/types.js";

let root: string;
let userPath: string;
let projectPath: string;

const writeJson = (path: string, value: unknown) => writeFile(path, JSON.stringify(value), "utf8");

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-atelier-"));
	userPath = join(root, "user.json");
	projectPath = join(root, "project.json");
});

describe("configuration", () => {
	it("merges defaults, user, trusted project, then session overrides", async () => {
		await writeJson(userPath, { preset: "classic", density: "compact" });
		await writeJson(projectPath, { preset: "minimal", contextWarning: 65 });
		const result = await loadConfig({
			userPath,
			projectPath,
			projectTrusted: true,
			session: { ornament: "none" },
		});
		expect(result.config).toMatchObject({
			preset: "minimal",
			density: "compact",
			contextWarning: 65,
			ornament: "none",
		});
	});

	it("does not read untrusted project configuration", async () => {
		await writeJson(projectPath, { preset: "minimal" });
		const result = await loadConfig({ userPath, projectPath, projectTrusted: false });
		expect(result.config.preset).toBe("editorial");
	});

	it("rejects invalid thresholds, duplicates, and unknown segments", () => {
		const result = validateConfig({
			contextWarning: 95,
			contextDanger: 80,
			segments: ["metrics", "metrics", "unknown"],
		});
		expect(result.config.contextWarning).toBe(70);
		expect(result.config.contextDanger).toBe(90);
		expect(result.config.segments).toEqual(["metrics", "context"]);
		expect(result.warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining("threshold"),
				expect.stringContaining("duplicate"),
				expect.stringContaining("unknown"),
			]),
		);
	});

	it("reports malformed JSON once and retains defaults", async () => {
		await writeFile(userPath, "{broken", "utf8");
		const result = await loadConfig({ userPath, projectPath, projectTrusted: false });
		expect(result.config).toEqual(DEFAULT_CONFIG);
		expect(result.warnings).toHaveLength(1);
	});

	it("saves valid JSON atomically without leaving temporary files", async () => {
		await saveUserConfig(userPath, { ...DEFAULT_CONFIG, preset: "classic" });
		expect(JSON.parse(await readFile(userPath, "utf8"))).toMatchObject({ preset: "classic" });
		expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
});

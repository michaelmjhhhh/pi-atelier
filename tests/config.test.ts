import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, saveUserConfig, saveUserConfigPatch, validateConfig } from "../src/config.js";
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
	it("defaults to no brand ornament, a closed sidebar, collapsed tool details, and completion notifications", () => {
		expect(DEFAULT_CONFIG.ornament).toBe("none");
		expect(DEFAULT_CONFIG.sidebarOpen).toBe(false);
		expect(DEFAULT_CONFIG.showSidebarToolNames).toBe(false);
		expect(DEFAULT_CONFIG.completionNotifications).toBe(true);
	});

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

	it("keeps completion notifications as a global user preference", async () => {
		await writeJson(userPath, { completionNotifications: false });
		await writeJson(projectPath, { completionNotifications: true });
		const result = await loadConfig({
			userPath,
			projectPath,
			projectTrusted: true,
			session: { completionNotifications: true },
		});

		expect(result.config.completionNotifications).toBe(false);
	});

	it("does not let project configuration disable default-on completion notifications", async () => {
		await writeJson(projectPath, { completionNotifications: false });
		const result = await loadConfig({ userPath, projectPath, projectTrusted: true });

		expect(result.config.completionNotifications).toBe(true);
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

	it("validates boolean preferences", () => {
		expect(
			validateConfig({
				sidebarOpen: true,
				showSidebarToolNames: true,
				completionNotifications: false,
			}).config,
		).toMatchObject({ sidebarOpen: true, showSidebarToolNames: true, completionNotifications: false });
		const invalid = validateConfig({
			sidebarOpen: "yes",
			showSidebarToolNames: "yes",
			completionNotifications: "yes",
		});
		expect(invalid.config.sidebarOpen).toBe(false);
		expect(invalid.config.showSidebarToolNames).toBe(false);
		expect(invalid.config.completionNotifications).toBe(true);
		expect(invalid.warnings).toContain("sidebarOpen must be boolean");
		expect(invalid.warnings).toContain("showSidebarToolNames must be boolean");
		expect(invalid.warnings).toContain("completionNotifications must be boolean");
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

	it("patches one user preference without persisting effective defaults or losing unknown fields", async () => {
		await writeJson(userPath, { density: "compact", futureSetting: "keep" });
		await saveUserConfigPatch(userPath, { completionNotifications: false });

		expect(JSON.parse(await readFile(userPath, "utf8"))).toEqual({
			density: "compact",
			futureSetting: "keep",
			completionNotifications: false,
		});
	});
});

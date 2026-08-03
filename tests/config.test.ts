import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	loadConfig,
	mergeConfig,
	saveUserConfig,
	saveUserConfigPatch,
	validateConfig,
} from "../src/config.js";
import { DISPLAY_TEMPLATES, PRODUCT_SEGMENT_ORDER } from "../src/display.js";
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

const visibility = (layout: typeof DEFAULT_CONFIG.segmentLayout, id: string) =>
	layout.find((entry) => entry.id === id)?.visible;

describe("configuration", () => {
	it("defines complete defaults and compatibility templates", () => {
		for (const template of [DEFAULT_CONFIG, ...Object.values(DISPLAY_TEMPLATES)]) {
			expect(template.segmentLayout.map((entry) => entry.id)).toEqual(PRODUCT_SEGMENT_ORDER);
			expect(new Set(template.segmentLayout.map((entry) => entry.id)).size).toBe(9);
			expect(visibility(template.segmentLayout, "metrics")).toBe(true);
			expect(visibility(template.segmentLayout, "context")).toBe(true);
			expect(visibility(template.segmentLayout, "brand")).toBe(false);
			expect(visibility(template.segmentLayout, "performance")).toBe(false);
		}
		expect(DEFAULT_CONFIG.showSidebarToolNames).toBe(false);
		expect(DEFAULT_CONFIG.completionNotifications).toBe(true);
		expect(DEFAULT_CONFIG.showSidebarAgent).toBe(true);
		expect(DEFAULT_CONFIG.sidebarPanelLayout.map((entry) => entry.id)).toEqual([
			"agent",
			"activity",
			"alerts",
			"todos",
			"context",
			"workspace",
			"usage",
			"tools",
		]);
	});

	it("loads an ordered global Sidebar layout with deterministic compatibility precedence", async () => {
		await writeJson(userPath, {
			showSidebarAgent: false,
			showSidebarTodos: false,
			sidebarPanelLayout: [
				{ id: "tools", visible: false },
				{ id: "vendor:queue", visible: false },
				{ id: "tools", visible: true },
			],
		});
		await writeJson(projectPath, { sidebarPanelLayout: [{ id: "agent", visible: false }] });
		const result = await loadConfig({
			userPath,
			projectPath,
			projectTrusted: true,
			session: { sidebarPanelLayout: [] },
		});
		expect(result.config.sidebarPanelLayout.slice(0, 2)).toEqual([
			{ id: "tools", visible: false },
			{ id: "vendor:queue", visible: false },
		]);
		expect(result.config.sidebarPanelLayout.find((entry) => entry.id === "agent")?.visible).toBe(true);
		expect(result.config.sidebarPanelLayout.find((entry) => entry.id === "todos")?.visible).toBe(true);
		expect(result.warnings.filter((warning) => warning.includes("duplicate")).length).toBe(1);
	});

	it("keeps legacy Sidebar visibility compatible when no authoritative layout is present", () => {
		const result = validateConfig({ showSidebarAgent: false, showSidebarTodos: false });
		expect(result.config.sidebarPanelLayout.find((entry) => entry.id === "agent")?.visible).toBe(false);
		expect(result.config.sidebarPanelLayout.find((entry) => entry.id === "todos")?.visible).toBe(false);
	});

	it("applies named templates atomically before same-layer deviations", () => {
		const named = validateConfig({ preset: "minimal" });
		expect(named.config).toMatchObject({ preset: "minimal", density: "compact" });
		expect(named.config.segmentLayout).toEqual(DISPLAY_TEMPLATES.minimal.segmentLayout);

		const deviated = validateConfig({ preset: "minimal", density: "comfortable" });
		expect(deviated.config.preset).toBe("custom");
		expect(deviated.config.segmentLayout).toEqual(DISPLAY_TEMPLATES.minimal.segmentLayout);
	});

	it("preserves the public validateConfig base Display values", () => {
		const base = { ...DEFAULT_CONFIG, ...DISPLAY_TEMPLATES.minimal };
		const result = validateConfig({ shortcut: "ctrl+x" }, base);
		expect(result.config).toMatchObject({ preset: "minimal", density: "compact", shortcut: "ctrl+x" });
		expect(result.config.segmentLayout).toEqual(DISPLAY_TEMPLATES.minimal.segmentLayout);
	});

	it("preserves a custom base Sidebar layout when input omits layout", () => {
		const base = {
			...DEFAULT_CONFIG,
			showSidebarAgent: false,
			showSidebarTodos: true,
			sidebarPanelLayout: [
				{ id: "vendor:queue" as const, visible: true },
				{ id: "agent" as const, visible: false },
				...DEFAULT_CONFIG.sidebarPanelLayout.filter((entry) => !["agent", "todos"].includes(entry.id)),
			],
		};
		const result = validateConfig({ shortcut: "ctrl+x" }, base);
		expect(result.config.sidebarPanelLayout).toEqual(base.sidebarPanelLayout);
		expect(result.config.showSidebarAgent).toBe(false);
		expect(result.config.showSidebarTodos).toBe(true);
	});

	it("translates legacy Sidebar visibility against a custom base without resetting it", () => {
		const base = {
			...DEFAULT_CONFIG,
			showSidebarAgent: false,
			showSidebarTodos: true,
			sidebarPanelLayout: [
				{ id: "vendor:queue" as const, visible: true },
				{ id: "agent" as const, visible: false },
				...DEFAULT_CONFIG.sidebarPanelLayout.filter((entry) => entry.id !== "agent"),
			],
		};
		const result = validateConfig({ showSidebarTodos: false }, base);
		expect(result.config.sidebarPanelLayout.find((entry) => entry.id === "vendor:queue")?.visible).toBe(true);
		expect(result.config.sidebarPanelLayout.find((entry) => entry.id === "agent")?.visible).toBe(false);
		expect(result.config.sidebarPanelLayout.find((entry) => entry.id === "todos")?.visible).toBe(false);
		expect(result.config.showSidebarAgent).toBe(false);
		expect(result.config.showSidebarTodos).toBe(false);
	});

	it("merges user, trusted project, then session with actionable provenance", async () => {
		await writeJson(userPath, { density: "compact" });
		await writeJson(projectPath, {
			segmentLayout: [
				{ id: "context", visible: true },
				{ id: "metrics", visible: true },
			],
		});
		const result = await loadConfig({
			userPath,
			projectPath,
			projectTrusted: true,
			session: { segmentLayout: [{ id: "brand", visible: true }] },
		});
		expect(result.config.density).toBe("compact");
		expect(result.config.segmentLayout[0]).toEqual({ id: "brand", visible: true });
		expect(result.displayProvenance.density).toBe("user");
		expect(result.displayProvenance.order).toBe("session");
		expect(result.displayProvenance.visibility.brand).toBe("session");
		expect(result.config.preset).toBe("custom");
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

	it("lets a user Agent visibility preference win over trusted project and session values", async () => {
		await writeJson(userPath, { showSidebarAgent: false });
		await writeJson(projectPath, { showSidebarAgent: true });
		const result = await loadConfig({
			userPath,
			projectPath,
			projectTrusted: true,
			session: { showSidebarAgent: true },
		});
		expect(result.config.showSidebarAgent).toBe(false);
	});

	it("keeps legacy Agent and TODOS visibility global-user-only in mergeConfig", () => {
		expect(
			mergeConfig(
				{ showSidebarAgent: false, showSidebarTodos: false },
				{ showSidebarAgent: true, showSidebarTodos: true },
				{ showSidebarAgent: true, showSidebarTodos: true },
			).config,
		).toMatchObject({ showSidebarAgent: false, showSidebarTodos: false });
		expect(
			mergeConfig(
				{},
				{ showSidebarAgent: false, showSidebarTodos: false },
				{
					showSidebarAgent: false,
					showSidebarTodos: false,
				},
			).config,
		).toMatchObject({ showSidebarAgent: true, showSidebarTodos: true });
	});

	it("ignores project and session legacy Sidebar visibility when the user omits it", async () => {
		await writeJson(projectPath, { showSidebarAgent: false, showSidebarTodos: false });
		const result = await loadConfig({
			userPath,
			projectPath,
			projectTrusted: true,
			session: { showSidebarAgent: false, showSidebarTodos: false },
		});
		expect(result.config.showSidebarAgent).toBe(true);
		expect(result.config.showSidebarTodos).toBe(true);
	});

	it("keeps a user legacy TODOS value ahead of trusted project and session values", async () => {
		await writeJson(userPath, { showSidebarTodos: false });
		await writeJson(projectPath, { showSidebarTodos: true });
		const result = await loadConfig({
			userPath,
			projectPath,
			projectTrusted: true,
			session: { showSidebarTodos: true },
		});
		expect(result.config.showSidebarTodos).toBe(false);
		expect(result.config.sidebarPanelLayout.find((entry) => entry.id === "todos")?.visible).toBe(false);
	});

	it("does not read, warn about, or attribute an untrusted project", async () => {
		await writeFile(projectPath, "{broken", "utf8");
		const result = await loadConfig({ userPath, projectPath, projectTrusted: false });
		expect(result.config).toEqual(DEFAULT_CONFIG);
		expect(result.warnings).toEqual([]);
		expect(result.displayProvenance.order).toBe("product");
	});

	it("makes a usable segmentLayout authoritative over same-layer legacy fields", () => {
		const result = validateConfig({
			segmentLayout: [
				{ id: "brand", visible: true },
				{ id: "statuses", visible: true },
			],
			segments: ["metrics", "context"],
			ornament: "none",
			showExtensionStatuses: false,
		});
		expect(visibility(result.config.segmentLayout, "brand")).toBe(true);
		expect(visibility(result.config.segmentLayout, "statuses")).toBe(true);
	});

	it("repairs malformed layouts deterministically and de-duplicates warnings", () => {
		const result = validateConfig({
			segmentLayout: [
				{ id: "menu", visible: true },
				{ id: "metrics", visible: false },
				{ id: "menu", visible: false },
				{ id: "mystery", visible: true },
				{ id: "brand", visible: "yes" },
				null,
				null,
			],
		});
		expect(result.config.segmentLayout.slice(0, 3)).toEqual([
			{ id: "menu", visible: true },
			{ id: "metrics", visible: true },
			{ id: "brand", visible: false },
		]);
		expect(result.config.segmentLayout.map((entry) => entry.id)).toHaveLength(9);
		expect(result.warnings.some((warning) => warning.includes("duplicate"))).toBe(true);
		expect(result.warnings.filter((warning) => warning.includes("malformed"))).toHaveLength(1);
	});

	it("uses legacy fallback for non-array layouts and retains hidden omissions", () => {
		const result = validateConfig({ segmentLayout: {}, segments: ["activity", "performance"] });
		expect(result.warnings).toContain("segmentLayout must be an array");
		expect(result.config.segmentLayout.map((entry) => entry.id).slice(0, 2)).toEqual([
			"activity",
			"performance",
		]);
		expect(visibility(result.config.segmentLayout, "performance")).toBe(true);
		expect(visibility(result.config.segmentLayout, "git")).toBe(false);
		expect(visibility(result.config.segmentLayout, "metrics")).toBe(true);
	});

	it.each([
		[{ preset: "classic", ornament: "restrained", segments: ["brand"] }, true],
		[{ preset: "editorial", ornament: "restrained", segments: ["brand"] }, false],
		[{ preset: "classic", ornament: "none", segments: ["brand"] }, false],
		[{ preset: "classic", ornament: "restrained", segments: [] }, false],
	] as const)("reproduces legacy Brand compatibility for %j", (input, expected) => {
		expect(visibility(validateConfig(input).config.segmentLayout, "brand")).toBe(expected);
	});

	it("reproduces legacy Statuses compatibility", () => {
		expect(
			visibility(
				validateConfig({ segments: ["statuses"], showExtensionStatuses: false }).config.segmentLayout,
				"statuses",
			),
		).toBe(false);
		expect(
			visibility(
				validateConfig({ segments: ["statuses"], showExtensionStatuses: true }).config.segmentLayout,
				"statuses",
			),
		).toBe(true);
	});

	it("rejects invalid thresholds and validates boolean preferences", () => {
		const result = validateConfig({ contextWarning: 95, contextDanger: 80, showSidebarToolNames: "yes" });
		expect(result.config.contextWarning).toBe(70);
		expect(result.warnings).toEqual(
			expect.arrayContaining([expect.stringContaining("threshold"), "showSidebarToolNames must be boolean"]),
		);
	});

	it("loads persisted showSidebarAgent false from user config", async () => {
		await writeJson(userPath, { showSidebarAgent: false });
		const result = await loadConfig({ userPath, projectPath, projectTrusted: false });
		expect(result.config.showSidebarAgent).toBe(false);
	});

	it("rejects non-boolean showSidebarAgent with warning", () => {
		const result = validateConfig({ showSidebarAgent: "off" });
		expect(result.config.showSidebarAgent).toBe(true);
		expect(result.warnings).toContain("showSidebarAgent must be boolean");
	});

	it("loads persisted sidebarDisabled true from user config", async () => {
		await writeJson(userPath, { sidebarDisabled: true });
		const result = await loadConfig({ userPath, projectPath, projectTrusted: false });
		expect(result.config.sidebarDisabled).toBe(true);
	});

	it("defaults sidebarDisabled to false", () => {
		expect(DEFAULT_CONFIG.sidebarDisabled).toBe(false);
		const result = validateConfig({});
		expect(result.config.sidebarDisabled).toBe(false);
	});

	it("rejects non-boolean sidebarDisabled with warning", () => {
		const result = validateConfig({ sidebarDisabled: "yes" });
		expect(result.config.sidebarDisabled).toBe(false);
		expect(result.warnings).toContain("sidebarDisabled must be boolean");
	});

	it("reports malformed JSON once and retains defaults", async () => {
		await writeFile(userPath, "{broken", "utf8");
		const result = await loadConfig({ userPath, projectPath, projectTrusted: false });
		expect(result.config).toEqual(DEFAULT_CONFIG);
		expect(result.warnings).toHaveLength(1);
	});

	it("saves valid JSON atomically without leaving temporary files", async () => {
		await saveUserConfig(userPath, { ...DEFAULT_CONFIG, preset: "custom" });
		expect(JSON.parse(await readFile(userPath, "utf8"))).toMatchObject({ preset: "custom" });
		expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("patches one preference without losing unknown fields", async () => {
		await writeJson(userPath, { density: "compact", futureSetting: "keep" });
		await saveUserConfigPatch(userPath, { completionNotifications: false });
		expect(JSON.parse(await readFile(userPath, "utf8"))).toEqual({
			density: "compact",
			futureSetting: "keep",
			completionNotifications: false,
		});
	});
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, resolveConfig, saveUserConfigPatch } from "../src/config.js";
import { DISPLAY_TEMPLATES, PRODUCT_SEGMENT_ORDER } from "../src/display.js";

const validateConfig = (user: unknown) => resolveConfig({ user });

const visibility = (layout: typeof DEFAULT_CONFIG.segmentLayout, id: string) =>
	layout.find((entry) => entry.id === id)?.visible;

describe("configuration validation", () => {
	it("defines complete templates with the required segments visible", () => {
		for (const template of [DEFAULT_CONFIG, ...Object.values(DISPLAY_TEMPLATES)]) {
			expect(template.segmentLayout.map((entry) => entry.id)).toEqual(PRODUCT_SEGMENT_ORDER);
			expect(new Set(template.segmentLayout.map((entry) => entry.id)).size).toBe(9);
			expect(visibility(template.segmentLayout, "metrics")).toBe(true);
			expect(visibility(template.segmentLayout, "context")).toBe(true);
			expect(visibility(template.segmentLayout, "brand")).toBe(false);
			expect(visibility(template.segmentLayout, "performance")).toBe(false);
		}
	});

	it("validates top rail height", () => {
		expect(DEFAULT_CONFIG.railTopHeight).toBe(6);
		for (const height of [1, 6, 10])
			expect(validateConfig({ railTopHeight: height }).config.railTopHeight).toBe(height);
		const invalid = validateConfig({ railTopHeight: 11 });
		expect(invalid.config.railTopHeight).toBe(6);
		expect(invalid.warnings).toContain("railTopHeight must be an integer from 1 through 10");
	});

	it("validates header rail rows and builtin section expansion", () => {
		expect(DEFAULT_CONFIG.headerRailRows).toBe(2);
		for (const rows of [1, 2, 3, 4])
			expect(validateConfig({ headerRailRows: rows }).config.headerRailRows).toBe(rows);
		const invalidRows = validateConfig({ headerRailRows: 5 });
		expect(invalidRows.config.headerRailRows).toBe(2);
		expect(invalidRows.warnings).toContain("headerRailRows must be an integer from 1 through 4");
		const expansion = validateConfig({ sectionExpansion: { agent: false, unknown: true, tools: "no" } });
		expect(expansion.config.sectionExpansion).toEqual({ agent: false });
		expect(expansion.warnings).toEqual(
			expect.arrayContaining([
				"Unknown sectionExpansion section: unknown",
				"sectionExpansion value for tools must be boolean",
			]),
		);
	});

	it("resolves source panel placement from user, project, and session layers", () => {
		expect(DEFAULT_CONFIG.panelPlacement).toBe("right");
		expect(validateConfig({ sourcePanelPlacement: "top" }).config.panelPlacement).toBe("top");
		expect(validateConfig({ sourcePanelPlacement: "right" }).config.panelPlacement).toBe("right");
		expect(
			resolveConfig({
				user: { sourcePanelPlacement: "right" },
				project: { sourcePanelPlacement: "top" },
				session: { sourcePanelPlacement: "right" },
			}).config.panelPlacement,
		).toBe("right");
		const invalid = validateConfig({ sourcePanelPlacement: "left" });
		expect(invalid.config.panelPlacement).toBe("right");
		expect(invalid.warnings).toContain("Unknown sourcePanelPlacement: left");
	});

	it("parses the optional sidebar toggle shortcut", () => {
		expect(DEFAULT_CONFIG.toggleShortcut).toBe("");
		expect(validateConfig({ toggleShortcut: " ctrl+shift+b " }).config.toggleShortcut).toBe("ctrl+shift+b");
		expect(
			resolveConfig({ user: { toggleShortcut: "ctrl+shift+b" }, project: { toggleShortcut: "" } }).config
				.toggleShortcut,
		).toBe("");
		const invalid = validateConfig({ toggleShortcut: 1 });
		expect(invalid.config.toggleShortcut).toBe("");
		expect(invalid.warnings).toContain("toggleShortcut must be a string");
	});

	it("parses the user-only sidebar width", () => {
		expect(DEFAULT_CONFIG.sidebarWidth).toBe(44);
		expect(validateConfig({ sidebarWidth: 36 }).config.sidebarWidth).toBe(36);
		const clamped = validateConfig({ sidebarWidth: 10 });
		expect(clamped.config.sidebarWidth).toBe(28);
		expect(clamped.warnings).toContain("sidebarWidth must be from 28 through 72; using 28");
		const invalid = validateConfig({ sidebarWidth: 40.5 });
		expect(invalid.config.sidebarWidth).toBe(44);
		expect(invalid.warnings).toContain("sidebarWidth must be an integer");
		expect(
			resolveConfig({ user: { sidebarWidth: 36 }, project: { sidebarWidth: 60 } }).config.sidebarWidth,
		).toBe(36);
	});

	it("keeps legacy Sidebar visibility compatible when no authoritative layout is present", () => {
		const result = validateConfig({ showSidebarAgent: false, showSidebarTodos: false });
		expect(result.config.sidebarPanelLayout.find((entry) => entry.id === "agent")?.visible).toBe(false);
		expect(result.config.sidebarPanelLayout.find((entry) => entry.id === "todos")?.visible).toBe(false);
	});

	it("places a panel that a saved Sidebar layout predates next to its product-order neighbour", () => {
		const saved = ["agent", "activity", "context", "vendor:queue", "workspace", "usage"].map((id) => ({
			id,
			visible: true,
		}));
		const layout = validateConfig({ sidebarPanelLayout: saved }).config.sidebarPanelLayout;
		const ids = layout.map((entry) => entry.id);
		expect(ids.slice(ids.indexOf("context"), ids.indexOf("context") + 2)).toEqual(["context", "prefill"]);
		expect(ids.indexOf("prefill")).toBeLessThan(ids.indexOf("vendor:queue"));
		expect(ids.indexOf("vendor:queue")).toBeLessThan(ids.indexOf("workspace"));
		expect(ids.indexOf("tools")).toBe(ids.length - 1);
	});

	it("applies named templates atomically before same-layer deviations", () => {
		const named = validateConfig({ preset: "minimal" });
		expect(named.config).toMatchObject({ preset: "minimal", density: "compact" });
		expect(named.config.segmentLayout).toEqual(DISPLAY_TEMPLATES.minimal.segmentLayout);

		const deviated = validateConfig({ preset: "minimal", density: "comfortable" });
		expect(deviated.config.preset).toBe("custom");
		expect(deviated.config.segmentLayout).toEqual(DISPLAY_TEMPLATES.minimal.segmentLayout);
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
		expect(result.warnings.filter((warning) => warning.includes("duplicate"))).toHaveLength(1);
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
		const result = validateConfig({
			contextWarning: 95,
			contextDanger: 80,
			showSidebarToolNames: "yes",
			showSidebarOnStartup: "yes",
		});
		expect(result.config.contextWarning).toBe(70);
		expect(result.warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining("threshold"),
				"showSidebarToolNames must be boolean",
				"showSidebarOnStartup must be boolean",
			]),
		);
	});

	it("rejects non-boolean showSidebarAgent with warning", () => {
		const result = validateConfig({ showSidebarAgent: "off" });
		expect(result.config.sidebarPanelLayout.find((entry) => entry.id === "agent")?.visible).toBe(true);
		expect(result.warnings).toContain("showSidebarAgent must be boolean");
	});
});

describe("configuration files", () => {
	let root: string;
	let userPath: string;
	let projectPath: string;
	const writeJson = (path: string, value: unknown) => writeFile(path, JSON.stringify(value), "utf8");

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-atelier-"));
		userPath = join(root, "user.json");
		projectPath = join(root, "project.json");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it.each<[string, Record<string, unknown>]>([
		["completionNotifications", { completionNotifications: false }],
		["showSidebarOnStartup", { showSidebarOnStartup: false }],
		["showFooter", { showFooter: false }],
		["showSidebarAgent", { sidebarPanelLayout: expect.arrayContaining([{ id: "agent", visible: false }]) }],
		["showSidebarTodos", { sidebarPanelLayout: expect.arrayContaining([{ id: "todos", visible: false }]) }],
	])("keeps %s as a global user preference", async (key, expected) => {
		await writeJson(userPath, { [key]: false });
		await writeJson(projectPath, { [key]: true });
		const result = await loadConfig({
			userPath,
			projectPath,
			projectTrusted: true,
			session: { [key]: true },
		});
		expect(result.config).toMatchObject(expected);
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

	it("retains sourcePanelPlacement from the session layer", async () => {
		const result = await loadConfig({
			userPath,
			projectPath,
			projectTrusted: true,
			session: { sourcePanelPlacement: "top" },
		});
		expect(result.config.panelPlacement).toBe("top");
		expect(result.displayLayers.session).toEqual({ sourcePanelPlacement: "top" });
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

	it("ignores project and session legacy Sidebar visibility when the user omits it", async () => {
		await writeJson(projectPath, { showSidebarAgent: false, showSidebarTodos: false });
		const result = await loadConfig({
			userPath,
			projectPath,
			projectTrusted: true,
			session: { showSidebarAgent: false, showSidebarTodos: false },
		});
		expect(result.config.sidebarPanelLayout.find((entry) => entry.id === "agent")?.visible).toBe(true);
		expect(result.config.sidebarPanelLayout.find((entry) => entry.id === "todos")?.visible).toBe(true);
	});

	it("does not read, warn about, or attribute an untrusted project", async () => {
		await writeFile(projectPath, "{broken", "utf8");
		const result = await loadConfig({ userPath, projectPath, projectTrusted: false });
		expect(result.config).toEqual(DEFAULT_CONFIG);
		expect(result.warnings).toEqual([]);
		expect(result.displayProvenance.order).toBe("product");
	});

	it("reports malformed JSON once and retains defaults", async () => {
		await writeFile(userPath, "{broken", "utf8");
		const result = await loadConfig({ userPath, projectPath, projectTrusted: false });
		expect(result.config).toEqual(DEFAULT_CONFIG);
		expect(result.warnings).toHaveLength(1);
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

	it("keeps every field when patches are saved concurrently", async () => {
		await writeJson(userPath, { futureSetting: "keep" });
		await Promise.all([
			saveUserConfigPatch(userPath, { sidebarWidth: 36 }),
			saveUserConfigPatch(userPath, { completionNotifications: false }),
			saveUserConfigPatch(userPath, { nerdFont: false }),
		]);
		expect(JSON.parse(await readFile(userPath, "utf8"))).toEqual({
			futureSetting: "keep",
			sidebarWidth: 36,
			completionNotifications: false,
			nerdFont: false,
		});
	});

	it("defaults prefill to a llama.cpp-only panel with four distinct views", () => {
		expect(DEFAULT_CONFIG).toMatchObject({
			prefillEnabled: true,
			prefillViews: ["percent", "tokens", "eta", "rate"],
			prefillProviders: ["llama.cpp"],
		});
		// A view repeated in the default list would draw the same row twice.
		expect(new Set(DEFAULT_CONFIG.prefillViews).size).toBe(DEFAULT_CONFIG.prefillViews.length);
	});

	it("keeps the known prefill views and warns about the rest", () => {
		const known = validateConfig({ prefillViews: ["tokens", "rate", "eta"] });
		expect(known.config.prefillViews).toEqual(["tokens", "rate", "eta"]);
		expect(known.warnings).toEqual([]);

		const unknown = validateConfig({ prefillViews: ["tokens", "tps"] });
		expect(unknown.config.prefillViews).toEqual(["tokens"]);
		expect(unknown.warnings).toContain("Unknown prefillViews: tps");

		const malformed = validateConfig({ prefillViews: "percent" });
		expect(malformed.config.prefillViews).toEqual(DEFAULT_CONFIG.prefillViews);
		expect(malformed.warnings).toContain("prefillViews must be an array");
	});

	it("keeps prefillProviders as a global user preference", async () => {
		await writeJson(userPath, { prefillProviders: ["llama.cpp"] });
		await writeJson(projectPath, { prefillProviders: ["vllm"] });
		const result = await loadConfig({
			userPath,
			projectPath,
			projectTrusted: true,
			session: { prefillProviders: ["strata"] },
		});
		expect(result.config.prefillProviders).toEqual(["llama.cpp"]);
	});
});

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type {
	ContributedSidebarPanelId,
	SidebarPanelContribution,
	SidebarPanelDiscoveryEvent,
	SidebarPanelEvent,
	SidebarPanelLayout,
	SidebarPanelRegisterEvent,
	SidebarPanelRole,
	SidebarPanelRow,
	SidebarPanelUnregisterEvent,
} from "../extensions/index.js";
import {
	BUILTIN_SIDEBAR_PANEL_IDS,
	isSidebarPanelContributionId,
	isSidebarPanelId,
	isSidebarPanelRequestId,
	SIDEBAR_PANEL_MAX_RAW_REQUEST_ID_CODE_UNITS,
} from "../extensions/index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("npm package contract", () => {
	it("publishes a Pi extension with compatible peers", () => {
		expect(pkg.name).toBe("pi-atelier");
		expect(pkg.version).toBe("0.8.2");
		expect(pkg.description).toBe("A responsive status rail and live activity sidebar for Pi");
		expect(pkg.keywords).toContain("pi-package");
		expect(pkg.pi.extensions).toEqual(["./extensions/index.ts"]);
		expect(pkg.peerDependencies["@earendil-works/pi-coding-agent"]).toBe(">=0.84.0");
		expect(pkg.peerDependencies["@earendil-works/pi-tui"]).toBe(">=0.84.0");
		expect(pkg.engines.node).toBe(">=22.19.0");
		expect(pkg.files).toEqual(expect.arrayContaining(["extensions", "src", "README.md", "LICENSE"]));
	});

	it("documents Sidebar use and Resize", async () => {
		const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
		expect(readme).toContain("/atelier sidebar");
		expect(readme).toContain("Ctrl+Shift+R");
		expect(readme).toContain("hides when the terminal is too narrow");
		expect(readme).toContain("rounded frame");
	});

	it("exports the deliberate structured contribution contract from the package entrypoint", () => {
		const contributedId: ContributedSidebarPanelId = "vendor:queue";
		const row: SidebarPanelRow = { text: "Ready", role: "ready" };
		const role: SidebarPanelRole = row.role ?? "primary";
		const contribution: SidebarPanelContribution = { id: contributedId, title: "Queue", rows: [row] };
		const register: SidebarPanelRegisterEvent = {
			version: 1,
			type: "register",
			source: "vendor",
			revision: 1,
			panel: contribution,
		};
		const unregister: SidebarPanelUnregisterEvent = {
			version: 1,
			type: "unregister",
			source: "vendor",
			revision: 2,
			id: contributedId,
		};
		const discovery: SidebarPanelDiscoveryEvent = { version: 1, type: "discover", requestId: "vendor-1" };
		const event: SidebarPanelEvent = register;
		const layout: SidebarPanelLayout = [
			{ id: "agent", visible: true },
			{ id: contributedId, visible: false },
		];
		// @ts-expect-error Built-ins are valid config IDs but not contributed IDs.
		const invalidContribution: SidebarPanelContribution = { id: "agent", title: "Agent", rows: [] };
		expect(row).toEqual({ text: "Ready", role: "ready" });
		expect(role).toBe("ready");
		expect(register.panel).toBe(contribution);
		expect(unregister.id).toBe(contributedId);
		expect(discovery.requestId).toBe("vendor-1");
		expect(event.type).toBe("register");
		expect(layout).toHaveLength(2);
		expect(invalidContribution.id).toBe("agent");
		expect(BUILTIN_SIDEBAR_PANEL_IDS).toContain("agent");
		expect(isSidebarPanelContributionId(contributedId)).toBe(true);
		expect(isSidebarPanelContributionId("agent")).toBe(false);
		expect(isSidebarPanelId("agent")).toBe(true);
		expect(isSidebarPanelRequestId("vendor-1")).toBe(true);
		expect(SIDEBAR_PANEL_MAX_RAW_REQUEST_ID_CODE_UNITS).toBeGreaterThan(0);
	});

	it("documents Display settings", async () => {
		const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
		expect(readme).toContain("/atelier display");
		expect(readme).toContain("Settings → Display");
	});
});

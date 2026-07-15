import { describe, expect, it, vi } from "vitest";
import { AtelierRuntime } from "../src/state.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const assistant = {
	type: "message",
	message: {
		role: "assistant",
		usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0, cost: { total: 0.01 } },
	},
};

function createRuntime(execResult = { stdout: "", stderr: "", code: 0, killed: false }) {
	const requestRender = vi.fn();
	const exec = vi.fn().mockResolvedValue(execResult);
	const ctx = {
		model: { id: "model", provider: "provider", reasoning: true },
		modelRegistry: { isUsingOAuth: vi.fn().mockReturnValue(true) },
		getContextUsage: vi.fn().mockReturnValue({ tokens: 1_000, contextWindow: 10_000, percent: 10 }),
		sessionManager: { getEntries: vi.fn().mockReturnValue([assistant]) },
	};
	const runtime = new AtelierRuntime({
		pi: { exec } as never,
		ctx: ctx as never,
		config: DEFAULT_CONFIG,
		autoCompact: true,
		requestRender,
	});
	return { runtime, exec, requestRender };
}

describe("AtelierRuntime", () => {
	it("derives metrics without retaining message content", () => {
		const { runtime } = createRuntime();
		runtime.refreshUsage();
		expect(runtime.getState()).toMatchObject({
			modelId: "model",
			provider: "provider",
			metrics: { input: 100, output: 20, cacheRead: 900, subscription: true, autoCompact: true },
		});
		expect(JSON.stringify(runtime.getState())).not.toContain("content");
	});

	it("probes git without shell interpolation", async () => {
		const { runtime, exec } = createRuntime({ stdout: " M src/a.ts\n", stderr: "", code: 0, killed: false });
		await runtime.refreshGitDirty();
		expect(exec).toHaveBeenCalledWith("git", ["status", "--porcelain", "--untracked-files=no"], {
			timeout: 2_000,
		});
		expect(runtime.getState().dirty).toBe(true);
	});

	it("fails closed to a clean indicator when git cannot run", async () => {
		const { runtime, exec } = createRuntime();
		exec.mockRejectedValue(new Error("not a repository"));
		await expect(runtime.refreshGitDirty()).resolves.toBeUndefined();
		expect(runtime.getState().dirty).toBe(false);
	});

	it("updates activity and configuration with render invalidation", () => {
		const { runtime, requestRender } = createRuntime();
		requestRender.mockClear();
		runtime.setActivity("working");
		runtime.setConfig({ ...DEFAULT_CONFIG, preset: "minimal" });
		expect(runtime.getState().activity).toBe("working");
		expect(runtime.getConfig().preset).toBe("minimal");
		expect(requestRender).toHaveBeenCalledTimes(2);
	});
});

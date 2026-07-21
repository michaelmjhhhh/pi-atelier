import { describe, expect, it, vi } from "vitest";
import { AtelierRuntime, parseGitStatus } from "../src/state.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const assistant = {
	type: "message",
	message: {
		role: "assistant",
		usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0, cost: { total: 0.01 } },
	},
};

function createRuntime(
	execResult = { stdout: "", stderr: "", code: 0, killed: false },
	random: () => number = Math.random,
) {
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
		random,
		requestRender,
	});
	return { runtime, exec, requestRender };
}

describe("parseGitStatus", () => {
	it("normalizes an unborn branch header", () => {
		expect(parseGitStatus("## No commits yet on main\n")).toEqual({ branch: "main", dirty: false });
	});
});

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

	it("derives branch and dirty state from one porcelain query", async () => {
		const { runtime, exec } = createRuntime({
			stdout: "## feature/sidebar\n M src/a.ts\n",
			stderr: "",
			code: 0,
			killed: false,
		});

		await runtime.refreshGitState();

		expect(exec).toHaveBeenCalledWith("git", ["status", "--short", "--branch", "--untracked-files=no"], {
			timeout: 2_000,
		});
		expect(runtime.getState()).toMatchObject({ branch: "feature/sidebar", dirty: true });
	});

	it("handles detached HEAD and a clean tree", async () => {
		const { runtime } = createRuntime({
			stdout: "## HEAD (no branch)\n",
			stderr: "",
			code: 0,
			killed: false,
		});

		await runtime.refreshGitState();

		expect(runtime.getState()).toMatchObject({ branch: "detached", dirty: false });
	});

	it("clears Git metadata when the directory is not a repository", async () => {
		const { runtime, exec } = createRuntime();
		exec.mockRejectedValue(new Error("not a repository"));

		await expect(runtime.refreshGitState()).resolves.toBeUndefined();

		expect(runtime.getState().branch).toBeUndefined();
		expect(runtime.getState().dirty).toBe(false);
	});

	it("selects one stable label when a work cycle starts", () => {
		const random = vi.fn().mockReturnValue(0.5);
		const { runtime, requestRender } = createRuntime(undefined, random);
		requestRender.mockClear();

		runtime.setActivity("working");
		const selected = runtime.getState().workingLabel;
		runtime.setActivity("working");
		runtime.refreshUsage();

		expect(selected).toBe("PONDERING");
		expect(runtime.getState()).toMatchObject({ activity: "working", workingLabel: "PONDERING" });
		expect(random).toHaveBeenCalledOnce();
		expect(requestRender).toHaveBeenCalledTimes(2);
	});

	it("selects again for the next work cycle and still updates configuration", () => {
		const random = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0.999_999);
		const { runtime, requestRender } = createRuntime(undefined, random);
		requestRender.mockClear();

		runtime.setActivity("working");
		expect(runtime.getState().workingLabel).toBe("KNEADING");
		runtime.setActivity("ready");
		runtime.setActivity("working");
		runtime.setConfig({ ...DEFAULT_CONFIG, preset: "minimal" });

		expect(runtime.getState()).toMatchObject({ activity: "working", workingLabel: "COMBOBULATING" });
		expect(runtime.getConfig().preset).toBe("minimal");
		expect(random).toHaveBeenCalledTimes(2);
		expect(requestRender).toHaveBeenCalledTimes(4);
	});
});

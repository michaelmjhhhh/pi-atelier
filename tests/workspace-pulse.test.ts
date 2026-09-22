import { getEventListeners } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createWorkspacePulseRefresh,
	inspectWorkspacePulse,
	type WorkspacePulseInspection,
} from "../src/workspace-pulse.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

afterEach(() => {
	vi.useRealTimers();
});

const result = (stdout = "", code = 0, stderr = "") => ({
	stdout,
	stderr,
	code,
	killed: false,
});

describe("createWorkspacePulseRefresh", () => {
	const clean: WorkspacePulseInspection = {
		kind: "available",
		root: "/repo",
		relativeCwd: "",
		branch: "main",
		snapshot: {
			trackedFiles: 0,
			untrackedFiles: 0,
			linesAdded: 0,
			linesRemoved: 0,
			binaryFiles: 0,
			submodules: 0,
			conflicts: 0,
		},
	};

	it("coalesces scheduled requests into one inspection", async () => {
		vi.useFakeTimers();
		const inspect = vi.fn().mockResolvedValue(clean);
		const publish = vi.fn();
		const refresh = createWorkspacePulseRefresh({ inspect, publish, delayMs: 250 });

		refresh.request();
		refresh.request();
		refresh.request();
		await vi.advanceTimersByTimeAsync(249);
		expect(inspect).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		expect(inspect).toHaveBeenCalledOnce();
		expect(publish).toHaveBeenCalledWith(clean);
	});

	it("runs no concurrent inspections and retains one trailing request", async () => {
		vi.useFakeTimers();
		const first = deferred<WorkspacePulseInspection>();
		const second = deferred<WorkspacePulseInspection>();
		const inspect = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const publish = vi.fn();
		const refresh = createWorkspacePulseRefresh({ inspect, publish, delayMs: 250 });

		refresh.request();
		await vi.advanceTimersByTimeAsync(250);
		expect(inspect).toHaveBeenCalledOnce();

		refresh.request();
		await vi.advanceTimersByTimeAsync(250);
		expect(inspect).toHaveBeenCalledOnce();

		first.resolve(clean);
		await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
		second.resolve(clean);
		await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
	});

	it("flushes through a running inspection to guarantee a fresh result", async () => {
		vi.useFakeTimers();
		const first = deferred<WorkspacePulseInspection>();
		const second = deferred<WorkspacePulseInspection>();
		const changed: WorkspacePulseInspection = {
			...clean,
			branch: "feature/pulse",
			snapshot: { ...clean.snapshot, trackedFiles: 1 },
		};
		const inspect = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const publish = vi.fn();
		const refresh = createWorkspacePulseRefresh({ inspect, publish, delayMs: 250 });

		refresh.request();
		await vi.advanceTimersByTimeAsync(250);
		const flushed = refresh.flush();
		first.resolve(clean);
		await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
		second.resolve(changed);
		await flushed;

		expect(publish).toHaveBeenLastCalledWith(changed);
	});

	it("cancels scheduled work and ignores in-flight results after disposal", async () => {
		vi.useFakeTimers();
		const running = deferred<WorkspacePulseInspection>();
		const inspect = vi.fn().mockReturnValue(running.promise);
		const publish = vi.fn();
		const refresh = createWorkspacePulseRefresh({ inspect, publish, delayMs: 250 });

		refresh.request();
		await vi.advanceTimersByTimeAsync(250);
		refresh.request();
		refresh.dispose();
		running.resolve(clean);
		await vi.runAllTimersAsync();

		expect(inspect).toHaveBeenCalledOnce();
		expect(publish).not.toHaveBeenCalled();
	});

	it("cancels pending work and accepts no requests while suspended", async () => {
		vi.useFakeTimers();
		const inspect = vi.fn().mockResolvedValue(clean);
		const refresh = createWorkspacePulseRefresh({ inspect, publish: vi.fn() });
		refresh.request();
		refresh.setEnabled(false);
		refresh.request();
		await refresh.flush();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(inspect).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		refresh.setEnabled(true);
		await refresh.flush();
		expect(inspect).toHaveBeenCalledOnce();
		refresh.dispose();
	});

	it("releases suspended flushes but serializes resumption behind an uncooperative inspection", async () => {
		const first = deferred<WorkspacePulseInspection>();
		const second = deferred<WorkspacePulseInspection>();
		const signals: AbortSignal[] = [];
		const inspect = vi.fn((signal: AbortSignal) => {
			signals.push(signal);
			return signals.length === 1 ? first.promise : second.promise;
		});
		const publish = vi.fn();
		const refresh = createWorkspacePulseRefresh({ inspect, publish });
		const suspendedFlush = refresh.flush();
		refresh.setEnabled(false);
		expect(signals[0]?.aborted).toBe(true);
		await suspendedFlush;

		refresh.setEnabled(true);
		const resumedFlush = refresh.flush();
		expect(inspect).toHaveBeenCalledOnce();
		first.resolve(clean);
		await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
		expect(publish).not.toHaveBeenCalled();
		expect(signals[1]?.aborted).toBe(false);
		const changed = { ...clean, branch: "resumed" };
		second.resolve(changed);
		await resumedFlush;
		expect(publish).toHaveBeenCalledExactlyOnceWith(changed);
		refresh.dispose();
	});

	it("removes cancellation listeners after each completed flush", async () => {
		let observedSignal: AbortSignal | undefined;
		const refresh = createWorkspacePulseRefresh({
			inspect: async (signal) => {
				observedSignal = signal;
				return clean;
			},
			publish: vi.fn(),
		});
		for (let count = 0; count < 50; count += 1) {
			await refresh.flush();
			expect(getEventListeners(observedSignal!, "abort")).toHaveLength(0);
		}
		refresh.dispose();
	});

	it("aborts active work and releases flush waiters permanently on disposal", async () => {
		const pending = deferred<WorkspacePulseInspection>();
		let signal: AbortSignal | undefined;
		const publish = vi.fn();
		const inspect = vi.fn((current: AbortSignal) => {
			signal = current;
			return pending.promise;
		});
		const refresh = createWorkspacePulseRefresh({ inspect, publish });
		const flushed = refresh.flush();
		refresh.dispose();
		await flushed;
		expect(signal?.aborted).toBe(true);
		refresh.setEnabled(true);
		refresh.request();
		await refresh.flush();
		pending.resolve(clean);
		await Promise.resolve();
		expect(inspect).toHaveBeenCalledOnce();
		expect(publish).not.toHaveBeenCalled();
	});
});

describe("inspectWorkspacePulse", () => {
	it("forwards cancellation to Git and starts no subsequent command after abort", async () => {
		const controller = new AbortController();
		const discovery = deferred<ReturnType<typeof result>>();
		const exec = vi.fn().mockReturnValue(discovery.promise);
		const inspection = inspectWorkspacePulse({ exec, cwd: "/repo", signal: controller.signal });
		expect(exec).toHaveBeenCalledWith("git", ["rev-parse", "--is-inside-work-tree", "--show-toplevel"], {
			cwd: "/repo",
			timeout: 2_000,
			signal: controller.signal,
		});
		controller.abort();
		discovery.resolve(result("true\n/repo\n"));
		await expect(inspection).resolves.toEqual({ kind: "unavailable" });
		expect(exec).toHaveBeenCalledOnce();
		await expect(inspectWorkspacePulse({ exec, cwd: "/repo", signal: controller.signal })).resolves.toEqual({
			kind: "unavailable",
		});
		expect(exec).toHaveBeenCalledOnce();
	});

	it("reports an explicit clean Pulse for the containing worktree", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce(result("true\n/repo \n"))
			.mockResolvedValueOnce(result("# branch.oid abc\0# branch.head main\0"));

		await expect(inspectWorkspacePulse({ exec, cwd: "/repo /packages/api" })).resolves.toEqual({
			kind: "available",
			root: "/repo ",
			relativeCwd: "packages/api",
			branch: "main",
			snapshot: {
				trackedFiles: 0,
				untrackedFiles: 0,
				linesAdded: 0,
				linesRemoved: 0,
				binaryFiles: 0,
				submodules: 0,
				conflicts: 0,
			},
		});
	});

	it.each([
		["abc", "", 0],
		["abc", "? new file.ts\0? nested/other.ts\0", 2],
		["(initial)", "", 0],
		["(initial)", "? first.ts\0", 1],
	])("skips diff work with oid %s and untracked records %s", async (oid, records, untrackedFiles) => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce(result("true\n/repo\n"))
			.mockResolvedValueOnce(result(`# branch.oid ${oid}\0# branch.head main\0${records}`));
		await expect(inspectWorkspacePulse({ exec, cwd: "/repo" })).resolves.toMatchObject({
			kind: "available",
			branch: "main",
			snapshot: {
				trackedFiles: 0,
				untrackedFiles,
				linesAdded: 0,
				linesRemoved: 0,
				binaryFiles: 0,
				conflicts: 0,
				submodules: 0,
			},
		});
		expect(exec).toHaveBeenCalledTimes(2);
	});

	it("does not report a clean result when cancelled during status", async () => {
		const controller = new AbortController();
		const status = deferred<ReturnType<typeof result>>();
		const exec = vi.fn().mockResolvedValueOnce(result("true\n/repo\n")).mockReturnValueOnce(status.promise);
		const inspection = inspectWorkspacePulse({ exec, cwd: "/repo", signal: controller.signal });
		await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(2));
		controller.abort();
		status.resolve(result("# branch.oid abc\0# branch.head main\0"));
		await expect(inspection).resolves.toEqual({ kind: "unavailable" });
		expect(exec).toHaveBeenCalledTimes(2);
	});

	it.each([
		["1 M. N... 100644 100644 100644 aaa bbb staged.ts", 0, 0, "2\t1\tstaged.ts\0", 2],
		["u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts", 1, 0, "0\t0\tconflict.ts\0", 0],
		["1 .M S.M. 160000 160000 160000 aaa aaa modules/lib", 0, 1, "1\t1\tmodules/lib\0", 0],
	])(
		"retains diff inspection for a lone tracked record: %s",
		async (record, conflicts, submodules, diff, linesAdded) => {
			const exec = vi
				.fn()
				.mockResolvedValueOnce(result("true\n/repo\n"))
				.mockResolvedValueOnce(result(`# branch.oid abc\0# branch.head main\0${record}\0`))
				.mockResolvedValueOnce(result("tree-id\n"))
				.mockResolvedValueOnce(result(diff));
			await expect(inspectWorkspacePulse({ exec, cwd: "/repo" })).resolves.toMatchObject({
				kind: "available",
				snapshot: { trackedFiles: 1, conflicts, submodules, linesAdded },
			});
			expect(exec).toHaveBeenCalledTimes(4);
		},
	);

	it("aggregates tracked, untracked, text, binary, submodule, rename, and conflict changes", async () => {
		const status = [
			"# branch.oid abc",
			"# branch.head feature/pulse",
			"1 .M N... 100644 100644 100644 aaa aaa src/a.ts",
			"1 .M N... 100644 100644 100644 bbb bbb image.png",
			"1 .M S.M. 160000 160000 160000 ccc ccc modules/lib",
			"u UU N... 100644 100644 100644 100644 ddd eee fff conflict.txt",
			"2 R. N... 100644 100644 100644 aaa aaa R100 new.ts",
			"old.ts",
			"? new-file.ts",
		].join("\0");
		const numstat = [
			"10\t2\tsrc/a.ts",
			"-\t-\timage.png",
			"1\t1\tmodules/lib",
			"3\t4\tconflict.txt",
			"5\t0\t",
			"old.ts",
			"new.ts",
		].join("\0");
		const exec = vi
			.fn()
			.mockResolvedValueOnce(result("true\n/repo\n"))
			.mockResolvedValueOnce(result(status))
			.mockResolvedValueOnce(result("tree-id\n"))
			.mockResolvedValueOnce(result(numstat));

		const inspection = await inspectWorkspacePulse({ exec, cwd: "/repo" });

		expect(inspection).toMatchObject({
			kind: "available",
			branch: "feature/pulse",
			snapshot: {
				trackedFiles: 5,
				untrackedFiles: 1,
				linesAdded: 18,
				linesRemoved: 6,
				binaryFiles: 1,
				submodules: 1,
				conflicts: 1,
			},
		});
		expect(exec).toHaveBeenNthCalledWith(
			1,
			"git",
			["rev-parse", "--is-inside-work-tree", "--show-toplevel"],
			{ cwd: "/repo", timeout: 2_000 },
		);
		expect(exec).toHaveBeenNthCalledWith(
			2,
			"git",
			["-C", "/repo", "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"],
			{ timeout: 2_000 },
		);
		expect(exec).toHaveBeenNthCalledWith(3, "git", ["-C", "/repo", "rev-parse", "--verify", "HEAD^{tree}"], {
			timeout: 2_000,
		});
		expect(exec).toHaveBeenNthCalledWith(
			4,
			"git",
			["-C", "/repo", "diff", "--numstat", "-z", "--find-renames", "tree-id", "--"],
			{ timeout: 2_000 },
		);
	});

	it("distinguishes a non-repository from an unavailable Git inspection", async () => {
		const notRepoExec = vi.fn().mockResolvedValue(result("", 128, "fatal: kein Git-Repository"));
		const unavailableExec = vi.fn().mockRejectedValue(new Error("spawn failed"));

		await expect(
			inspectWorkspacePulse({ exec: notRepoExec, cwd: "/definitely-not-a-repository/pulse" }),
		).resolves.toEqual({
			kind: "not-repo",
		});
		await expect(inspectWorkspacePulse({ exec: unavailableExec, cwd: "/tmp" })).resolves.toEqual({
			kind: "unavailable",
		});

		const worktree = mkdtempSync(join(tmpdir(), "atelier-pulse-"));
		mkdirSync(join(worktree, ".git"));
		try {
			await expect(inspectWorkspacePulse({ exec: notRepoExec, cwd: worktree })).resolves.toEqual({
				kind: "unavailable",
			});
		} finally {
			rmSync(worktree, { recursive: true, force: true });
		}
	});

	it("treats malformed porcelain output as unavailable instead of clean", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce(result("true\n/repo\n"))
			.mockResolvedValueOnce(result("unexpected output"))
			.mockResolvedValueOnce(result("tree-id\n"))
			.mockResolvedValueOnce(result());

		await expect(inspectWorkspacePulse({ exec, cwd: "/repo" })).resolves.toEqual({
			kind: "unavailable",
		});
	});

	it("uses the empty tree as the baseline before the first commit", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce(result("true\n/repo\n"))
			.mockResolvedValueOnce(
				result(
					[
						"# branch.oid (initial)",
						"# branch.head main",
						"1 A. N... 100644 100644 100644 aaa aaa first.ts",
					].join("\0"),
				),
			)
			.mockResolvedValueOnce(result("", 128, "fatal: Needed a single revision"))
			.mockResolvedValueOnce(result("7\t0\tfirst.ts\0"));

		const inspection = await inspectWorkspacePulse({ exec, cwd: "/repo" });

		expect(inspection).toMatchObject({
			kind: "available",
			branch: "main",
			snapshot: { trackedFiles: 1, linesAdded: 7 },
		});
		expect(exec).toHaveBeenLastCalledWith(
			"git",
			expect.arrayContaining(["4b825dc642cb6eb9a060e54bf8d69288fbee4904"]),
			{ timeout: 2_000 },
		);
	});
});

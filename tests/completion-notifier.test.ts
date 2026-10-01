import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
	createCompletionNotifier,
	type CompletionNotification,
	type NotificationProcess,
	type SpawnNotificationProcess,
} from "../src/completion-notifier.js";

class FakeProcess extends EventEmitter implements NotificationProcess {
	kill = vi.fn(() => true);
	unref = vi.fn();
}

const settled: CompletionNotification = {
	projectName: "pi-atelier",
	sessionName: "Notification work",
	completedToolCount: 2,
	failedToolCount: 1,
};

function harness(platform: NodeJS.Platform = "linux") {
	const processes: FakeProcess[] = [];
	const spawn = vi.fn<SpawnNotificationProcess>(() => {
		const child = new FakeProcess();
		processes.push(child);
		return child;
	});
	let enabled = true;
	const notifier = createCompletionNotifier({
		platform,
		spawn,
		isEnabled: () => enabled,
	});
	onTestFinished(() => notifier.reset());
	return {
		notifier,
		spawn,
		processes,
		get process() {
			const child = processes[0];
			if (!child) throw new Error("No notification spawned");
			return child;
		},
		disable: () => (enabled = false),
	};
}

describe("completion notifier", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([true, false])("delivers one settlement per run (agent_start observed: %s)", (observed) => {
		const h = harness("darwin");
		if (observed) h.notifier.runStarted();
		h.notifier.turnSettled(settled);
		h.notifier.turnSettled(settled);

		expect(h.spawn).toHaveBeenCalledOnce();
	});

	it.each([true, false])(
		"delivers one notification per input request (agent_start observed: %s)",
		(observed) => {
			const h = harness("win32");
			if (observed) h.notifier.runStarted();
			const notification: CompletionNotification = {
				projectName: "pi-atelier",
				sessionName: "Notification work",
			};
			h.notifier.inputRequested("question-1", notification);
			h.notifier.inputRequested("question-1", notification);
			h.notifier.inputRequested("question-2", notification);

			expect(h.spawn).toHaveBeenCalledTimes(2);
		},
	);

	it("does nothing while completion notifications are disabled", () => {
		const h = harness("darwin");
		h.disable();
		h.notifier.runStarted();
		h.notifier.inputRequested("question-1", { projectName: "private" });
		h.notifier.turnSettled(settled);

		expect(h.spawn).not.toHaveBeenCalled();
	});

	it("spawns a detached macOS notification without interpolating content into AppleScript", () => {
		const h = harness("darwin");
		h.notifier.runStarted();
		h.notifier.turnSettled(settled);

		expect(h.spawn).toHaveBeenCalledOnce();
		const [command, args, options] = h.spawn.mock.calls[0]!;
		expect(command).toBe("osascript");
		expect(args).toContain("Pi Atelier · pi-atelier");
		expect(args).toContain("Turn settled · Notification work · 2 done · 1 failed");
		expect(args.slice(0, -2).join(" ")).not.toContain("Notification work");
		expect(options).toMatchObject({ detached: true, stdio: "ignore" });
		expect(h.process.unref).toHaveBeenCalledOnce();
	});

	it("spawns a hidden Windows toast with notification content passed through the environment", () => {
		const h = harness("win32");
		h.notifier.runStarted();
		h.notifier.turnSettled(settled);

		const [command, args, options] = h.spawn.mock.calls[0]!;
		expect(command).toBe("powershell.exe");
		expect(args).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]));
		expect(args.join(" ")).not.toContain("Notification work");
		expect(options).toMatchObject({ detached: true, stdio: "ignore", windowsHide: true });
		expect(options.env).toMatchObject({
			PI_ATELIER_NOTIFICATION_TITLE: "Pi Atelier · pi-atelier",
			PI_ATELIER_NOTIFICATION_BODY: "Turn settled · Notification work · 2 done · 1 failed",
		});
	});

	it("kills pending system notifications when reset", () => {
		const h = harness("darwin");
		h.notifier.runStarted();
		h.notifier.turnSettled(settled);

		h.notifier.inputRequested("question-1", { projectName: "pi-atelier" });
		h.notifier.reset();

		expect(h.processes).toHaveLength(2);
		for (const child of h.processes) expect(child.kill).toHaveBeenCalledOnce();
	});

	it("kills a native notification that exceeds its delivery timeout", () => {
		vi.useFakeTimers();
		const h = harness("darwin");
		h.notifier.runStarted();
		h.notifier.turnSettled(settled);

		vi.advanceTimersByTime(5_000);
		expect(h.process.kill).toHaveBeenCalledOnce();
	});

	it("clears the process timeout after native delivery exits", () => {
		vi.useFakeTimers();
		const h = harness("darwin");
		h.notifier.runStarted();
		h.notifier.turnSettled(settled);
		h.process.emit("exit", 0);

		vi.advanceTimersByTime(10_000);
		expect(h.process.kill).not.toHaveBeenCalled();
	});

	it("does not notify on platforms without native system delivery", () => {
		const h = harness("linux");
		h.notifier.runStarted();
		h.notifier.turnSettled(settled);

		expect(h.spawn).not.toHaveBeenCalled();
	});

	it("silently absorbs system spawn failures", () => {
		const notifier = createCompletionNotifier({
			platform: "darwin",
			isEnabled: () => true,
			spawn: () => {
				throw new Error("unavailable");
			},
		});
		notifier.runStarted();

		expect(() => notifier.turnSettled(settled)).not.toThrow();
	});
});

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	type CompletionNotification,
	createCompletionNotifier,
	type NotificationProcess,
	type SpawnNotificationProcess,
} from "../src/completion-notifier.js";

class FakeProcess extends EventEmitter implements NotificationProcess {
	kill = vi.fn(() => true);
	unref = vi.fn();
}

const settled: CompletionNotification = {
	kind: "turn-settled",
	projectName: "pi-atelier",
	sessionName: "Notification work",
	completedToolCount: 2,
	failedToolCount: 1,
};

function harness(platform: NodeJS.Platform = "linux") {
	const process = new FakeProcess();
	const spawn = vi.fn<SpawnNotificationProcess>(() => process);
	let enabled = true;
	const notifier = createCompletionNotifier({
		platform,
		spawn,
		isEnabled: () => enabled,
	});
	return { notifier, spawn, process, disable: () => (enabled = false) };
}

describe("completion notifier", () => {
	it("delivers one macOS system notification when a run settles without a duration threshold", () => {
		const h = harness("darwin");
		h.notifier.runStarted();
		h.notifier.turnSettled(settled);
		h.notifier.turnSettled(settled);

		expect(h.spawn).toHaveBeenCalledOnce();
	});

	it("delivers one Windows system notification per explicit input-request tool call", () => {
		const h = harness("win32");
		h.notifier.runStarted();
		const notification: CompletionNotification = {
			kind: "input-requested",
			projectName: "pi-atelier",
			sessionName: "Notification work",
		};
		h.notifier.inputRequested("question-1", notification);
		h.notifier.inputRequested("question-1", notification);
		h.notifier.inputRequested("question-2", notification);

		expect(h.spawn).toHaveBeenCalledTimes(2);
	});

	it("delivers an authoritative settlement event even when agent_start was not observed", () => {
		const h = harness("darwin");

		h.notifier.turnSettled(settled);
		h.notifier.turnSettled(settled);

		expect(h.spawn).toHaveBeenCalledOnce();
	});

	it("delivers and deduplicates input requests even when agent_start was not observed", () => {
		const h = harness("darwin");
		const notification: CompletionNotification = {
			kind: "input-requested",
			projectName: "pi-atelier",
		};

		h.notifier.inputRequested("question-1", notification);
		h.notifier.inputRequested("question-1", notification);

		expect(h.spawn).toHaveBeenCalledOnce();
	});

	it("does nothing while completion notifications are disabled", () => {
		const h = harness("darwin");
		h.disable();
		h.notifier.runStarted();
		h.notifier.inputRequested("question-1", { kind: "input-requested", projectName: "private" });
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

		h.notifier.reset();

		expect(h.process.kill).toHaveBeenCalledOnce();
	});

	it("kills a native notification that exceeds its delivery timeout", () => {
		vi.useFakeTimers();
		try {
			const h = harness("darwin");
			h.notifier.runStarted();
			h.notifier.turnSettled(settled);

			vi.advanceTimersByTime(5_000);
			expect(h.process.kill).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears the process timeout after native delivery exits", () => {
		vi.useFakeTimers();
		try {
			const h = harness("darwin");
			h.notifier.runStarted();
			h.notifier.turnSettled(settled);
			h.process.emit("exit", 0);

			vi.advanceTimersByTime(10_000);
			expect(h.process.kill).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
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

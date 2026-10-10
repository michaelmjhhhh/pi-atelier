import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import { deferred } from "./async.js";
import { plainTheme } from "./render.js";

/**
 * A Pi-regular TUI by default (`mode: "regular"`); every legacy sidebar test
 * mounts the persistent overlay only on a host serving Pi's TUI surface.
 * Pass `mode: null` to model a foreign host TUI (no TuiMode), which the
 * sidebar must not install a persistent overlay onto. (JS default
 * parameters activate on `undefined`, so null is the explicit escape.)
 */
export function fakeTui(requestRender = vi.fn(), mode: "regular" | "fullscreen" | null = "regular") {
	return {
		...(mode === null ? {} : { mode }),
		render: vi.fn((width: number) => [`main:${width}`]),
		requestRender,
		terminal: { columns: 120, rows: 36, width: 120, write: vi.fn() },
	};
}

type TestTui = ReturnType<typeof fakeTui>;
type CustomOptions = NonNullable<Parameters<ExtensionContext["ui"]["custom"]>[1]>;
interface OverlayComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

/** Minimal synchronous Pi custom-dialog host; real renderer contracts use the real Pi TUI. */
export function overlayHost(getTui: () => TestTui = fakeTui, interactive = true) {
	const overlays: Array<{
		component: OverlayComponent;
		done: ReturnType<typeof vi.fn<(value?: unknown) => void>>;
		closed: boolean;
		handle: { hide: ReturnType<typeof vi.fn> };
		options: CustomOptions;
		layout: () => import("@earendil-works/pi-tui").OverlayOptions | undefined;
		requestRender: TestTui["requestRender"];
		tui: TestTui;
	}> = [];
	type Overlay = (typeof overlays)[number];
	const mounted = new Map<number, ReturnType<typeof deferred<Overlay>>>();
	const custom = vi.fn(
		(
			factory: (
				tui: TestTui,
				theme: typeof plainTheme & { name: string },
				keys: object,
				done: (value?: unknown) => void,
			) => OverlayComponent,
			options: CustomOptions = {},
		) => {
			const tui = getTui();
			const pending = deferred<unknown>();
			let closed = false;
			const done = vi.fn((value?: unknown) => {
				if (closed) return;
				closed = true;
				pending.resolve(value);
			});
			const handle = { hide: vi.fn() };
			// A factory that throws must reject the lifecycle promise, the way
			// real hosts settle `ctx.ui.custom()`; previously the throw escaped
			// synchronously and the caller's catch/finally chain never ran.
			let component: OverlayComponent;
			try {
				component = factory(tui, { ...plainTheme, name: "dark" }, {}, done);
			} catch (error) {
				pending.reject(error);
				return pending.promise;
			}
			tui.requestRender.mockClear();
			const layout = () =>
				typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
			const overlay = {
				component,
				done,
				get closed() {
					return closed;
				},
				handle,
				options,
				layout,
				requestRender: tui.requestRender,
				tui,
			};
			overlays.push(overlay);
			options.onHandle?.(handle as unknown as OverlayHandle);
			mounted.get(overlays.length - 1)?.resolve(overlay);
			if (!layout()?.nonCapturing && !interactive) done();
			return pending.promise;
		},
	);
	return {
		custom,
		overlays,
		async mounted(index: number): Promise<Overlay> {
			if (overlays[index]) return overlays[index];
			const signal = mounted.get(index) ?? deferred<Overlay>();
			mounted.set(index, signal);
			return signal.promise;
		},
	};
}

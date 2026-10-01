import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";

/** Session lifetime shared by every interactive overlay owned by the extension. */
export interface OverlayLifetime {
	isActive(): boolean;
	register(cancel: () => void): () => void;
}

/** Without a lifetime an overlay is unbound and stays active. */
export const isLifetimeActive = (lifetime: OverlayLifetime | undefined): boolean =>
	lifetime?.isActive() ?? true;

type LifecycleOverlayComponent = Component & { handleInput(data: string): void };

const INERT_COMPONENT: LifecycleOverlayComponent = { render: () => [], invalidate() {}, handleInput() {} };

/** Controls the lifetime of a mounted overlay binding. */
interface RetirableLifecycleOverlayComponent extends LifecycleOverlayComponent {
	/** Retires the binding and invokes the host-removal callback. */
	retire(): void;
	/** Releases the binding without invoking host removal a second time. */
	release(): void;
}

/**
 * Keeps an overlay inert after its session retires, even when Pi cannot remove it.
 * Retirement is best-effort: a host `done()` failure must not make stale render/input
 * paths call into the retired runtime.
 */
function createLifecycleOverlayComponent(
	lifetime: OverlayLifetime | undefined,
	component: LifecycleOverlayComponent,
	retire: () => void,
): RetirableLifecycleOverlayComponent {
	let inert = false;
	let activeComponent: LifecycleOverlayComponent | undefined = component;
	let unregisterLifetime: (() => void) | undefined;
	const isActive = (): boolean => {
		if (inert) return false;
		try {
			return isLifetimeActive(lifetime);
		} catch {
			return false;
		}
	};
	const releaseSafely = (): boolean => {
		if (inert) return false;
		inert = true;
		activeComponent = undefined;
		const unregister = unregisterLifetime;
		unregisterLifetime = undefined;
		try {
			unregister?.();
		} catch {
			// Lifetime unregister is best-effort during session teardown.
		}
		return true;
	};
	const retireSafely = (): void => {
		if (!releaseSafely()) return;
		try {
			retire();
		} catch {
			// Pi overlay removal is best-effort during session teardown.
		}
	};

	if (lifetime) {
		try {
			unregisterLifetime = lifetime.register(retireSafely);
		} catch {
			retireSafely();
		}
	}

	return {
		retire: retireSafely,
		release: () => {
			releaseSafely();
		},
		render(width) {
			if (!isActive()) {
				retireSafely();
				return [];
			}
			return activeComponent?.render(width) ?? [];
		},
		invalidate() {
			if (!isActive()) {
				retireSafely();
				return;
			}
			activeComponent?.invalidate();
		},
		handleInput(data) {
			if (!isActive()) {
				retireSafely();
				return;
			}
			activeComponent?.handleInput(data);
		},
	};
}

/** Owns host completion, cancellation, and stale callbacks for a capturing dialog. */
export async function openLifecycleOverlay<T>(
	ctx: ExtensionContext,
	create: (
		tui: TUI,
		theme: ExtensionContext["ui"]["theme"],
		finish: (value?: T) => void,
	) => LifecycleOverlayComponent,
	lifetime?: OverlayLifetime,
	overlayOptions: OverlayOptions = {
		anchor: "center",
		width: "70%",
		minWidth: 32,
		maxHeight: "80%",
		margin: 1,
	},
): Promise<T | undefined> {
	const isActive = (): boolean => isLifetimeActive(lifetime);
	if (!isActive()) return undefined;
	let resolve!: (value: T | undefined) => void;
	const settlement = new Promise<T | undefined>((done) => {
		resolve = done;
	});
	let binding: RetirableLifecycleOverlayComponent | undefined;
	try {
		const hostPromise = ctx.ui.custom<T | undefined>(
			(tui, theme, _keys, done) => {
				let completed = false;
				const finish = (value?: T): void => {
					if (completed) return;
					completed = true;
					binding?.release();
					resolve(value);
					try {
						done(value);
					} catch {
						// Settle locally even when Pi cannot remove the host overlay.
					}
				};
				if (!isActive()) {
					finish();
					return INERT_COMPONENT;
				}
				binding = createLifecycleOverlayComponent(lifetime, create(tui, theme, finish), () => finish());
				// Creation or lifetime registration can complete synchronously, before binding is assigned.
				if (completed) binding.release();
				return binding;
			},
			{ overlay: true, overlayOptions },
		);
		const result = await Promise.race([hostPromise, settlement]);
		return isActive() ? result : undefined;
	} finally {
		if (lifetime) binding?.release();
	}
}
